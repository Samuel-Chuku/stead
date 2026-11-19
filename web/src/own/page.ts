// "Protect an Aave position": a visitor opens a protected Aave position with their own wallets, then
// pushes it under the trigger and watches a real Stead rescue. Two networks, one flow:
// - testnet (default): NEAR testnet + Sepolia, on the demo contract (3-minute buy-back window, so
//   both endings fit in one sitting), with test funds and a sponsor for NEAR-only visitors;
// - mainnet (`?net=mainnet#/try`): NEAR mainnet + Ethereum, real funds, on the capped contract: the
//   visitor funds the position from their own Ethereum wallet; no faucet, no sponsor.
// Everything that differs between them lives in one object per network (./net.ts).
// Every step is chosen from chain state, so a reload picks up where it was; every transaction the
// visitor signs is listed with its link. Nothing here holds a key: the wallets sign.
import { connectNear, nearAccount, onNearAccount, setNearNetwork, steadCall } from "../wallet/near";
import { createPublicClient, createWalletClient, custom, fallback, http, parseAbi, type Address, type Hex } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { icon } from "../icons";
import { mountLive } from "../board/live";
import { fmtAmt } from "../board/model";
import type { FeedRescue } from "../../../stewards/src/livefeed";
import {
  NETS, netFromSearch, gasFromMarket, marketMismatch, allowed, capUsd, borrowUnits, withdrawUnits, repayUnits, valueBase, walletNeeds, isShort,
  directLines, ladder, rescueClock, units as fmtUnits,
  type OwnNet, type MarketView, type LimitsView, type ParamsView, type RescueView, type ClaimView,
} from "./net";
import { mountDash } from "./dashboard";
import { hfBand } from "./dashlogic";

const E18 = 10n ** 18n;
/** NEAR-only visitors: the sponsor's Sepolia address is the position's payout (it holds the Sepolia side). */
const SPONSOR_PAYOUT: Address = "0xA57b528591700bB77992D095258eF6F921CDAD68";
/** The network this page shows (set when it mounts) and the gas its signed transactions carry. */
let net: OwnNet = NETS.testnet;
let gas = { evmGas: net.evmGas, txUpfrontWei: net.txUpfrontWei };
const CHAINS = { testnet: sepolia, mainnet } as const;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const poolAbi = parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
// two public RPCs that answer browsers: if one refuses or stalls, the other answers
const client = (n: OwnNet) => createPublicClient({ chain: CHAINS[n.id], transport: fallback(n.evmRpcs.map((u) => http(u, { timeout: 8000 }))) });
let pub = client(net);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: bigint, dec = 18, dp = 4) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dp });
const feedUrl = () => (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FastNEAR's free tier rate-limits bursts, and its 429 carries no CORS header, so the browser only
// says "Failed to fetch": on any transport failure, try NEAR's own public RPC, then wait and retry.
async function nearQuery(params: object): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of net.nearRpcs) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }), signal: AbortSignal.timeout(5000) });
        if (r.status === 429 || r.status >= 500) throw new Error(`NEAR RPC ${r.status}`);
        return await r.json();
      } catch (e) {
        last = e;
      }
    }
    await sleep(800 * (attempt + 1));
  }
  throw new Error(`NEAR RPC unreachable (${(last as Error)?.message ?? "no answer"})`);
}
async function nearView<T>(method: string, args: object): Promise<T> {
  const j = await nearQuery({ request_type: "call_function", finality: "optimistic", account_id: net.contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (!j.result) throw new Error(j.error?.cause?.name ?? "NEAR view failed");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}
async function nearBalance(id: string): Promise<bigint | null> {
  const j = await nearQuery({ request_type: "view_account", finality: "final", account_id: id });
  return j.result ? BigInt(j.result.amount) : null;
}

/** Positions on the contract, from the live feed's records (re-read by the feed every 2 minutes):
 *  one request instead of asking the contract for every id. Cached for a minute. */
let recordsAt = 0;
let recordsCache: { id: number; owner: string }[] | null = null;
const lastRescueOf = new Map<number, number>(); // position → its latest rescue (from the records)
async function knownPositions(): Promise<{ id: number; owner: string }[] | null> {
  if (!net.liveFeed) return null; // the feed doesn't watch this contract: the caller reads the contract
  if (recordsCache && Date.now() - recordsAt < 60_000) return recordsCache;
  try {
    const r = await fetch(`${feedUrl()}/records.json`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    recordsCache = (j.positions as { contract: string; id: number; owner: string }[]).filter((p) => p.contract === net.contract).map(({ id, owner }) => ({ id, owner }));
    lastRescueOf.clear();
    for (const r of j.rescues as { contract: string; id: number; positionId: number }[]) if (r.contract === net.contract && r.id > (lastRescueOf.get(r.positionId) ?? -1)) lastRescueOf.set(r.positionId, r.id);
    recordsAt = Date.now();
  } catch {
    /* the feed is down: the caller falls back to the contract */
  }
  return recordsCache;
}

type Position = { id: number; owner: string; evm_address: string | null; payout: string; next_nonce: number; pending: unknown; active_auction: number | null; open_rescues: number[]; health?: unknown };
type Rescue = RescueView;
type Claim = ClaimView;
type TxRow = { at: number; label: string; chain: "near" | "sepolia" | "ethereum"; hash: string; ok: boolean; note?: string; step?: number; pos?: number };
type Sent = { label: string; chain: "near" | "sepolia" | "ethereum"; hash: string };
type Receipts = { faucet: { at: number; sent: Sent[] } | null; fund: { at: number; sent: Sent[] } | null };
/** Which step a transaction belongs to (rows saved before steps were recorded: by their label). */
const stepOfTx = (t: TxRow) => t.step ?? (/^Test funds:/.test(t.label) ? 3 : /^(Register a position|Sponsor: .*(NEAR to|for its gas|into your position \(Aave))/.test(t.label) ? 4 : 0);
/** "Test funds: 0.0025 Sepolia ETH" → "0.0025 ETH"; "Supply 60 LINK on Aave (the contract…)" → "Supply 60 LINK on Aave". */
/** One line per step of the rescue, as it happens (from the live feed). */
function liveLine(e: FeedRescue["events"][number]): string | null {
  const x = e as any;
  switch (e.kind) {
    case "TRIGGER": return `Proven: health ${Number(x.hf).toFixed(3)}, under 1.15`;
    case "AUCTION_OPEN": return `Auction open: ${fmtAmt(x.topUp.amount)} ${x.topUp.asset} needed, premium cap ${x.capBps} bps`;
    case "BID": return `<strong>${x.steward}</strong> bids ${x.bps} bps for ${fmtAmt(x.amount)}`;
    case "AUCTION_CLOSE": return `Auction closed: ${x.winners.map((w: any) => `<strong>${w.steward}</strong> at ${w.bps} bps`).join(", ") || "no winner"}`;
    case "TOPUP_SENT": return `<strong>${x.steward}</strong> tops up ${fmtAmt(x.amount)} ${x.asset} on Aave`;
    case "TOPUP_CONFIRMED": return `Top-up proven on Sepolia`;
    case "CLAIM_MINTED": return `Claim ${x.claim} minted to <strong>${x.holder}</strong>: owed ${fmtAmt(x.owed)} ${x.asset}`;
    case "PAYMENT_IN": return `Payment into the position: ${fmtAmt(x.amount)} ${x.asset}`;
    case "BOUGHT_BACK": return `Bought back`;
    case "PAYOUT": return `Paid out: ${fmtAmt(x.amount)} ${x.asset} (${x.purpose})`;
    case "SETTLE_START": return `Settlement started at the oracle price`;
    case "SETTLED": return `Settled`;
    default: return null;
  }
}
/** What each rescue state means for the borrower, in a sentence. */
const rescueText = (st: string, auctionS = 45) =>
  ({
    auction: `Stewards are bidding now (a ${auctionS}-second auction); watch the bids ${net.liveFeed ? "on the board below" : "below"}.`,
    top_up_pending: "The auction is closed. The winner is topping up your position; the contract waits for a proven reading of the new collateral before minting its claim.",
    open: "Your position is rescued and the claim is open: buy it back by paying exactly what is owed into your position, or do nothing and the claim owner settles when the window ends.",
    settling: "The buy-back window ended, so the claim owner is settling at the oracle price: it repays part of your debt and takes the collateral it is owed. Your cost is still only the premium.",
    settled: "Settled at the oracle price: the claim owner took exactly what it was owed.",
    bought_back: "Bought back: the claim owner was paid exactly what it was owed.",
  })[st] ?? st.replace(/_/g, " ");
const elapsed = (fromMs: number) => {
  const s = Math.max(0, Math.round((Date.now() - fromMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const countdown = (endMs: number) => {
  const left = Math.max(0, Math.round((endMs - Date.now()) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
};
const shortLabel = (l: string) => {
  const x = l.replace(/^(Test funds|Sponsor): /, "");
  const amt = x.match(/^([\d.]+) (?:Sepolia )?([A-Z]{2,5})\b/);
  return amt ? `${amt[1]} ${amt[2]}` : x.replace(/ \(.*$/, "").replace(/: refused.*$/, " (refused)");
};
const txHref = (t: TxRow) => (t.chain === "near" ? net.nearTx(t.hash) : net.evmTx(t.hash));
/** Where a transaction ran, as the chips and the run log name it. */
const chainName = (t: TxRow) => (t.chain === "near" ? "NEAR" : t.chain === "ethereum" ? "Ethereum" : "Sepolia");
const evmChain = (): "sepolia" | "ethereum" => (net.id === "mainnet" ? "ethereum" : "sepolia");

export function mountOwn(root: HTMLElement): () => void {
  // mainnet is a position dashboard, not this guided demo
  if (netFromSearch(location.search) === "mainnet") return mountDash(root);
  net = NETS[netFromSearch(location.search)];
  gas = { evmGas: net.evmGas, txUpfrontWei: net.txUpfrontWei };
  pub = client(net);
  setNearNetwork(net.id);
  const C = net.collateral;
  const D = net.debt;
  const MAIN = net.id === "mainnet";
  // mainnet keeps its saved state apart from testnet's
  const NK = MAIN ? "mainnet-" : "";
  let gone = false;
  let near: string | null = null;
  /** "sponsored": NEAR wallet only, the sponsor holds the Sepolia side; "own": the visitor's Sepolia wallet too. */
  let mode: "sponsored" | "own" | null = null;
  const MODE_KEY = () => `stead-own-mode-${NK}${near}`;
  const loadMode = () => {
    try {
      const m = localStorage.getItem(MODE_KEY());
      mode = (m === "sponsored" && net.sponsor) || m === "own" ? m : mode;
    } catch {
      /* ignore */
    }
  };
  const setMode = (m: "sponsored" | "own") => {
    mode = m;
    try {
      localStorage.setItem(MODE_KEY(), m);
    } catch {
      /* ignore */
    }
  };
  let evm: Address | null = null;
  let busy = "";
  let error = "";
  let txs: TxRow[] = [];
  let notice = ""; // a plain explanation (not an error) shown above the steps
  let busySince = 0;
  let showAllTxs = false;
  let forceNew = false; // "Protect a new position": register a fresh one instead of reusing the last
  // testnet: every position this NEAR account owns (newest first), re-read every 30 s
  type Owned = { id: number; evm: string | null; coll: bigint; debt: bigint; hfBps: bigint | null; status: "running" | "claim" | "open" | "new" | "closed" };
  let owned: Owned[] | null = null;
  let ownedAt = 0;
  let ownedFor: string | null = null;
  // the rescue as the live feed sees it (bids and every step, seconds after the chain), while one runs
  let live: FeedRescue | null = null;
  let livePoll = 0;
  let stepNow = 0; // the step whose button is running: its transactions are filed under it
  let receipts: Receipts | null = null; // what the faucet and the sponsor sent this visitor (any device)
  let receiptsAt = 0;
  // eth/link/dai: the visitor's wallet (link/dai = the market's collateral and debt token);
  // posEth/posColl: what the position's own address holds before it is opened
  let state: { nearYocto: bigint | null; eth: bigint; link: bigint; dai: bigint; pos: Position | null; hf: number | null; coll: bigint; debt: bigint; rescue: Rescue | null; claims: Claim[]; posEth: bigint; posColl: bigint } | null = null;
  // mainnet: the contract's own settings, read once (market, size cap, allow-list, timing) and the
  // collateral's oracle price; a market that doesn't match this page's addresses stops every action
  let chainCfg: { market: MarketView | null; limits: LimitsView | null; params: ParamsView | null } | null = null;
  let mismatch: string[] = [];
  let collPrice = 0n;
  const seenAt = new Map<string, number>(); // when this page first saw a rescue event the contract doesn't time
  let directPoll = 0;
  let stopBoard: () => void = () => {};
  let boardFor: number | null = null;
  let lastRescue: number | null = null; // the visitor's latest rescue, for its story link
  // the steps re-render on every refresh; the live board lives in its own container below them
  root.innerHTML = `<div data-own-main></div><div class="st-own-board" data-own-board hidden></div>`;
  const main = root.querySelector<HTMLElement>("[data-own-main]")!;
  const boardHost = root.querySelector<HTMLElement>("[data-own-board]")!;
  const KEY = () => `stead-own-${NK}${near}`;

  // each NEAR account's transactions are kept apart (and shown only while it's connected)
  const TXKEY = () => `stead-own-txs-${NK}${near}`;
  const loadTxs = () => {
    txs = [];
    if (!near) return;
    try {
      const old = MAIN ? null : localStorage.getItem("stead-own-txs"); // the list from before it was kept per account
      if (old && !localStorage.getItem(TXKEY())) localStorage.setItem(TXKEY(), old);
      if (!MAIN) localStorage.removeItem("stead-own-txs");
      txs = JSON.parse(localStorage.getItem(TXKEY()) ?? "[]");
    } catch {
      txs = [];
    }
  };
  const saveTxs = () => {
    if (!near) return;
    try {
      localStorage.setItem(TXKEY(), JSON.stringify(txs.slice(-60)));
    } catch {
      /* the list still shows; it just won't survive a reload */
    }
  };
  /** This position's transactions. Rows saved before positions were tagged: those after the last
   *  "Register a position" (any earlier ones belong to older runs). */
  const shown = (): TxRow[] => {
    const id = state?.pos?.id;
    if (id === undefined) return [];
    const reg = txs.filter((t) => /^Register a position/.test(t.label) && (t.pos === undefined || t.pos === id)).reduce((m, t) => Math.max(m, t.at), 0);
    return txs.filter((t) => (t.pos !== undefined ? t.pos === id : t.at >= reg));
  };
  const addTx = (t: Omit<TxRow, "at">) => {
    txs.push({ ...t, at: Date.now(), step: stepNow, pos: state?.pos?.id });
    saveTxs();
    render();
  };

  // ── wallets ──
  let stopNear: () => void = () => {};
  async function initNear() {
    near = await nearAccount();
    loadMode();
    loadTxs();
    stopNear = onNearAccount((a) => {
      near = a;
      loadMode();
      loadTxs();
      void refresh();
    });
  }
  // a visitor who disconnected the Sepolia wallet stays disconnected across reloads
  const EVM_OFF = "stead-own-evm-off";
  const evmOff = () => {
    try {
      return localStorage.getItem(EVM_OFF) === "1";
    } catch {
      return false;
    }
  };
  async function disconnectEvm() {
    const eth = (window as any).ethereum;
    // wallets that support it (MetaMask) drop this site's access; otherwise the page just forgets it
    await eth?.request?.({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
    try {
      localStorage.setItem(EVM_OFF, "1");
    } catch {
      /* ignore */
    }
    evm = null;
    if (mode === "own") {
      mode = null;
      try {
        localStorage.removeItem(MODE_KEY());
      } catch {
        /* ignore */
      }
    }
    render();
    void refresh();
  }
  async function connectEvm() {
    try {
      localStorage.removeItem(EVM_OFF);
    } catch {
      /* ignore */
    }
    const eth = (window as any).ethereum;
    if (!eth) throw new Error(`No ${net.evmName} wallet found in this browser (MetaMask or another injected wallet).`);
    const w = createWalletClient({ chain: CHAINS[net.id], transport: custom(eth) });
    const [a] = await w.requestAddresses();
    try {
      await w.switchChain({ id: CHAINS[net.id].id });
    } catch {
      await w.addChain({ chain: CHAINS[net.id] });
    }
    evm = a;
    setMode("own");
  }
  const evmWallet = () => createWalletClient({ account: evm!, chain: CHAINS[net.id], transport: custom((window as any).ethereum) });
  async function ensureChain() {
    const w = evmWallet();
    if ((await w.getChainId()) === CHAINS[net.id].id) return;
    try {
      await w.switchChain({ id: CHAINS[net.id].id });
    } catch {
      await w.addChain({ chain: CHAINS[net.id] });
      await w.switchChain({ id: CHAINS[net.id].id });
    }
    if ((await w.getChainId()) !== CHAINS[net.id].id) throw new Error(`Switch your wallet to ${net.evmName}, then try again.`);
  }

  // ── Stead calls (signed by the visitor's NEAR wallet) ──
  async function stead(method: string, args: object, label: string, gasTgas = 150n): Promise<string> {
    try {
      const out: any = await steadCall(method, args, gasTgas);
      const hash = out?.transaction?.hash ?? out?.transaction_outcome?.id ?? "";
      const failure = [out?.status?.Failure, ...(out?.receipts_outcome ?? []).map((r: any) => r.outcome?.status?.Failure)].find(Boolean);
      if (failure) {
        const msg = JSON.stringify(failure).match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? "refused";
        addTx({ label: `${label}: refused by the contract ("${msg}")`, chain: "near", hash, ok: false });
        throw Object.assign(new Error(msg), { refused: true });
      }
      addTx({ label, chain: "near", hash, ok: true });
      return hash;
    } catch (e) {
      const m = String((e as Error).message ?? e);
      const panic = m.match(/Smart contract panicked: ([^"\\]+)/)?.[1];
      const hash = (e as any)?.transaction?.hash ?? (e as any)?.txHash;
      if (panic && !(e as any).refused) addTx({ label: `${label}: refused by the contract ("${panic}")`, chain: "near", hash: hash ?? "", ok: false });
      else if (!panic && !/reject|cancel|denied|closed|user/i.test(m)) addTx({ label: `${label}: failed (${m.slice(0, 120)})`, chain: "near", hash: hash ?? "", ok: false });
      throw panic ? Object.assign(new Error(panic), { refused: true }) : e;
    }
  }
  /** Every contract-signed transaction needs gas limit × max fee available up front at the position's
   *  address (testnet 600k × 2 gwei = 0.0012 ETH; mainnet the market's caps, 375,332 × 1 gwei). Top it
   *  up from the visitor's wallet, or the sponsor. */
  async function ensureGas(pid: number) {
    const p = await nearView<Position>("get_position", { position_id: pid });
    if (!p.evm_address || (await pub.getBalance({ address: p.evm_address as Address })) >= gas.txUpfrontWei) return;
    if (mode === "sponsored") {
      busy = "Your position is low on gas: the sponsor sends it 0.002 Sepolia ETH…";
      render();
      await sponsor("gas");
    } else await evmSend(`Your position is low on gas: send it ${fmt(net.gasTopupWei, 18, 4)} ETH`, () => evmWallet().sendTransaction({ to: p.evm_address as Address, value: net.gasTopupWei }));
  }
  /** Ask the contract to sign an Aave action for the position, then wait until it lands on Sepolia. */
  async function signAction(pid: number, action: object, label: string) {
    await ensureGas(pid);
    const before = (await nearView<Position>("get_position", { position_id: pid })).next_nonce;
    await stead("sign_action", { position_id: pid, action, gas: gas.evmGas }, `${label} (the contract signs it through NEAR's chain signatures)`);
    busy = `${label}: waiting for it to land on ${net.evmName}…`;
    render();
    for (let i = 0; i < 90; i++) {
      const p = await nearView<Position>("get_position", { position_id: pid });
      if (p.next_nonce > before && p.pending === null) return;
      // still waiting after 40 s: a position that can't pay the gas would wait forever
      if (i === 10) await ensureGas(pid);
      await sleep(4000);
    }
    throw new Error(`${label} did not land within 6 minutes`);
  }
  async function evmSend(label: string, fn: () => Promise<Hex>) {
    busy = `${label}: confirm in your ${net.evmName} wallet…`;
    render();
    // the wallet may have moved to another chain since it connected (a mainnet run, another site):
    // put it on this page's chain before it is asked to sign, adding the chain if it doesn't know it
    await ensureChain();
    const hash = await fn();
    addTx({ label, chain: evmChain(), hash, ok: true });
    busy = `${label}: waiting for ${net.evmName}…`;
    render();
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") {
      const row = txs.find((t) => t.hash === hash);
      if (row) row.ok = false;
      saveTxs();
      throw new Error(`${label}: the transaction reverted on ${net.evmName} (nothing moved).`);
    }
  }

  // ── chain state ──
  async function findPosition(): Promise<Position | null> {
    if (!near) return null;
    let id: number | null = null;
    try {
      id = Number(localStorage.getItem(KEY()) ?? "NaN");
    } catch {
      id = null;
    }
    if (id !== null && Number.isInteger(id)) {
      const p = await nearView<Position | null>("get_position", { position_id: id }).catch(() => null);
      if (p && p.owner === near) return p;
    }
    const remember = (p: Position) => {
      try {
        localStorage.setItem(KEY(), String(p.id));
      } catch {
        /* ignore */
      }
      return p;
    };
    // positions newer than the records (just registered): the ids after the highest known one
    const known = await knownPositions();
    const newest = async (from: number) => {
      for (let i = from; i < from + 8; i++) {
        const p = await nearView<Position | null>("get_position", { position_id: i });
        if (!p) return null; // ids are sequential: the first gap is the end
        if (p.owner === near) return remember(p);
      }
      return null;
    };
    if (known) {
      const mine = known.filter((k) => k.owner === near).sort((a, b) => b.id - a.id)[0];
      const fresh = await newest(known.reduce((m, k) => Math.max(m, k.id), -1) + 1);
      if (fresh) return fresh;
      if (mine) {
        const p = await nearView<Position | null>("get_position", { position_id: mine.id });
        if (p && p.owner === near) return remember(p);
      }
      return null;
    }
    // no records (the feed is down): walk the contract's ids once from 0, a few at a time
    let found: Position | null = null;
    for (let i = 0; i < 200; i += 8) {
      const page = await Promise.all(Array.from({ length: 8 }, (_, k) => nearView<Position | null>("get_position", { position_id: i + k })));
      found = page.filter((x): x is Position => !!x && x.owner === near).pop() ?? found; // the newest wins
      if (page.every((x) => !x)) break;
    }
    return found && remember(found);
  }
  /** Testnet: the account's positions for the list above the steps (the latest 8). Ids from the live
   *  feed's records plus the one this page follows; each read from the contract and Aave. */
  async function loadOwned(followed: Position | null) {
    if (MAIN || !near) {
      owned = null;
      return;
    }
    if (ownedFor === near && Date.now() - ownedAt < 30_000 && (!followed || owned?.some((o) => o.id === followed.id))) return;
    const known = await knownPositions();
    const ids = [...new Set([...(known ?? []).filter((k) => k.owner === near).map((k) => k.id), ...(followed ? [followed.id] : [])])].sort((a, b) => b - a).slice(0, 8);
    const rows = await Promise.all(
      ids.map(async (id): Promise<Owned | null> => {
        const p = id === followed?.id ? followed : await nearView<Position | null>("get_position", { position_id: id }).catch(() => null);
        if (!p || p.owner !== near) return null;
        let coll = 0n, debt = 0n, hfBps: bigint | null = null;
        if (p.evm_address) {
          const d = await pub.readContract({ address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [p.evm_address as Address] }).catch(() => null);
          if (d) {
            coll = d[0];
            debt = d[1];
            hfBps = debt > 0n ? d[5] / 10n ** 14n : null;
          }
        }
        const status = p.active_auction !== null ? "running" : p.open_rescues.length ? "claim" : coll > 0n || debt > 0n ? "open" : p.next_nonce >= 3 ? "closed" : "new"; // a used position back to nothing on Aave ran to the end
        return { id: p.id, evm: p.evm_address, coll, debt, hfBps, status };
      }),
    );
    owned = rows.filter((r): r is Owned => !!r);
    ownedAt = Date.now();
    ownedFor = near;
  }
  /** Follow another of the account's positions (the list), or start a new one. */
  function follow(id: number | null) {
    if (busy) return;
    forceNew = id === null;
    if (id !== null) {
      try {
        localStorage.setItem(KEY(), String(id));
      } catch {
        /* ignore */
      }
    }
    lastRescue = null;
    notice = "";
    error = "";
    live = null;
    if (state) state = { ...state, pos: null, rescue: null, claims: [], hf: null, coll: 0n, debt: 0n, posEth: 0n, posColl: 0n };
    render();
    void refresh();
  }
  function ownedHtml(followedId: number | null): string {
    if (MAIN || !near || !owned?.length) return "";
    const usd8 = (v: bigint) => "$" + (Number(v) / 1e8).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const CHIP: Record<Owned["status"], string> = { running: "RESCUE RUNNING", claim: "CLAIM OPEN", open: "PROTECTED", new: "NOT OPENED", closed: "CLOSED" };
    const row = (o: Owned) => {
      const live = o.status !== "closed";
      const band = o.status === "closed" || o.status === "new" ? "closed" : hfBand(o.hfBps);
      const hf = o.hfBps !== null ? (Number(o.hfBps) / 1e4).toFixed(2) : "—";
      const here = o.id === followedId;
      return `<li><button type="button" class="st-dash-posrow is-${band}${here ? " is-here" : ""}" data-pick-pos="${o.id}"${here ? ' aria-current="true"' : ""}${busy ? " disabled" : ""} aria-label="Position ${o.id}, ${CHIP[o.status].toLowerCase()}${here ? ", shown below" : ""}">
        <span class="st-dash-poshead">${icon("rescues", 22)}<span>Position ${o.id}</span><span class="st-dash-poschip${live ? " is-open" : ""}">${CHIP[o.status]}</span></span>
        <span class="st-dash-posfig"><span class="st-label">COLLATERAL</span><b class="st-num">${usd8(o.coll)}</b></span>
        <span class="st-dash-posfig"><span class="st-label">DEBT</span><b class="st-num">${usd8(o.debt)}</b></span>
        <span class="st-dash-posfig is-hf"><span class="st-label">HEALTH</span><b class="st-num">${hf}</b></span>
        <span class="st-dash-posfig"><span class="st-label">ADDRESS</span><span class="st-mono">${o.evm ? `${o.evm.slice(0, 6)}…${o.evm.slice(-4)}` : "deriving…"}</span></span>
        <span class="st-dash-posgo" aria-hidden="true">${here ? "SHOWN" : "›"}</span>
      </button></li>`;
    };
    const openN = owned.filter((o) => o.status !== "closed").length;
    return `<section class="st-dash-poslist st-own-poslist" aria-label="Your positions">
      <div class="st-dash-poslist-head">
        <span class="st-dash-poslist-shield" aria-hidden="true">${icon("rescues", 30)}</span>
        <div><div class="st-label">YOUR POSITIONS · ${esc(near)}</div><h2>${openN ? `${openN} open, ${owned.length - openN} closed` : `${owned.length} closed`}</h2></div>
        ${forceNew ? `<button type="button" class="st-secondary st-cut" data-pick-back${busy ? " disabled" : ""}>Back to my positions</button>` : `<button type="button" class="st-dash-newbig st-cut" data-new-pos${busy ? " disabled" : ""}>${icon("rescues", 18)}Open a new position</button>`}
      </div>
      <ol class="st-dash-posrows">${owned.map(row).join("")}</ol>
      ${forceNew ? `<p class="st-own-hint">A new position: the steps below register and open it. Your other positions stay as they are.</p>` : `<p class="st-own-hint">The steps below follow the position marked SHOWN. Choose another to follow it.</p>`}
    </section>`;
  }
  async function refresh() {
    if (gone) return;
    try {
      const pos = forceNew ? null : await findPosition();
      await loadOwned(pos);
      const [nearYocto, eth, link, dai] = await Promise.all([
        near ? nearBalance(near) : Promise.resolve(null),
        evm ? pub.getBalance({ address: evm }) : Promise.resolve(0n),
        evm ? pub.readContract({ address: C.address, abi: erc20, functionName: "balanceOf", args: [evm] }) : Promise.resolve(0n),
        evm ? pub.readContract({ address: D.address, abi: erc20, functionName: "balanceOf", args: [evm] }) : Promise.resolve(0n),
      ]);
      if (MAIN) await readChainCfg();
      let hf: number | null = null, coll = 0n, debt = 0n, rescue: Rescue | null = null, claims: Claim[] = [], posEth = 0n, posColl = 0n;
      if (pos?.evm_address && MAIN) {
        [posEth, posColl] = await Promise.all([
          pub.getBalance({ address: pos.evm_address as Address }),
          pub.readContract({ address: C.address, abi: erc20, functionName: "balanceOf", args: [pos.evm_address as Address] }),
        ]);
      }
      if (pos?.evm_address) {
        const d = await pub.readContract({ address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [pos.evm_address as Address] });
        coll = d[0];
        debt = d[1];
        hf = debt === 0n ? null : Number(d[5] / 10n ** 14n) / 10_000;
        const rid = pos.active_auction ?? pos.open_rescues[0] ?? null;
        if (rid !== null) {
          lastRescue = rid;
          rescue = await nearView<Rescue>("get_rescue", { rescue_id: rid });
          claims = (await Promise.all(rescue.members.filter((m) => m.claim_id).map((m) => nearView<Claim>("get_claim", { token_id: m.claim_id })))).filter(Boolean);
        }
      }
      state = { nearYocto, eth, link, dai, pos, hf, coll, debt, rescue, claims, posEth, posColl };
      if (pos && lastRescue === null) {
        await knownPositions();
        lastRescue = lastRescueOf.get(pos.id) ?? null;
      }
      if (near && (net.faucet || net.sponsor) && Date.now() - receiptsAt > 60_000) {
        receiptsAt = Date.now();
        const q = new URLSearchParams({ near, ...(evm ? { evm } : {}), ...(pos ? { position: String(pos.id) } : {}) });
        receipts = await fetch(`${feedUrl()}/demo/receipts?${q}`, { signal: AbortSignal.timeout(6000) }).then((r) => (r.ok ? r.json() : receipts), () => receipts);
      }
      if (error.startsWith("Reading the chains failed")) error = ""; // a later read worked: the notice goes
    } catch (e) {
      error = `Reading the chains failed (${(e as Error).message}); retrying.`;
    }
    render();
  }

  /** Mainnet: the contract's settings (once) and the collateral's oracle price (each refresh). */
  async function readChainCfg() {
    if (!chainCfg) {
      const [market, limits, params] = await Promise.all([
        nearView<MarketView | null>("get_market", { market_id: net.market }),
        nearView<LimitsView>("get_limits", {}),
        nearView<ParamsView>("get_params", {}),
      ]);
      chainCfg = { market, limits, params };
      mismatch = marketMismatch(net, market);
      if (market && !mismatch.length) gas = gasFromMarket(net, market);
    }
    collPrice = await pub.readContract({ address: net.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [C.address] });
  }
  /** Mainnet: the rescue straight from the contract every 3 s while one may run (no feed watches it). */
  async function pollDirect() {
    const pos = state?.pos;
    if (!pos || gone) return;
    try {
      const p = await nearView<Position>("get_position", { position_id: pos.id });
      const rid = p.active_auction ?? p.open_rescues[0] ?? null;
      let rescue: Rescue | null = null;
      let claims: Claim[] = [];
      if (rid !== null) {
        lastRescue = rid;
        rescue = await nearView<Rescue>("get_rescue", { rescue_id: rid });
        claims = (await Promise.all(rescue.members.filter((m) => m.claim_id).map((m) => nearView<Claim>("get_claim", { token_id: m.claim_id })))).filter(Boolean);
      }
      const sig = (r: Rescue | null, c: Claim[]) => JSON.stringify([r?.id, r?.state, r?.bids.length, r?.members.map((m) => [m.confirmed, m.evm_tx]), c.map((x) => x.status)]);
      const changed = sig(rescue, claims) !== sig(state?.rescue ?? null, state?.claims ?? []) || p.next_nonce !== pos.next_nonce;
      if (!state || gone) return;
      state = { ...state, pos: { ...pos, ...p }, rescue, claims };
      const el = root.querySelector<HTMLElement>("[data-own-live]");
      if (el) el.innerHTML = panelHtml();
      const act = root.querySelector<HTMLElement>("[data-own-activity]");
      if (act) act.innerHTML = lastActivity;
      const lad = root.querySelector<HTMLElement>("[data-own-ladder]");
      if (lad) lad.innerHTML = ladderHtml();
      if (changed && !busy) void refresh();
    } catch {
      /* the next poll tries again */
    }
  }

  // ── the live panel: what is happening now, the position, the latest activity (whole run) ──
  function isFinished() {
    const s = state;
    const pos = s?.pos;
    return !!pos && !!s && s.coll === 0n && s.debt === 0n && pos.next_nonce >= 3 && pos.pending === null && !pos.open_rescues.length && pos.active_auction === null;
  }
  function panelHtml(): string {
    const s = state;
    const pos = s?.pos ?? null;
    // the rescue running now: from the live feed (testnet) or read from the contract (mainnet)
    const ENDED = ["bought_back", "settled", "failed"];
    const r: { rescueId: number; contractState: string; closesAt: number } | null = net.liveFeed
      ? live && !ENDED.includes(live.contractState)
        ? (() => {
            const open = live.events.find((e) => e.kind === "AUCTION_OPEN") as any;
            return { rescueId: live.rescueId, contractState: live.contractState, closesAt: open ? live.openedAtMs + (open.t + open.durationS) * 1000 : 0 };
          })()
        : null
      : s?.rescue && !ENDED.includes(s.rescue.state)
        ? { rescueId: s.rescue.id, contractState: s.rescue.state, closesAt: rescueClock(s.rescue, s.claims).closesAtMs ?? 0 }
        : null;
    const usd8 = (v: bigint) => "$" + (Number(v) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 0 });
    const hf = s?.hf != null ? s.hf.toFixed(2) : "n/a";
    let now: string;
    if (!near) now = `Connect a ${net.nearName} wallet to start.`;
    else if (busy) now = `${esc(busy)} <span class="st-own-elapsed" data-elapsed="${busySince}">${elapsed(busySince)}</span>`;
    else if (r) {
      const closesAt = r.closesAt;
      const ends = (s?.claims ?? []).filter((c) => c.status === "open" && c.expires_at).map((c) => Number(BigInt(c.expires_at!) / 1_000_000n));
      now =
        r.contractState === "auction" && closesAt ? `Rescue #${r.rescueId}: stewards are bidding · <strong data-countdown="${closesAt}">${countdown(closesAt)}</strong> left`
        : r.contractState === "top_up_pending" ? `Rescue #${r.rescueId}: the winner is topping up; waiting for the proof of the new collateral`
        : r.contractState === "open" && ends.length ? `Rescue #${r.rescueId}: claim open · <strong data-countdown="${Math.min(...ends)}">${countdown(Math.min(...ends))}</strong> left to buy back`
        : r.contractState === "settling" ? `Rescue #${r.rescueId}: the claim owner is settling at the oracle price`
        : `Rescue #${r.rescueId}: ${esc(r.contractState.replace(/_/g, " "))}`;
    } else if (!pos) now = MAIN ? "No position yet: register one in step 3." : "No position yet: open one in step 4.";
    else if (isFinished()) now = "Run complete: the position is closed and everything is back in your wallets.";
    else if (!s || s.coll === 0n) now = `Position ${pos.id} is registered, not opened yet.`;
    else if (pos.active_auction !== null || pos.open_rescues.length) now = "A rescue is starting: reading the auction…";
    else if (s.hf !== null && s.hf < 1.15) now = "Under the 1.15 trigger: waiting for the proven reading that opens the auction (usually under a minute).";
    else if (s.debt > 0n) now = `Protected: health ${hf}. If it falls under 1.15, stewards compete to rescue it.`;
    else now = "Opened, no debt.";
    // amber only for exposure: under the trigger, or a claim open on the position
    const exposed = (s?.hf != null && s.hf < 1.15 && s.debt > 0n) || (r?.contractState === "open");
    const fall = s?.hf != null && s.debt > 0n ? `${C.symbol} can fall ${((1 - 1 / s.hf) * 100).toFixed(1)}% before liquidation` : "no debt: nothing to liquidate";
    const tiles = pos && s
      ? `<dl class="st-np-tiles">
          <div><dt>HEALTH FACTOR</dt><dd><span class="st-num${exposed && s.hf != null && s.hf < 1.15 ? " is-exposed" : ""}">${hf}</span></dd><dd class="st-np-sub">${fall}</dd></div>
          <div><dt>COLLATERAL</dt><dd><span class="st-num">${usd8(s.coll)}</span></dd><dd class="st-np-sub">${C.symbol} supplied on Aave</dd></div>
          <div><dt>DEBT</dt><dd><span class="st-num">${usd8(s.debt)}</span></dd><dd class="st-np-sub">${D.symbol} borrowed</dd></div>
          <div><dt>POSITION</dt><dd><span class="st-num">${pos.id}</span></dd><dd class="st-np-sub">read from Aave on ${net.evmName}</dd></div>
        </dl>`
      : "";
    // your transactions and the rescue's events, newest first
    const acts: { at: number; html: string }[] = shown().map((t) => ({
      at: t.at,
      html: `${t.ok ? "" : '<span class="st-own-chip-refused">refused</span> '}${esc(shortLabel(t.label).replace(/ \(refused\)$/, ""))}${t.hash ? ` <a class="st-np-link" href="${txHref(t)}" target="_blank" rel="noopener" aria-label="the transaction">${icon("external", 11)}</a>` : ""}`,
    }));
    if (net.liveFeed && live) for (const e of live.events) {
      const line = liveLine(e);
      if (line) acts.push({ at: live.openedAtMs + e.t * 1000, html: line });
    }
    if (!net.liveFeed && s?.rescue) for (const l of directLines(s.rescue, s.claims, C, net.evmName)) {
      if (!seenAt.has(l.key)) seenAt.set(l.key, l.atMs ?? Date.now());
      acts.push({ at: l.atMs ?? seenAt.get(l.key)!, html: l.html });
    }
    const rows = acts
      .sort((a, b) => b.at - a.at)
      .slice(0, 5)
      .map((a) => `<li><span class="st-np-t">${new Date(a.at).toISOString().slice(11, 19)}</span><span>${a.html}</span></li>`)
      .join("");
    const lamp = busy || r ? "st-np-lamp is-live" : exposed ? "st-np-lamp is-exposed" : "st-np-lamp";
    lastActivity = rows ? `<div class="st-np-journal"><div class="st-journal-head">LATEST ACTIVITY · POSITION ${pos?.id ?? ""}</div><ol class="st-np-lines">${rows}</ol></div>` : "";
    return `<div class="st-np-head"><span class="${lamp}" aria-hidden="true"></span><span class="st-np-label">NOW</span><span class="st-np-now">${now}</span></div>${tiles}`;
  }
  let lastActivity = ""; // the journal below the panel, built with it

  // ── the steps ──
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = `${label}…`;
    busySince = Date.now();
    error = "";
    notice = "";
    render();
    try {
      await fn();
    } catch (e) {
      const raw = String((e as any).shortMessage ?? (e as Error).message ?? e);
      const cancelled = /user (rejected|denied|cancel)|rejected the request|request rejected/i.test(raw);
      error = (e as any).refused
        ? `The contract refused it: "${(e as Error).message}".`
        : cancelled
          ? `${label} paused: you cancelled the request in your wallet, so nothing was sent. Press the button again when you're ready; it picks up where it stopped.`
          : `${label} stopped: ${raw.split("\n")[0].slice(0, 200)}`;
    }
    busy = "";
    await refresh();
  }
  async function sponsor(what: "fund" | "buyback" | "repay" | "gas") {
    const r = await fetch(`${feedUrl()}/demo/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ near, positionId: state!.pos!.id, what }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    for (const x of j.sent ?? []) addTx({ label: `Sponsor: ${x.label}`, chain: x.chain, hash: x.hash, ok: true });
  }
  const faucet = () =>
    run("Getting test funds", async () => {
      stepNow = 3;
      receiptsAt = 0;
      const r = await fetch(`${feedUrl()}/demo/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ near, evm }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      for (const s of j.sent ?? []) addTx({ label: `Test funds: ${s.label}`, chain: s.chain, hash: s.hash, ok: true });
    });
  async function borrowTo(pid: number, hfBps: bigint, label: string) {
    const p = await nearView<Position>("get_position", { position_id: pid });
    const d = await pub.readContract({ address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [p.evm_address as Address] });
    const pd = await pub.readContract({ address: net.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [D.address] });
    const units = borrowUnits(d[0], d[1], d[3], hfBps, pd, D.decimals);
    if (units === 0n) return;
    void label;
    await signAction(pid, { type: "borrow", amount: units.toString() }, `Borrow ${fmt(units, D.decimals, 2)} ${D.symbol} (health to ${(Number(hfBps) / 10_000).toFixed(2)})`);
    try {
      await signAction(pid, { type: "transfer_debt", amount: units.toString() }, `Move the borrowed ${D.symbol} to your ${net.evmName} wallet`);
    } catch (e) {
      if (!(e as any).refused) throw e;
      // under the trigger, the auction can open before this lands: from then on the contract signs
      // only repays and supplies, so the debt token stays in the position and is refunded when the rescue ends
      notice = `The auction opened before the borrowed ${fmt(units, D.decimals, 2)} ${D.symbol} left your position. While a rescue runs the contract only signs repays and supplies, so it stays there; the contract refunds it to your wallet when the rescue ends.`;
    }
  }
  /** "Push it under the trigger": borrow more (testnet), or withdraw a little collateral straight to the
   *  visitor's wallet (mainnet: one transaction, nothing left at the position for the rescue to hold). */
  async function pushUnder(pid: number) {
    if (net.pushBy === "borrow") return borrowTo(pid, net.pushHfBps, "Trigger");
    const p = await nearView<Position>("get_position", { position_id: pid });
    const d = await pub.readContract({ address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [p.evm_address as Address] });
    const pc = await pub.readContract({ address: net.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [C.address] });
    const u = withdrawUnits(d[0], d[1], d[3], net.pushHfBps, pc, C.decimals);
    if (u === 0n) return;
    await signAction(pid, { type: "withdraw", amount: { exact: u.toString() } }, `Withdraw ${fmt(u, C.decimals, 6)} ${C.symbol} to your wallet (health to ${(Number(net.pushHfBps) / 10_000).toFixed(2)})`);
  }
  /** Register a position for the connected NEAR account (its address is derived by NEAR's MPC network). */
  async function registerPosition(): Promise<Position> {
    try {
      localStorage.removeItem(KEY()); // the new position becomes the one this page follows
    } catch {
      /* ignore */
    }
    let p: Position | null = null;
    await stead("register_position", { market_id: net.market, payout: mode === "sponsored" ? SPONSOR_PAYOUT : evm }, `Register a position (its ${net.evmName} address is derived by NEAR's MPC network)`, 100n);
    for (let i = 0; i < 20 && !(p = await findPosition())?.evm_address; i++) await sleep(2000);
    if (!p?.evm_address) throw new Error("the new position didn't appear");
    forceNew = false;
    ownedAt = 0; // the list shows it on the next read
    lastRescue = null; // the new position has no rescue yet
    for (const t of txs) if (t.pos === undefined && /^Register a position/.test(t.label) && Date.now() - t.at < 10 * 60_000) t.pos = p.id;
    saveTxs();
    state = { ...(state as NonNullable<typeof state>), pos: p };
    return p;
  }
  /** Mainnet step 3: register (if needed), then each transfer on its own button. */
  const register = () =>
    run("Registering your position", async () => {
      stepNow = 3;
      await registerPosition();
    });
  const fundColl = () =>
    run(`Sending ${C.symbol} to your position`, async () => {
      stepNow = 3;
      const addr = state!.pos!.evm_address as Address;
      const held = await pub.readContract({ address: C.address, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (held < net.collateralUnits) await evmSend(`Send ${fmt(net.collateralUnits - held, C.decimals, 4)} ${C.symbol} to your position`, () => evmWallet().writeContract({ address: C.address, abi: erc20, functionName: "transfer", args: [addr, net.collateralUnits - held] }));
    });
  const fundGas = () =>
    run("Sending ETH to your position for its gas", async () => {
      stepNow = 3;
      const addr = state!.pos!.evm_address as Address;
      if ((await pub.getBalance({ address: addr })) < gas.txUpfrontWei) await evmSend(`Send ${fmt(net.positionGasWei, 18, 4)} ETH to your position for its gas`, () => evmWallet().sendTransaction({ to: addr, value: net.positionGasWei }));
    });
  const open = () =>
    run("Opening your position", async () => {
      stepNow = 4;
      receiptsAt = 0;
      let p = forceNew ? null : state?.pos ?? null;
      if (!p) p = await registerPosition();
      const addr = p.evm_address as Address;
      if (mode === "sponsored") {
        busy = "The sponsor sends your position its LINK and gas…";
        render();
        await sponsor("fund").catch((e) => {
          if (!/already done/.test((e as Error).message)) throw e;
        });
      }
      const held = await pub.readContract({ address: C.address, abi: erc20, functionName: "balanceOf", args: [addr] });
      const d0 = await pub.readContract({ address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [addr] });
      const COLLATERAL = net.collateralUnits;
      if (mode === "own" && d0[0] === 0n && held < COLLATERAL) await evmSend(`Send ${fmt(COLLATERAL - held, C.decimals, MAIN ? 4 : 0)} ${C.symbol} to your position`, () => evmWallet().writeContract({ address: C.address, abi: erc20, functionName: "transfer", args: [addr, COLLATERAL - held] }));
      // testnet sends the gas here; mainnet sent it in step 3 and tops it up only when low
      if (mode === "own" && (await pub.getBalance({ address: addr })) < (MAIN ? gas.txUpfrontWei : net.positionGasWei)) await evmSend(`Send ${fmt(net.positionGasWei, 18, 4)} ETH to your position for its gas`, () => evmWallet().sendTransaction({ to: addr, value: net.positionGasWei }));
      const allowance = (t: Address) => pub.readContract({ address: t, abi: erc20, functionName: "allowance", args: [addr, net.pool] });
      if ((await allowance(C.address)) < COLLATERAL) await signAction(p.id, { type: "approve", token: "collateral", amount: "max" }, `Let Aave take the position's ${C.symbol}`);
      if (d0[0] === 0n && net.readingBeforeSupply) {
        // a size cap is set: the contract checks the supply against a price reading of this position,
        // which the keeper asks for once it sees the position (a proven reading on mainnet)
        busy = "Waiting for the first proven reading of your position (the size cap needs a price before a supply)…";
        render();
        for (let i = 0; i < 60 && !(await nearView<Position>("get_position", { position_id: p.id })).health; i++) await sleep(5000);
        if (!(await nearView<Position>("get_position", { position_id: p.id })).health) throw new Error("no price reading for the position after 5 minutes: is the keeper running?");
      }
      if (d0[0] === 0n) await signAction(p.id, { type: "supply", amount: COLLATERAL.toString() }, `Supply ${fmt(COLLATERAL, C.decimals, 4)} ${C.symbol} on Aave`);
      // testnet: straight to 1.14, just under the 1.15 trigger (on mainnet a falling price would take it
      // there); mainnet: to 1.20, and step 5 pushes it under
      if (net.openHfBps < 11_500n) stepNow = 5;
      await borrowTo(p.id, net.openHfBps, "Open");
    });
  const trigger = () =>
    run("Triggering a rescue", async () => {
      stepNow = 5;
      await pushUnder(state!.pos!.id);
    });
  const tryBreak = (what: "withdraw" | "borrow") =>
    run(what === "withdraw" ? "Trying to withdraw" : "Trying to borrow", async () => {
      stepNow = 6;
      const a = what === "withdraw" ? { type: "withdraw", amount: { exact: net.breakWithdrawUnits.toString() } } : { type: "borrow", amount: net.breakBorrowUnits.toString() };
      await stead("sign_action", { position_id: state!.pos!.id, action: a, gas: gas.evmGas }, what === "withdraw" ? `Try to withdraw ${fmt(net.breakWithdrawUnits, C.decimals, 4)} ${C.symbol} while the claim is open` : `Try to borrow ${fmt(net.breakBorrowUnits, D.decimals, 4)} ${D.symbol} while the claim is open`).catch((e) => {
        if (!(e as any).refused) throw e;
      });
    });
  const buyBack = () =>
    run("Buying back", async () => {
      stepNow = 6;
      if (mode === "sponsored") return sponsor("buyback");
      const owed = state!.claims.filter((c) => c.status === "open").reduce((s, c) => s + BigInt(c.owed_units), 0n);
      const addr = state!.pos!.evm_address as Address;
      const held = await pub.readContract({ address: C.address, abi: erc20, functionName: "balanceOf", args: [addr] });
      const have = await pub.readContract({ address: C.address, abi: erc20, functionName: "balanceOf", args: [evm!] });
      if (owed > held && have < owed - held)
        throw new Error(`Buy-back not sent: your wallet holds ${fmt(have, C.decimals, 4)} ${C.symbol} and the buy-back needs ${fmt(owed - held, C.decimals, 6)}. Nothing was sent; if the window ends first, the claim owner settles at the oracle price.`);
      if (owed > held) await evmSend(`Pay exactly the ${fmt(owed - held, C.decimals, 6)} ${C.symbol} owed into your position`, () => evmWallet().writeContract({ address: C.address, abi: erc20, functionName: "transfer", args: [addr, owed - held] }));
    });
  const close = () =>
    run("Closing your position", async () => {
      stepNow = 7;
      const p = state!.pos!;
      const addr = p.evm_address as Address;
      // the contract refuses the borrower's requests while it still owes payouts (e.g. a refund): wait
      for (let i = 0; i < 60; i++) {
        const books = await nearView<{ outflows: unknown[] }>("get_books", { position_id: p.id });
        if (!books.outflows.length) break;
        busy = `Waiting for the contract to finish its ${books.outflows.length} queued payout${books.outflows.length > 1 ? "s" : ""} (the keeper relays them)…`;
        render();
        await sleep(5000);
      }
      if ((await pub.readContract({ address: D.address, abi: erc20, functionName: "allowance", args: [addr, net.pool] })) === 0n) await signAction(p.id, { type: "approve", token: "debt", amount: "max" }, `Let Aave take the ${D.symbol} repay`);
      const d = await pub.readContract({ address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [addr] });
      if (d[1] > 0n && mode === "sponsored") {
        await sponsor("repay").catch((e) => {
          if (!/already done|no debt/.test((e as Error).message)) throw e;
        });
        await signAction(p.id, { type: "repay", amount: "max" }, "Repay all the debt");
      } else if (d[1] > 0n) {
        const pd = await pub.readContract({ address: net.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [D.address] });
        const need = repayUnits(d[1], pd, D.decimals); // a little over the debt: interest keeps accruing
        const held = await pub.readContract({ address: D.address, abi: erc20, functionName: "balanceOf", args: [addr] });
        if (held < need) await evmSend(`Send ${fmt(need - held, D.decimals, 2)} ${D.symbol} to your position to repay`, () => evmWallet().writeContract({ address: D.address, abi: erc20, functionName: "transfer", args: [addr, need - held] }));
        await signAction(p.id, { type: "repay", amount: "max" }, "Repay all the debt");
      }
      const left = await pub.readContract({ address: D.address, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (left > 0n) await signAction(p.id, { type: "transfer_debt", amount: left.toString() }, `Return the unused ${D.symbol} to your wallet`);
      if ((await pub.readContract({ address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [addr] }))[0] > 0n) await signAction(p.id, { type: "withdraw", amount: "max" }, `Withdraw all the ${C.symbol} to your wallet`);
      // anything still at the position's address (e.g. debt tokens that arrived after the repay) goes home too
      const dust = await pub.readContract({ address: D.address, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (dust > 0n) await signAction(p.id, { type: "transfer_debt", amount: dust.toString() }, `Return the last ${D.symbol} to your wallet`);
    });

  // ── the page ──
  function stepHtml(n: number, title: string, done: boolean, active: boolean, body: string) {
    return `<li class="st-own-step${done ? " is-done" : active ? " is-now" : ""}"><span class="st-own-num" aria-hidden="true">${n}</span><div><h3>${title}${done ? '<span class="st-visually-hidden"> (done)</span>' : ""}</h3>${active || done ? `<div class="st-own-body">${body}</div>` : ""}</div></li>`;
  }
  /** Mainnet, step 6: the bids lowest first and the claims, read from the contract. */
  function ladderHtml(): string {
    const r = state?.rescue;
    if (!r) return "";
    const won = new Set(r.members.map((m) => m.steward));
    const bids = ladder(r)
      .map((b) => `<tr><td>${esc(b.steward.split(".")[0])}</td><td class="st-num-cell">${b.premium_bps} bps</td><td class="st-num-cell">${fmtUnits(b.amount_units, C.decimals, 6)} ${C.symbol}</td><td>${r.state !== "auction" && won.has(b.steward) ? "won" : r.state === "auction" ? "bidding" : ""}</td></tr>`)
      .join("");
    const claims = (state?.claims ?? [])
      .map((c) => `<tr><td class="st-mono">${esc(c.token_id)}</td><td>${esc(c.owner.split(".")[0])}</td><td class="st-num-cell">${fmtUnits(c.owed_units, C.decimals, 6)} ${C.symbol}</td><td>${esc(c.status.replace(/_/g, " "))}</td></tr>`)
      .join("");
    return `<div class="st-own-ladder">
      <div class="st-label">RESCUE #${r.id} · BIDS · LOWEST PREMIUM WINS · CAP ${r.cap_bps} BPS</div>
      ${bids ? `<table><thead><tr><th>Steward</th><th>Premium</th><th>Amount</th><th></th></tr></thead><tbody>${bids}</tbody></table>` : `<p class="st-own-hint">No bid yet: the stewards are pricing the top-up of ${fmtUnits(r.topup_units, C.decimals, 6)} ${C.symbol}.</p>`}
      ${claims ? `<div class="st-label">CLAIMS · OWED IN ${C.symbol}</div><table><thead><tr><th>Claim</th><th>Owner</th><th>Owed</th><th>Status</th></tr></thead><tbody>${claims}</tbody></table>` : ""}
      <p class="st-own-hint">Read from ${esc(net.contract)} every 3 seconds.</p>
    </div>`;
  }
  function render() {
    if (gone) return;
    const s = state;
    const pos = s?.pos ?? null;
    // a used position that is back to nothing on Aave: the run is complete (read from the chain, not
    // from this browser's saved transactions)
    const finished = !!pos && !!s && s.coll === 0n && s.debt === 0n && pos.next_nonce >= 3 && pos.pending === null && !pos.open_rescues.length && pos.active_auction === null;
    const opened = finished || (!!pos && s!.coll > 0n);
    const rescue = s?.rescue ?? null;
    const sponsored = mode === "sponsored";
    const COLLATERAL = net.collateralUnits;
    const BUYBACK_SPARE = 20n * 10n ** BigInt(C.decimals); // a buy-back pays back the top-up plus its premium, about 19 LINK here
    const owedNow = (s?.claims ?? []).filter((c) => c.status === "open").reduce((a, c) => a + BigInt(c.owed_units), 0n);
    const shortForBuyback = mode === "own" && rescue?.state === "open" && owedNow > 0n && s!.link < owedNow;
    const funded = !!s && (s.nearYocto ?? 0n) >= 20_000_000_000_000_000_000_000n && (sponsored || (s.eth >= 2_000_000_000_000_000n && (opened || s.link >= COLLATERAL)));
    const triggered = finished || (opened && (rescue !== null || (s!.hf !== null && s!.hf < 1.15)));
    const ended = finished || (opened && !rescue && s!.hf !== null && s!.hf >= 1.4); // after a rescue, health is back near 1.50
    const closed = finished;
    // mainnet: the allow-list, the size cap and the market check gate every action
    const limits = chainCfg?.limits ?? null;
    const allow = allowed(limits, near);
    const blocked = MAIN && (allow === "no" || mismatch.length > 0 || !chainCfg);
    const cap = capUsd(limits);
    const posFunded = !!pos && (opened || (!!s && s.posColl >= COLLATERAL && s.posEth >= gas.txUpfrontWei));
    const btn = (label: string, attr: string, primary = false, off = false) => `<button type="button" class="${primary ? "st-push" : "st-secondary"} st-cut" ${attr}${busy || off ? ' aria-disabled="true" disabled' : ""}>${primary ? '<span class="st-lamp" aria-hidden="true"></span>' : ""}${label}</button>`;
    // the buy-back window: the earliest open claim's expiry (ns → ms)
    const ends = (s?.claims ?? []).filter((c) => c.status === "open" && c.expires_at).map((c) => Number(BigInt(c.expires_at!) / 1_000_000n));
    const windowEnd = ends.length ? Math.min(...ends) : 0;
    const sentRow = (x: Sent, at: number): TxRow => ({ ...x, at, ok: true });
    const fromServer = (r: { at: number; sent: Sent[] } | null | undefined) => (r ? r.sent.map((x) => sentRow(x, r.at)) : []);
    const mine = (n: number) => shown().filter((t) => stepOfTx(t) === n && (t.hash || !t.ok));
    // the visitor's own record first; the server's for another device (or a cleared browser)
    const step3 = mine(3).length ? mine(3) : fromServer(receipts?.faucet);
    const step4 = [...mine(4), ...(mine(4).some((t) => /^Sponsor:/.test(t.label)) ? [] : fromServer(receipts?.fund))];
    const where = (t: TxRow) => (MAIN ? (t.chain === "near" ? "NEAR mainnet" : chainName(t)) : t.chain === "near" ? "NEAR" : "Sepolia");
    const chip = (t: TxRow) => !t.hash
      ? `<span class="st-own-chip is-refused" title="${esc(t.label)}"><span>${esc(shortLabel(t.label).replace(/ \(refused\)$/, ""))}</span><span class="st-own-chip-refused">${/refused by the contract/.test(t.label) ? "refused" : "failed"}</span><span class="st-own-chip-where">${where(t)} · no hash from the wallet</span></span>`
      : `<a class="st-own-chip${t.ok ? "" : " is-refused"}" href="${txHref(t)}" target="_blank" rel="noopener" title="${esc(t.label)}"><span>${esc(shortLabel(t.label).replace(/ \(refused\)$/, ""))}</span>${t.ok ? "" : `<span class="st-own-chip-refused">refused</span>`}<span class="st-own-chip-where">${where(t)}</span>${icon("external", 12)}</a>`;
    const receipt = (head: string, rows: TxRow[], more = "") => `<div class="st-own-receipt"><span class="st-own-receipt-head">${icon("check", 14)}${head}</span><div class="st-own-chips">${rows.map(chip).join("")}</div>${more}</div>`;
    const aaveLink = `<a class="st-textlink st-extlink" href="https://app.aave.com/?marketName=proto_mainnet_v3" target="_blank" rel="noopener">Open on Aave${icon("external", 12)}</a>`;
    const aaveNote = pos?.evm_address ? `${aaveLink}: Aave's app has no link that opens a given address, so choose <strong>Watch wallet</strong> in its connect menu and paste <button type="button" class="st-own-copy" data-copy="${pos.evm_address}">the position's address</button>.` : "";
    const posLinks = pos?.evm_address
      ? `<p class="st-own-hint">Your position <a class="st-textlink st-extlink" href="${net.evmAddress(pos.evm_address)}" target="_blank" rel="noopener"><span class="st-mono">${pos.evm_address.slice(0, 8)}…${pos.evm_address.slice(-6)}</span>${icon("external", 12)}</a> on Etherscan: its a${C.symbol} collateral and ${D.symbol} debt tokens. Aave says: ${fmt(s!.coll, 8, 2)} USD of collateral, ${fmt(s!.debt, 8, 2)} USD of debt, health ${s!.hf?.toFixed(2) ?? "n/a"}.${MAIN ? ` ${aaveNote}` : ` Position ${pos.id} on the <a class="st-textlink" href="#/positions">Positions</a> page.`}</p>`
      : "";
    const story = (rid: number, tail: string) => (net.storyContract ? `<a class="st-textlink" href="?rescue=${net.storyContract}:${rid}#/rescues">rescue #${rid}</a>${tail}` : "");
    const auctionS = chainCfg?.params ? Number(BigInt(chainCfg.params.auction_window_ns) / 1_000_000_000n) : net.auctionS;

    // ── steps 1 to 4: testnet (faucet or sponsor) and mainnet (your own Ethereum wallet) differ ──
    let first: string[];
    if (!MAIN) {
      first = [
        stepHtml(1, "Connect a NEAR testnet wallet", !!near, !near, near ? `Connected as <strong>${esc(near)}</strong>${s?.nearYocto != null ? ` · ${fmt(s.nearYocto, 24, 3)} NEAR` : ""}${s?.nearYocto != null && s.nearYocto < 10_000_000_000_000_000_000_000n ? ` · <span class="st-own-warn">your account needs a little testnet NEAR to sign: get 10 from <a class="st-textlink" href="https://near-faucet.io" target="_blank" rel="noopener">a NEAR testnet faucet</a></span>` : ""}` : `<p>Your NEAR account owns the position and signs its Stead calls. Any NEAR wallet with testnet works (Meteor, Intear, Nightly, Ledger, NEAR CLI and more). Connecting adds a limited key for the Stead contract only, so the calls below need few approvals.</p><div class="st-own-buttons">${btn("Connect NEAR wallet", "data-near", true)}</div>`),
        stepHtml(2, "Sepolia side: your wallet, or ours", !!mode, !!near && !mode, mode === "own" && evm ? `Your Sepolia wallet <span class="st-mono">${evm.slice(0, 8)}…${evm.slice(-6)}</span> <button type="button" class="st-own-x" data-evm-off title="Disconnect this Sepolia wallet" aria-label="Disconnect this Sepolia wallet"${busy ? " disabled" : ""}>${icon("close", 12)}</button>${s ? ` · ${fmt(s.eth, 18, 4)} ETH · ${fmt(s.link, 18, 2)} LINK · ${fmt(s.dai, 18, 2)} DAI` : ""}` : mode === "sponsored" ? `NEAR only: the sponsor holds the Sepolia side. Your position's payout is the sponsor's address; it funds the position and pays the buy-back when you ask.` : `<p>The position's money lives on Sepolia. <strong>Only a NEAR wallet?</strong> Let the sponsor hold the Sepolia side: it funds your position and pays the buy-back when you ask; test funds go back to it at the end. <strong>Have a Sepolia wallet?</strong> Use it: you fund the position and get everything back.</p><div class="st-own-buttons">${btn("Only NEAR: sponsor the Sepolia side", "data-sponsored", true)}${btn("Use my Sepolia wallet", "data-evm")}</div>`),
        stepHtml(3, "Get test funds", funded || sponsored, mode === "own" && !funded && !opened, funded
          ? step3.length
            ? receipt("Completed", step3)
            : mode === "own" && !opened && s!.link < COLLATERAL + BUYBACK_SPARE
              ? `<p>Your wallets hold enough to open the position (${fmt(COLLATERAL, C.decimals, 0)} ${C.symbol}). <span class="st-own-warn">To buy the rescue back you'll also need about ${fmt(BUYBACK_SPARE, C.decimals, 0)} ${C.symbol} more in your wallet</span> (you hold ${fmt(s!.link, C.decimals, 2)}).</p><div class="st-own-buttons">${btn("Send me test funds", "data-faucet")}</div>`
              : `<p>Your wallets already hold what the run needs.</p>`
          : `<p>You need about 0.03 NEAR, 0.002 Sepolia ETH and 60 LINK (+20 LINK if you buy back). We sponsor one set per wallet per day: 0.04 NEAR, 0.0025 Sepolia ETH, 80 LINK and 5 DAI.</p><div class="st-own-buttons">${btn("Send me test funds", "data-faucet", true)}</div>`),
        stepHtml(4, "Open your protected position", opened, (sponsored ? !!near : funded) && !opened, opened
          ? receipt("Opened", step4, posLinks)
          : `<p>Registers a position on the demo contract; its Sepolia address is derived by NEAR's MPC network, and only the contract can sign for it. Then 60 LINK goes in${sponsored ? " (from the sponsor)" : ""}, the contract supplies it on Aave and borrows DAI straight to a health factor of 1.14, just under Stead's 1.15 trigger: on mainnet a falling price would take it there. <strong>About 3 minutes</strong>${sponsored ? "; every step is a Stead call from your NEAR wallet" : "; two Sepolia confirmations in your wallet, the rest are Stead calls"}. The rescue starts on its own.</p>${pos && !opened ? `<p class="st-own-hint">Position ${pos.id} is registered; opening it again picks up where it stopped.</p>` : ""}<div class="st-own-buttons">${btn(pos ? "Continue opening my position" : "Open my position", "data-open", true)}</div>`),
      ];
    } else {
      const borrowers = limits?.borrowers.length ? limits.borrowers.map((b) => `<strong>${esc(b)}</strong>`).join(", ") : "";
      const allowLine =
        allow === "no"
          ? `<p class="st-own-stop" role="alert"><strong>${esc(near!)}</strong> is not on this contract's borrower allow-list, so the contract refuses to register a position for it. Allowed: ${borrowers}. Connect that account instead (the NEAR button in the sidebar disconnects with a second click).</p>`
          : allow === "yes" && limits?.borrowers.length ? ` · on the contract's borrower allow-list` : "";
      const lowNear = s?.nearYocto != null && s.nearYocto < 50_000_000_000_000_000_000_000n ? ` · <span class="st-own-warn">your account needs a little NEAR to sign (0.05 is plenty)</span>` : "";
      const usd = (base: bigint) => "$" + (Number(base) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 });
      const collUsd = collPrice ? valueBase(COLLATERAL, collPrice, C.decimals) : 0n;
      const capLine = collPrice ? `${fmt(COLLATERAL, C.decimals, 4)} ${C.symbol} is ${usd(collUsd)} at Aave's oracle price${cap ? `, ${collUsd <= BigInt(cap) * 10n ** 8n ? "under" : "<strong>over</strong>"} the contract's $${cap} cap` : ""}.` : "";
      const needs = s ? walletNeeds(net, { eth: s.eth, coll: s.link, debt: s.dai }, { buyBackUnits: (COLLATERAL * 3n) / 10n, ownGasWei: 10n ** 15n, repayMarginUnits: 2n * 10n ** 6n }) : [];
      const needsTable = needs.length
        ? `<table class="st-own-needs"><thead><tr><th>Your wallet</th><th>Needs</th><th>Holds</th><th>For</th></tr></thead><tbody>${needs
            .map((n) => `<tr><td>${n.symbol}</td><td class="st-num-cell">${fmt(n.need, n.decimals, n.decimals === 6 ? 2 : 4)}</td><td class="st-num-cell">${fmt(n.have, n.decimals, n.decimals === 6 ? 2 : 4)}${isShort(n) ? ` <strong class="st-own-short">short</strong>` : ""}</td><td>${n.note}</td></tr>`)
            .join("")}</tbody></table>`
        : "";
      const posAddr = pos?.evm_address ?? null;
      const fundRows = posAddr && s
        ? `<p class="st-own-addr">Your position's address: <a class="st-textlink st-extlink" href="${net.evmAddress(posAddr)}" target="_blank" rel="noopener"><span class="st-mono">${posAddr}</span>${icon("external", 12)}</a></p>
          <table class="st-own-needs"><thead><tr><th>Position</th><th>Needs</th><th>Holds</th><th></th></tr></thead><tbody>
            <tr><td>${C.symbol}</td><td class="st-num-cell">${fmt(COLLATERAL, C.decimals, 4)}</td><td class="st-num-cell">${fmt(s.posColl, C.decimals, 6)}</td><td>${s.posColl >= COLLATERAL ? "received" : btn(`Send ${fmt(COLLATERAL - s.posColl, C.decimals, 4)} ${C.symbol} to your position`, "data-fund-coll", true, blocked || !evm)}</td></tr>
            <tr><td>ETH</td><td class="st-num-cell">${fmt(gas.txUpfrontWei, 18, 6)}</td><td class="st-num-cell">${fmt(s.posEth, 18, 6)}</td><td>${s.posEth >= gas.txUpfrontWei ? "received" : btn(`Send ${fmt(net.positionGasWei, 18, 4)} ETH for its gas`, "data-fund-gas", !(s.posColl < COLLATERAL), blocked || !evm)}</td></tr>
          </tbody></table>
          <p class="st-own-hint">The ETH pays the position's own transactions: each one the contract signs may cost at most ${Number(gas.evmGas.gas_limit).toLocaleString("en-US")} gas at ${fmt(BigInt(gas.evmGas.max_fee_per_gas), 9, 2)} gwei (${fmt(gas.txUpfrontWei, 18, 6)} ETH, which Ethereum wants available up front); the real cost is far lower. Balances re-read every 8 seconds. ${aaveNote}</p>`
        : "";
      first = [
        stepHtml(1, "Connect a NEAR mainnet wallet", !!near && allow !== "no", !near || allow === "no", near
          ? `Connected as <strong>${esc(near)}</strong>${s?.nearYocto != null ? ` · ${fmt(s.nearYocto, 24, 3)} NEAR` : ""}${lowNear}${allowLine}`
          : `<p>Your NEAR account owns the position and signs its Stead calls, on NEAR mainnet. Any NEAR wallet works (Meteor, Intear, HOT, Nightly, Ledger and more). Connecting adds a limited key for ${esc(net.contract)} only, so the calls below need few approvals.${borrowers ? ` This contract is capped: only ${borrowers} may register a position.` : ""}</p><div class="st-own-buttons">${btn("Connect NEAR wallet", "data-near", true)}</div>`),
        stepHtml(2, "Connect your Ethereum wallet", !!evm, !!near && allow !== "no" && !evm, evm
          ? `Your Ethereum wallet <span class="st-mono">${evm.slice(0, 8)}…${evm.slice(-6)}</span> <button type="button" class="st-own-x" data-evm-off title="Disconnect this Ethereum wallet" aria-label="Disconnect this Ethereum wallet"${busy ? " disabled" : ""}>${icon("close", 12)}</button>${s ? ` · ${fmt(s.eth, 18, 4)} ETH · ${fmt(s.link, C.decimals, 4)} ${C.symbol} · ${fmt(s.dai, D.decimals, 2)} ${D.symbol}` : ""}${pos && pos.payout.toLowerCase() !== evm.toLowerCase() ? `<p class="st-own-stop">Position ${pos.id} pays out to <span class="st-mono">${esc(pos.payout)}</span>, not this wallet: withdrawals and refunds go there.</p>` : ""}`
          : `<p>The position's money lives on Ethereum mainnet and comes from your own wallet (MetaMask or another injected wallet): you fund the position, and everything comes back to this wallet at the end; it becomes the position's payout address when you register. There is no faucet and no sponsor on mainnet.</p><div class="st-own-buttons">${btn("Connect Ethereum wallet", "data-evm", true)}</div>`),
        stepHtml(3, "Register and fund your position", posFunded, !!near && !!evm && !posFunded, posFunded
          ? receipt("Registered and funded", mine(3))
          : `<p>${pos ? `Position ${pos.id} is registered on ${esc(net.contract)}. Send it the ${C.symbol} it will supply and a little ETH for its own gas, from your wallet:` : `Registers a position on ${esc(net.contract)}: its Ethereum address is derived by NEAR's MPC network, and only the contract can sign for it. Your wallet becomes its payout. Then you send the position ${fmt(COLLATERAL, C.decimals, 4)} ${C.symbol} and ${fmt(net.positionGasWei, 18, 4)} ETH for its gas, each with its own button.`} ${capLine}</p>
            ${pos ? fundRows : `${needsTable}<div class="st-own-buttons">${btn("Register a position", "data-register", true, blocked || !evm)}</div>`}`),
        stepHtml(4, "Open your protected position", opened, posFunded && !opened, opened
          ? receipt("Opened", mine(4), posLinks)
          : `<p>Four Stead calls from your NEAR wallet, each signed by the contract through NEAR's chain signatures and sent to Ethereum by the keeper: let Aave take the position's ${C.symbol}, wait for the first proven reading of the position (the $${cap || 150} cap needs a price before a supply), supply ${fmt(COLLATERAL, C.decimals, 4)} ${C.symbol}, borrow ${D.symbol} to a health factor of ${(Number(net.openHfBps) / 10_000).toFixed(2)} and move the ${D.symbol} to your wallet. <strong>About 3 to 5 minutes.</strong></p><div class="st-own-buttons">${btn("Open my position", "data-open", true, blocked)}</div>`),
      ];
    }
    const steps = [
      ...first,
      stepHtml(5, "Push it under the trigger", triggered || ended, opened && !triggered && !ended, triggered || ended
        ? mine(5).length
          ? receipt("Under the trigger", mine(5))
          : `<p>Done (health under 1.15).</p>`
        : MAIN
          ? `<p>On a live market a falling ${C.symbol === "WETH" ? "ETH" : C.symbol} price does this. To see a rescue now, the contract withdraws about 5% of the ${C.symbol} from Aave straight to your wallet, taking the health factor to ${(Number(net.pushHfBps) / 10_000).toFixed(2)}: under Stead's 1.15 trigger. A proven reading then opens a real auction among the stewards (${auctionS} seconds).</p><div class="st-own-buttons">${btn(`Withdraw to ${(Number(net.pushHfBps) / 10_000).toFixed(2)}`, "data-trigger", true, blocked)}</div>`
          : `<p>On mainnet a falling price does this; on Sepolia prices are fixed, so you borrow a little more, to a health factor of 1.14: under Stead's 1.15 trigger. The keeper's proven reading then opens a real auction among the stewards.</p><div class="st-own-buttons">${btn("Borrow to 1.14", "data-trigger", true)}</div>`),
      stepHtml(6, "Watch your rescue, try to break it, choose the ending", ended, triggered && !ended, `${rescue ? `<p>Rescue <strong>#${rescue.id}</strong>: ${esc(rescue.state.replace(/_/g, " "))}. ${rescueText(rescue.state, auctionS)}${rescue.state === "open" && windowEnd ? ` <strong class="st-own-countdown" data-countdown="${windowEnd}">${countdown(windowEnd)}</strong> left to buy back.` : ""}</p>` : `<p>Waiting for the proven reading to open the auction (30 to 60 seconds).</p>`}
        ${shortForBuyback ? `<p class="st-own-warn">Your wallet holds ${fmt(s!.link, C.decimals, 4)} ${C.symbol}; the buy-back needs ${fmt(owedNow, C.decimals, 6)}. Get ${C.symbol} first (test funds, once a day), or let the window end: the claim owner then settles at the oracle price, never worse for you than a liquidation.</p>` : ""}
        <div class="st-own-buttons">${rescue?.state === "open" ? btn("Buy back now", "data-buyback", true, shortForBuyback) : ""}${shortForBuyback && net.faucet ? btn("Send me test funds", "data-faucet") : ""}${rescue ? btn(`Try to withdraw ${fmt(net.breakWithdrawUnits, C.decimals, 4)} ${C.symbol}`, 'data-break="withdraw"') + btn(`Try to borrow ${fmt(net.breakBorrowUnits, D.decimals, 4)} ${D.symbol}`, 'data-break="borrow"') : ""}</div>
        ${mine(6).length ? `<div class="st-own-receipt"><span class="st-own-receipt-head">Your requests during the rescue</span><div class="st-own-chips">${mine(6).map(chip).join("")}</div></div>` : ""}
        ${net.liveFeed ? `<p class="st-own-hint">The full live board for your position is below.</p>` : `<div data-own-ladder>${ladderHtml()}</div>`}`),
      stepHtml(7, "Close and get everything back", closed, ended && !closed, closed
        ? receipt("Closed: everything is back in your wallets", mine(7), lastRescue !== null && net.storyContract ? `<p class="st-own-hint">Your rescue's full story, every step with its transaction: ${story(lastRescue, ".")}</p>` : "")
        : `<p>Repay the debt from your ${D.symbol}, then withdraw all the ${C.symbol} to your ${net.evmName} wallet. <strong>About 2 minutes.</strong>${lastRescue !== null && net.storyContract ? ` Your rescue's full story, every step with its transaction: ${story(lastRescue, " (it appears a few minutes after the rescue ends).")}` : ""}</p><div class="st-own-buttons">${btn("Close my position", "data-close", true)}</div>`),
    ];
    // the network switch: a full page load each way, so wallets and saved state start clean
    const netSwitch = `<nav class="st-own-net" aria-label="Network">
        <div class="st-own-netseg"><a href="${location.pathname}#/try"${MAIN ? "" : ' aria-current="page"'}>TESTNET</a><a href="${location.pathname}?net=mainnet#/try"${MAIN ? ' aria-current="page"' : ""}>MAINNET · REAL FUNDS</a></div>
      </nav>`;
    const params = chainCfg?.params;
    const secs = (ns: string | undefined) => (ns ? `${Number(BigInt(ns) / 1_000_000_000n)} s` : "…");
    const addr = (label: string, a: string) => `<a class="st-textlink st-extlink" href="https://etherscan.io/address/${a}" target="_blank" rel="noopener">${label} <span class="st-mono">${a.slice(0, 6)}…${a.slice(-4)}</span>${icon("external", 11)}</a>`;
    const realBanner = MAIN
      ? `<div class="st-own-real" role="note"><p class="st-own-real-head">Ethereum mainnet · real funds · capped at $${cap || 150}</p>
          <p>Every transaction here moves real ${C.symbol}, ${D.symbol} and ETH on Ethereum and real NEAR. The contract caps each position at $${cap || 150} of collateral and lets only its allow-listed borrower open one.</p>
          ${mismatch.length ? `<p class="st-own-stop" role="alert">The contract's market ${net.market} does not match this page (${esc(mismatch.join(", "))}): every action is off.</p>` : ""}
          <dl class="st-own-cfg">
            <div><dt>CONTRACT</dt><dd><a class="st-textlink st-extlink" href="https://nearblocks.io/address/${net.contract}" target="_blank" rel="noopener">${esc(net.contract)}${icon("external", 11)}</a></dd></div>
            <div><dt>MARKET ${net.market}</dt><dd>${C.symbol} / ${D.symbol} on Aave V3 Ethereum${chainCfg?.market ? ` · liquidation threshold ${chainCfg.market.lt_bps / 100}% · bonus ${chainCfg.market.liq_bonus_bps / 100}%` : ""}</dd></div>
            <div><dt>RULES</dt><dd>${params ? `trigger ${(params.trigger_hf_bps / 10_000).toFixed(2)} · target ${(params.target_hf_bps / 10_000).toFixed(2)} · auction ${secs(params.auction_window_ns)} · top-up deadline ${secs(params.topup_deadline_ns)} · buy-back window ${secs(params.buyback_window_ns)}` : "reading…"}</dd></div>
            <div><dt>LIMITS</dt><dd>${limits ? `$${cap} of collateral per position · borrowers: ${limits.borrowers.map(esc).join(", ") || "anyone"}` : "reading…"}</dd></div>
            <div><dt>SIGNED-TX GAS</dt><dd>${chainCfg?.market ? `up to ${Number(gas.evmGas.gas_limit).toLocaleString("en-US")} gas at ${fmt(BigInt(gas.evmGas.max_fee_per_gas), 9, 2)} gwei max` : "reading…"}</dd></div>
            <div><dt>YOU NEED</dt><dd>in your Ethereum wallet: ${fmt(net.collateralUnits, C.decimals, 4)} ${C.symbol} (about ${fmt((net.collateralUnits * 3n) / 10n, C.decimals, 4)} more to buy the rescue back), about 0.002 ETH (${fmt(net.positionGasWei, 18, 4)} of it for the position's gas) and 2 ${D.symbol} for the repay margin; about 0.05 NEAR in your NEAR account</dd></div>
            <div><dt>SIGNED BY YOU</dt><dd>NEAR: register, then one Stead call per Aave step (about 10). Ethereum: ${C.symbol} and ETH to the position, the buy-back payment, the ${D.symbol} for the repay</dd></div>
            <div><dt>ADDRESSES</dt><dd>${addr("Pool", net.pool)} · ${addr(C.symbol, C.address)} · ${addr(D.symbol, D.address)} · ${addr("Oracle", net.oracle)}</dd></div>
          </dl>
          <p class="st-own-hint">Read from ${esc(net.contract)} on NEAR mainnet and from Ethereum. The rescue below is read straight from the contract.</p></div>`
      : "";
    main.innerHTML = `
      <section class="st-panel st-sect st-own${MAIN ? " is-mainnet" : ""}">
        ${MAIN
          ? `<header class="st-list-head"><div class="st-label">PROTECT AN AAVE POSITION · NEAR MAINNET AND ETHEREUM</div><h1 class="st-page-title">Protect an Aave position, then watch it get rescued</h1>
          <p class="st-list-sub">A protected position is an Aave position at an address only the Stead contract can sign for, through NEAR's chain signatures; your NEAR account owns it. When its health falls below 1.15, stewards compete to top it up, and you buy the rescue back. This is Ethereum mainnet: you fund the position from your own wallet, and everything comes back to it at the end. About 15 minutes in all: each Aave step waits for an Ethereum block and a proof.</p></header>`
          : `<header class="st-list-head"><div class="st-label">PROTECT AN AAVE POSITION · NEAR TESTNET AND SEPOLIA</div><h1 class="st-page-title">Protect an Aave position, then watch it get rescued</h1>
          <p class="st-list-sub">A protected position is an Aave position at an address only the Stead contract can sign for, through NEAR's chain signatures; your NEAR account owns it. When its health falls below 1.15, stewards compete to top it up, and you buy the rescue back. Everything below is real, on testnets; Sepolia's prices don't move, so opening borrows straight under the trigger. About 12 minutes in all: each Aave step waits for a Sepolia block and a proof.</p></header>`}
        ${netSwitch}
        ${realBanner}
        <section class="st-own-live" data-own-live aria-label="What is happening now" role="status">${panelHtml()}</section>
        <div data-own-activity>${lastActivity}</div>
        ${notice ? `<p class="st-own-notice" role="status">${esc(notice)}</p>` : ""}
        ${error ? `<p class="st-own-error" role="alert">${esc(error)}</p>` : ""}
        ${finished && pos ? `<div class="st-own-done"><p><strong>Run complete.</strong> Position ${pos.id} is closed on Aave${lastRescue !== null && net.storyContract ? `; ${story(lastRescue, " has its full story")}` : ""}. Its receipts stay below.</p><div class="st-own-buttons">${btn("Protect a new position", "data-new", true, blocked)}</div></div>` : ""}
        ${ownedHtml(pos?.id ?? null)}
        <ol class="st-own-steps">${steps.join("")}</ol>
        ${near && shown().length ? `<div class="st-label st-runlog-head">YOUR TRANSACTIONS · POSITION ${state?.pos?.id ?? ""}${MAIN ? " · MAINNET" : ""}</div><ol class="st-runlog">${shown()
          .slice()
          .reverse()
          .slice(0, showAllTxs ? undefined : 3)
          .map((t) => `<li><span class="st-runlog-time">${new Date(t.at).toISOString().slice(11, 19)}</span><span class="st-runlog-label">${esc(t.label)}</span>${t.hash ? `<a class="st-txlink" href="${txHref(t)}" target="_blank" rel="noopener"><span>${t.chain === "near" ? "NearBlocks" : "Etherscan"}</span><span class="st-txlink-where">${t.hash.slice(0, 8)}…</span>${icon("external", 12)}</a>` : ""}</li>`)
          .join("")}</ol>${shown().length > 3 ? `<button type="button" class="st-secondary st-cut st-own-more" data-more-txs>${showAllTxs ? "Show the latest 3" : `See all ${shown().length}`}</button>` : ""}` : ""}
      </section>`;
    main.querySelector("[data-near]")?.addEventListener("click", () => run("Connecting your NEAR wallet", async () => {
      near = await connectNear();
      loadTxs();
    }));
    main.querySelector("[data-sponsored]")?.addEventListener("click", () => {
      setMode("sponsored");
      render();
    });
    main.querySelector("[data-evm]")?.addEventListener("click", () => run(`Connecting your ${net.evmName} wallet`, connectEvm));
    main.querySelector("[data-faucet]")?.addEventListener("click", faucet);
    main.querySelector("[data-evm-off]")?.addEventListener("click", () => void disconnectEvm());
    main.querySelector("[data-more-txs]")?.addEventListener("click", () => {
      showAllTxs = !showAllTxs;
      render();
    });
    main.querySelector("[data-open]")?.addEventListener("click", open);
    main.querySelector("[data-register]")?.addEventListener("click", register);
    main.querySelector("[data-fund-coll]")?.addEventListener("click", fundColl);
    main.querySelector("[data-fund-gas]")?.addEventListener("click", fundGas);
    main.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) =>
      b.addEventListener("click", () => {
        void navigator.clipboard?.writeText(b.dataset.copy!).then(
          () => (b.textContent = "the position's address (copied)"),
          () => undefined,
        );
      }),
    );
    main.querySelector("[data-new]")?.addEventListener("click", () => {
      forceNew = true;
      // mainnet registers in step 3 (then each transfer has its own button); testnet opens in one go
      if (MAIN)
        void run("Registering your position", async () => {
          stepNow = 3;
          await registerPosition();
        });
      else open();
    });
    main.querySelectorAll<HTMLButtonElement>("[data-pick-pos]").forEach((b) => b.addEventListener("click", () => follow(Number(b.dataset.pickPos))));
    main.querySelector("[data-new-pos]")?.addEventListener("click", () => follow(null));
    main.querySelector("[data-pick-back]")?.addEventListener("click", () => {
      forceNew = false;
      follow(owned?.[0]?.id ?? null);
    });
    main.querySelector("[data-trigger]")?.addEventListener("click", trigger);
    main.querySelector("[data-buyback]")?.addEventListener("click", buyBack);
    main.querySelector("[data-close]")?.addEventListener("click", close);
    main.querySelectorAll<HTMLButtonElement>("[data-break]").forEach((b) => b.addEventListener("click", () => tryBreak(b.dataset.break as "withdraw" | "borrow")));
    // the live board for this position while a rescue runs: mounted once, not on every refresh
    const show = net.liveFeed && !!pos && triggered && !ended;
    // and the compact live panel in step 6: its own poll while the rescue runs (testnet: the live
    // feed every 2.5 s; mainnet: the contract itself every 3 s)
    const following = !!pos && !finished;
    if (following && net.liveFeed && !livePoll) {
      const poll = async () => {
        try {
          const r = await fetch(`${feedUrl()}/live.json`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
          const j = (await r.json()) as { rescues: FeedRescue[] };
          const mine = j.rescues.filter((x) => x.contract === net.contract && x.positionId === state?.pos?.id).sort((a, b) => b.rescueId - a.rescueId)[0] ?? null;
          const changed = JSON.stringify(mine?.events.length) !== JSON.stringify(live?.events.length) || mine?.contractState !== live?.contractState;
          live = mine;
          const el = root.querySelector<HTMLElement>("[data-own-live]");
          if (el) el.innerHTML = panelHtml();
          const act = root.querySelector<HTMLElement>("[data-own-activity]");
          if (act) act.innerHTML = lastActivity;
          // a step changed on chain: re-read the page's state at once (no reload needed)
          if (changed && !busy) void refresh();
        } catch {
          /* the next poll tries again */
        }
      };
      void poll();
      livePoll = window.setInterval(poll, 2500);
    } else if (!following && livePoll) {
      clearInterval(livePoll);
      livePoll = 0;
    }
    // mainnet polls the contract only while a rescue may be running (pushed under, not yet ended)
    const watching = !net.liveFeed && following && opened && triggered && !ended;
    if (watching && !directPoll) directPoll = window.setInterval(() => void pollDirect(), 3000);
    else if (!watching && directPoll) {
      clearInterval(directPoll);
      directPoll = 0;
    }
    boardHost.hidden = !show;
    if (show && boardFor !== pos!.id) {
      stopBoard();
      boardFor = pos!.id;
      stopBoard = mountLive(boardHost, () => {}, "live", (r) => r.contract === net.contract && r.positionId === pos!.id);
    } else if (!show && boardFor !== null) {
      stopBoard();
      boardFor = null;
    }
  }

  void (async () => {
    main.innerHTML = `<section class="st-panel st-page"><div class="st-label">PROTECT AN AAVE POSITION${MAIN ? " · MAINNET" : ""}</div><p class="st-empty">Loading the wallets…</p></section>`;
    await initNear().catch((e) => (error = `NEAR wallets could not load (${(e as Error).message}).`));
    const eth = (window as any).ethereum;
    if (eth && !evmOff()) {
      const accts: string[] = await eth.request({ method: "eth_accounts" }).catch(() => []);
      if (accts[0]) evm = accts[0] as Address;
    }
    // mainnet has one path: the visitor's own Ethereum wallet
    if (!net.sponsor) mode = evm ? "own" : null;
    await refresh();
  })();
  const timer = window.setInterval(() => !busy && void refresh(), 8000);
  // the buy-back countdown ticks every second between refreshes
  const tick = window.setInterval(() => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-countdown]")) el.textContent = countdown(Number(el.dataset.countdown));
    for (const el of root.querySelectorAll<HTMLElement>("[data-elapsed]")) el.textContent = elapsed(Number(el.dataset.elapsed));
  }, 1000);
  return () => {
    gone = true;
    clearInterval(timer);
    if (livePoll) clearInterval(livePoll);
    if (directPoll) clearInterval(directPoll);
    clearInterval(tick);
    stopBoard();
    stopNear();
    // the rest of the site stays on testnet
    setNearNetwork("testnet");
  };
}

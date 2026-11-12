// "Protect an Aave position": a visitor opens a protected Aave position with their own wallets, then
// pushes it under the trigger and watches a real Stead rescue (NEAR testnet +
// Sepolia), on the demo contract (3-minute buy-back window, so both endings fit in one sitting).
// Every step is chosen from chain state, so a reload picks up where it was; every transaction the
// visitor signs is listed with its link. Nothing here holds a key: the wallets sign.
import { connectNear, nearAccount, onNearAccount, steadCall } from "../wallet/near";
import { createPublicClient, createWalletClient, custom, fallback, http, parseAbi, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { icon } from "../icons";
import { mountLive } from "../board/live";
import type { FeedRescue } from "../../../stewards/src/livefeed";

const CONTRACT = "sepolia-demo.steadfi.testnet";
const MARKET = 1;
const NEAR_RPC = "https://test.rpc.fastnear.com";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const POOL: Address = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
const ORACLE: Address = "0x2da88497588bf89281816106C7259e31AF45a663";
const LINK: Address = "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5";
const DAI: Address = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";
const E18 = 10n ** 18n;
/** NEAR-only visitors: the sponsor's Sepolia address is the position's payout (it holds the Sepolia side). */
const SPONSOR_PAYOUT: Address = "0xA57b528591700bB77992D095258eF6F921CDAD68";
/** The position's size: 60 LINK; it opens at health 1.20 and is triggered at 1.14. */
const COLLATERAL = 60n * E18;
const POSITION_GAS_WEI = 1_500_000_000_000_000n; // 0.0015 ETH: one signed tx's maximum fee up front, plus spend
const EVM_GAS = { gas_limit: "600000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "100000000" };
const TX_UPFRONT_WEI = 600_000n * 2_000_000_000n; // what the RPC wants available before it sends a signed tx
const GAS_TOPUP_WEI = 2_000_000_000_000_000n;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const poolAbi = parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
// two public Sepolia RPCs that answer browsers: if one refuses or stalls, the other answers
const pub = createPublicClient({ chain: sepolia, transport: fallback([http(SEPOLIA_RPC, { timeout: 8000 }), http("https://rpc.sepolia.ethpandaops.io", { timeout: 8000 })]) });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: bigint, dec = 18, dp = 4) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dp });
const feedUrl = () => (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// FastNEAR's free tier rate-limits bursts, and its 429 carries no CORS header, so the browser only
// says "Failed to fetch": on any transport failure, try NEAR's own public RPC, then wait and retry.
const NEAR_RPCS = [NEAR_RPC, "https://rpc.testnet.near.org"];
async function nearQuery(params: object): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of NEAR_RPCS) {
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
  const j = await nearQuery({ request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) });
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
  if (recordsCache && Date.now() - recordsAt < 60_000) return recordsCache;
  try {
    const r = await fetch(`${feedUrl()}/records.json`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    recordsCache = (j.positions as { contract: string; id: number; owner: string }[]).filter((p) => p.contract === CONTRACT).map(({ id, owner }) => ({ id, owner }));
    lastRescueOf.clear();
    for (const r of j.rescues as { contract: string; id: number; positionId: number }[]) if (r.contract === CONTRACT && r.id > (lastRescueOf.get(r.positionId) ?? -1)) lastRescueOf.set(r.positionId, r.id);
    recordsAt = Date.now();
  } catch {
    /* the feed is down: the caller falls back to the contract */
  }
  return recordsCache;
}

type Position = { id: number; owner: string; evm_address: string | null; payout: string; next_nonce: number; pending: unknown; active_auction: number | null; open_rescues: number[] };
type Rescue = { id: number; state: string; members: { steward: string; claim_id: string | null }[] };
type Claim = { token_id: string; owed_units: string; status: string; expires_at?: string };
type TxRow = { at: number; label: string; chain: "near" | "sepolia"; hash: string; ok: boolean; note?: string; step?: number };
type Sent = { label: string; chain: "near" | "sepolia"; hash: string };
type Receipts = { faucet: { at: number; sent: Sent[] } | null; fund: { at: number; sent: Sent[] } | null };
/** Which step a transaction belongs to (rows saved before steps were recorded: by their label). */
const stepOfTx = (t: TxRow) => t.step ?? (/^Test funds:/.test(t.label) ? 3 : /^(Register a position|Sponsor: .*(NEAR to|for its gas|into your position \(Aave))/.test(t.label) ? 4 : 0);
/** "Test funds: 0.0025 Sepolia ETH" → "0.0025 ETH"; "Supply 60 LINK on Aave (the contract…)" → "Supply 60 LINK on Aave". */
/** One line per step of the rescue, as it happens (from the live feed). */
function liveLine(e: FeedRescue["events"][number]): string | null {
  const x = e as any;
  switch (e.kind) {
    case "TRIGGER": return `Proven: health ${Number(x.hf).toFixed(3)}, under 1.15`;
    case "AUCTION_OPEN": return `Auction open: ${x.topUp.amount} ${x.topUp.asset} needed, premium cap ${x.capBps} bps`;
    case "BID": return `<strong>${x.steward}</strong> bids ${x.bps} bps for ${Number(x.amount).toFixed(2)}`;
    case "AUCTION_CLOSE": return `Auction closed: ${x.winners.map((w: any) => `<strong>${w.steward}</strong> at ${w.bps} bps`).join(", ") || "no winner"}`;
    case "TOPUP_SENT": return `<strong>${x.steward}</strong> tops up ${Number(x.amount).toFixed(2)} ${x.asset} on Aave`;
    case "TOPUP_CONFIRMED": return `Top-up proven on Sepolia`;
    case "CLAIM_MINTED": return `Claim ${x.claim} minted to <strong>${x.holder}</strong>: owed ${Number(x.owed).toFixed(4)} ${x.asset}`;
    case "PAYMENT_IN": return `Payment into the position: ${Number(x.amount).toFixed(4)} ${x.asset}`;
    case "BOUGHT_BACK": return `Bought back`;
    case "PAYOUT": return `Paid out: ${Number(x.amount).toFixed(4)} ${x.asset} (${x.purpose})`;
    case "SETTLE_START": return `Settlement started at the oracle price`;
    case "SETTLED": return `Settled`;
    default: return null;
  }
}
/** What each rescue state means for the borrower, in a sentence. */
const rescueText = (st: string) =>
  ({
    auction: "Stewards are bidding now (a 45-second auction); watch the bids on the board below.",
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
const txHref = (t: TxRow) => (t.chain === "near" ? `https://testnet.nearblocks.io/txns/${t.hash}` : `https://sepolia.etherscan.io/tx/${t.hash}`);

export function mountOwn(root: HTMLElement): () => void {
  let gone = false;
  let near: string | null = null;
  /** "sponsored": NEAR wallet only, the sponsor holds the Sepolia side; "own": the visitor's Sepolia wallet too. */
  let mode: "sponsored" | "own" | null = null;
  const MODE_KEY = () => `stead-own-mode-${near}`;
  const loadMode = () => {
    try {
      const m = localStorage.getItem(MODE_KEY());
      mode = m === "sponsored" || m === "own" ? m : mode;
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
  // the rescue as the live feed sees it (bids and every step, seconds after the chain), while one runs
  let live: FeedRescue | null = null;
  let livePoll = 0;
  let stepNow = 0; // the step whose button is running: its transactions are filed under it
  let receipts: Receipts | null = null; // what the faucet and the sponsor sent this visitor (any device)
  let receiptsAt = 0;
  let state: { nearYocto: bigint | null; eth: bigint; link: bigint; dai: bigint; pos: Position | null; hf: number | null; coll: bigint; debt: bigint; rescue: Rescue | null; claims: Claim[] } | null = null;
  let stopBoard: () => void = () => {};
  let boardFor: number | null = null;
  let lastRescue: number | null = null; // the visitor's latest rescue, for its story link
  // the steps re-render on every refresh; the live board lives in its own container below them
  root.innerHTML = `<div data-own-main></div><div class="st-own-board" data-own-board hidden></div>`;
  const main = root.querySelector<HTMLElement>("[data-own-main]")!;
  const boardHost = root.querySelector<HTMLElement>("[data-own-board]")!;
  const KEY = () => `stead-own-${near}`;

  // each NEAR account's transactions are kept apart (and shown only while it's connected)
  const TXKEY = () => `stead-own-txs-${near}`;
  const loadTxs = () => {
    txs = [];
    if (!near) return;
    try {
      const old = localStorage.getItem("stead-own-txs"); // the list from before it was kept per account
      if (old && !localStorage.getItem(TXKEY())) localStorage.setItem(TXKEY(), old);
      localStorage.removeItem("stead-own-txs");
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
  const addTx = (t: Omit<TxRow, "at">) => {
    txs.push({ ...t, at: Date.now(), step: stepNow });
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
    if (!eth) throw new Error("No Sepolia wallet found in this browser (MetaMask or another injected wallet).");
    const w = createWalletClient({ chain: sepolia, transport: custom(eth) });
    const [a] = await w.requestAddresses();
    try {
      await w.switchChain({ id: sepolia.id });
    } catch {
      await w.addChain({ chain: sepolia });
    }
    evm = a;
    setMode("own");
  }
  const evmWallet = () => createWalletClient({ account: evm!, chain: sepolia, transport: custom((window as any).ethereum) });

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
      throw panic ? Object.assign(new Error(panic), { refused: true }) : e;
    }
  }
  /** Every contract-signed transaction needs gas limit × max fee available up front at the position's
   *  address (600k × 2 gwei = 0.0012 ETH). Top it up from the visitor's wallet, or the sponsor. */
  async function ensureGas(pid: number) {
    const p = await nearView<Position>("get_position", { position_id: pid });
    if (!p.evm_address || (await pub.getBalance({ address: p.evm_address as Address })) >= TX_UPFRONT_WEI) return;
    if (mode === "sponsored") {
      busy = "Your position is low on gas: the sponsor sends it 0.002 Sepolia ETH…";
      render();
      await sponsor("gas");
    } else await evmSend("Your position is low on gas: send it 0.002 ETH", () => evmWallet().sendTransaction({ to: p.evm_address as Address, value: GAS_TOPUP_WEI }));
  }
  /** Ask the contract to sign an Aave action for the position, then wait until it lands on Sepolia. */
  async function signAction(pid: number, action: object, label: string) {
    await ensureGas(pid);
    const before = (await nearView<Position>("get_position", { position_id: pid })).next_nonce;
    await stead("sign_action", { position_id: pid, action, gas: EVM_GAS }, `${label} (the contract signs it through NEAR's chain signatures)`);
    busy = `${label}: waiting for it to land on Sepolia…`;
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
    busy = `${label}: confirm in your Sepolia wallet…`;
    render();
    const hash = await fn();
    addTx({ label, chain: "sepolia", hash, ok: true });
    busy = `${label}: waiting for Sepolia…`;
    render();
    await pub.waitForTransactionReceipt({ hash });
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
  async function refresh() {
    if (gone) return;
    try {
      const pos = await findPosition();
      const [nearYocto, eth, link, dai] = await Promise.all([
        near ? nearBalance(near) : Promise.resolve(null),
        evm ? pub.getBalance({ address: evm }) : Promise.resolve(0n),
        evm ? pub.readContract({ address: LINK, abi: erc20, functionName: "balanceOf", args: [evm] }) : Promise.resolve(0n),
        evm ? pub.readContract({ address: DAI, abi: erc20, functionName: "balanceOf", args: [evm] }) : Promise.resolve(0n),
      ]);
      let hf: number | null = null, coll = 0n, debt = 0n, rescue: Rescue | null = null, claims: Claim[] = [];
      if (pos?.evm_address) {
        const d = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [pos.evm_address as Address] });
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
      state = { nearYocto, eth, link, dai, pos, hf, coll, debt, rescue, claims };
      if (pos && lastRescue === null) {
        await knownPositions();
        lastRescue = lastRescueOf.get(pos.id) ?? null;
      }
      if (near && Date.now() - receiptsAt > 60_000) {
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

  // ── the live panel: what is happening now, the position, the latest activity (whole run) ──
  function isFinished() {
    const s = state;
    const pos = s?.pos;
    return !!pos && !!s && s.coll === 0n && s.debt === 0n && pos.next_nonce >= 3 && pos.pending === null && !pos.open_rescues.length && pos.active_auction === null;
  }
  function panelHtml(): string {
    const s = state;
    const pos = s?.pos ?? null;
    const r = live && !["bought_back", "settled", "failed"].includes(live.contractState) ? live : null;
    const usd8 = (v: bigint) => "$" + (Number(v) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 0 });
    const hf = s?.hf != null ? s.hf.toFixed(2) : "n/a";
    let now: string;
    if (!near) now = "Connect a NEAR testnet wallet to start.";
    else if (busy) now = `${esc(busy)} <span class="st-own-elapsed" data-elapsed="${busySince}">${elapsed(busySince)}</span>`;
    else if (r) {
      const open = r.events.find((e) => e.kind === "AUCTION_OPEN") as any;
      const closesAt = open ? r.openedAtMs + (open.t + open.durationS) * 1000 : 0;
      const ends = (s?.claims ?? []).filter((c) => c.status === "open" && c.expires_at).map((c) => Number(BigInt(c.expires_at!) / 1_000_000n));
      now =
        r.contractState === "auction" && closesAt ? `Rescue #${r.rescueId}: stewards are bidding · <strong data-countdown="${closesAt}">${countdown(closesAt)}</strong> left`
        : r.contractState === "top_up_pending" ? `Rescue #${r.rescueId}: the winner is topping up; waiting for the proof of the new collateral`
        : r.contractState === "open" && ends.length ? `Rescue #${r.rescueId}: claim open · <strong data-countdown="${Math.min(...ends)}">${countdown(Math.min(...ends))}</strong> left to buy back`
        : r.contractState === "settling" ? `Rescue #${r.rescueId}: the claim owner is settling at the oracle price`
        : `Rescue #${r.rescueId}: ${esc(r.contractState.replace(/_/g, " "))}`;
    } else if (!pos) now = "No position yet: open one in step 4.";
    else if (isFinished()) now = "Run complete: the position is closed and everything is back in your wallets.";
    else if (!s || s.coll === 0n) now = `Position ${pos.id} is registered, not opened yet.`;
    else if (pos.active_auction !== null || pos.open_rescues.length) now = "A rescue is starting: reading the auction…";
    else if (s.hf !== null && s.hf < 1.15) now = "Under the 1.15 trigger: waiting for the proven reading that opens the auction (usually under a minute).";
    else if (s.debt > 0n) now = `Protected: health ${hf}. If it falls under 1.15, stewards compete to rescue it.`;
    else now = "Opened, no debt.";
    const position = pos && s ? `Position ${pos.id} · health <strong>${hf}</strong> · ${usd8(s.coll)} collateral · ${usd8(s.debt)} debt` : "";
    // your transactions and the rescue's events, newest first
    const acts: { at: number; html: string }[] = txs.map((t) => ({
      at: t.at,
      html: `${t.ok ? "" : '<span class="st-own-chip-refused">refused</span> '}${esc(shortLabel(t.label).replace(/ \(refused\)$/, ""))}${t.hash ? ` <a class="st-textlink" href="${txHref(t)}" target="_blank" rel="noopener" aria-label="transaction">${icon("external", 11)}</a>` : ""}`,
    }));
    if (live) for (const e of live.events) {
      const line = liveLine(e);
      if (line) acts.push({ at: live.openedAtMs + e.t * 1000, html: line });
    }
    const rows = acts
      .sort((a, b) => b.at - a.at)
      .slice(0, 5)
      .map((a) => `<li><span class="st-own-live-t">${new Date(a.at).toISOString().slice(11, 19)}</span><span>${a.html}</span></li>`)
      .join("");
    return `<div class="st-own-live-head"><span class="st-live-dot" aria-hidden="true"></span><span>${now}</span></div>${position ? `<p class="st-own-live-pos">${position}</p>` : ""}${rows ? `<ol class="st-own-live-list">${rows}</ol>` : ""}`;
  }

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
      error = (e as any).refused ? `The contract refused it: "${(e as Error).message}".` : `${label} stopped: ${(e as Error).message}`;
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
    const d = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [p.evm_address as Address] });
    const target = (d[0] * d[3]) / hfBps;
    if (target <= d[1]) return;
    const pd = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getAssetPrice", args: [DAI] });
    const units = ((target - d[1]) * E18) / pd;
    await signAction(pid, { type: "borrow", amount: units.toString() }, `Borrow ${fmt(units, 18, 2)} DAI (health to ${(Number(hfBps) / 10_000).toFixed(2)})`);
    try {
      await signAction(pid, { type: "transfer_debt", amount: units.toString() }, `Move the borrowed DAI to your Sepolia wallet`);
    } catch (e) {
      if (!(e as any).refused) throw e;
      // under the trigger, the auction can open before this lands: from then on the contract signs
      // only repays and supplies, so the DAI stays in the position and is refunded when the rescue ends
      notice = `The auction opened before the borrowed ${fmt(units, 18, 2)} DAI left your position. While a rescue runs the contract only signs repays and supplies, so it stays there; the contract refunds it to your wallet when the rescue ends.`;
    }
  }
  const open = () =>
    run("Opening your position", async () => {
      stepNow = 4;
      receiptsAt = 0;
      let p = forceNew ? null : state?.pos ?? null;
      if (forceNew) {
        try {
          localStorage.removeItem(KEY()); // the new position becomes the one this page follows
        } catch {
          /* ignore */
        }
      }
      if (!p) {
        await stead("register_position", { market_id: MARKET, payout: mode === "sponsored" ? SPONSOR_PAYOUT : evm }, "Register a position (its Sepolia address is derived by NEAR's MPC network)", 100n);
        for (let i = 0; i < 20 && !(p = await findPosition())?.evm_address; i++) await sleep(2000);
        if (!p?.evm_address) throw new Error("the new position didn't appear");
        forceNew = false;
        lastRescue = null; // the new position has no rescue yet
        state = { ...(state as NonNullable<typeof state>), pos: p };
      }
      const addr = p.evm_address as Address;
      if (mode === "sponsored") {
        busy = "The sponsor sends your position its LINK and gas…";
        render();
        await sponsor("fund").catch((e) => {
          if (!/already done/.test((e as Error).message)) throw e;
        });
      }
      const held = await pub.readContract({ address: LINK, abi: erc20, functionName: "balanceOf", args: [addr] });
      const d0 = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [addr] });
      if (mode === "own" && d0[0] === 0n && held < COLLATERAL) await evmSend(`Send ${fmt(COLLATERAL - held, 18, 0)} LINK to your position`, () => evmWallet().writeContract({ address: LINK, abi: erc20, functionName: "transfer", args: [addr, COLLATERAL - held] }));
      if (mode === "own" && (await pub.getBalance({ address: addr })) < POSITION_GAS_WEI) await evmSend("Send 0.0015 ETH to your position for its gas", () => evmWallet().sendTransaction({ to: addr, value: POSITION_GAS_WEI }));
      const allowed = (t: Address) => pub.readContract({ address: t, abi: erc20, functionName: "allowance", args: [addr, POOL] });
      if ((await allowed(LINK)) < COLLATERAL) await signAction(p.id, { type: "approve", token: "collateral", amount: "max" }, "Let Aave take the position's LINK");
      if (d0[0] === 0n) await signAction(p.id, { type: "supply", amount: COLLATERAL.toString() }, "Supply 60 LINK on Aave");
      // straight to 1.14, just under the 1.15 trigger: on mainnet a falling price would take it there
      stepNow = 5;
      await borrowTo(p.id, 11_400n, "Open");
    });
  const trigger = () =>
    run("Triggering a rescue", async () => {
      stepNow = 5;
      await borrowTo(state!.pos!.id, 11_400n, "Trigger");
    });
  const tryBreak = (what: "withdraw" | "borrow") =>
    run(what === "withdraw" ? "Trying to withdraw" : "Trying to borrow", async () => {
      stepNow = 6;
      const a = what === "withdraw" ? { type: "withdraw", amount: { exact: E18.toString() } } : { type: "borrow", amount: E18.toString() };
      await stead("sign_action", { position_id: state!.pos!.id, action: a, gas: EVM_GAS }, what === "withdraw" ? "Try to withdraw 1 LINK while the claim is open" : "Try to borrow 1 DAI while the claim is open").catch((e) => {
        if (!(e as any).refused) throw e;
      });
    });
  const buyBack = () =>
    run("Buying back", async () => {
      stepNow = 6;
      if (mode === "sponsored") return sponsor("buyback");
      const owed = state!.claims.filter((c) => c.status === "open").reduce((s, c) => s + BigInt(c.owed_units), 0n);
      const addr = state!.pos!.evm_address as Address;
      const held = await pub.readContract({ address: LINK, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (owed > held) await evmSend(`Pay exactly the ${fmt(owed - held, 18, 6)} LINK owed into your position`, () => evmWallet().writeContract({ address: LINK, abi: erc20, functionName: "transfer", args: [addr, owed - held] }));
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
      if ((await pub.readContract({ address: DAI, abi: erc20, functionName: "allowance", args: [addr, POOL] })) === 0n) await signAction(p.id, { type: "approve", token: "debt", amount: "max" }, "Let Aave take the DAI repay");
      const d = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [addr] });
      if (d[1] > 0n && mode === "sponsored") {
        await sponsor("repay").catch((e) => {
          if (!/already done|no debt/.test((e as Error).message)) throw e;
        });
        await signAction(p.id, { type: "repay", amount: "max" }, "Repay all the debt");
      } else if (d[1] > 0n) {
        const pd = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getAssetPrice", args: [DAI] });
        const need = (d[1] * E18 * 1002n) / 1000n / pd; // a little over the debt: interest keeps accruing
        const held = await pub.readContract({ address: DAI, abi: erc20, functionName: "balanceOf", args: [addr] });
        if (held < need) await evmSend(`Send ${fmt(need - held, 18, 2)} DAI to your position to repay`, () => evmWallet().writeContract({ address: DAI, abi: erc20, functionName: "transfer", args: [addr, need - held] }));
        await signAction(p.id, { type: "repay", amount: "max" }, "Repay all the debt");
      }
      const left = await pub.readContract({ address: DAI, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (left > 0n) await signAction(p.id, { type: "transfer_debt", amount: left.toString() }, "Return the unused DAI to your wallet");
      if ((await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [addr] }))[0] > 0n) await signAction(p.id, { type: "withdraw", amount: "max" }, "Withdraw all the LINK to your wallet");
      // anything still at the position's address (e.g. DAI that arrived after the repay) goes home too
      const dust = await pub.readContract({ address: DAI, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (dust > 0n) await signAction(p.id, { type: "transfer_debt", amount: dust.toString() }, "Return the last DAI to your wallet");
    });

  // ── the page ──
  function stepHtml(n: number, title: string, done: boolean, active: boolean, body: string) {
    return `<li class="st-own-step${done ? " is-done" : active ? " is-now" : ""}"><span class="st-own-num" aria-hidden="true">${n}</span><div><h3>${title}${done ? '<span class="st-visually-hidden"> (done)</span>' : ""}</h3>${active || done ? `<div class="st-own-body">${body}</div>` : ""}</div></li>`;
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
    const funded = !!s && (s.nearYocto ?? 0n) >= 20_000_000_000_000_000_000_000n && (sponsored || (s.eth >= 2_000_000_000_000_000n && (opened || s.link >= COLLATERAL)));
    const triggered = finished || (opened && (rescue !== null || (s!.hf !== null && s!.hf < 1.15)));
    const ended = finished || (opened && !rescue && s!.hf !== null && s!.hf >= 1.4); // after a rescue, health is back near 1.50
    const closed = finished;
    const btn = (label: string, attr: string, primary = false, off = false) => `<button type="button" class="${primary ? "st-push" : "st-secondary"} st-cut" ${attr}${busy || off ? ' aria-disabled="true" disabled' : ""}>${primary ? '<span class="st-lamp" aria-hidden="true"></span>' : ""}${label}</button>`;
    // the buy-back window: the earliest open claim's expiry (ns → ms)
    const ends = (s?.claims ?? []).filter((c) => c.status === "open" && c.expires_at).map((c) => Number(BigInt(c.expires_at!) / 1_000_000n));
    const windowEnd = ends.length ? Math.min(...ends) : 0;
    const sentRow = (x: Sent, at: number): TxRow => ({ ...x, at, ok: true });
    const fromServer = (r: { at: number; sent: Sent[] } | null | undefined) => (r ? r.sent.map((x) => sentRow(x, r.at)) : []);
    const mine = (n: number) => txs.filter((t) => stepOfTx(t) === n && t.hash);
    // the visitor's own record first; the server's for another device (or a cleared browser)
    const step3 = mine(3).length ? mine(3) : fromServer(receipts?.faucet);
    const step4 = [...mine(4), ...(mine(4).some((t) => /^Sponsor:/.test(t.label)) ? [] : fromServer(receipts?.fund))];
    const chip = (t: TxRow) => `<a class="st-own-chip${t.ok ? "" : " is-refused"}" href="${txHref(t)}" target="_blank" rel="noopener" title="${esc(t.label)}"><span>${esc(shortLabel(t.label).replace(/ \(refused\)$/, ""))}</span>${t.ok ? "" : `<span class="st-own-chip-refused">refused</span>`}<span class="st-own-chip-where">${t.chain === "near" ? "NEAR" : "Sepolia"}</span>${icon("external", 12)}</a>`;
    const receipt = (head: string, rows: TxRow[], more = "") => `<div class="st-own-receipt"><span class="st-own-receipt-head">${icon("check", 14)}${head}</span><div class="st-own-chips">${rows.map(chip).join("")}</div>${more}</div>`;
    const posLinks = pos?.evm_address
      ? `<p class="st-own-hint">Your position <a class="st-textlink st-extlink" href="https://sepolia.etherscan.io/address/${pos.evm_address}#tokentxns" target="_blank" rel="noopener"><span class="st-mono">${pos.evm_address.slice(0, 8)}…${pos.evm_address.slice(-6)}</span>${icon("external", 12)}</a> on Etherscan: its aLINK collateral and DAI debt tokens. Aave says: ${fmt(s!.coll, 8, 2)} USD of collateral, ${fmt(s!.debt, 8, 2)} USD of debt, health ${s!.hf?.toFixed(2) ?? "n/a"}. Position ${pos.id} on the <a class="st-textlink" href="#/positions">Positions</a> page.</p>`
      : "";
    const steps = [
      stepHtml(1, "Connect a NEAR testnet wallet", !!near, !near, near ? `Connected as <strong>${esc(near)}</strong>${s?.nearYocto != null ? ` · ${fmt(s.nearYocto, 24, 3)} NEAR` : ""}${s?.nearYocto != null && s.nearYocto < 10_000_000_000_000_000_000_000n ? ` · <span class="st-own-warn">your account needs a little testnet NEAR to sign: get 10 from <a class="st-textlink" href="https://near-faucet.io" target="_blank" rel="noopener">a NEAR testnet faucet</a></span>` : ""}` : `<p>Your NEAR account owns the position and signs its Stead calls. Any NEAR wallet with testnet works (Meteor, Intear, Nightly, Ledger, NEAR CLI and more). Connecting adds a limited key for the Stead contract only, so the calls below need few approvals.</p><div class="st-own-buttons">${btn("Connect NEAR wallet", "data-near", true)}</div>`),
      stepHtml(2, "Sepolia side: your wallet, or ours", !!mode, !!near && !mode, mode === "own" && evm ? `Your Sepolia wallet <span class="st-mono">${evm.slice(0, 8)}…${evm.slice(-6)}</span> <button type="button" class="st-own-x" data-evm-off title="Disconnect this Sepolia wallet" aria-label="Disconnect this Sepolia wallet"${busy ? " disabled" : ""}>${icon("close", 12)}</button>${s ? ` · ${fmt(s.eth, 18, 4)} ETH · ${fmt(s.link, 18, 2)} LINK · ${fmt(s.dai, 18, 2)} DAI` : ""}` : mode === "sponsored" ? `NEAR only: the sponsor holds the Sepolia side. Your position's payout is the sponsor's address; it funds the position and pays the buy-back when you ask.` : `<p>The position's money lives on Sepolia. <strong>Only a NEAR wallet?</strong> Let the sponsor hold the Sepolia side: it funds your position and pays the buy-back when you ask; test funds go back to it at the end. <strong>Have a Sepolia wallet?</strong> Use it: you fund the position and get everything back.</p><div class="st-own-buttons">${btn("Only NEAR: sponsor the Sepolia side", "data-sponsored", true)}${btn("Use my Sepolia wallet", "data-evm")}</div>`),
      stepHtml(3, "Get test funds", funded || sponsored, mode === "own" && !funded && !opened, funded
        ? step3.length
          ? receipt("Completed", step3)
          : `<p>Your wallets already hold what the run needs.</p>`
        : `<p>You need about 0.03 NEAR, 0.002 Sepolia ETH and 60 LINK (+20 LINK if you buy back). We sponsor one set per wallet per day: 0.04 NEAR, 0.0025 Sepolia ETH, 80 LINK and 5 DAI.</p><div class="st-own-buttons">${btn("Send me test funds", "data-faucet", true)}</div>`),
      stepHtml(4, "Open your protected position", opened, (sponsored ? !!near : funded) && !opened, opened
        ? receipt("Opened", step4, posLinks)
        : `<p>Registers a position on the demo contract; its Sepolia address is derived by NEAR's MPC network, and only the contract can sign for it. Then 60 LINK goes in${sponsored ? " (from the sponsor)" : ""}, the contract supplies it on Aave and borrows DAI straight to a health factor of 1.14, just under Stead's 1.15 trigger: on mainnet a falling price would take it there. <strong>About 3 minutes</strong>${sponsored ? "; every step is a Stead call from your NEAR wallet" : "; two Sepolia confirmations in your wallet, the rest are Stead calls"}. The rescue starts on its own.</p>${pos && !opened ? `<p class="st-own-hint">Position ${pos.id} is registered; opening it again picks up where it stopped.</p>` : ""}<div class="st-own-buttons">${btn(pos ? "Continue opening my position" : "Open my position", "data-open", true)}</div>`),
      stepHtml(5, "Push it under the trigger", triggered || ended, opened && !triggered && !ended, triggered || ended
        ? mine(5).length
          ? receipt("Under the trigger", mine(5))
          : `<p>Done (health under 1.15).</p>`
        : `<p>On mainnet a falling price does this; on Sepolia prices are fixed, so you borrow a little more, to a health factor of 1.14: under Stead's 1.15 trigger. The keeper's proven reading then opens a real auction among the stewards.</p><div class="st-own-buttons">${btn("Borrow to 1.14", "data-trigger", true)}</div>`),
      stepHtml(6, "Watch your rescue, try to break it, choose the ending", ended, triggered && !ended, `${rescue ? `<p>Rescue <strong>#${rescue.id}</strong>: ${esc(rescue.state.replace(/_/g, " "))}. ${rescueText(rescue.state)}${rescue.state === "open" && windowEnd ? ` <strong class="st-own-countdown" data-countdown="${windowEnd}">${countdown(windowEnd)}</strong> left to buy back.` : ""}</p>` : `<p>Waiting for the proven reading to open the auction (30 to 60 seconds).</p>`}
        <div class="st-own-buttons">${rescue?.state === "open" ? btn("Buy back now", "data-buyback", true) : ""}${rescue ? btn("Try to withdraw 1 LINK", 'data-break="withdraw"') + btn("Try to borrow 1 DAI", 'data-break="borrow"') : ""}</div>
        ${mine(6).length ? `<div class="st-own-receipt"><span class="st-own-receipt-head">Your requests during the rescue</span><div class="st-own-chips">${mine(6).map(chip).join("")}</div></div>` : ""}
        <p class="st-own-hint">The full live board for your position is below.</p>`),
      stepHtml(7, "Close and get everything back", closed, ended && !closed, closed
        ? receipt("Closed: everything is back in your wallets", mine(7), lastRescue !== null ? `<p class="st-own-hint">Your rescue's full story, every step with its transaction: <a class="st-textlink" href="?rescue=sepolia-demo:${lastRescue}#/rescues">rescue #${lastRescue}</a>.</p>` : "")
        : `<p>Repay the debt from your DAI, then withdraw all the LINK to your Sepolia wallet. <strong>About 2 minutes.</strong>${lastRescue !== null ? ` Your rescue's full story, every step with its transaction: <a class="st-textlink" href="?rescue=sepolia-demo:${lastRescue}#/rescues">rescue #${lastRescue}</a> (it appears a few minutes after the rescue ends).` : ""}</p><div class="st-own-buttons">${btn("Close my position", "data-close", true)}</div>`),
    ];
    main.innerHTML = `
      <section class="st-panel st-sect st-own">
        <header class="st-list-head"><div class="st-label">PROTECT AN AAVE POSITION · NEAR TESTNET AND SEPOLIA</div><h1 class="st-page-title">Protect an Aave position, then watch it get rescued</h1>
          <p class="st-list-sub">A protected position is an Aave position at an address only the Stead contract can sign for, through NEAR's chain signatures; your NEAR account owns it. When its health falls below 1.15, stewards compete to top it up, and you buy the rescue back. Everything below is real, on testnets; Sepolia's prices don't move, so opening borrows straight under the trigger. About 12 minutes in all: each Aave step waits for a Sepolia block and a proof.</p></header>
        <section class="st-own-live" data-own-live aria-label="What is happening now" role="status">${panelHtml()}</section>
        ${notice ? `<p class="st-own-notice" role="status">${esc(notice)}</p>` : ""}
        ${error ? `<p class="st-own-error" role="alert">${esc(error)}</p>` : ""}
        ${finished && pos ? `<div class="st-own-done"><p><strong>Run complete.</strong> Position ${pos.id} is closed on Aave${lastRescue !== null ? `; <a class="st-textlink" href="?rescue=sepolia-demo:${lastRescue}#/rescues">rescue #${lastRescue}</a> has its full story` : ""}. Its receipts stay below.</p><div class="st-own-buttons">${btn("Protect a new position", "data-new", true)}</div></div>` : ""}
        <ol class="st-own-steps">${steps.join("")}</ol>
        ${near && txs.length ? `<div class="st-label st-runlog-head">YOUR TRANSACTIONS</div><ol class="st-runlog">${txs
          .slice()
          .reverse()
          .slice(0, showAllTxs ? undefined : 3)
          .map((t) => `<li><span class="st-runlog-time">${new Date(t.at).toISOString().slice(11, 19)}</span><span class="st-runlog-label">${esc(t.label)}</span>${t.hash ? `<a class="st-txlink" href="${txHref(t)}" target="_blank" rel="noopener"><span>${t.chain === "near" ? "NearBlocks" : "Etherscan"}</span><span class="st-txlink-where">${t.hash.slice(0, 8)}…</span>${icon("external", 12)}</a>` : ""}</li>`)
          .join("")}</ol>${txs.length > 3 ? `<button type="button" class="st-secondary st-cut st-own-more" data-more-txs>${showAllTxs ? "Show the latest 3" : `See all ${txs.length}`}</button>` : ""}` : ""}
      </section>`;
    main.querySelector("[data-near]")?.addEventListener("click", () => run("Connecting your NEAR wallet", async () => {
      near = await connectNear();
      loadTxs();
    }));
    main.querySelector("[data-sponsored]")?.addEventListener("click", () => {
      setMode("sponsored");
      render();
    });
    main.querySelector("[data-evm]")?.addEventListener("click", () => run("Connecting your Sepolia wallet", connectEvm));
    main.querySelector("[data-faucet]")?.addEventListener("click", faucet);
    main.querySelector("[data-evm-off]")?.addEventListener("click", () => void disconnectEvm());
    main.querySelector("[data-more-txs]")?.addEventListener("click", () => {
      showAllTxs = !showAllTxs;
      render();
    });
    main.querySelector("[data-open]")?.addEventListener("click", open);
    main.querySelector("[data-new]")?.addEventListener("click", () => {
      forceNew = true;
      open();
    });
    main.querySelector("[data-trigger]")?.addEventListener("click", trigger);
    main.querySelector("[data-buyback]")?.addEventListener("click", buyBack);
    main.querySelector("[data-close]")?.addEventListener("click", close);
    main.querySelectorAll<HTMLButtonElement>("[data-break]").forEach((b) => b.addEventListener("click", () => tryBreak(b.dataset.break as "withdraw" | "borrow")));
    // the live board for this position while a rescue runs: mounted once, not on every refresh
    const show = !!pos && triggered && !ended;
    // and the compact live panel in step 6: its own 2.5 s poll while the rescue runs
    const following = !!pos && !finished;
    if (following && !livePoll) {
      const poll = async () => {
        try {
          const r = await fetch(`${feedUrl()}/live.json`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
          const j = (await r.json()) as { rescues: FeedRescue[] };
          const mine = j.rescues.filter((x) => x.contract === CONTRACT && x.positionId === state?.pos?.id).sort((a, b) => b.rescueId - a.rescueId)[0] ?? null;
          const changed = JSON.stringify(mine?.events.length) !== JSON.stringify(live?.events.length) || mine?.contractState !== live?.contractState;
          live = mine;
          const el = root.querySelector<HTMLElement>("[data-own-live]");
          if (el) el.innerHTML = panelHtml();
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
    boardHost.hidden = !show;
    if (show && boardFor !== pos!.id) {
      stopBoard();
      boardFor = pos!.id;
      stopBoard = mountLive(boardHost, () => {}, "live", (r) => r.contract === CONTRACT && r.positionId === pos!.id);
    } else if (!show && boardFor !== null) {
      stopBoard();
      boardFor = null;
    }
  }

  void (async () => {
    main.innerHTML = `<section class="st-panel st-page"><div class="st-label">PROTECT AN AAVE POSITION</div><p class="st-empty">Loading the wallets…</p></section>`;
    await initNear().catch((e) => (error = `NEAR wallets could not load (${(e as Error).message}).`));
    const eth = (window as any).ethereum;
    if (eth && !evmOff()) {
      const accts: string[] = await eth.request({ method: "eth_accounts" }).catch(() => []);
      if (accts[0]) evm = accts[0] as Address;
    }
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
    clearInterval(tick);
    stopBoard();
    stopNear();
  };
}

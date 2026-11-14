// "Protect a position" on mainnet: a position dashboard (the testnet page keeps its guided demo).
// The visitor connects a NEAR mainnet wallet (it owns the position and signs its Stead calls) and,
// optionally, an Ethereum wallet (it funds the position and is its payout). The page reads the contract and
// Ethereum every few seconds and offers the normal actions: deposit, borrow, repay, withdraw, buy
// back while a claim is open, and return leftover gas ETH. Each action shows the health factor it
// would leave before anything is signed. Nothing here holds a key: the wallets sign.
// Without an Ethereum wallet the visitor pastes the payout address and sends WETH and gas ETH
// straight to the position's address (shown with a QR code); every step after that is a NEAR call.
// One NEAR account may own several positions: the page shows one (remembered per account, else the
// newest), and an empty one offers to open a new position beside it.
import { connectNear, disconnectNear, nearAccount, onNearAccount, setNearNetwork, steadCall } from "../wallet/near";
import { createPublicClient, createWalletClient, custom, fallback, getAddress as getAddr, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { icon } from "../icons";
import { crown, bindCrowns } from "../crown";
import { CODE } from "../board/model";
import { dialogHtml as svDialogHtml, showSteward, stewardPanel, flowSeq } from "../mainnet/runs";
import { NETS, gasFromMarket, marketMismatch, allowed, capUsd, rescueFlow, protectionRows, rescueFinished, OUTCOME_WORD, units as fmtUnits, type MarketView, type LimitsView, type ParamsView, type RescueView, type ClaimView, type ProtectionRow } from "./net";
import {
  project, depositMax, borrowMax, withdrawMax, repayAllUnits, sweepAmount, sweepSupported, gasTopUp, phaseOf, availability, fallLine,
  hfFromWad, hfText, hfBarPct, TRIGGER_BPS, TRANSFER_GAS, KEEPER_TOPS_UP_GAS, UNDER_TRIGGER_WARNING,
  checkPayout, gasAsk, arrived, depositPlan, buybackDue, qrSvg,
  hfBand, hfPulses, riskLines, pctText, ltvView, premiumCapBase, barZones, BAR_MARKS, EARLY_SETTLE_BPS, linePrice,
  ladderStep, bidBarPct, premiumCostBase, stewardIdOf, fundAsk, gasLow, liveStewardView, positionEmpty,
  flowActivity, sortActivity, clockText, flowMoves, type ActRow,
  nearGate, windowRefused, parkedView, repayPlan, defaultRepaySrc, positionRepayOffer, payoutLine, payoutChangeState, durationText,
  doneView, relayedHash, lastProtection, wethOutAvail, wethOutNext, wethOutArg, type DoneKind,
  type Account, type Avail, type Op, type Phase, type Projection, type SeenBid, type LadderRow,
} from "./dashlogic";

const net = NETS.mainnet;
const C = net.collateral;
const D = net.debt;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const poolAbi = parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const mcAbi = parseAbi(["function getEthBalance(address) view returns (uint256)"]);
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const pub = createPublicClient({ chain: mainnet, transport: fallback(net.evmRpcs.map((u) => http(u, { timeout: 8000 }))) });
const POLL_MS = 5000;
/** The position's Ethereum balances and Aave figures are read this often, and on every new block. */
const FAST_MS = 3000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: bigint, dec = 18, dp = 4) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dp });
const usd8 = (v: bigint, dp = 2) => "$" + (Number(v) / 1e8).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  // an hour or more (the buy-back window) reads h:mm:ss
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const nsMs = (ns: string | undefined) => (ns && ns !== "0" ? Number(BigInt(ns) / 1_000_000n) : 0);

// ── NEAR reads (FastNEAR first, NEAR's own RPC on failure, then a short back-off) ──
async function nearRpc(method: string, params: object): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of net.nearRpcs) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(5000) });
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
  const j = await nearRpc("query", { request_type: "call_function", finality: "optimistic", account_id: net.contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (!j.result) throw new Error(j.error?.cause?.name ?? "NEAR view failed");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}
async function nearAccountView(id: string): Promise<{ amount: string; code_hash: string } | null> {
  const j = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: id });
  return j.result ?? null;
}

type Position = { id: number; owner: string; evm_address: string | null; payout: string; payout_change?: { to: string; effective_at: string } | null; next_nonce: number; pending: { signed_raw?: string | null } | null; active_auction: number | null; open_rescues: number[]; health?: unknown; premium_cap_base?: string; premium_used_base?: string };
type Books = { escrow: { collateral_units: string; debt_units: string; collateral_committed: string; debt_committed: string }; outflows: unknown[] };
// evmHash: the Ethereum transaction a contract-signed call became, once it was broadcast
type TxRow = { at: number; label: string; chain: "near" | "ethereum"; hash: string; ok: boolean; pos?: number; evmHash?: string };
type Bal = { eth: bigint; coll: bigint; debt: bigint };
type State = {
  nearYocto: bigint | null;
  wallet: Bal | null;
  pos: Position | null;
  acct: Account | null;
  /** Aave's maximum loan-to-value for the position, bps (getUserAccountData[4]). */
  maxLtv: bigint;
  hf: bigint | null;
  prices: { coll: bigint; debt: bigint };
  posBal: Bal;
  allow: { coll: bigint; debt: bigint };
  books: Books | null;
  rescue: RescueView | null;
  claims: ClaimView[];
  /** The position's last finished rescue, so its story stays in the activity after it closes. */
  past: { rescue: RescueView; claims: ClaimView[] } | null;
};

export function mountDash(root: HTMLElement): () => void {
  setNearNetwork("mainnet");
  let gone = false;
  let near: string | null = null;
  let evm: Address | null = null;
  let busy = "";
  let busySince = 0;
  let error = "";
  let notice = "";
  let txs: TxRow[] = [];
  let showAllTxs = false;
  let s: State | null = null;
  let cfg: { market: MarketView | null; limits: LimitsView | null; params: ParamsView | null; paused: boolean; codeHash: string | null; at: number } | null = null;
  let mismatch: string[] = [];
  let gas = { evmGas: net.evmGas, txUpfrontWei: net.txUpfrontWei };
  const seenAt = new Map<string, number>();
  // every rescue the position has had, with its claims: found once per page load by paging the
  // contract's rescues; a finished one never changes, so it is never read again
  type Hist = { rescue: RescueView; claims: ClaimView[]; readAt: number };
  const hist = new Map<number, Hist>();
  let histPos: number | null = null;
  let histState: "idle" | "loading" | "done" | "failed" = "idle";
  let histFailedAt = 0;
  let showNoBids = false;
  let showAllProt = false;
  // the times of the Ethereum blocks the contract's proofs name, read once each
  const blockTimes = new Map<number, number | null>();
  const wantBlock = (n: number) => {
    if (blockTimes.has(n)) return;
    blockTimes.set(n, null);
    pub.getBlock({ blockNumber: BigInt(n) }).then(
      (b) => {
        blockTimes.set(n, Number(b.timestamp) * 1000);
        render();
      },
      () => setTimeout(() => blockTimes.delete(n), 30_000), // try again later
    );
  };
  /** How the rescue steps are drawn: the debt token for the settler's repay, the explorer links,
   *  and the proof blocks' times. */
  const flowOpts = () => ({
    debt: D,
    evmTx: net.evmTx,
    evmBlock: net.evmBlock,
    evmAddress: net.evmAddress,
    blockMs: (n: number) => {
      wantBlock(n);
      return blockTimes.get(n) ?? null;
    },
  });
  /** Every rescue story the page holds for the shown position: the history, then the live reads on top. */
  const stories = (): { rescue: RescueView; claims: ClaimView[] }[] => {
    if (!s?.pos) return [];
    const out: { rescue: RescueView; claims: ClaimView[] }[] = histPos === s.pos.id ? [...hist.values()] : [];
    if (s.past) out.push(s.past);
    if (s.rescue) out.push({ rescue: s.rescue, claims: s.claims });
    return out;
  };
  // what the visitor typed in each action, kept across the re-renders
  const amt: Record<string, string> = {};
  const all: Record<string, boolean> = {};
  // the repay's source when the visitor picked one; else the position when it holds USDC
  let repayPicked: "position" | "wallet" | null = null;
  const repaySrc = () => defaultRepaySrc({ evmConnected: !!evm, picked: repayPicked, idleUnits: s?.posBal.debt ?? 0n });
  // which side of each token card is showing, which disclosures are open, when the address was copied
  let wethMode: "deposit" | "withdraw" = "deposit";
  let usdcMode: "borrow" | "repay" = "borrow";
  const opened = new Set<string>();
  let copiedAt = 0;
  // no Ethereum wallet: the pasted payout, the gas an action is waiting for, WETH that just arrived
  let payoutText = "";
  let gasWait = 0n;
  let lastIdle: { pos: number; units: bigint } | null = null;
  let arrivedUnits = 0n;
  let arrivedAt = 0;
  let flashArrival = false;
  let autoDeposit = "";
  let prefillKey = "";
  // opening a new position beside an empty one: the empty position's id while its form shows
  let freshFrom: number | null = null;
  // the click that started or continued the running action: a NEAR wallet that signs in a window
  // of its own can open it only right after one
  let clickAt = 0;
  // the steps the running action finished (for its pause and its result)
  let runDone: string[] = [];
  // an action stopped before a NEAR signature: what it finished, and the step a click goes on with
  type Park = { act: string; done: string[]; next: string };
  let parked: Park | null = null;
  // the protections dialog: the list (null) or one rescue's flow
  let protView: number | null = null;
  // the action dialog: a withdrawal's confirm (and the payout change from it), a send from the
  // wallet to the position, or an action's result
  type Done = { kind: DoneKind; title: string; line: string; figure: { label: string; value: string }; links: { label: string; near?: string; evm?: string }[] };
  type ActView = { v: "confirm"; kind: "withdraw" | "move" | "sweep" | "wethout" } | { v: "payout"; back: ActView | null } | { v: "send"; token: "coll" | "debt" | "eth" } | { v: "done"; done: Done };
  let actView: ActView | null = null;
  let payoutNew = "";
  // a disabled tile button's reason, shown after a tap (touch has no tooltip)
  let tileWhy = "";
  let tileWhyAt = 0;
  // the token a tile's + opened the Fund dialog for
  let fundFor: "coll" | "debt" | "eth" | null = null;

  // ── saved per NEAR account: its transactions and its position id (the keys the earlier mainnet page used) ──
  const TXKEY = () => `stead-own-txs-mainnet-${near}`;
  const POSKEY = () => `stead-own-mainnet-${near}`;
  const loadTxs = () => {
    txs = [];
    if (!near) return;
    try {
      txs = JSON.parse(localStorage.getItem(TXKEY()) ?? "[]");
    } catch {
      txs = [];
    }
  };
  const saveTxs = () => {
    try {
      if (near) localStorage.setItem(TXKEY(), JSON.stringify(txs.slice(-80)));
    } catch {
      /* the list still shows; it just won't survive a reload */
    }
  };
  const shown = () => (s?.pos ? txs.filter((t) => t.pos === s!.pos!.id) : []);
  const addTx = (t: Omit<TxRow, "at" | "pos">) => {
    txs.push({ ...t, at: Date.now(), pos: s?.pos?.id });
    saveTxs();
    render();
  };

  // ── wallets ──
  const EVM_OFF = "stead-own-evm-off";
  const evmOff = () => {
    try {
      return localStorage.getItem(EVM_OFF) === "1";
    } catch {
      return false;
    }
  };
  async function connectEvm() {
    try {
      localStorage.removeItem(EVM_OFF);
    } catch {
      /* ignore */
    }
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No Ethereum wallet found in this browser (MetaMask or another injected wallet).");
    const w = createWalletClient({ chain: mainnet, transport: custom(eth) });
    const [a] = await w.requestAddresses();
    await w.switchChain({ id: mainnet.id });
    evm = a;
  }
  async function disconnectEvm() {
    await (window as any).ethereum?.request?.({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
    try {
      localStorage.setItem(EVM_OFF, "1");
    } catch {
      /* ignore */
    }
    evm = null;
    void refresh();
  }
  const evmWallet = () => createWalletClient({ account: evm!, chain: mainnet, transport: custom((window as any).ethereum) });
  /** One Ethereum transaction from the visitor's wallet: on chain 1, listed, then waited for. */
  async function evmSend(label: string, fn: () => Promise<Hex>) {
    if (!evm) throw new Error("connect your Ethereum wallet first");
    busy = `${label}: confirm in your Ethereum wallet`;
    render();
    await evmWallet().switchChain({ id: mainnet.id });
    const hash = await fn();
    addTx({ label, chain: "ethereum", hash, ok: true });
    busy = `${label}: waiting for Ethereum`;
    render();
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`${label}: the Ethereum transaction failed (reverted)`);
    runDone.push(label);
  }

  // ── Stead calls (the visitor's NEAR wallet) ──
  /** The browser's own answer to "may this page open a window now", where it has one. */
  const activation = (): boolean | null => {
    const u = (navigator as any).userActivation;
    return u && typeof u.isActive === "boolean" ? u.isActive : null;
  };
  /** A pause before a NEAR signature: the action goes on from a click (see run). */
  const parkErr = (label: string) => Object.assign(new Error(`${label}: waiting for a click`), { park: label });
  async function stead(method: string, args: object, label: string, gasTgas = 150n): Promise<string> {
    // after a wait (an Ethereum transaction, a step landing) the click has expired: a wallet window
    // opened now would be blocked, so stop here and go on from a fresh click
    if (nearGate(activation(), Date.now() - clickAt) === "click") throw parkErr(label);
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
      if (!panic && windowRefused(m)) throw parkErr(label); // the window was blocked or shut: nothing was signed
      throw panic ? Object.assign(new Error(panic), { refused: true }) : e;
    }
  }
  /** Each contract-signed transaction needs gas limit × max fee available up front at the position. */
  async function ensureGas(pid: number, upfront = gas.txUpfrontWei) {
    const p = await nearView<Position>("get_position", { position_id: pid });
    if (!p.evm_address) return;
    const bal = await pub.getBalance({ address: p.evm_address as Address });
    const top = gasTopUp(bal, upfront);
    if (top === 0n) return;
    if (KEEPER_TOPS_UP_GAS) {
      busy = "The position is short of gas: waiting for the keeper's top-up";
      render();
      for (let i = 0; i < 36; i++) {
        await sleep(5000);
        if ((await pub.getBalance({ address: p.evm_address as Address })) >= upfront) return;
      }
      throw new Error("the keeper's gas top-up did not arrive within 3 minutes");
    }
    if (!evm) {
      // no wallet to send it from: ask for it at the position's address and wait until it is there
      const was = busy;
      gasWait = gasAsk(bal, upfront);
      busy = `The position needs about ${fmt(gasWait, 18, 4)} ETH for gas: send it to the position's address`;
      render();
      openFund(null);
      try {
        for (let i = 0; i < 300; i++) {
          await sleep(FAST_MS);
          if ((await pub.getBalance({ address: p.evm_address as Address }).catch(() => 0n)) >= upfront) return;
        }
      } finally {
        gasWait = 0n;
        busy = was;
        render();
      }
      throw new Error("no gas ETH arrived at the position within 15 minutes");
    }
    await evmSend(`Send ${fmt(top, 18, 6)} ETH to the position for its gas`, () => evmWallet().sendTransaction({ to: p.evm_address as Address, value: top }));
  }
  /** Ask the contract to sign one Aave action for the position, then wait until it lands on Ethereum. */
  async function signAction(pid: number, action: object, label: string, g = gas.evmGas) {
    await ensureGas(pid, BigInt(g.gas_limit) * BigInt(g.max_fee_per_gas));
    const before = (await nearView<Position>("get_position", { position_id: pid })).next_nonce;
    const nearHash = await stead("sign_action", { position_id: pid, action, gas: g }, label);
    busy = `${label}: signed by the contract, waiting for Ethereum`;
    render();
    await landed(pid, before, label, nearHash);
  }
  /** Wait until the contract's signed transaction has landed on Ethereum (the position's nonce moved
   *  on and nothing is pending), keeping its Ethereum hash with the NEAR call; a revert stops the action. */
  async function landed(pid: number, before: number, label: string, nearHash: string) {
    let evmHash = "";
    for (let i = 0; i < 90; i++) {
      const p = await nearView<Position>("get_position", { position_id: pid });
      if (p.pending?.signed_raw) evmHash = relayedHash(p.pending.signed_raw);
      if (p.next_nonce > before && p.pending === null) {
        const row = nearHash ? txs.find((t) => t.hash === nearHash) : undefined;
        if (row && evmHash) {
          row.evmHash = evmHash;
          saveTxs();
        }
        const rc = evmHash ? await pub.getTransactionReceipt({ hash: evmHash as Hex }).catch(() => null) : null;
        if (rc && rc.status !== "success") throw new Error(`${label} landed on Ethereum but failed (reverted)`);
        runDone.push(label);
        return;
      }
      await sleep(4000);
    }
    throw new Error(`${label} did not land within 6 minutes`);
  }

  // ── chain state ──
  let noPosUntil = 0;
  async function findPosition(): Promise<Position | null> {
    if (!near) return null;
    let id = NaN;
    try {
      id = Number(localStorage.getItem(POSKEY()) ?? "NaN");
    } catch {
      /* ignore */
    }
    if (Number.isInteger(id)) {
      const p = await nearView<Position | null>("get_position", { position_id: id }).catch(() => null);
      if (p && p.owner === near) return p;
    }
    if (Date.now() < noPosUntil) return null;
    // ids are sequential: walk them a page at a time; the newest one this account owns wins
    let found: Position | null = null;
    for (let i = 0; i < 400; i += 8) {
      const page = await Promise.all(Array.from({ length: 8 }, (_, k) => nearView<Position | null>("get_position", { position_id: i + k })));
      found = page.filter((x): x is Position => !!x && x.owner === near).pop() ?? found;
      if (page.some((x) => !x)) break;
    }
    if (!found) {
      noPosUntil = Date.now() + 30_000;
      return null;
    }
    try {
      localStorage.setItem(POSKEY(), String(found.id));
    } catch {
      /* ignore */
    }
    return found;
  }
  async function readCfg() {
    if (cfg && Date.now() - cfg.at < 60_000) return;
    const [market, limits, params, roles, acct] = await Promise.all([
      nearView<MarketView | null>("get_market", { market_id: net.market }),
      nearView<LimitsView>("get_limits", {}),
      nearView<ParamsView>("get_params", {}),
      nearView<[string, string[], string[], boolean]>("get_roles", {}),
      nearAccountView(net.contract),
    ]);
    cfg = { market, limits, params, paused: roles[3], codeHash: acct?.code_hash ?? null, at: Date.now() };
    mismatch = marketMismatch(net, market);
    if (market && !mismatch.length) gas = gasFromMarket(net, market);
  }
  let refreshing = false;
  let nearBalAt = 0;
  // every Ethereum read is numbered when it starts; only a newer one replaces what is shown
  let readSeq = 0;
  let shownSeq = 0;
  /** One multicall for the prices, the wallet's balances and the position's balances and Aave figures. */
  async function readEvm(pa: Address | null) {
    const calls: any[] = [
      { address: net.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [C.address] },
      { address: net.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [D.address] },
    ];
    if (evm) calls.push(
      { address: MULTICALL3, abi: mcAbi, functionName: "getEthBalance", args: [evm] },
      { address: C.address, abi: erc20, functionName: "balanceOf", args: [evm] },
      { address: D.address, abi: erc20, functionName: "balanceOf", args: [evm] },
    );
    if (pa) calls.push(
      { address: net.pool, abi: poolAbi, functionName: "getUserAccountData", args: [pa] },
      { address: MULTICALL3, abi: mcAbi, functionName: "getEthBalance", args: [pa] },
      { address: C.address, abi: erc20, functionName: "balanceOf", args: [pa] },
      { address: D.address, abi: erc20, functionName: "balanceOf", args: [pa] },
      { address: C.address, abi: erc20, functionName: "allowance", args: [pa, net.pool] },
      { address: D.address, abi: erc20, functionName: "allowance", args: [pa, net.pool] },
    );
    const seq = ++readSeq;
    const out = (await pub.multicall({ contracts: calls, allowFailure: false })) as any[];
    let k = 2;
    const wallet: Bal | null = evm ? { eth: out[k++], coll: out[k++], debt: out[k++] } : null;
    let acct: Account | null = null, hf: bigint | null = null, maxLtv = 0n;
    let posBal: Bal = { eth: 0n, coll: 0n, debt: 0n }, allow = { coll: 0n, debt: 0n };
    if (pa) {
      const d = out[k++] as readonly bigint[];
      acct = { collBase: d[0], debtBase: d[1], availBase: d[2], ltBps: d[3] };
      maxLtv = d[4];
      hf = hfFromWad(d[1], d[5]); // null without debt (never Aave's no-debt sentinel as a number)
      posBal = { eth: out[k++], coll: out[k++], debt: out[k++] };
      allow = { coll: out[k++], debt: out[k++] };
    }
    return { seq, wallet, acct, maxLtv, hf, prices: { coll: out[0] as bigint, debt: out[1] as bigint }, posBal, allow };
  }
  /** WETH that arrived at the position since the last reading: noted once, offered as the supply. */
  function noteArrival(posId: number | null, idle: bigint) {
    if (posId === null) return;
    const up = arrived(lastIdle && lastIdle.pos === posId ? lastIdle.units : null, idle);
    lastIdle = { pos: posId, units: idle };
    if (up === 0n || facts().locked) return; // during a rescue, WETH arriving is the buy-back payment
    arrivedUnits = up;
    arrivedAt = Date.now();
    flashArrival = true;
    wethMode = "deposit";
    if (!amt.deposit || amt.deposit === autoDeposit) amt.deposit = autoDeposit = trim(readyUnits(idle), C.decimals, 6);
  }
  /** WETH at the position that can be supplied now (within the size cap). */
  const readyUnits = (idle: bigint) => (s?.acct && s.prices.coll ? depositMax(0n, idle, s.acct.collBase, capBase(), s.prices.coll, C.decimals) : idle);
  async function refresh() {
    if (gone || refreshing) return;
    refreshing = true;
    try {
      await readCfg();
      const pos = await findPosition();
      const pa = (pos?.evm_address ?? null) as Address | null;
      const e = await readEvm(pa);
      let books: Books | null = null, rescue: RescueView | null = null, claims: ClaimView[] = [];
      if (pos) {
        books = await nearView<Books>("get_books", { position_id: pos.id });
        const rid = pos.active_auction ?? pos.open_rescues[0] ?? null;
        if (rid !== null) {
          rescue = await nearView<RescueView>("get_rescue", { rescue_id: rid });
          claims = (await Promise.all(rescue.members.filter((m) => m.claim_id).map((m) => nearView<ClaimView>("get_claim", { token_id: m.claim_id })))).filter(Boolean);
          lastRescue(pos.id, rid);
        } else past = await readPast(pos.id).catch(() => past);
      }
      let nearYocto = s?.nearYocto ?? null;
      if (near && Date.now() - nearBalAt > 30_000) {
        nearBalAt = Date.now();
        const a = await nearAccountView(near).catch(() => null);
        nearYocto = a ? BigInt(a.amount) : null;
      }
      if (gone) return;
      const fresh = e.seq > shownSeq || !s || s.pos?.id !== pos?.id;
      if (fresh) shownSeq = e.seq;
      const evmPart = fresh ? { wallet: e.wallet, acct: e.acct, maxLtv: e.maxLtv, hf: e.hf, prices: e.prices, posBal: e.posBal, allow: e.allow } : { wallet: s!.wallet, acct: s!.acct, maxLtv: s!.maxLtv, hf: s!.hf, prices: s!.prices, posBal: s!.posBal, allow: s!.allow };
      s = { nearYocto, pos, books, rescue, claims, past: rescue ? null : past, ...evmPart };
      if (pos) {
        if (histPos !== pos.id) {
          hist.clear();
          histPos = pos.id;
          histState = "idle";
          showNoBids = showAllProt = false;
        }
        const keep = (r: RescueView, c: ClaimView[]) => hist.set(r.id, { rescue: r, claims: c, readAt: Date.now() });
        if (rescue) keep(rescue, claims);
        else if (past) keep(past.rescue, past.claims);
        if (histState === "idle" || (histState === "failed" && Date.now() - histFailedAt > 60_000)) void loadHist(pos.id);
        else if (histState === "done") void rereadOne(pos.id, rescue?.id ?? null);
      }
      stepLadder();
      if (fresh) noteArrival(pos?.evm_address ? pos.id : null, e.posBal.coll);
      if (error.startsWith("Reading the chains failed")) error = "";
    } catch (e) {
      error = `Reading the chains failed (${(e as Error).message.split("\n")[0].slice(0, 160)}); retrying.`;
    } finally {
      refreshing = false;
    }
    render();
  }
  /** Every rescue of the position, once per page load: the contract's rescues 50 at a time (its
   *  limit), the ones on this position kept with their claims; gently, one read per 1.5 s. */
  async function loadHist(posId: number) {
    histState = "loading";
    try {
      const found: RescueView[] = [];
      let from = 0;
      for (let pages = 0; pages < 400; pages++) {
        const page = await nearView<RescueView[]>("get_rescues", { from, limit: 50 });
        for (const x of page) if (x.position_id === posId) found.push(x);
        if (page.length < 50) break;
        from = page[page.length - 1].id + 1;
        await sleep(1500);
      }
      if (gone || histPos !== posId) return;
      for (const r of found.sort((a, b) => b.id - a.id)) {
        if (hist.has(r.id)) continue; // the live read already holds it
        const claims: ClaimView[] = [];
        for (const m of r.members) {
          if (!m.claim_id) continue;
          await sleep(1500);
          const c = await nearView<ClaimView | null>("get_claim", { token_id: m.claim_id }).catch(() => null);
          if (c) claims.push(c);
        }
        if (gone || histPos !== posId) return;
        if (!hist.has(r.id)) hist.set(r.id, { rescue: r, claims, readAt: Date.now() });
      }
      histState = "done";
      if (lastRid === null && hist.size && lastRidPos === posId) lastRescue(posId, Math.max(...hist.keys()));
    } catch {
      if (histPos === posId) {
        histState = "failed";
        histFailedAt = Date.now();
      }
    }
    render();
  }
  /** A rescue in the history that is still running but not the one the page reads each time (a
   *  stacked one): read again, at most one per refresh and each at most every 30 s. */
  async function rereadOne(posId: number, liveId: number | null) {
    const x = [...hist.values()].find((h) => h.rescue.id !== liveId && !rescueFinished(h.rescue) && Date.now() - h.readAt > 30_000);
    if (!x) return;
    x.readAt = Date.now();
    const r = await nearView<RescueView | null>("get_rescue", { rescue_id: x.rescue.id }).catch(() => null);
    if (!r || histPos !== posId) return;
    const claims = (await Promise.all(r.members.filter((m) => m.claim_id).map((m) => nearView<ClaimView>("get_claim", { token_id: m.claim_id }).catch(() => null)))).filter(Boolean) as ClaimView[];
    hist.set(r.id, { rescue: r, claims, readAt: Date.now() });
  }
  // the position's last rescue id, remembered per position (found once by scanning the contract's rescues)
  let lastRid: number | null = null, lastRidPos: number | null = null, scanned = false;
  let past: State["past"] = null, pastAt = 0;
  function lastRescue(posId: number, rid: number) {
    lastRid = rid;
    lastRidPos = posId;
    try {
      localStorage.setItem(`stead-own-mainnet-lastrescue-${posId}`, String(rid));
    } catch {
      /* ignore */
    }
  }
  async function readPast(posId: number): Promise<State["past"]> {
    if (lastRidPos !== posId) {
      lastRid = null;
      lastRidPos = posId;
      scanned = false;
      past = null;
      try {
        const v = Number(localStorage.getItem(`stead-own-mainnet-lastrescue-${posId}`) ?? "NaN");
        if (Number.isInteger(v)) lastRid = v;
      } catch {
        /* ignore */
      }
    }
    if (lastRid === null && histPos === posId && histState === "done" && hist.size) lastRescue(posId, Math.max(...hist.keys()));
    if (lastRid === null && !scanned && histState === "failed") {
      scanned = true;
      for (let from = 0; from < 5000; from += 50) {
        const page = await nearView<(RescueView & { position_id: number })[]>("get_rescues", { from, limit: 50 });
        for (const x of page) if (x.position_id === posId && (lastRid === null || x.id > lastRid)) lastRid = x.id;
        if (page.length < 50) break;
      }
      if (lastRid !== null) lastRescue(posId, lastRid);
    }
    if (lastRid === null) return null;
    // a finished rescue no longer changes: read it again only now and then
    if (past && past.rescue.id === lastRid && (rescueFinished(past.rescue) || Date.now() - pastAt < 60_000)) return past;
    const known = hist.get(lastRid);
    if (known && histPos === posId && rescueFinished(known.rescue)) return (past = { rescue: known.rescue, claims: known.claims });
    const rescue = await nearView<RescueView | null>("get_rescue", { rescue_id: lastRid });
    if (!rescue) return null;
    const claims = (await Promise.all(rescue.members.filter((m) => m.claim_id).map((m) => nearView<ClaimView>("get_claim", { token_id: m.claim_id }).catch(() => null)))).filter(Boolean) as ClaimView[];
    pastAt = Date.now();
    return (past = { rescue, claims });
  }

  /** The fast read between the full ones (every few seconds and on each new block): Ethereum only,
   *  one at a time (a request while one is running is folded into one more afterwards), never while
   *  the tab is hidden; the page redraws only when a figure changed. */
  let evmReading = false;
  let evmAgain = false;
  async function refreshEvm() {
    if (gone || document.hidden || !s?.pos?.evm_address) return;
    if (evmReading || refreshing) {
      evmAgain = evmReading;
      return;
    }
    evmReading = true;
    try {
      const pos = s.pos;
      const e = await readEvm(pos.evm_address as Address);
      if (gone || !s || s.pos?.id !== pos.id || e.seq <= shownSeq) return;
      shownSeq = e.seq;
      const key = (x: object) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      const part = { wallet: e.wallet, acct: e.acct, maxLtv: e.maxLtv, hf: e.hf, prices: e.prices, posBal: e.posBal, allow: e.allow };
      const changed = key(part) !== key({ wallet: s.wallet, acct: s.acct, maxLtv: s.maxLtv, hf: s.hf, prices: s.prices, posBal: s.posBal, allow: s.allow });
      s = { ...s, ...part };
      noteArrival(pos.id, e.posBal.coll);
      if (changed) render();
    } catch {
      /* the full read reports read failures */
    } finally {
      evmReading = false;
      if (evmAgain) {
        evmAgain = false;
        void refreshEvm();
      }
    }
  }

  // ── derived ──
  const facts = () => {
    const pos = s?.pos ?? null;
    const e = s?.books?.escrow;
    const free = (u?: string, c?: string) => BigInt(u ?? "0") - BigInt(c ?? "0");
    const locked = !!pos && (pos.active_auction !== null || pos.open_rescues.length > 0);
    const maxFee = BigInt(gas.evmGas.max_fee_per_gas);
    return {
      registered: !!pos?.evm_address,
      evmConnected: !!evm,
      marketOk: !!cfg && !mismatch.length,
      paused: !!cfg?.paused,
      locked,
      claimOpen: s?.rescue?.state === "open" && (s?.claims ?? []).some((c) => c.status === "open"),
      escrowHeld: !!e && (BigInt(e.collateral_units) > 0n || BigInt(e.debt_units) > 0n),
      refundPending: !!pos && pos.open_rescues.length === 0 && !!e && (free(e.collateral_units, e.collateral_committed) > 0n || free(e.debt_units, e.debt_committed) > 0n),
      outflows: s?.books?.outflows.length ?? 0,
      pendingTx: !!pos && pos.pending !== null,
      hasColl: (s?.acct?.collBase ?? 0n) > 0n,
      hasDebt: (s?.acct?.debtBase ?? 0n) > 0n,
      idleDebtUnits: s?.posBal.debt ?? 0n,
      idleCollUnits: s?.posBal.coll ?? 0n,
      repayFromWallet: repaySrc() === "wallet",
      sweepSupported: sweepSupported(cfg?.codeHash ?? null),
      sweepUnits: sweepAmount(s?.posBal.eth ?? 0n, maxFee),
    };
  };
  /** The shown position is empty (nothing on Aave, no rescue, nothing held or in flight): a new one can be started. */
  const isEmpty = () => {
    const pos = s?.pos;
    if (!pos?.evm_address || !s) return false;
    const f = facts();
    return positionEmpty({ acctKnown: !!s.acct, collBase: s.acct?.collBase ?? 0n, debtBase: s.acct?.debtBase ?? 0n, activeAuction: pos.active_auction !== null, openRescues: pos.open_rescues.length, escrowHeld: f.escrowHeld, refundPending: f.refundPending, outflows: f.outflows, pendingTx: f.pendingTx, idleCollUnits: f.idleCollUnits, idleDebtUnits: f.idleDebtUnits });
  };
  /** The new-position form shows in place of the empty position it was opened from. */
  const freshShown = () => freshFrom !== null && s?.pos?.id === freshFrom && (isEmpty() || !!busy); // a Return in flight keeps the form
  const owedUnits = () => (s?.claims ?? []).filter((c) => c.status === "open").reduce((t, c) => t + BigInt(c.owed_units), 0n);
  const capBase = () => BigInt(cfg?.limits?.max_collateral_base ?? "0");
  const ltFallback = () => BigInt(cfg?.market?.lt_bps ?? 8400);
  const parse = (id: string, dec: number): bigint | null => {
    const v = (amt[id] ?? "").trim();
    if (!v) return null;
    try {
      const u = parseUnits(v, dec);
      return u >= 0n ? u : null;
    } catch {
      return null;
    }
  };
  const opOf = (id: "deposit" | "borrow" | "repay" | "withdraw"): Op | null => {
    if ((id === "repay" || id === "withdraw") && all[id]) return { kind: id, units: 0n, all: true };
    const u = parse(id, id === "deposit" || id === "withdraw" ? C.decimals : D.decimals);
    return u === null || u === 0n ? null : ({ kind: id, units: u } as Op);
  };
  const projOf = (id: "deposit" | "borrow" | "repay" | "withdraw"): Projection | null => {
    const op = opOf(id);
    if (!op || !s?.acct || !s.prices.coll) return null;
    return project(s.acct, s.prices, { coll: C.decimals, debt: D.decimals }, op, ltFallback(), capBase());
  };

  // ── actions ──
  /** Run one action from a click. It stops before any NEAR signature the click can no longer open a
   *  window for (see stead) and offers that step as a button; a key action ends with its result. */
  type DoneOf = () => { kind: DoneKind; what: string; payout?: string; atText?: string } | null;
  async function run(label: string, fn: () => Promise<void>, opt: { act?: string; done?: DoneOf } = {}) {
    if (busy) return;
    busy = label;
    busySince = Date.now();
    clickAt = Date.now();
    error = "";
    notice = "";
    parked = null;
    runDone = [];
    const mark = txs.length;
    let ok = false;
    render();
    try {
      await fn();
      ok = true;
    } catch (e) {
      if ((e as any).park) {
        parked = { act: opt.act ?? "", done: [...runDone], next: (e as any).park };
        busy = "";
        await refresh();
        return;
      }
      const raw = String((e as any).shortMessage ?? (e as Error).message ?? e);
      const cancelled = /user (rejected|denied|cancel)|rejected the request|request rejected/i.test(raw);
      error = (e as any).refused
        ? `The contract refused it: "${(e as Error).message}".`
        : cancelled
          ? `${label} paused: you cancelled the request in your wallet, so nothing was sent from that step on.`
          : `${label} stopped: ${raw.split("\n")[0].slice(0, 200)}`;
    }
    busy = "";
    await refresh();
    const d = ok && opt.done ? opt.done() : null;
    if (d && s?.pos) showDone(d, txs.slice(mark));
  }
  /** The result dialog: one line, the key figure from the reading after it, and the transactions. */
  function showDone(d: NonNullable<ReturnType<DoneOf>>, rows: TxRow[]) {
    const v = doneView(d.kind, { what: d.what, hfText: hfText(s?.hf ?? null), posId: s!.pos!.id, payout: d.payout, atText: d.atText });
    const links = rows.filter((t) => t.ok).map((t) => ({ label: t.label, ...(t.chain === "near" ? { near: t.hash } : { evm: t.hash }), ...(t.evmHash ? { evm: t.evmHash } : {}) }));
    actView = { v: "done", done: { kind: d.kind, ...v, links } };
    openAct(null);
  }
  const pid = () => s!.pos!.id;
  const posAddr = () => s!.pos!.evm_address as Address;
  const readBal = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
  const readAllowance = (token: Address) => pub.readContract({ address: token, abi: erc20, functionName: "allowance", args: [posAddr(), net.pool] });

  /** Addresses a payout may never be: the market's contracts and the position itself. */
  const refuseList = () => [
    { address: net.pool, name: "the Aave Pool" },
    { address: net.oracle, name: "Aave's price oracle" },
    { address: C.address, name: `the ${C.symbol} token contract` },
    { address: D.address, name: `the ${D.symbol} token contract` },
    ...(s?.pos?.evm_address ? [{ address: s.pos.evm_address, name: "the position's own address" }] : []),
  ];
  const register = () =>
    run("Protecting a new position", async () => {
      const pasted = checkPayout(payoutText, refuseList());
      if (!evm && !pasted.ok) throw new Error(`connect your Ethereum wallet or paste a payout address first (${pasted.why})`);
      const payout = evm ?? (pasted as { address: Address }).address;
      // the position shown before (an empty one when starting fresh): the new one must be another
      const oldId = s?.pos?.id ?? null;
      const mark = txs.length;
      const forget = () => {
        try {
          localStorage.removeItem(POSKEY());
        } catch {
          /* ignore */
        }
      };
      forget();
      await stead("register_position", { market_id: net.market, payout }, `Protect a new position (payout ${payout.slice(0, 8)}…; its Ethereum address is derived by NEAR's MPC network)`, 100n);
      let p: Position | null = null;
      for (let i = 0; i < 20; i++) {
        // a read running meanwhile may have remembered the old position: look for the newest again
        forget();
        noPosUntil = 0;
        p = await findPosition();
        if (p?.evm_address && p.id !== oldId) break;
        await sleep(2000);
      }
      if (!p?.evm_address || p.id === oldId) throw new Error("the new position didn't appear yet; it will show on the next read");
      // the register was listed under the position shown at the time: it belongs to the new one
      txs.forEach((t, i) => {
        if ((i >= mark || t.pos === undefined) && /^Protect a new position/.test(t.label)) t.pos = p!.id;
      });
      saveTxs();
      freshFrom = null;
      for (const k of Object.keys(amt)) amt[k] = "";
    }, { act: "register", done: () => ({ kind: "register", what: "" }) });

  /** The size cap is checked against a proven price reading of the position: wait for the first one. */
  async function firstReading() {
    if (capBase() > 0n && !(await nearView<Position>("get_position", { position_id: pid() })).health) {
      busy = "Waiting for the first proven reading of the position (the size cap needs a price before a supply)";
      render();
      for (let i = 0; i < 60 && !(await nearView<Position>("get_position", { position_id: pid() })).health; i++) await sleep(5000);
    }
  }
  /** WETH out of the position's address: the contract never sends idle WETH, so it is supplied to
   *  Aave and the same amount withdrawn to the payout (health unchanged). Each NEAR signature is its
   *  own click; going on after a pause never supplies twice. */
  let wout: { units: bigint; collBefore: bigint; supplied: boolean; pos: number } | null = null;
  const wethOut = () => {
    if (!s?.pos || !s.acct) return;
    const keep = wout && wout.pos === s.pos.id ? wout : null;
    const what = (u: bigint) => `${fmt(u, C.decimals, 8)} ${C.symbol}`;
    return run(`Withdrawing the position's ${C.symbol}`, async () => {
      let w = keep;
      if (!w) {
        const idle = await readBal(C.address, posAddr());
        if (idle === 0n) throw new Error(`the position holds no ${C.symbol}`);
        w = wout = { units: idle, collBefore: s!.acct!.collBase, supplied: false, pos: pid() };
      }
      if (!w.supplied) await firstReading();
      for (;;) {
        const step = wethOutNext({ supplied: w.supplied, allowanceUnits: w.supplied ? 0n : await readAllowance(C.address), units: w.units });
        if (step === "approve") await signAction(pid(), { type: "approve", token: "collateral", amount: "max" }, `Let Aave take the position's ${C.symbol}`);
        else if (step === "supply") {
          await signAction(pid(), { type: "supply", amount: w.units.toString() }, `Supply the position's ${what(w.units)} on Aave (to withdraw it)`);
          w.supplied = true;
        } else {
          await signAction(pid(), { type: "withdraw", amount: wethOutArg(w.units, w.collBefore) }, `Withdraw ${what(w.units)} to your payout`);
          break;
        }
      }
      wout = null;
    }, { act: "wethout", done: () => ({ kind: "withdraw", what: what(keep?.units ?? wout?.units ?? 0n), payout: s?.pos?.payout }) });
  };
  const delayText = () => durationText(Number(BigInt(cfg?.params?.payout_change_delay_ns ?? "86400000000000") / 1_000_000n));
  /** Ask for a new payout: it takes effect after the contract's delay, then one more call applies it. */
  const requestPayout = () => {
    const c = checkPayout(payoutNew, refuseList());
    if (!c.ok || !s?.pos) return;
    const to = c.address;
    return run("Requesting a payout change", async () => {
      await stead("request_payout_change", { position_id: pid(), payout: to }, `Request a payout change to ${short(to)} (takes effect after ${delayText()})`);
      payoutNew = "";
    }, { act: "payoutReq", done: () => ({ kind: "payout", what: "", payout: to, atText: s?.pos?.payout_change ? dayText(nsMs(s.pos.payout_change.effective_at)) : `in ${delayText()}` }) });
  };
  const applyPayout = () =>
    run("Applying the payout change", async () => {
      await stead("apply_payout_change", { position_id: pid() }, "Apply the payout change");
    }, { act: "payoutApply" });
  /** A tile's +: send WETH, USDC or gas ETH from the connected wallet to the position's address. */
  const sendIn = (token: "coll" | "debt" | "eth") => {
    const dec = token === "coll" ? C.decimals : token === "debt" ? D.decimals : 18;
    const sym = token === "coll" ? C.symbol : token === "debt" ? D.symbol : "ETH";
    const units = parse(`send-${token}`, dec);
    if (!units) return;
    const label = token === "eth" ? `Send ${fmt(units, 18, 6)} ETH to the position for its gas` : `Send ${fmt(units, dec, 6)} ${sym} to the position`;
    return run(label, async () => {
      const addr = posAddr();
      await evmSend(label, () => (token === "eth" ? evmWallet().sendTransaction({ to: addr, value: units }) : evmWallet().writeContract({ address: token === "coll" ? C.address : D.address, abi: erc20, functionName: "transfer", args: [addr, units] })));
      amt[`send-${token}`] = "";
    }, { act: "send" });
  };

  const deposit = () => {
    const units = parse("deposit", C.decimals);
    if (!units) return;
    return run(`Depositing ${fmt(units, C.decimals, 6)} ${C.symbol}`, async () => {
      const addr = posAddr();
      const idle = await readBal(C.address, addr);
      if (!evm && idle < units) throw new Error(`the position holds ${fmt(idle, C.decimals, 6)} ${C.symbol}: send the rest (${fmt(units - idle, C.decimals, 6)} ${C.symbol}) to the position's address`);
      if (idle < units) await evmSend(`Send ${fmt(units - idle, C.decimals, 6)} ${C.symbol} to the position`, () => evmWallet().writeContract({ address: C.address, abi: erc20, functionName: "transfer", args: [addr, units - idle] }));
      await firstReading();
      if ((await readAllowance(C.address)) < units) await signAction(pid(), { type: "approve", token: "collateral", amount: "max" }, `Let Aave take the position's ${C.symbol}`);
      await signAction(pid(), { type: "supply", amount: units.toString() }, `Supply ${fmt(units, C.decimals, 6)} ${C.symbol} on Aave`);
      amt.deposit = "";
    }, { act: "deposit", done: () => ({ kind: "deposit", what: `${fmt(units, C.decimals, 6)} ${C.symbol}` }) });
  };
  const borrow = () => {
    const units = parse("borrow", D.decimals);
    if (!units) return;
    return run(`Borrowing ${fmt(units, D.decimals, 2)} ${D.symbol}`, async () => {
      // the borrowed USDC stays at the position: moving it to the wallet is its own action
      await signAction(pid(), { type: "borrow", amount: units.toString() }, `Borrow ${fmt(units, D.decimals, 2)} ${D.symbol}`);
      amt.borrow = "";
    }, { act: "borrow", done: () => ({ kind: "borrow", what: `${fmt(units, D.decimals, 2)} ${D.symbol}` }) });
  };
  const repay = () => {
    const op = opOf("repay");
    if (!op || !s?.acct) return;
    const repayAll = !!(op as any).all;
    const allUnits = repayAllUnits(s.acct.debtBase, s.prices.debt, D.decimals);
    const need = repayAll ? allUnits : op.units;
    return run(repayAll ? "Repaying all the debt" : `Repaying ${fmt(need, D.decimals, 2)} ${D.symbol}`, async () => {
      const addr = posAddr();
      const idle = await readBal(D.address, addr);
      const plan = repayPlan({ src: repaySrc(), all: repayAll, typedUnits: need, allUnits, idleUnits: idle });
      if (plan.sendUnits > 0n) {
        await evmSend(`Send ${fmt(plan.sendUnits, D.decimals, 2)} ${D.symbol} to the position to repay`, () => evmWallet().writeContract({ address: D.address, abi: erc20, functionName: "transfer", args: [addr, plan.sendUnits] }));
        // the USDC is at the position now: the repay goes on from there (a pause never sends it twice)
        repayPicked = "position";
      } else if (plan.shortUnits > 0n) throw new Error(`the position holds ${fmt(idle, D.decimals, 2)} ${D.symbol}, less than the ${fmt(need, D.decimals, 2)} this repay needs: ${evm ? "repay from your wallet instead" : `send the rest to the position's address`}`);
      if ((await readAllowance(D.address)) < need) await signAction(pid(), { type: "approve", token: "debt", amount: "max" }, `Let Aave take the position's ${D.symbol}`);
      await signAction(pid(), { type: "repay", amount: plan.arg }, repayAll ? "Repay all the debt" : `Repay ${fmt(need, D.decimals, 2)} ${D.symbol}`);
      amt.repay = "";
      all.repay = false;
      repayPicked = null;
    }, { act: "repay", done: () => ({ kind: "repay", what: repayAll ? "all the debt" : `${fmt(need, D.decimals, 2)} ${D.symbol}` }) });
  };
  const withdraw = () => {
    const op = opOf("withdraw");
    if (!op) return;
    const wAll = !!(op as any).all;
    return run(wAll ? `Withdrawing all the ${C.symbol}` : `Withdrawing ${fmt(op.units, C.decimals, 6)} ${C.symbol}`, async () => {
      await signAction(pid(), { type: "withdraw", amount: wAll ? "max" : { exact: op.units.toString() } }, wAll ? `Withdraw all the ${C.symbol} to your payout` : `Withdraw ${fmt(op.units, C.decimals, 6)} ${C.symbol} to your payout`);
      amt.withdraw = "";
      all.withdraw = false;
    }, { act: "withdraw", done: () => ({ kind: "withdraw", what: wAll ? `all the ${C.symbol}` : `${fmt(op.units, C.decimals, 6)} ${C.symbol}`, payout: s?.pos?.payout }) });
  };
  const tryAnyway = (what: "withdraw" | "borrow") => {
    const small = what === "withdraw" ? net.breakWithdrawUnits : net.breakBorrowUnits;
    const typed = parse(what, what === "withdraw" ? C.decimals : D.decimals);
    const u = typed && typed > 0n ? typed : small;
    const dec = what === "withdraw" ? C.decimals : D.decimals;
    const sym = what === "withdraw" ? C.symbol : D.symbol;
    return run(`Trying to ${what} during the rescue`, async () => {
      const a = what === "withdraw" ? { type: "withdraw", amount: { exact: u.toString() } } : { type: "borrow", amount: u.toString() };
      await stead("sign_action", { position_id: pid(), action: a, gas: gas.evmGas }, `Try to ${what} ${fmt(u, dec, 6)} ${sym} while the rescue runs`).catch((e) => {
        if (!(e as any).refused) throw e;
        notice = `Refused, as expected: while a rescue runs the contract signs only repays and supplies. The refusal is on NEAR, linked below.`;
      });
    });
  };
  const buyBack = () =>
    run("Buying back", async () => {
      const owed = owedUnits();
      const addr = posAddr();
      const held = await readBal(C.address, addr);
      if (owed > held) await evmSend(`Pay exactly the ${fmt(owed - held, C.decimals, 8)} ${C.symbol} owed into your position`, () => evmWallet().writeContract({ address: C.address, abi: erc20, functionName: "transfer", args: [addr, owed - held] }));
      notice = "Paid into your position. The keeper proves the balance, the contract commits the buy-back and pays the claim owner exactly what it is owed; anything extra is refunded to your payout.";
    }, { act: "buyback", done: () => ({ kind: "buyback", what: `${fmt(owedUnits() || 0n, C.decimals, 8)} ${C.symbol}` }) });
  const sweep = () =>
    run("Returning the position's leftover ETH", async () => {
      const bal = await pub.getBalance({ address: posAddr() });
      const maxFee = BigInt(gas.evmGas.max_fee_per_gas);
      const amount = sweepAmount(bal, maxFee);
      if (amount === 0n) throw new Error("nothing to return");
      const g = { gas_limit: TRANSFER_GAS.toString(), max_fee_per_gas: gas.evmGas.max_fee_per_gas, max_priority_fee_per_gas: gas.evmGas.max_priority_fee_per_gas };
      // a native transfer pays its own fee from the balance it leaves: no gas top-up first
      const before = (await nearView<Position>("get_position", { position_id: pid() })).next_nonce;
      const label = `Return ${fmt(amount, 18, 6)} ETH to your payout`;
      const h = await stead("sign_action", { position_id: pid(), action: { type: "sweep_eth", amount: amount.toString() }, gas: g }, label);
      await landed(pid(), before, label, h);
    }, { act: "sweep" });
  /** USDC at the position → the payout: the typed amount, or all of it when nothing is typed. */
  const move = () => {
    const typed = parse("move", D.decimals);
    return run(`Withdrawing the position's ${D.symbol} to your payout`, async () => {
      const idle = await readBal(D.address, posAddr());
      if (idle === 0n) throw new Error(`the position holds no ${D.symbol}`);
      const units = typed && typed > 0n ? typed : idle;
      if (units > idle) throw new Error(`the position holds ${fmt(idle, D.decimals, 6)} ${D.symbol}, less than the ${fmt(units, D.decimals, 6)} typed`);
      await signAction(pid(), { type: "transfer_debt", amount: units.toString() }, `Withdraw ${fmt(units, D.decimals, 2)} ${D.symbol} from the position to your payout`);
      amt.move = "";
    }, { act: "move" });
  };

  // ── the page ──
  const btn = (label: string, attr: string, primary = false, off = false) =>
    `<button type="button" class="${primary ? "st-push st-push--small" : "st-secondary"} st-cut" ${attr}${busy || off ? ' aria-disabled="true" disabled' : ""}>${primary ? '<span class="st-lamp" aria-hidden="true"></span>' : ""}${esc(label)}</button>`;
  const ext = (href: string, inner: string) => `<a class="st-textlink st-extlink" href="${href}" target="_blank" rel="noopener">${inner}${icon("external", 12)}</a>`;
  const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
  const PHASE: Record<Phase, string> = { none: "NO POSITION", safe: "SAFE", under_trigger: "UNDER THE TRIGGER", rescue: "RESCUE RUNNING", claim_open: "CLAIM OPEN", settling: "SETTLING" };
  // the page's own stroke glyphs (16×16, stroke 1.6, round caps, like web/src/icons.ts)
  const glyph = (d: string, size: number, cls = "") =>
    `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const chevron = () => glyph("M4 6l4 4 4-4", 14, "st-dash-chev");
  const copyGlyph = () => glyph("M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3", 16);
  const toGlyph = () => glyph("M2.5 8h10M9 4.5 12.5 8 9 11.5", 14, "st-dash-to");
  /** A disclosure: a text button with a chevron; what it opens is drawn only while open. */
  const disc = (key: string, label: string, body: () => string) =>
    `<div class="st-dash-disc"><button type="button" class="st-dash-disc-btn" data-disc="${key}" aria-expanded="${opened.has(key)}" aria-controls="dash-disc-${key}">${esc(label)}${chevron()}</button>${opened.has(key) ? `<div class="st-dash-disc-body" id="dash-disc-${key}">${body()}</div>` : ""}</div>`;
  /** A two- or three-way switch (square segments; the pressed one in ink). */
  const seg = (label: string, attr: string, opts: { v: string; t: string; off?: boolean }[], cur: string) =>
    `<div class="st-dash-seg" role="group" aria-label="${esc(label)}">${opts.map((o) => `<button type="button" ${attr}="${o.v}" aria-pressed="${o.v === cur}"${o.off ? " disabled" : ""}>${esc(o.t)}</button>`).join("")}</div>`;
  const usdOf = (units: bigint, price: bigint, dec: number) => usd8((units * price) / 10n ** BigInt(dec));
  /** The health factor's colour class: under 1.10 danger, under 1.15 exposure, under 1.50 caution. */
  const hfCls = (h: bigint | null) => {
    const b = hfBand(h);
    return b === "safe" ? "" : ` is-${b}`;
  };
  /** The health bar: flat zones (liquidation, early settlement, under the trigger, caution, safe),
   *  marks at 1.00, 1.10 and 1.15 (a steward chip at the rescue line), and the current reading,
   *  which pulses now and then under 1.50 (in phase across re-renders). */
  const PULSE_MS = 6000;
  /** The whole bar takes a light sweep this often (phase kept across re-renders; none under reduced motion). */
  const SWEEP_MS = 9000;
  function hfBarHtml(hf: bigint | null, on: boolean): string {
    const label = hf === null ? "no debt" : hfText(hf);
    const zones = barZones().map((z) => `<span class="st-dash-zone is-${z.band}" style="left:${z.left}%;width:${z.width}%"></span>`).join("");
    const marks = BAR_MARKS.map((m) => `<span class="st-dash-bar-mark${m.rescue ? " is-trigger" : ""}" style="left:${hfBarPct(m.bps)}%"><i>${m.label}</i></span>`).join("");
    const rescue = `<span class="st-dash-bar-rescue" style="left:${hfBarPct(TRIGGER_BPS)}%" title="Stewards rescue it automatically here">${icon("stewards", 14)}<span>rescue</span></span>`;
    const now = on ? `<span class="st-dash-bar-now${hfCls(hf)}${hfPulses(hf) ? " is-pulse" : ""}" style="left:${hfBarPct(hf)}%;animation-delay:-${Date.now() % PULSE_MS}ms"></span>` : "";
    const sweep = `<span class="st-dash-bar-sweep" style="animation-delay:-${Date.now() % SWEEP_MS}ms"></span>`;
    return `<div class="st-dash-bar" role="img" aria-label="Health factor ${label}. Aave liquidates under 1.00, a claim settles early under 1.10, and stewards rescue it automatically under 1.15."><div class="st-dash-bar-track"><span class="st-dash-bar-fill" aria-hidden="true">${zones}${sweep}</span>${marks}${rescue}${now}</div></div>`;
  }

  function walletsHtml(): string {
    const limits = cfg?.limits ?? null;
    const allow = allowed(limits, near);
    const listed = limits?.borrowers.length ? limits.borrowers.map((b) => `<strong>${esc(b)}</strong>`).join(", ") : "anyone";
    const allowLine = !near
      ? `<p class="st-dash-wsub">Allow-listed: ${listed}</p>`
      : allow === "yes"
        ? `<p class="st-dash-ok">${icon("check", 14)}Allow-listed borrower</p>`
        : allow === "no"
          ? `<p class="st-own-stop" role="alert"><strong>${esc(near)}</strong> is not on the borrower allow-list (${listed}). Disconnect it with the X beside the name.</p>`
          : `<p class="st-dash-wsub">Reading the allow-list…</p>`;
    const w = s?.wallet;
    const payoutOff = s?.pos && evm && s.pos.payout.toLowerCase() !== evm.toLowerCase();
    const lowNear = s?.nearYocto != null && s.nearYocto < 50_000_000_000_000_000_000_000n;
    return `<section class="st-dash-wallets" aria-label="Your wallets">
      <div class="st-dash-wallet">
        <div class="st-label">${icon("near", 14)} NEAR · OWNS THE POSITION</div>
        ${near
          ? `<p class="st-dash-who"><span class="st-dash-whoname">${esc(near)}</span><button type="button" class="st-own-x" data-near-off title="Disconnect this NEAR wallet" aria-label="Disconnect this NEAR wallet"${busy ? " disabled" : ""}>${icon("close", 12)}</button></p><p class="st-dash-wsub">${s?.nearYocto != null ? `${fmt(s.nearYocto, 24, 3)} NEAR` : "…"}${lowNear ? ` · <strong>needs 0.05 NEAR to sign</strong>` : ""}</p>`
          : `<div class="st-own-buttons">${btn("Connect NEAR wallet", "data-near", true)}</div><p class="st-dash-wsub">Signs the position's Stead calls (a key for ${esc(net.contract)} only).</p>`}
        ${allowLine}
      </div>
      <div class="st-dash-wallet">
        <div class="st-label">${icon("ethereum", 14)} ${evm ? "ETHEREUM · FUNDS IT, GETS PAYOUTS" : "ETHEREUM WALLET · OPTIONAL"}</div>
        ${evm
          ? `<p class="st-dash-who"><span class="st-mono">${short(evm)}</span><button type="button" class="st-own-x" data-evm-off title="Disconnect this Ethereum wallet" aria-label="Disconnect this Ethereum wallet"${busy ? " disabled" : ""}>${icon("close", 12)}</button></p>
             <dl class="st-dash-wbal">
               <div><dt>ETH</dt><dd>${w ? fmt(w.eth, 18, 5) : "…"}</dd></div>
               <div><dt>${C.symbol}</dt><dd>${w ? fmt(w.coll, C.decimals, 5) : "…"}</dd></div>
               <div><dt>${D.symbol}</dt><dd>${w ? fmt(w.debt, D.decimals, 2) : "…"}</dd></div>
             </dl>`
          : `<p class="st-dash-wsub">Optional: connect an Ethereum wallet to fund and repay from it. ${s?.pos && !freshShown() ? `Without one, send funds to the position's address; payouts go to <span class="st-mono">${short(s.pos.payout)}</span>.` : `Without one, paste a payout address below: it receives withdrawals and refunds.`}</p><div class="st-own-buttons">${btn("Connect Ethereum wallet", "data-evm", false)}</div>`}
        ${payoutOff ? `<p class="st-own-stop">Position ${s!.pos!.id} pays out to <span class="st-mono">${esc(s!.pos!.payout)}</span>, not this wallet: withdrawals and refunds go there.</p>` : ""}
      </div>
    </section>`;
  }

  /** Without a wallet: the payout address pasted by hand, checked, and shown back with its warning. */
  function payoutHtml(): string {
    const c = checkPayout(payoutText, refuseList());
    const typed = payoutText.trim() !== "";
    return `<div class="st-dash-payout">
      <label class="st-label" for="dash-payout">PAYOUT ADDRESS · ETHEREUM</label>
      <div class="st-dash-amt st-dash-payin"><input id="dash-payout" data-payout autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0x…" value="${esc(payoutText)}"${typed && !c.ok ? ' aria-invalid="true" aria-describedby="dash-payout-msg"' : ""}${busy ? " disabled" : ""}></div>
      ${!typed
        ? `<p class="st-dash-wsub">The Ethereum address that receives withdrawals, refunds and leftover ETH.</p>`
        : c.ok
          ? `<div class="st-dash-payout-ok" role="status"><p class="st-dash-payout-addr st-mono">${esc(c.address)}</p><p class="st-dash-payout-warn"><strong>Payouts can only ever go to this address.</strong> It is fixed when the position is registered.</p></div>`
          : `<p class="st-own-stop" id="dash-payout-msg" role="alert">${esc(c.why)}</p>`}
    </div>`;
  }

  function newPositionHtml(): string {
    const allow = allowed(cfg?.limits ?? null, near);
    const pasted = evm ? null : checkPayout(payoutText, refuseList());
    const why = !near ? "Connect your NEAR wallet first." : allow === "no" ? "This NEAR account is not on the allow-list." : pasted && !pasted.ok ? "Paste a payout address (or connect an Ethereum wallet): it receives withdrawals and refunds." : mismatch.length ? "The contract's market does not match this page." : !cfg ? "Reading the contract…" : "";
    const payoutShown = evm ? `<span class="st-mono">${short(evm)}</span>` : pasted?.ok ? `<span class="st-mono">${short(pasted.address)}</span>` : "your Ethereum wallet";
    const from = freshShown() ? s!.pos! : null;
    return `<div class="st-dash-new">
      ${from
        ? `<div class="st-dash-new-top"><div class="st-label">NEW POSITION ON MARKET ${net.market}${near ? ` · ${esc(near)}` : ""}</div><button type="button" class="st-dash-linkbtn" data-fresh-back${busy ? " disabled" : ""}>Back to position ${from.id}</button></div>`
        : `<div class="st-label">NO POSITION ON MARKET ${net.market} YET${near ? ` · ${esc(near)}` : ""}</div>`}
      <h2>Protect a new position</h2>
      <p>${C.symbol} collateral, ${D.symbol} debt, Aave V3 on Ethereum · up to $${capUsd(cfg?.limits ?? null) || 150} · payout ${payoutShown}</p>
      ${from ? `<p>Position ${from.id} is empty and stays yours on the contract. Once the new one is registered, this page shows the new one.</p>${leftoverHtml(from.id)}` : ""}
      ${evm ? "" : disc("payout", "No Ethereum wallet? Paste a payout address", payoutHtml)}
      ${parkedHtml(["register"])}
      <div class="st-dash-go">${btn("Protect a new position", "data-register", true, !!why)}${why ? `<p class="st-dash-why">${esc(why)}</p>` : ""}</div>
      ${disc("how-new", "How it works", () => `<p>One NEAR call registers the position on ${esc(net.contract)}. NEAR's chain signatures derive its Ethereum address, and only the contract can sign for it. Withdrawals and refunds go to the payout. Then supply ${C.symbol} and borrow below.</p>`)}
    </div>`;
  }

  /** The empty position's leftover gas ETH, with the Return button when the contract would sign it. */
  function leftoverHtml(id: number): string {
    const eth = s?.posBal.eth ?? 0n;
    if (eth === 0n) return "";
    const f = facts();
    const v = availability(f).sweep;
    return `<div class="st-dash-left"><p>Position ${id} still holds <strong>${fmt(eth, 18, 6)} ETH</strong> of gas.${v.on ? "" : ` ${esc(v.why)}`}</p>${v.on ? `<span class="st-dash-ret">${btn(`Return ${fmt(f.sweepUnits, 18, 6)} ETH`, 'data-ask="sweep" aria-haspopup="dialog"', false)}</span>` : ""}</div>`;
  }

  function statusHtml(): string {
    const pos = s!.pos!;
    const r = s!.rescue;
    const phase = phaseOf({ registered: true, rescueState: r && !["bought_back", "settled", "failed"].includes(r.state) ? r.state : null, hfBps: s!.hf });
    const exposedHf = s!.hf !== null && s!.hf < TRIGGER_BPS;
    const exposed = exposedHf || phase === "claim_open" || phase === "under_trigger";
    const a = s!.acct;
    const collUnits = a && s!.prices.coll ? (a.collBase * 10n ** BigInt(C.decimals)) / s!.prices.coll : 0n;
    const debtUnits = a && s!.prices.debt ? (a.debtBase * 10n ** BigInt(D.decimals)) / s!.prices.debt : 0n;
    const waiting = !!a && a.collBase === 0n && s!.posBal.coll > 0n;
    let now: string;
    // a running rescue's clock and bids are on the auction card below: here, one line
    if (busy) now = `${esc(busy)} <span class="st-own-elapsed" data-elapsed="${busySince}">${mmss(Date.now() - busySince)}</span>`;
    else if (r?.state === "auction") now = `Rescue #${r.id}: stewards bidding`;
    else if (r?.state === "top_up_pending") now = `Rescue #${r.id}: the winner is topping up`;
    else if (r?.state === "open") now = `Rescue #${r.id}: claim open`;
    else if (r?.state === "settling") now = `Rescue #${r.id}: settling at the oracle price`;
    else if (waiting) now = `${fmt(s!.posBal.coll, C.decimals, 6)} ${C.symbol} waiting to be supplied`;
    else if (!a || a.collBase === 0n) now = `Registered · supply ${C.symbol} to open it`;
    else if (exposedHf) now = "Under 1.15: the auction opens on the next proven reading";
    else if (a.debtBase > 0n) now = "Protected · stewards rescue it under 1.15";
    else now = "Collateral supplied · no debt";
    const lamp = busy || phase === "rescue" || phase === "settling" ? "st-np-lamp is-live" : exposed ? "st-np-lamp is-exposed" : "st-np-lamp";
    const chip = `<span class="st-dash-phase${phase === "claim_open" || phase === "under_trigger" ? " is-exposed" : ""}">${PHASE[phase]}</span>`;
    const hf = s!.hf;
    const hfLabel = hf === null ? "no debt" : hfText(hf);
    const bar = hfBarHtml(hf, !!a && (a.collBase > 0n || hf !== null));
    const riskBtn = `<button type="button" class="st-secondary st-cut st-dash-riskbtn" data-risk aria-haspopup="dialog"${a && a.collBase > 0n ? "" : " disabled"}>Risk details</button>`;
    const collNum = !a
      ? `<span class="st-num">…</span>`
      : waiting
        ? `<span class="st-num">${fmt(s!.posBal.coll, C.decimals, 6)}</span><span class="st-dash-unit">${C.symbol}</span>`
        : `<span class="st-num">${usd8(a.collBase, 2)}</span>`;
    const collSub = !a ? "" : waiting ? `waiting to be supplied · ${usdOf(s!.posBal.coll, s!.prices.coll, C.decimals)}` : a.collBase > 0n ? `${fmt(collUnits, C.decimals, 6)} ${C.symbol} supplied` : "nothing supplied";
    return `<section class="st-own-live st-dash-status" data-own-live aria-label="Your position" role="status">
      <div class="st-np-head"><span class="${lamp}" aria-hidden="true"></span><span class="st-np-label">POSITION ${pos.id}</span>${chip}<span class="st-np-now">${now}</span>${!busy && isEmpty() ? `<button type="button" class="st-secondary st-cut st-dash-freshbtn" data-fresh>Open a new position</button>` : ""}</div>
      <dl class="st-dash-kpis">
        <div class="st-dash-kpi-hf"><dt>HEALTH FACTOR</dt><dd class="st-dash-big st-dash-hfrow">${hf === null ? `<span class="st-dash-nodebt">no debt</span>` : `<span class="st-num st-dash-hf${hfCls(hf)}">${hfLabel}</span>`}${riskBtn}</dd><dd class="st-dash-cons">${hf === null ? "nothing to liquidate" : fallLine(hf, C.symbol)}</dd><dd>${bar}</dd></div>
        <div><dt>COLLATERAL</dt><dd class="st-dash-big">${collNum}</dd><dd class="st-dash-cons">${collSub}</dd></div>
        <div><dt>DEBT</dt><dd class="st-dash-big"><span class="st-num">${a ? usd8(a.debtBase, 2) : "…"}</span></dd><dd class="st-dash-cons">${a ? (a.debtBase > 0n ? `${fmt(debtUnits, D.decimals, 2)} ${D.symbol} borrowed` : "nothing borrowed") : ""}</dd></div>
      </dl>
      <p class="st-dash-src">${C.symbol} <strong>${s!.prices.coll ? usd8(s!.prices.coll, 2) : "…"}</strong> · Aave V3, read every ${FAST_MS / 1000} s and on each block</p>
    </section>`;
  }

  /** The "Fund position" dialog: what to send, the address large with a copy button, its QR code,
   *  and the position's balances, live. Ethereum mainnet only. */
  function fundHtml(): string {
    if (!s?.pos?.evm_address) return `<p class="st-empty">Reading the position…</p>`;
    const f = facts();
    const fp = fundAsk({ registered: f.registered, locked: f.locked, claimOpen: f.claimOpen, ethWei: s.posBal.eth, upfrontWei: gas.txUpfrontWei, gasWaitWei: gasWait, dueUnits: buybackDue(owedUnits(), s.posBal.coll) });
    if (fp.kind === "none") return "";
    const addr = s.pos.evm_address;
    const eth = (w: bigint) => `${fmt(w, 18, 4)} ETH`;
    const gasTail = (w: bigint) => (w > 0n ? ` <span class="st-dash-fund-gas">and about ${eth(w)} for its gas</span>` : "");
    const say = fp.kind === "fund" && fundFor === "eth" ? `Send <strong>ETH</strong> here for the position's gas`
      : fp.kind === "fund" && fundFor ? `Send <strong>${fundFor === "coll" ? C.symbol : D.symbol}</strong> to the position's address`
      : fp.kind === "gas"
      ? fp.gasWei > 0n ? `Send about <strong>${eth(fp.gasWei)}</strong> for the position's gas` : `Send <strong>ETH</strong> here for the position's gas`
      : fp.kind === "buyback"
        ? `Send exactly <strong>${trim(fp.wethUnits, C.decimals, C.decimals)} ${C.symbol}</strong> to buy back${gasTail(fp.gasWei)}`
        : `Send <strong>${C.symbol}</strong> to supply${gasTail(fp.gasWei)}`;
    const usdcToo = fp.kind === "fund" && f.hasDebt;
    const only = fp.kind === "gas" ? `<strong>Ethereum mainnet only.</strong> ETH only.` : `<strong>Ethereum mainnet only.</strong> ${C.symbol}${usdcToo ? `, ${D.symbol}` : ""}${fp.gasWei > 0n ? " and ETH" : ""} only: no other token, no other network.`;
    const sub = fp.kind === "gas"
      ? f.locked && gasWait === 0n ? `While a rescue runs, ${C.symbol} sent here is held for the buy-back: send only ETH.` : "The waiting action goes on once it arrives."
      : fp.kind === "buyback"
        ? "Once the balance is proven, the contract pays the claim owner exactly what it is owed and refunds any extra to your payout."
        : `Then supply it: one NEAR call, no Ethereum wallet needed.${usdcToo ? ` ${D.symbol} sent here repays from the position (Repay, from THE POSITION).` : ""}`;
    const copied = Date.now() - copiedAt < 1600;
    const b = s.posBal;
    return `<div class="st-dash-fund-row">
        <figure class="st-dash-qr">${qrSvg(addr, `QR code of the position's address, ${addr}`)}<figcaption>Position address</figcaption></figure>
        <div class="st-dash-fund-main">
          <p class="st-dash-fund-say">${say}</p>
          <p class="st-dash-fund-addr"><span class="st-mono">${esc(addr)}</span><button type="button" class="st-dash-copy" data-copy="${addr}" aria-label="Copy the position's address">${copied ? icon("check", 16) : copyGlyph()}</button><span class="st-dash-copied" role="status">${copied ? "Copied" : ""}</span></p>
          <p class="st-dash-fund-only">${only}</p>
          <p class="st-dash-fund-sub">${sub}</p>
        </div>
      </div>
      <dl class="st-dash-bal" aria-live="polite">
        <div${flashArrival ? ' class="is-flash"' : ""}><dt>${C.symbol} HERE</dt><dd><strong>${fmt(b.coll, C.decimals, 8)}</strong></dd></div>
        <div><dt>${D.symbol} HERE</dt><dd><strong>${fmt(b.debt, D.decimals, 6)}</strong></dd></div>
        <div><dt>ETH · GAS</dt><dd><strong>${fmt(b.eth, 18, 6)}</strong></dd></div>
      </dl>`;
  }

  // ── the live bid ladder: one DOM block per rescue, kept across re-renders so rows glide ──
  type Lad = { rid: number; el: HTMLElement; seen: Map<string, SeenBid> | null; rows: LadderRow[]; flashed: Map<string, number>; pipeKey: string; tagKey: string };
  let lad: Lad | null = null;
  const stewardColor = (id: string | null) => (id ? `var(--st-steward-${id})` : "var(--st-quiet)");
  const tileOf = (row: { id: string | null; code: string }, size: number) => `<span class="st-tile st-tile--${size}" style="--sc: ${stewardColor(row.id)}" aria-hidden="true">${esc(row.code)}</span>`;
  const whoOf = (account: string) => {
    const name = account.split(".")[0];
    const id = stewardIdOf(account);
    return { name, id, code: id ? CODE[id] : name.slice(0, 2).toUpperCase() };
  };
  /** A new reading of the rescue: stamp its bids (they carry no time on chain) and update the ladder. */
  function stepLadder() {
    const r = s?.rescue ?? null;
    if (!r) {
      lad = null;
      return;
    }
    if (!lad || lad.rid !== r.id) lad = { rid: r.id, el: buildLadder(), seen: null, rows: [], flashed: new Map(), pipeKey: "", tagKey: "" };
    const st = ladderStep(lad.seen, r, Date.now(), nsMs(r.closes_at));
    lad.seen = st.seen;
    lad.rows = st.rows;
    updateLadder();
  }
  function buildLadder(): HTMLElement {
    const el = document.createElement("section");
    el.className = "st-dash-rescue";
    el.setAttribute("aria-label", "Rescue auction");
    el.innerHTML = `<div class="st-auction-head">
        <div class="st-panel-head"><div class="st-label" data-l-label></div><h2 class="st-panel-title" data-l-title></h2><div class="st-panel-sub" data-l-sub></div></div>
        <div class="st-dash-lright"><div class="st-dash-lclock" data-l-clock><span class="st-mini-clock" role="timer" data-l-count></span><span class="st-label" data-l-clocklbl></span></div><button type="button" class="st-secondary st-cut st-dash-watch" data-l-watch aria-haspopup="dialog" hidden></button></div>
      </div>
      <div class="st-ladder-head" aria-hidden="true"><span>#</span><span>STEWARD</span><span class="st-dash-axis"><span>0</span><span data-l-cap></span></span><span>PREMIUM</span><span>COST</span></div>
      <div class="st-ladder" role="list" aria-label="Bids, lowest premium first" data-l-ladder>${[0, 1, 2].map((i) => `<div class="st-placeholder" style="--rank:${i}" aria-hidden="true">watching</div>`).join("")}</div>
      <div class="st-dash-pipes" data-l-pipes></div>
      <div class="st-dash-tags" data-l-tags></div>`;
    // the steward's view: the Watch button, or a click on the leading or winning row
    el.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest("[data-l-watch]")) return openSteward(null, t.closest<HTMLElement>("[data-l-watch]"));
      const row = t.closest<HTMLElement>(".st-row.is-watch");
      if (row && !t.closest("a, button")) openSteward(row.dataset.row!, el.querySelector<HTMLElement>("[data-l-watch]"));
    });
    return el;
  }
  /** Bring the ladder block up to the latest reading: header, clock, rows (CSS glides them), pipes, claim tags. */
  function updateLadder() {
    const r = s?.rescue;
    if (!lad || !r || lad.rid !== r.id) return;
    const el = lad.el;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    const rows = lad.rows;
    const lead = rows[0];
    const winners = rows.filter((x) => x.won);
    const wName = winners.map((w) => w.name).join(" and ");
    const params = cfg?.params;
    const topupDue = nsMs(r.closes_at) + (params ? Number(BigInt(params.topup_deadline_ns) / 1_000_000n) : 0);
    const clock: { at: number; label: string } | null =
      r.state === "auction" ? { at: nsMs(r.closes_at), label: "TO CLOSE" }
      : r.state === "top_up_pending" && params ? { at: topupDue, label: "TOP-UP DUE" }
      : null; // a claim's window counts down on its lockout tag
    const topupUsd = s!.prices.coll ? usdOf(BigInt(r.topup_units), s!.prices.coll, C.decimals) : "";
    q("[data-l-label]").textContent = `RESCUE #${r.id} · ${r.state === "auction" ? "LOWEST PREMIUM WINS" : r.state.replace(/_/g, " ").toUpperCase()} · CAP ${r.cap_bps} BPS`;
    q("[data-l-title]").textContent =
      r.state === "auction" ? (lead ? `${lead.name} leads at ${lead.bps} bps` : "Stewards are pricing the top-up")
      : r.state === "top_up_pending" ? `${wName || "The winner"} won: topping up`
      : r.state === "open" ? `Rescued by ${wName || "the winner"}: claim open`
      : r.state === "settling" ? "Settling at the oracle price"
      : `Rescue ${r.state.replace(/_/g, " ")}`;
    q("[data-l-sub]").textContent = `Top-up ${fmtUnits(r.topup_units, C.decimals, 6)} ${C.symbol}${topupUsd ? ` (${topupUsd})` : ""} to health ${params ? (params.target_hf_bps / 10_000).toFixed(2) : "1.50"}`;
    const watched = r.state === "auction" ? (lead ? [lead] : []) : winners;
    const wb = q<HTMLButtonElement>("[data-l-watch]");
    wb.hidden = !watched.length;
    const wLabel = watched.length > 1 ? "Watch the stewards" : watched.length ? `Watch ${watched[0].name}` : "";
    if (wb.textContent !== wLabel) wb.textContent = wLabel;
    const ck = q("[data-l-clock]");
    ck.hidden = !clock;
    if (clock) {
      const cnt = q("[data-l-count]");
      cnt.dataset.countdown = String(clock.at);
      cnt.textContent = mmss(clock.at - Date.now());
      cnt.setAttribute("aria-label", clock.label.toLowerCase());
      q("[data-l-clocklbl]").textContent = clock.label;
    }
    q("[data-l-cap]").textContent = `${r.cap_bps} bps cap`;

    // rows: one per steward, placed by rank (the CSS glides `top`), bars as a share of the cap
    const ladder = q("[data-l-ladder]");
    ladder.style.setProperty("--n", String(Math.max(3, rows.length)));
    ladder.classList.toggle("has-bids", rows.length > 0);
    const keep = new Set(rows.map((x) => x.steward));
    for (const old of ladder.querySelectorAll<HTMLElement>("[data-row]")) if (!keep.has(old.dataset.row!)) old.remove();
    for (const row of rows) {
      let rowEl = [...ladder.querySelectorAll<HTMLElement>("[data-row]")].find((x) => x.dataset.row === row.steward);
      if (!rowEl) {
        rowEl = document.createElement("div");
        rowEl.className = "st-row";
        rowEl.setAttribute("role", "listitem");
        rowEl.dataset.row = row.steward;
        rowEl.style.setProperty("--sc", stewardColor(row.id));
        rowEl.style.setProperty("--flash-c", stewardColor(row.id));
        rowEl.style.setProperty("--rank", String(row.rank));
        rowEl.innerHTML = `<span class="st-rank" data-rank></span><span class="st-row-steward">${tileOf(row, 26)}<span class="st-row-name">${esc(row.name)}</span><span class="st-badge" data-badge></span></span><span class="st-bar"><span class="st-bar-fill" data-fill></span><span class="st-bar-prev" data-prev></span></span><span class="st-premium" data-bps></span><span class="st-cost" data-cost></span>`;
        ladder.append(rowEl);
        const added = rowEl;
        requestAnimationFrame(() => added.classList.add("is-in"));
      } else rowEl.classList.add("is-in");
      rowEl.style.setProperty("--rank", String(row.rank));
      rowEl.classList.toggle("is-first", row.rank === 0);
      rowEl.classList.toggle("is-won", row.won);
      rowEl.classList.toggle("is-watch", watched.some((x) => x.steward === row.steward));
      rowEl.querySelector("[data-rank]")!.textContent = String(row.rank + 1);
      const cost = s!.prices.coll ? premiumCostBase(row.amountUnits, row.bps, s!.prices.coll, C.decimals) : null;
      const badge = rowEl.querySelector<HTMLElement>("[data-badge]")!;
      const kind = row.won ? "won" : r.state === "auction" && row.rank === 0 ? "leading" : "";
      if (badge.dataset.kind !== kind) {
        badge.dataset.kind = kind;
        if (kind === "won") badge.innerHTML = crown(row.name, [["Premium", `${row.bps} bps`], ["Amount", `${fmtUnits(row.amountUnits, C.decimals, 6)} ${C.symbol}`], ...(cost !== null ? ([["Cost", usd8(cost, 2)]] as [string, string][]) : [])], 15);
        else badge.textContent = kind === "leading" ? "LEADING" : "";
      }
      rowEl.querySelector<HTMLElement>("[data-fill]")!.style.width = `${bidBarPct(row.bps, r.cap_bps)}%`;
      const prev = rowEl.querySelector<HTMLElement>("[data-prev]")!;
      prev.hidden = row.prevBps === null;
      prev.style.left = `${bidBarPct(row.prevBps ?? row.bps, r.cap_bps)}%`;
      rowEl.querySelector("[data-bps]")!.textContent = `${row.bps} bps`;
      rowEl.querySelector("[data-cost]")!.textContent = cost !== null ? usd8(cost, 2) : "";
      rowEl.setAttribute("aria-label", `${row.rank + 1}: ${row.name}, ${row.bps} bps for ${fmtUnits(row.amountUnits, C.decimals, 6)} ${C.symbol}${row.won ? ", won" : ""}`);
      // a new bid or rebid flashes once (and shakes in the last seconds), keyed by its seq
      const seq = lad.seen?.get(row.steward)?.seq ?? -1;
      if (row.fresh && lad.flashed.get(row.steward) !== seq) {
        rowEl.classList.remove("is-fresh", "is-late");
        void rowEl.offsetWidth;
        rowEl.classList.add(row.late ? "is-late" : "is-fresh");
      }
      lad.flashed.set(row.steward, seq);
    }

    // the winner's supply, as a pipe in its colour (flowing while in flight)
    const pipeKey = `${r.state}|${r.members.map((m) => `${m.steward}:${m.confirmed}:${m.evm_tx ?? ""}`).join(",")}`;
    if (pipeKey !== lad.pipeKey) {
      lad.pipeKey = pipeKey;
      q("[data-l-pipes]").innerHTML = r.state === "auction" ? "" : r.members.map((m) => {
        const w = whoOf(m.steward);
        const done = m.confirmed || r.state === "open" || r.state === "settling";
        return `<div class="st-pipe-row"><span class="st-pipe-who">${tileOf(w, 22)}${esc(w.name)}</span><span class="st-pipe${done ? " is-done" : " is-flowing"}" style="--sc: ${stewardColor(w.id)}" aria-hidden="true"></span><span class="st-pipe-to">position ${s!.pos?.id ?? ""}</span><span class="st-pipe-label">${done ? "SUPPLIED" : "SUPPLYING"} ${fmtUnits(m.share_units, C.decimals, 6)} ${C.symbol}</span></div>`;
      }).join("");
    }

    // claims: a lockout tag each (they drop in once, then only their countdown changes)
    const live = s!.claims.filter((c) => c.status === "open" || r.state === "settling");
    const tagKey = `${r.state}|${live.map((c) => `${c.token_id}:${c.status}:${c.owed_units}`).join(",")}`;
    if (tagKey !== lad.tagKey) {
      lad.tagKey = tagKey;
      q("[data-l-tags]").innerHTML = live.map((c) => {
        const w = whoOf(c.owner);
        const end = c.expires_at ? nsMs(c.expires_at) : 0;
        return `<div class="st-tag st-cut st-cut--l">
          <div class="st-tag-top">${tileOf(w, 22)}<span class="st-tag-title">LOCKED OUT · CLAIM <span class="st-mono">${esc(c.token_id)}</span></span></div>
          <div class="st-tag-lines">Owed to ${esc(w.name)}: ${fmtUnits(c.owed_units, C.decimals, 8)} ${C.symbol}, the top-up plus its premium<br>Withdrawals locked on position ${s!.pos?.id ?? ""} until ${r.state === "settling" ? "the settlement lands" : "buy-back"}</div>
          ${r.state === "settling" ? `<div class="st-tag-window"><span>SETTLING AT THE ORACLE PRICE</span></div>` : end ? `<div class="st-tag-window"><span>BUY-BACK WINDOW</span><span class="st-tag-count" data-countdown="${end}">${mmss(end - Date.now())}</span></div>` : ""}
        </div>`;
      }).join("");
    }
  }

  /** The Aave mark on the two Aave cards: a small ghost drawn in the page's stroke style, and the market's name. */
  const aaveTag = () => `<span class="st-dash-aave" title="Supplied and borrowed on Aave V3 (Ethereum)">${glyph("M3.5 14V7.5a4.5 4.5 0 0 1 9 0V14l-1.5-1.2L9.5 14 8 12.8 6.5 14 5 12.8zM6.4 7.4v.4M9.6 7.4v.4", 14)}AAVE V3</span>`;
  /** An action that stopped before a NEAR signature: what is done, and the button that goes on (a click of its own). */
  function parkedHtml(acts: string[]): string {
    if (!parked || !acts.includes(parked.act) || busy || !s) return "";
    const b = s.posBal;
    const held = parked.act === "repay" && b.debt > 0n ? `${fmt(b.debt, D.decimals, 2)} ${D.symbol}`
      : (parked.act === "deposit" || (parked.act === "wethout" && !wout?.supplied)) && b.coll > 0n ? `${fmt(b.coll, C.decimals, 6)} ${C.symbol}`
      : null;
    const v = parkedView({ held, done: parked.done, next: parked.next });
    return `<div class="st-dash-next" role="status">
      <div class="st-dash-next-top"><span class="st-label">NEXT STEP · NEAR WALLET</span><button type="button" class="st-dash-linkbtn" data-park-x>Not now</button></div>
      <p class="st-dash-next-head">${esc(v.head)}</p>
      <div class="st-dash-go">${btn(v.button, "data-resume", true)}</div>
      <p class="st-dash-next-why">Your NEAR wallet opens its window only from a click, so a signature after a wait gets its own button.</p>
    </div>`;
  }
  /** One small square + or − on a balance tile; off ones stay focusable and say why when pressed. */
  const tileBtn = (sign: "plus" | "minus", token: "coll" | "debt" | "eth", label: string, on: boolean, why: string) =>
    `<button type="button" class="st-dash-tb" data-tile="${sign}:${token}" aria-label="${esc(on ? label : `${label}: ${why}`)}" title="${esc(on ? label : why)}"${on && !busy ? "" : ' aria-disabled="true"'}${on && !busy ? "" : ` data-why="${esc(busy ? "Wait for the running action to finish." : why)}"`}>${glyph(sign === "plus" ? "M8 3.5v9M3.5 8h9" : "M3.5 8h9", 14)}</button>`;

  function positionWalletHtml(): string {
    const pos = s!.pos!;
    const b = s!.posBal;
    const addr = pos.evm_address!;
    const f = facts();
    const av = availability(f);
    const upfront = gas.txUpfrontWei;
    const txsLeft = upfront > 0n ? b.eth / upfront : 0n;
    const copied = Date.now() - copiedAt < 1600;
    const low = gasLow({ ethWei: b.eth, hasDebt: f.hasDebt, locked: f.locked, upfrontWei: upfront });
    const gasNote = KEEPER_TOPS_UP_GAS
      ? "Gas is topped up by the keeper when short."
      : evm
        ? `When it can't cover the next one, your Ethereum wallet is asked for a small top-up (${fmt(2n * upfront, 18, 6)} ETH at most) first.`
        : `When it can't cover the next one, the page asks you to send about ${fmt(gasAsk(0n, upfront), 18, 4)} ETH to this address and waits for it.`;
    // the + on WETH and USDC: while a rescue runs, tokens sent here are held for the buy-back
    const inWhy = f.locked ? "While a rescue runs, tokens sent to the position are held for the buy-back." : "";
    const wo = wethOutState();
    const repayAny = availability({ ...f, repayFromWallet: false }).repay;
    const supplyIt = b.coll > 0n && av.deposit.on ? `<button type="button" class="st-dash-linkbtn st-dash-tlink" data-tile-go="supply">Supply it</button>` : "";
    const repayIt = b.debt > 0n && f.hasDebt && repayAny.on ? `<button type="button" class="st-dash-linkbtn st-dash-tlink" data-tile-go="repay">Repay with it</button>` : "";
    const why = tileWhy && Date.now() - tileWhyAt < 8000 ? `<p class="st-dash-why st-dash-tilewhy" role="status">${esc(tileWhy)}</p>` : "";
    // the newest rescue, in one line; the button opens every one
    const { rows, noBids } = s ? protectionRows(stories().map((x) => x.rescue), pos.id) : { rows: [], noBids: [] };
    const last = lastProtection(rows, noBids);
    const loading = histState === "loading" || histState === "idle";
    const lastLine = last
      ? `<p class="st-dash-lastprot"><span class="st-dash-lastprot-l">Last protection:</span> <button type="button" class="st-dash-linkbtn" data-prot="${last.id}" aria-haspopup="dialog">Rescue ${last.id}</button> <span class="st-dash-pchip is-${last.outcome}">${esc(last.outcome === "running" ? last.stage : OUTCOME_WORD[last.outcome])}</span>${last.winners.map((w) => ` <span class="st-dash-lastprot-w">${protTile(w.steward)}${esc(w.name)} <b class="st-num">${w.bps}</b> bps</span>`).join("")} <span class="st-dash-lastprot-d">${dayText(last.openedMs)}</span></p>`
      : `<p class="st-dash-lastprot is-none">${loading ? "Reading this position's protections…" : "No protections yet. Stewards act if its health factor falls under 1.15."}</p>`;
    return `<section class="st-dash-poswallet" aria-label="The position's address and balances">
      <div class="st-dash-pw-head"><div class="st-label">POSITION ADDRESS · ETHEREUM</div><div class="st-dash-pw-btns"><button type="button" class="st-secondary st-cut st-dash-protbtn" data-prots aria-haspopup="dialog">${icon("rescues", 14)}Protections${rows.length ? ` <b class="st-num">${rows.length}</b>` : ""}</button><button type="button" class="st-push st-push--small st-cut" data-fund aria-haspopup="dialog"${busy && !gasWait ? " disabled" : ""}><span class="st-lamp" aria-hidden="true"></span>Fund position</button></div></div>
      ${lastLine}
      <p class="st-dash-addr"><span class="st-mono">${esc(addr)}</span><button type="button" class="st-dash-copy" data-copy="${addr}" aria-label="Copy the position's address">${copied ? icon("check", 16) : copyGlyph()}</button><span class="st-dash-copied" role="status">${copied ? "Copied" : ""}</span></p>
      <p class="st-dash-links">${ext(net.evmAddress(addr), "Etherscan")}${ext(`https://debank.com/profile/${addr}`, "DeBank")}<span>${ext("https://app.aave.com/?marketName=proto_mainnet_v3", "Aave")}: Watch wallet, then paste the address</span></p>
      ${low ? `<p class="st-dash-gaslow" role="alert"><span class="st-dash-gaslow-tag">GAS LOW</span>Position gas low: add a little ETH (the + on ETH · GAS).</p>` : ""}
      ${parkedHtml(["wethout", "move", "sweep", "send", "payoutReq", "payoutApply"])}
      <dl class="st-dash-bal">
        <div${flashArrival ? ' class="is-flash"' : ""}><dt>${C.symbol} HERE</dt><dd><strong>${fmt(b.coll, C.decimals, 8)}</strong></dd><dd class="st-dash-tbs">${tileBtn("plus", "coll", `Deposit ${C.symbol} to the position`, !inWhy, inWhy)}${tileBtn("minus", "coll", `Withdraw ${C.symbol} from the position (supplies it, then withdraws to your payout)`, wo.on, wo.why)}${supplyIt}</dd></div>
        <div><dt>${D.symbol} HERE</dt><dd><strong>${fmt(b.debt, D.decimals, 6)}</strong></dd><dd class="st-dash-tbs">${tileBtn("plus", "debt", `Deposit ${D.symbol} to the position`, !inWhy, inWhy)}${tileBtn("minus", "debt", `Withdraw ${D.symbol} from the position`, av.move.on, av.move.why)}${repayIt}</dd></div>
        <div><dt>ETH · GAS</dt><dd><strong>${fmt(b.eth, 18, 6)}</strong><span> · ~${txsLeft.toString()} tx</span></dd><dd class="st-dash-tbs">${tileBtn("plus", "eth", "Add ETH for gas", true, "")}${tileBtn("minus", "eth", `Return ETH${av.sweep.on ? ` (${fmt(f.sweepUnits, 18, 6)})` : ""} to your payout`, av.sweep.on, av.sweep.why)}</dd></div>
      </dl>
      ${why}
      ${disc("how-gas", "About these balances and gas", () => `<p>These sit at the position's own address on Ethereum, not on Aave. + sends to it (from your Ethereum wallet, or from any wallet to the address); − sends to your payout, the only place the contract pays out. ${C.symbol} here can't be sent on its own: − supplies it to Aave and withdraws the same amount, two transactions. The position pays the gas of what it sends: each may cost at most ${Number(gas.evmGas.gas_limit).toLocaleString("en-US")} gas at ${fmt(BigInt(gas.evmGas.max_fee_per_gas), 9, 2)} gwei (${fmt(upfront, 18, 6)} ETH, wanted up front; the real cost is lower). ${gasNote} The ETH returns only with no debt and no rescue.</p>`)}
    </section>`;
  }
  /** Whether the WETH at the position's address can be taken out now (supplied, then withdrawn). */
  const wethOutState = () => {
    const f = facts();
    const b = s!.posBal;
    const a = s!.acct;
    const resuming = !!wout && wout.pos === s!.pos!.id && wout.supplied;
    const overCap = !!a && capBase() > 0n && !!s!.prices.coll && depositMax(b.coll, 0n, a.collBase, capBase(), s!.prices.coll, C.decimals) < b.coll;
    const v = wethOutAvail({ ...f, idleUnits: resuming ? 1n : b.coll, overCap: resuming ? false : overCap, gasWei: b.eth, upfrontWei: gas.txUpfrontWei, needsApprove: !resuming && s!.allow.coll < b.coll });
    return v;
  };

  type Act = "deposit" | "borrow" | "repay" | "withdraw";
  /** The live part of an action card (redrawn as the visitor types): the projection, its warning or
   *  stop, the button, and the reason when the button is off. */
  function liveHtml(id: Act, v: Avail, label: string, extraOff = false, whyV: Avail = v): string {
    const p = projOf(id);
    const op = opOf(id);
    const isColl = id === "deposit" || id === "withdraw";
    const price = isColl ? s!.prices.coll : s!.prices.debt;
    const dec = isColl ? C.decimals : D.decimals;
    const usd = op && !(op as any).all && price ? `<span class="st-dash-usd">${usdOf(op.units, price, dec)}</span>` : "";
    const nowHf = hfText(s?.hf ?? null);
    const proj = p
      ? `<p class="st-dash-proj" aria-label="Health factor now ${nowHf}, after ${hfText(p.hfBps)}">${usd}<span class="st-dash-projlbl">HF</span><span class="st-dash-projnow${hfCls(s?.hf ?? null)}">${nowHf}</span>${toGlyph()}<strong class="st-dash-projnum${hfCls(p.hfBps)}">${hfText(p.hfBps)}</strong></p>`
      : `<p class="st-dash-proj is-empty"><span class="st-dash-projlbl">HF</span><span class="st-dash-projnow${s?.hf != null ? hfCls(s.hf) : ""}">${nowHf}</span></p>`;
    const off = !v.on || !p || !!p.block || extraOff;
    const why = !whyV.on ? whyV.why : "";
    return `<div class="st-dash-live">
      <div class="st-dash-go">${btn(label, id === "withdraw" ? 'data-ask="withdraw" aria-haspopup="dialog"' : `data-go=${id}`, true, off)}${proj}</div>
      ${why ? `<p class="st-dash-why">${esc(why)}</p>` : ""}
      ${p?.block ? `<p class="st-own-stop" role="alert">${esc(p.block)}</p>` : p?.underTrigger ? `<p class="st-dash-warn" role="alert"><span class="st-dash-warn-tag">UNDER 1.15</span>${esc(UNDER_TRIGGER_WARNING)}</p>` : ""}
    </div>`;
  }

  function actionsHtml(): string {
    const f = facts();
    const av = availability(f);
    const a = s!.acct;
    const P = s!.prices;
    const pos = s!.pos!;
    const input = (id: string, sym: string, maxLabel: string, off: boolean) =>
      `<div class="st-dash-amt"><label class="st-visually-hidden" for="dash-amt-${id}">Amount in ${sym}</label><input id="dash-amt-${id}" data-amt="${id}" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(all[id] ? "" : amt[id] ?? "")}"${all[id] ? ` aria-describedby="dash-all-${id}"` : ""}${off ? " disabled" : ""}><span class="st-dash-sym">${all[id] ? `<span id="dash-all-${id}">ALL</span>` : sym}</span><button type="button" class="st-dash-max" data-max="${id}"${off || busy ? " disabled" : ""}>${maxLabel}</button></div>`;
    const opLabel = (id: Act, verb: string, sym: string, dec: number, dp: number) => {
      const op = opOf(id);
      if (!op) return `${verb} ${sym}`;
      if ((op as any).all) return id === "repay" ? "Repay all the debt" : `Withdraw all the ${sym}`;
      return `${verb} ${fmt(op.units, dec, dp)} ${sym}`;
    };
    const tryBtn = (id: "withdraw" | "borrow", v: Avail) => (v.tryAnyway ? `<div class="st-dash-try">${btn("Try it anyway (the contract will refuse)", `data-try="${id}"`, false)}</div>` : "");
    const w = s!.wallet;
    const collUnits = a && P.coll ? (a.collBase * 10n ** BigInt(C.decimals)) / P.coll : 0n;
    const debtUnits = a && P.debt ? (a.debtBase * 10n ** BigInt(D.decimals)) / P.debt : 0n;

    // WETH: supply | withdraw
    const wm = wethMode;
    const wv = wm === "deposit" ? av.deposit : av.withdraw;
    const dMax = a && w ? depositMax(w.coll, s!.posBal.coll, a.collBase, capBase(), P.coll, C.decimals) : 0n;
    const idleColl = s!.posBal.coll;
    // without a wallet, WETH already at the position is the supply on offer
    const fillKey = `${pos.id}:${idleColl}`;
    if (!evm && wm === "deposit" && !amt.deposit && idleColl > 0n && av.deposit.on && fillKey !== prefillKey) {
      prefillKey = fillKey;
      amt.deposit = autoDeposit = trim(readyUnits(idleColl), C.decimals, 6);
    }
    const typedDeposit = parse("deposit", C.decimals);
    const plan = typedDeposit ? depositPlan(typedDeposit, idleColl, !!evm) : null;
    const shortV: Avail | null = plan?.kind === "short" ? { on: false, why: `Send the rest to the position's address: ${fmt(plan.shortUnits, C.decimals, 6)} ${C.symbol} more.`, tryAnyway: false } : null;
    const showArrived = arrivedUnits > 0n && Date.now() - arrivedAt < 120_000 && wm === "deposit";
    const arrivedLine = showArrived ? `<p class="st-dash-arrived${flashArrival ? " is-flash" : ""}" role="status"><strong>+${fmt(arrivedUnits, C.decimals, 6)} ${C.symbol}</strong> arrived at the position: supply it with one NEAR call</p>` : "";
    // WETH already at the position's address counts toward a supply (its balance is on the tile below)
    const idleLine = !showArrived && wm === "deposit" && idleColl > 0n && av.deposit.on ? `<p class="st-dash-idle">${fmt(idleColl, C.decimals, 6)} ${C.symbol} at the position's address counts toward this supply.</p>` : "";
    // a paused action shows only its next step in its card (the form comes back with "Not now" or once it is done)
    const wPark = parkedHtml(["deposit", "withdraw"]);
    const uPark = parkedHtml(["borrow", "repay"]);
    const wethCard = `<div class="st-dash-act${wv.on ? "" : " is-off"}" data-act="${wm}" id="dash-aave-weth">
      <div class="st-dash-act-head"><h3>${C.symbol}${aaveTag()}</h3>${seg(`${C.symbol} action`, "data-mode", [{ v: "weth:deposit", t: "SUPPLY" }, { v: "weth:withdraw", t: "WITHDRAW" }], `weth:${wm}`)}</div>
      ${wPark || `<p class="st-dash-have">${evm ? pill("wallet", w ? fmt(w.coll, C.decimals, 5) : "…") : ""}${pill("supplied", fmt(collUnits, C.decimals, 5))}</p>`}
      ${wPark ? "" : wm === "deposit"
        ? arrivedLine + idleLine + input("deposit", C.symbol, "MAX", !av.deposit.on) + liveHtml("deposit", av.deposit, opLabel("deposit", "Supply", C.symbol, C.decimals, 6), !!shortV, shortV ?? av.deposit)
          + disc("how-deposit", "How it works", () => evm
            ? `<p>Your Ethereum wallet sends the ${C.symbol} to the position (one signature; ${C.symbol} already waiting there counts), then the contract supplies it on Aave (one NEAR call, two the first time for Aave's approval). MAX: what you hold, within the $${capUsd(cfg?.limits ?? null) || 150} cap (${usd8(dMax && P.coll ? (dMax * P.coll) / 10n ** 18n : 0n)}).</p>`
            : `<p>Send ${C.symbol} to the position's address; once it is there the contract supplies it on Aave (one NEAR call, two the first time for Aave's approval). Nothing is sent from a wallet here. Up to the $${capUsd(cfg?.limits ?? null) || 150} cap.</p>`)
        : input("withdraw", C.symbol, "MAX", !av.withdraw.on) + liveHtml("withdraw", av.withdraw, opLabel("withdraw", "Withdraw", C.symbol, C.decimals, 6)) + tryBtn("withdraw", av.withdraw)
          + disc("how-withdraw", "How it works", () => `<p>One NEAR call: the contract signs Aave's withdraw, which sends the ${C.symbol} straight to your payout <span class="st-mono">${short(pos.payout)}</span> (you confirm the destination first). MAX: down to health 1.16, or all of it with no debt.</p>`)}
    </div>`;

    // USDC: borrow | repay
    const um = usdcMode;
    const fromPos = s!.posBal.debt > 0n;
    // the repay rules without the source: whether the switch and the amount are usable at all
    const repayAny = availability({ ...f, repayFromWallet: false }).repay;
    const uv = um === "borrow" ? av.borrow : av.repay;
    const src = repaySrc();
    const noUsdc: Avail | null = src === "position" && !fromPos && repayAny.on ? { on: false, why: evm ? `The position holds no ${D.symbol}: repay from your wallet.` : `The position holds no ${D.symbol}: send ${D.symbol} to the position's address (Fund position), then repay from it.`, tryAnyway: false } : null;
    // USDC at the position's address while there is debt: one click repays from it
    const offer = um === "repay" && !(parked?.act === "repay") ? positionRepayOffer({ repayOn: repayAny.on, debtBase: a?.debtBase ?? 0n, allUnits: a ? repayAllUnits(a.debtBase, P.debt, D.decimals) : 0n, idleUnits: s!.posBal.debt }) : null;
    const offerHtml = offer ? `<div class="st-dash-offer"><p><strong>${fmt(s!.posBal.debt, D.decimals, 2)} ${D.symbol}</strong> is at the position's address.</p>${btn(offer.all ? "Repay all the debt from it" : `Repay ${fmt(offer.units, D.decimals, 2)} ${D.symbol} from it`, "data-offer", false)}</div>` : "";
    const usdcCard = `<div class="st-dash-act${uv.on ? "" : " is-off"}" data-act="${um}" id="dash-aave-usdc">
      <div class="st-dash-act-head"><h3>${D.symbol}${aaveTag()}</h3>${seg(`${D.symbol} action`, "data-mode", [{ v: "usdc:borrow", t: "BORROW" }, { v: "usdc:repay", t: "REPAY" }], `usdc:${um}`)}</div>
      ${uPark || `<p class="st-dash-have">${evm ? pill("wallet", w ? fmt(w.debt, D.decimals, 2) : "…") : ""}${pill("debt", fmt(debtUnits, D.decimals, 2))}</p>`}
      ${uPark ? "" : um === "borrow"
        ? input("borrow", D.symbol, "MAX 1.16", !av.borrow.on) + liveHtml("borrow", av.borrow, opLabel("borrow", "Borrow", D.symbol, D.decimals, 2)) + tryBtn("borrow", av.borrow)
          + disc("how-borrow", "How it works", () => `<p>One NEAR call: the contract signs the Aave borrow and the ${D.symbol} lands at the position's address (Aave only lends to the position itself). Withdraw it to your payout from the position's balances below, or keep some there for a later repay. MAX stops at health 1.16, just above the trigger.</p>`)
        : offerHtml + `<div class="st-dash-from"><span class="st-label">FROM</span>${seg("Repay from", "data-repay-from", [{ v: "wallet", t: "MY WALLET", off: !repayAny.on || !evm }, { v: "position", t: "THE POSITION", off: !repayAny.on || !fromPos }], src)}</div>`
          + input("repay", D.symbol, "ALL", !repayAny.on) + liveHtml("repay", av.repay, opLabel("repay", "Repay", D.symbol, D.decimals, 2), !!noUsdc, noUsdc ?? av.repay)
          + disc("how-repay", "How it works", () => `<p>${src === "wallet" ? `Your Ethereum wallet sends the ${D.symbol} to the position (one signature), then` : `From the ${fmt(s!.posBal.debt, D.decimals, 2)} ${D.symbol} already at the position:`} the contract repays Aave (one NEAR call, two the first time). Each NEAR signature after a wait is its own click: once the ${D.symbol} is at the position, the card offers the repay. ALL repays the debt plus 0.2% for interest; Aave takes only what is owed.</p>`)}
    </div>`;

    // buy back (only while a claim is open)
    let buyCard = "";
    if (f.claimOpen) {
      const owed = owedUnits();
      const held = s!.posBal.coll;
      buyCard = `<div class="st-dash-act st-dash-buy${av.buyback.on || !evm ? "" : " is-off"}" data-act="buyback">
        <div class="st-dash-act-head"><h3>Buy back</h3></div>
        <p class="st-dash-owed"><span class="st-label">OWED</span><span class="st-num">${fmt(owed, C.decimals, 8)}</span><span class="st-dash-unit">${C.symbol}</span>${held > 0n ? `<span class="st-dash-have">${fmt(held, C.decimals, 8)} already at the position counts</span>` : ""}</p>
        <div class="st-dash-go">${!evm && f.claimOpen ? btn(`Send ${trim(buybackDue(owed, held), C.decimals, C.decimals)} ${C.symbol} to buy back`, 'data-fund aria-haspopup="dialog"', true) : btn(`Buy back for ${fmt(owed > held ? owed - held : 0n, C.decimals, 10)} ${C.symbol}`, "data-go=buyback", true, !av.buyback.on)}</div>
        ${av.buyback.on ? "" : !evm ? `<p class="st-dash-why">Send exactly ${trim(buybackDue(owed, held), C.decimals, C.decimals)} ${C.symbol} to the position's address (no Ethereum wallet needed): once the balance is proven, the buy-back commits.</p>` : `<p class="st-dash-why">${esc(av.buyback.why)}</p>`}
        ${disc("how-buyback", "How it works", () => `<p>Pay exactly what is owed into the position (${evm ? "one Ethereum signature" : "a plain transfer to its address"}). The contract checks the proven balance and pays the claim owner exactly that; any excess is refunded to your payout.</p>`)}
      </div>`;
    }

    return `${buyCard}<div class="st-dash-actions">${wethCard}${usdcCard}</div>`;
  }
  /** One balance as a pill: a quiet label and a bold figure. */
  const pill = (label: string, v: string) => `<span class="st-dash-pill"><span>${label}</span><b class="st-num">${v}</b></span>`;

  /** Every activity row for the position (its transactions and the rescue's events), newest first. */
  /** latestOnly: just the newest row (under the position card); otherwise the full journal with the rest in a drop-down. */
  function activityHtml(latestOnly = false): string {
    if (!s?.pos) return "";
    const own: ActRow[] = shown().map((t) => {
      const reason = t.ok ? "" : t.label.match(/refused by the contract \("(.*)"\)$/)?.[1] ?? "";
      const link = (t.hash ? `<a class="st-dash-txlink" href="${t.chain === "near" ? net.nearTx(t.hash) : net.evmTx(t.hash)}" target="_blank" rel="noopener">${t.chain === "near" ? "NearBlocks" : "Etherscan"}${icon("external", 11)}</a>` : "")
        + (t.evmHash ? `<a class="st-dash-txlink" href="${net.evmTx(t.evmHash)}" target="_blank" rel="noopener">Etherscan${icon("external", 11)}</a>` : "");
      return { at: t.at, ord: -1, exact: true, afterMs: t.at, html: `${t.ok ? "" : '<span class="st-own-chip-refused">refused</span> '}${esc(t.label.replace(/: refused by the contract.*$/, ""))}${reason ? ` <span class="st-dash-reason">"${esc(reason)}"</span>` : ""}${link}` };
    });
    // the visitor's transactions and every rescue step, by real time: the contract's own times, an
    // untimed step by its place in the rescue (never by when this page saw it)
    const steps = flowActivity(stories(), C, net.evmName, { ...flowOpts(), linkHtml: (href, label) => `<a class="st-dash-txlink" href="${href}" target="_blank" rel="noopener">${label}${icon("external", 11)}</a>` });
    const rows = sortActivity([...own, ...steps]);
    if (!rows.length) return "";
    const now = Date.now();
    const li = (r: ActRow) => `<li><span class="st-np-t${r.exact ? "" : " is-after"}"${r.exact ? "" : ' title="No time of its own on chain: it follows the step before it"'}>${r.exact ? clockText(r.at, now) : `after ${clockText(r.afterMs, now)}`}</span><span>${r.html}</span></li>`;
    const more = latestOnly ? 0 : rows.length - 1;
    if (latestOnly) return `<div class="st-np-journal st-dash-journal is-latest">
      <div class="st-dash-jhead"><span class="st-journal-head">LAST ACTION · POSITION ${s.pos.id}</span></div>
      <ol class="st-np-lines">${li(rows[0])}</ol>
    </div>`;
    return `<div class="st-np-journal st-dash-journal">
      <div class="st-dash-jhead"><span class="st-journal-head">ACTIVITY · POSITION ${s.pos.id}</span>${more > 0 ? `<button type="button" class="st-dash-jmore" data-more-txs aria-expanded="${showAllTxs}" aria-controls="dash-activity">${showAllTxs ? "Hide" : `${more} earlier`}${chevron()}</button>` : ""}</div>
      <ol class="st-np-lines" id="dash-activity">${li(rows[0])}${showAllTxs ? rows.slice(1, 80).map(li).join("") : ""}</ol>
    </div>`;
  }

  /** Every rescue run on this position, newest first: one compact row each (outcome, winners and
   *  premium, top-up, date); a row opens the rescue's full flow. No-bid rescues behind a toggle. */
  const PROT_ROWS = 4;
  const protTile = (acct: string) => {
    const id = stewardIdOf(acct);
    return id ? `<span class="st-tile st-tile--22" style="--sc: var(--st-steward-${id})" aria-hidden="true">${CODE[id]}</span>` : "";
  };
  const dayText = (ms: number) => `${new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${new Date(ms).toISOString().slice(11, 16)} UTC`;
  function protRowHtml(x: ProtectionRow): string {
    const who = x.winners.length
      ? x.winners.map((w) => `<span class="st-dash-prow-w">${protTile(w.steward)}<span>${esc(w.name)}</span><span class="st-dash-prow-bps"><b class="st-num">${w.bps}</b> bps</span></span>`).join("")
      : `<span class="st-dash-prow-none">${x.outcome === "running" ? esc(x.stage) : x.bids ? `${x.bids} bid${x.bids === 1 ? "" : "s"}, ${x.covered ? "no top-up proven" : "short of the top-up"}` : "no steward bid"}</span>`;
    // a running rescue's chip names its stage (the amber already says it is running)
    const chip = x.outcome === "running" ? x.stage : OUTCOME_WORD[x.outcome];
    return `<li><button type="button" class="st-dash-prow" data-prot="${x.id}" aria-haspopup="dialog" aria-label="Rescue ${x.id}: ${esc(chip)}. Open its full flow">
      <span class="st-dash-prow-id"><span>RESCUE</span><b class="st-num">${x.id}</b></span>
      <span class="st-dash-pchip is-${x.outcome}">${esc(chip)}</span>
      <span class="st-dash-prow-who">${who}</span>
      <span class="st-dash-prow-amt">${x.winners.length ? `<b>${fmt(BigInt(x.topupUnits), C.decimals, 6)}</b> ${C.symbol}` : ""}</span>
      <span class="st-dash-prow-date">${dayText(x.openedMs)}</span>
      ${glyph("M6 3.5 10.5 8 6 12.5", 14, "st-dash-prow-go")}
    </button></li>`;
  }
  function protListHtml(): string {
    if (!s?.pos) return `<p class="st-empty">Reading the position…</p>`;
    const { rows, noBids } = protectionRows(stories().map((x) => x.rescue), s.pos.id);
    const head = (extra = "") => `<div class="st-dash-jhead"><span class="st-label">EVERY RESCUE · NEWEST FIRST</span>${extra}</div>`;
    const loading = histState === "loading" || histState === "idle";
    if (!rows.length && !noBids.length) {
      if (loading) return `<section class="st-dash-prot" aria-label="Protections">${head()}<p class="st-dash-prot-note">Reading this position's rescues from the contract…</p></section>`;
      return `<section class="st-dash-prot" aria-label="Protections">${head()}<p class="st-dash-prot-note">No rescue has run on this position. Stewards act if its health factor falls under 1.15.</p></section>`;
    }
    const list = showNoBids ? [...rows, ...noBids].sort((a, b) => b.id - a.id) : rows;
    const shownRows = showAllProt ? list : list.slice(0, PROT_ROWS);
    const more = list.length - shownRows.length;
    const count = `${rows.length} rescue${rows.length === 1 ? "" : "s"} with bids${loading ? " · reading the rest…" : ""}`;
    const toggles = [
      more > 0 || (showAllProt && list.length > PROT_ROWS) ? `<button type="button" class="st-dash-jmore" data-prot-more aria-expanded="${showAllProt}">${showAllProt ? "Fewer" : `${more} earlier`}${chevron()}</button>` : "",
      noBids.length ? `<button type="button" class="st-dash-jmore" data-prot-nobids aria-pressed="${showNoBids}">${showNoBids ? `Hide the ${noBids.length} without bids` : `Show ${noBids.length} without bids`}</button>` : "",
    ].join("");
    return `<section class="st-dash-prot" aria-label="Protections">
      ${head(`<span class="st-dash-prot-count">${count}</span>`)}
      ${shownRows.length ? `<ol class="st-dash-prows">${shownRows.map(protRowHtml).join("")}</ol>` : `<p class="st-dash-prot-note">Every rescue so far ended with no bids.</p>`}
      ${toggles ? `<div class="st-dash-prot-foot">${toggles}</div>` : ""}
    </section>`;
  }
  const PROT_NOTE = "Read from Stead's contract on NEAR mainnet. Times are the contract's own, or the time of the Ethereum block a proof read; a step with no time of its own reads after the last recorded time before it.";
  function protBody(id: number): () => string {
    return () => {
      const x = stories().filter((h) => h.rescue.id === id).at(-1);
      if (!x) return `<p class="st-dash-prot-note">Rescue ${id} is not on this position.</p>`;
      const r = x.rescue;
      const row = protectionRows([r]).rows[0] ?? protectionRows([r]).noBids[0];
      const owed = x.claims.reduce((t, c) => t + BigInt(c.owed_units), 0n);
      const flow = rescueFlow(r, x.claims, { coll: C, evmName: net.evmName, ...flowOpts() });
      const win = row.winners.map((w) => `<span class="st-dash-prot-w">${protTile(w.steward)}<span>${esc(w.name)}</span></span>`).join("");
      const bps = row.winners.map((w) => `${w.bps} bps`).join(", ");
      return `<p class="st-dash-protback"><button type="button" class="st-dash-linkbtn" data-prot-back>${glyph("M10 3.5 5.5 8l4.5 4.5", 14)}All protections</button></p>
        <dl class="st-kpis st-sv-kpis st-dash-prot-kpis">
          <div><dt>OUTCOME</dt><dd class="st-kpi-word"><span class="st-dash-pchip is-${row.outcome}">${esc(row.outcome === "running" ? `${OUTCOME_WORD.running} · ${row.stage}` : OUTCOME_WORD[row.outcome])}</span></dd><dd class="st-kpi-sub">opened ${dayText(row.openedMs)}</dd></div>
          <div><dt>${row.winners.length > 1 ? "WINNERS" : "WINNER"}</dt><dd class="st-dash-prot-win">${win || `<span class="st-kpi-word">none</span>`}</dd><dd class="st-kpi-sub">${bps ? `${bps} · ` : ""}cap ${r.cap_bps} bps · ${r.bids.length} bid${r.bids.length === 1 ? "" : "s"}</dd></div>
          <div><dt>TOPPED UP</dt><dd>${row.winners.length ? `<span class="st-num">${fmt(BigInt(row.topupUnits), C.decimals, 6)}</span> <span class="st-sv-u">${C.symbol}</span>` : `<span class="st-kpi-word">nothing</span>`}</dd><dd class="st-kpi-sub">${fmt(BigInt(r.topup_units), C.decimals, 6)} ${C.symbol} needed</dd></div>
          ${owed > 0n ? `<div><dt>CLAIM OWED</dt><dd><span class="st-num">${fmt(owed, C.decimals, 6)}</span> <span class="st-sv-u">${C.symbol}</span></dd><dd class="st-kpi-sub">${x.claims.map((c) => esc(c.token_id)).join(", ")}</dd></div>` : ""}
        </dl>
        ${flowSeq(flowMoves(flow))}
        <p class="st-list-note st-sv-note">${esc(PROT_NOTE)}</p>`;
    };
  }
  /** The protections dialog: the list, or (id) one rescue's flow in the same dialog with a way back. */
  function openProt(id: number | null, opener: HTMLElement | null, focusSel?: string) {
    if (!s?.pos) return;
    protView = id;
    const keepOpener = dialogs.get("prot")?.el.open ? dialogs.get("prot")!.opener : opener;
    if (id === null) return modal("prot", `POSITION ${s.pos.id} · PROTECTIONS`, "Protections", protListHtml, keepOpener, focusSel ?? "[data-dlg-close]", protClick);
    const r = stories().filter((h) => h.rescue.id === id).at(-1)?.rescue;
    const word = r ? protectionRows([r]).rows.concat(protectionRows([r]).noBids)[0] : null;
    modal("prot", `POSITION ${s.pos.id} · PROTECTION`, `Rescue ${id}${word ? `: ${word.outcome === "running" ? word.stage : OUTCOME_WORD[word.outcome].toLowerCase()}` : ""}`, protBody(id), keepOpener, "[data-prot-back]", protClick);
  }
  /** Clicks inside the protections dialog: a row opens its flow, the back link the list, the toggles redraw it. */
  function protClick(t: HTMLElement) {
    const row = t.closest<HTMLElement>("[data-prot]");
    if (row) return openProt(Number(row.dataset.prot), null);
    if (t.closest("[data-prot-back]")) {
      const from = protView;
      return openProt(null, null, from !== null ? `[data-prot="${from}"]` : undefined);
    }
    if (t.closest("[data-prot-more]")) {
      showAllProt = !showAllProt;
      return openProt(null, null, "[data-prot-more]");
    }
    if (t.closest("[data-prot-nobids]")) {
      showNoBids = !showNoBids;
      return openProt(null, null, "[data-prot-nobids]");
    }
  }

  function bannerHtml(): string {
    const params = cfg?.params;
    const limits = cfg?.limits;
    const secs = (ns: string | undefined) => (ns ? `${Number(BigInt(ns) / 1_000_000_000n)} s` : "…");
    const cap = capUsd(limits ?? null);
    return `<div class="st-own-real st-dash-real" role="note"><div class="st-dash-realrow"><p class="st-own-real-head">Ethereum mainnet · real funds · capped at $${cap || 150}</p>${disc("cfg", "Contract settings", () => `<dl class="st-own-cfg">
        <div><dt>CONTRACT</dt><dd>${ext(`https://nearblocks.io/address/${net.contract}`, esc(net.contract))}${cfg?.paused ? " · paused" : ""}</dd></div>
        <div><dt>MARKET ${net.market}</dt><dd>${C.symbol} / ${D.symbol} on Aave V3 Ethereum${cfg?.market ? ` · liquidation bonus ${cfg.market.liq_bonus_bps / 100}%` : ""}</dd></div>
        <div><dt>RULES</dt><dd>${params ? `trigger ${(params.trigger_hf_bps / 10_000).toFixed(2)} · rescue to ${(params.target_hf_bps / 10_000).toFixed(2)} · auction ${secs(params.auction_window_ns)} · buy-back window ${secs(params.buyback_window_ns)}` : "reading…"}</dd></div>
        <div><dt>LIMITS</dt><dd>${limits ? `$${cap} of collateral per position · borrowers: ${limits.borrowers.map(esc).join(", ") || "anyone"}` : "reading…"}</dd></div>
      </dl><p class="st-own-hint">Every action moves real ${C.symbol}, ${D.symbol}, ETH and NEAR. Read from ${esc(net.contract)} on NEAR mainnet.</p>`)}</div>
      ${mismatch.length ? `<p class="st-own-stop" role="alert">The contract's market ${net.market} does not match this page (${esc(mismatch.join(", "))}): every action is off.</p>` : ""}
    </div>`;
  }

  /** The risk details: the three lines and how far the collateral can fall to each, the loan-to-value
   *  against Aave's limits, and what Stead does about it, for this position. */
  function riskHtml(): string {
    if (!s?.pos || !s.acct) return `<p class="st-empty">Reading the position…</p>`;
    const a = s.acct;
    const hf = s.hf;
    const price = s.prices.coll;
    const params = cfg?.params;
    const names: Record<string, string> = { liquidation: "Aave liquidation", early: "Early settlement", trigger: "Stead rescue" };
    const notes: Record<string, string> = { liquidation: "Aave sells the collateral at a discount", early: "an open claim settles at the oracle price", trigger: "stewards bid to top it up" };
    const lines = riskLines(hf, EARLY_SETTLE_BPS, params ? BigInt(params.trigger_hf_bps) : TRIGGER_BPS).map((l) => {
      const at = price ? linePrice(price, l.bps, hf) : null;
      const fall = l.fallBps === null ? `<span class="st-dash-rl-none">no debt</span>` : l.reached ? `<span class="st-dash-rl-none">reached</span>` : `<span class="st-num">${pctText(l.fallBps)}</span>`;
      return `<li class="st-dash-rl is-${l.key}">
        <span class="st-dash-rl-name">${names[l.key]}</span>
        <span class="st-dash-rl-hf"><span class="st-num">${hfText(l.bps)}</span></span>
        <span class="st-dash-rl-fall">${fall}<span class="st-dash-rl-sub">${l.fallBps !== null && !l.reached ? `${C.symbol} fall${at !== null ? ` · at ${usd8(at, 2)}` : ""}` : notes[l.key]}</span></span>
      </li>`;
    }).join("");
    const ltv = ltvView(a, s.maxLtv);
    const pct = (b: bigint) => pctText(b);
    const pos = s.pos;
    const stored = pos.open_rescues.length > 0 && BigInt(pos.premium_cap_base ?? "0") > 0n;
    const bonus = BigInt(cfg?.market?.liq_bonus_bps ?? 0);
    const capB = stored ? BigInt(pos.premium_cap_base!) : premiumCapBase(a.debtBase, bonus);
    const used = stored ? BigInt(pos.premium_used_base ?? "0") : 0n;
    const target = params ? (params.target_hf_bps / 10_000).toFixed(2) : "1.50";
    const trig = params ? (params.trigger_hf_bps / 10_000).toFixed(2) : "1.15";
    const win = params ? Number(BigInt(params.buyback_window_ns) / 1_000_000_000n) : 0;
    const winText = win ? (win % 3600 === 0 ? `${win / 3600} h` : win % 60 === 0 ? `${win / 60} min` : `${win} s`) : "";
    return `<div class="st-dash-risk-hf">
        <div class="st-dash-risk-now"><span class="st-label">HEALTH FACTOR</span><span class="st-num st-dash-hf${hfCls(hf)}">${hf === null ? "no debt" : hfText(hf)}</span><span class="st-dash-cons">${hf === null ? "nothing to liquidate" : fallLine(hf, C.symbol)}</span></div>
        ${hfBarHtml(hf, a.collBase > 0n || hf !== null)}
      </div>
      <div class="st-label">HOW FAR ${C.symbol} CAN FALL${price ? ` · NOW ${usd8(price, 2)}` : ""}</div>
      <ol class="st-dash-rls">${lines}</ol>
      <div class="st-label">LOAN TO VALUE · AAVE</div>
      <dl class="st-dash-ltv">
        <div><dt>CURRENT LTV</dt><dd class="st-num">${ltv ? pct(ltv.currentBps) : "…"}</dd></div>
        <div><dt>MAX LTV</dt><dd class="st-num">${ltv ? pct(ltv.maxBps) : "…"}</dd></div>
        <div><dt>LIQUIDATION THRESHOLD</dt><dd class="st-num">${ltv ? pct(ltv.ltBps) : "…"}</dd></div>
      </dl>
      <div class="st-label">HOW STEAD PROTECTS THIS POSITION</div>
      <ul class="st-dash-protect">
        <li><span class="st-dash-pk"><span class="st-num">${trig}</span></span><span>Under ${trig}, stewards compete to top it up back to ${target}.</span></li>
        <li><span class="st-dash-pk"><span class="st-num">${usd8(capB, 2)}</span></span><span>Most the rescues can cost in total${stored ? ` (${usd8(used, 2)} used)` : ""}: half the debt × Aave's ${bonus > 0n ? `${Number(bonus) / 100}% ` : ""}liquidation bonus, so always less than a liquidation.</span></li>
        <li><span class="st-dash-pk"><span class="st-num">${winText || "…"}</span></span><span>Buy the claim back within the window, or it settles at the oracle price.</span></li>
        <li class="is-rule"><span>You are never worse off than after an Aave liquidation.</span></li>
      </ul>`;
  }
  // ── dialogs: risk details and funding (one look), and the steward's view (the mainnet runs' dialog) ──
  type Dlg = { el: HTMLDialogElement; body: () => string; opener: HTMLElement | null; html: string; onClick?: (t: HTMLElement, ev: Event) => void };
  const dialogs = new Map<string, Dlg>();
  /** Keep Tab inside an open dialog. */
  const trapTab = (el: HTMLDialogElement) =>
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Tab") return;
      const f = [...el.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !(x as HTMLButtonElement).disabled && !x.closest("[hidden]"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    });
  function modal(key: string, label: string, title: string, body: () => string, opener: HTMLElement | null, focusSel = "[data-dlg-close]", onClick?: (t: HTMLElement, ev: Event) => void) {
    let d = dialogs.get(key);
    if (!d) {
      const el = document.createElement("dialog");
      el.className = `st-dash-risk st-dash-dlg--${key}`;
      el.setAttribute("aria-labelledby", `dash-${key}-title`);
      el.innerHTML = `<div class="st-dash-risk-head"><div><div class="st-label" data-dlg-label></div><h2 id="dash-${key}-title" data-dlg-title></h2></div><button type="button" class="st-dash-risk-x" data-dlg-close aria-label="Close">${icon("close", 16)}</button></div><div class="st-dash-risk-body" data-dlg-body></div>`;
      document.body.append(el);
      const dd: Dlg = { el, body, opener, html: "", onClick };
      d = dd;
      dialogs.set(key, dd);
      // ×, a click on the backdrop and Esc (native) close it; the copy button works inside it
      el.addEventListener("click", (ev) => {
        const t = ev.target as HTMLElement;
        if (t === el || t.closest("[data-dlg-close]")) return el.close();
        if (dd.onClick) dd.onClick(t, ev);
        const c = t.closest<HTMLButtonElement>("[data-copy]");
        if (c) void navigator.clipboard?.writeText(c.dataset.copy!).then(() => {
          copiedAt = Date.now();
          render();
          setTimeout(render, 1700);
        }, () => undefined);
      });
      trapTab(el);
      el.addEventListener("close", () => {
        if (key === "act") actView = null;
        if (key === "fund") fundFor = null;
        (dd.opener?.isConnected ? dd.opener : root.querySelector<HTMLElement>(`[data-${key}]`))?.focus({ preventScroll: true });
      });
    }
    d.body = body;
    d.opener = opener;
    if (onClick) d.onClick = onClick;
    d.el.querySelector("[data-dlg-label]")!.textContent = label;
    d.el.querySelector("[data-dlg-title]")!.textContent = title;
    d.el.querySelector("[data-dlg-close]")!.setAttribute("aria-label", `Close ${title.toLowerCase()}`);
    d.html = body();
    d.el.querySelector("[data-dlg-body]")!.innerHTML = d.html;
    if (!d.el.open) d.el.showModal();
    d.el.scrollTop = 0;
    (d.el.querySelector<HTMLElement>(focusSel) ?? d.el.querySelector<HTMLElement>("[data-dlg-close]")!).focus();
  }
  const openRisk = (ev?: Event) => modal("risk", `POSITION ${s?.pos?.id ?? ""} · LIQUIDATION RISK`, "Risk details", riskHtml, (ev?.currentTarget as HTMLElement) ?? null);
  function openFund(opener: HTMLElement | null, token: "coll" | "debt" | "eth" | null = null) {
    if (!s?.pos?.evm_address) return;
    if (dialogs.get("fund")?.el.open) return;
    fundFor = token;
    modal("fund", "POSITION ADDRESS · ETHEREUM MAINNET", token === "eth" ? "Add ETH for gas" : token ? `Deposit ${token === "coll" ? C.symbol : D.symbol} to the position` : "Fund position", fundHtml, opener);
  }

  // ── the action dialog: a withdrawal's destination, the payout change, a send from the wallet, a result ──
  const sym3 = (t: "coll" | "debt" | "eth") => (t === "coll" ? C.symbol : t === "debt" ? D.symbol : "ETH");
  const dec3 = (t: "coll" | "debt" | "eth") => (t === "coll" ? C.decimals : t === "debt" ? D.decimals : 18);
  const CONFIRM_TITLE = { withdraw: `Withdraw ${C.symbol} from Aave`, move: `Withdraw ${D.symbol} from the position`, sweep: "Return the gas ETH", wethout: `Withdraw ${C.symbol} from the position` };
  function openAct(opener: HTMLElement | null, focusSel?: string) {
    const v = actView;
    if (!v || !s?.pos) return;
    const id = s.pos.id;
    const [label, title] = v.v === "confirm" ? [`WITHDRAWAL · POSITION ${id}`, CONFIRM_TITLE[v.kind]]
      : v.v === "payout" ? [`PAYOUT · POSITION ${id}`, "Change payout"]
      : v.v === "send" ? ["POSITION ADDRESS · ETHEREUM MAINNET", v.token === "eth" ? "Add ETH for gas" : `Deposit ${sym3(v.token)} to the position`]
      : [`DONE · POSITION ${id}`, v.done.title];
    const keep = dialogs.get("act")?.el.open ? dialogs.get("act")!.opener : opener;
    modal("act", label, title, actBody, keep, focusSel ?? (v.v === "confirm" ? "[data-confirm]:not([disabled]), [data-dlg-close]:not(.st-dash-risk-x)" : v.v === "send" ? "#dlg-send" : v.v === "payout" ? "#dlg-payout" : "[data-done-ok]"), actClick);
    const d = dialogs.get("act")!;
    if (!d.el.dataset.wired) {
      d.el.dataset.wired = "1";
      // typing in the dialog redraws its body (the button's amount, the checks), keeping the caret
      d.el.addEventListener("input", (ev) => {
        const i = ev.target as HTMLInputElement;
        if (i.dataset.dlgAmt) amt[i.dataset.dlgAmt] = i.value;
        else if (i.dataset.dlgPayout !== undefined) payoutNew = i.value;
        else return;
        redrawDlg(d, actBody());
      });
    }
  }
  /** A withdrawal asks first: where it goes (the payout, and whether that is the connected wallet). */
  function ask(kind: "withdraw" | "move" | "sweep" | "wethout", opener: HTMLElement | null) {
    if (busy) return;
    actView = { v: "confirm", kind };
    if (kind === "move" && !amt.move) amt.move = "";
    openAct(opener);
  }
  function actBody(): string {
    const v = actView;
    if (!v || !s?.pos) return "";
    const pos = s.pos;
    const payout = getAddr(pos.payout);
    const dest = `<div class="st-dash-dest"><p class="st-dash-dest-line">${esc(payoutLine(pos.payout, evm))}</p><p class="st-dash-dest-full st-mono">${esc(payout)}</p><p class="st-dash-dest-act"><button type="button" class="st-dash-linkbtn" data-to-payout>Change payout</button><span> · takes effect ${esc(delayText())} after the request</span></p></div>`;
    if (v.v === "confirm") {
      const f = facts();
      const av = availability(f);
      const cancel = `<button type="button" class="st-secondary st-cut" data-dlg-close>Cancel</button>`;
      if (v.kind === "withdraw") {
        const op = opOf("withdraw");
        const p = projOf("withdraw");
        const what = !op ? "" : (op as any).all ? `all the ${C.symbol}` : `${fmt(op.units, C.decimals, 6)} ${C.symbol}`;
        const ok = av.withdraw.on && !!p && !p.block;
        return `<p class="st-dash-cf-what">Aave sends <strong>${esc(what)}</strong> of the position's collateral straight to your payout.</p>
          ${p ? `<p class="st-dash-proj"><span class="st-dash-projlbl">HF</span><span class="st-dash-projnow${hfCls(s.hf)}">${hfText(s.hf)}</span>${toGlyph()}<strong class="st-dash-projnum${hfCls(p.hfBps)}">${hfText(p.hfBps)}</strong></p>` : ""}
          ${dest}
          <div class="st-dash-cf-go">${btn(`Withdraw ${what} to ${short(payout)}`, "data-confirm", true, !ok)}${cancel}</div>
          ${ok ? "" : `<p class="st-dash-why">${esc(!av.withdraw.on ? av.withdraw.why : p?.block ?? "Type an amount in the WETH card first.")}</p>`}`;
      }
      if (v.kind === "move") {
        const idle = s.posBal.debt;
        const typed = parse("move", D.decimals);
        const units = typed && typed > 0n ? typed : idle;
        const bad = units > idle || ((amt.move ?? "").trim() !== "" && typed === null);
        return `<p class="st-dash-cf-what">The contract sends ${D.symbol} from the position's address to your payout. <strong>${fmt(idle, D.decimals, 6)} ${D.symbol}</strong> is there.</p>
          <div class="st-dash-amt"><label class="st-visually-hidden" for="dlg-move">Amount in ${D.symbol}</label><input id="dlg-move" data-dlg-amt="move" inputmode="decimal" autocomplete="off" placeholder="${trim(idle, D.decimals, 6)}" value="${esc(amt.move ?? "")}"><span class="st-dash-sym">${D.symbol}</span><button type="button" class="st-dash-max" data-dlg-max="move">ALL</button></div>
          ${dest}
          <div class="st-dash-cf-go">${btn(`Withdraw ${fmt(units, D.decimals, 2)} ${D.symbol} to ${short(payout)}`, "data-confirm", true, !av.move.on || bad)}${cancel}</div>
          ${!av.move.on ? `<p class="st-dash-why">${esc(av.move.why)}</p>` : units > idle ? `<p class="st-own-stop" role="alert">The position holds ${fmt(idle, D.decimals, 6)} ${D.symbol}: withdraw that much or less.</p>` : ""}
          ${f.hasDebt ? `<p class="st-dash-cf-note">Or keep it there to repay: ${D.symbol} card, Repay, from THE POSITION.</p>` : ""}`;
      }
      if (v.kind === "sweep") {
        return `<p class="st-dash-cf-what">The position's leftover gas ETH, less the transfer's own fee: <strong>${fmt(f.sweepUnits, 18, 6)} ETH</strong>.</p>
          ${dest}
          <div class="st-dash-cf-go">${btn(`Return ${fmt(f.sweepUnits, 18, 6)} ETH to ${short(payout)}`, "data-confirm", true, !av.sweep.on)}${cancel}</div>
          ${av.sweep.on ? "" : `<p class="st-dash-why">${esc(av.sweep.why)}</p>`}`;
      }
      const wo = wethOutState();
      const units = wout && wout.pos === pos.id ? wout.units : s.posBal.coll;
      return `<p class="st-dash-cf-what">The contract can't send ${C.symbol} from the position's address on its own, so this takes two steps: it supplies the <strong>${fmt(units, C.decimals, 8)} ${C.symbol}</strong> to Aave, then withdraws the same amount, which Aave sends to your payout. The health factor ends where it is now.</p>
        <ol class="st-dash-cf-steps"><li>Supply ${fmt(units, C.decimals, 8)} ${C.symbol} on Aave${s.allow.coll < units ? " (after Aave's approval, once)" : ""}</li><li>Withdraw ${fmt(units, C.decimals, 8)} ${C.symbol} to your payout</li></ol>
        <p class="st-dash-cf-note">Each NEAR signature is its own click: once the supply lands, the second step's button appears. Gas for ${wo.txs} transactions comes from the position's ETH.</p>
        ${dest}
        <div class="st-dash-cf-go">${btn(`Supply, then withdraw ${fmt(units, C.decimals, 8)} ${C.symbol}`, "data-confirm", true, !wo.on)}${cancel}</div>
        ${wo.on ? "" : `<p class="st-dash-why">${esc(wo.why)}</p>`}`;
    }
    if (v.v === "payout") {
      const st = payoutChangeState(pos.payout_change, Date.now(), facts().locked);
      const c = checkPayout(payoutNew, refuseList());
      const typed = payoutNew.trim() !== "";
      const same = c.ok && c.address.toLowerCase() === pos.payout.toLowerCase();
      const back = v.back ? `<p class="st-dash-protback"><button type="button" class="st-dash-linkbtn" data-payout-back>${glyph("M10 3.5 5.5 8l4.5 4.5", 14)}Back to the withdrawal</button></p>` : "";
      const pending = st.kind === "waiting"
        ? `<div class="st-dash-dest"><p class="st-dash-dest-line">Requested: ${esc(short(getAddr(st.to)))}</p><p>Takes effect ${esc(dayText(st.atMs))} (in ${esc(durationText(st.leftMs))}); then apply it here with one more call. A new request replaces it.</p></div>`
        : st.kind === "ready"
          ? `<div class="st-dash-dest"><p class="st-dash-dest-line">Ready: ${esc(short(getAddr(st.to)))}</p><p>The delay is over. Apply it to make it the payout.</p><div class="st-dash-cf-go">${btn(`Apply the payout change to ${short(getAddr(st.to))}`, "data-payout-apply", true, st.locked)}</div></div>`
          : "";
      return `${back}
        <p class="st-dash-cf-what">Withdrawals, refunds and returned ETH go only to the payout, today <span class="st-mono">${esc(short(getAddr(pos.payout)))}</span>${evm ? (pos.payout.toLowerCase() === evm.toLowerCase() ? " (your connected wallet)" : " (not your connected wallet)") : ""}.</p>
        <p class="st-dash-cf-note">A new payout takes effect <strong>${esc(delayText())} after you request it</strong>, then one more call applies it. Until then everything keeps going to the current one. The contract refuses a change while a rescue runs.</p>
        ${pending}
        <label class="st-label" for="dlg-payout">NEW PAYOUT · ETHEREUM ADDRESS</label>
        <div class="st-dash-amt st-dash-payin"><input id="dlg-payout" data-dlg-payout autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="0x…" value="${esc(payoutNew)}"></div>
        ${evm && evm.toLowerCase() !== pos.payout.toLowerCase() && !typed ? `<p><button type="button" class="st-dash-linkbtn" data-payout-mine>Use my connected wallet ${esc(short(evm))}</button></p>` : ""}
        ${typed && !c.ok ? `<p class="st-own-stop" role="alert">${esc(c.why)}</p>` : same ? `<p class="st-dash-why">That is already the payout.</p>` : ""}
        <div class="st-dash-cf-go">${btn(c.ok && !same ? `Request payout change to ${short(c.address)}` : "Request payout change", "data-payout-req", true, !c.ok || same || st.locked)}</div>
        ${st.locked ? `<p class="st-dash-why">A rescue is running: the contract refuses a payout change until it ends.</p>` : ""}`;
    }
    if (v.v === "send") {
      const t = v.token;
      const w = s.wallet;
      const have = !w ? null : t === "coll" ? w.coll : t === "debt" ? w.debt : w.eth;
      const units = parse(`send-${t}`, dec3(t));
      const tooMuch = have !== null && units !== null && units > have;
      const after = t === "coll" ? `Then supply it from the ${C.symbol} card (one NEAR call).` : t === "debt" ? `${D.symbol} here can repay the debt (Repay, from THE POSITION) or be withdrawn to your payout.` : "The position pays its own transactions' gas from this ETH.";
      return `<p class="st-dash-cf-what">From your Ethereum wallet <span class="st-mono">${esc(short(evm ?? ""))}</span>${have !== null ? `, which holds <strong>${fmt(have, dec3(t), t === "debt" ? 2 : 6)} ${sym3(t)}</strong>` : ""}, to the position's address. ${after}</p>
        <div class="st-dash-amt"><label class="st-visually-hidden" for="dlg-send">Amount in ${sym3(t)}</label><input id="dlg-send" data-dlg-amt="send-${t}" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(amt[`send-${t}`] ?? "")}"><span class="st-dash-sym">${sym3(t)}</span>${t !== "eth" ? `<button type="button" class="st-dash-max" data-dlg-max="send-${t}">MAX</button>` : ""}</div>
        <div class="st-dash-cf-go">${btn(units ? `Send ${fmt(units, dec3(t), 6)} ${sym3(t)} to the position` : `Send ${sym3(t)} to the position`, "data-send", true, !units || tooMuch)}</div>
        ${tooMuch ? `<p class="st-own-stop" role="alert">Your wallet holds ${fmt(have!, dec3(t), 6)} ${sym3(t)}.</p>` : ""}
        <p class="st-dash-cf-note">Or from any wallet: <button type="button" class="st-dash-linkbtn" data-dlg-fund>the address and its QR code</button>. Ethereum mainnet only.</p>`;
    }
    const d = v.done;
    const link = (href: string, txt: string) => `<a class="st-textlink st-extlink" href="${href}" target="_blank" rel="noopener">${txt}${icon("external", 12)}</a>`;
    return `<p class="st-dash-done-line">${esc(d.line)}</p>
      <div class="st-dash-done-fig"><span class="st-label">${esc(d.figure.label)}</span><span class="st-num${d.figure.label.startsWith("HEALTH") ? ` st-dash-hf${hfCls(s.hf)}` : ""}">${esc(d.figure.value)}</span>${d.figure.label.startsWith("HEALTH") && s.hf !== null ? `<span class="st-dash-cons">${esc(fallLine(s.hf, C.symbol))}</span>` : ""}</div>
      ${d.links.length ? `<ul class="st-dash-done-txs">${d.links.map((l) => `<li><span>${esc(l.label)}</span><span class="st-dash-done-links">${l.near ? link(net.nearTx(l.near), "NearBlocks") : ""}${l.evm ? link(net.evmTx(l.evm), "Etherscan") : ""}</span></li>`).join("")}</ul>` : ""}
      <div class="st-dash-cf-go"><button type="button" class="st-push st-push--small st-cut" data-done-ok data-dlg-close><span class="st-lamp" aria-hidden="true"></span>Done</button></div>`;
  }
  /** Clicks inside the action dialog. A confirm closes it and starts the action from that click. */
  function actClick(t: HTMLElement) {
    const v = actView;
    if (!v) return;
    const dlg = dialogs.get("act")!;
    if (t.closest("[data-confirm]") && v.v === "confirm" && !(t.closest("[data-confirm]") as HTMLButtonElement).disabled) {
      const kind = v.kind;
      dlg.el.close();
      return go(kind);
    }
    if (t.closest("[data-to-payout]")) {
      actView = { v: "payout", back: v.v === "confirm" ? v : null };
      return openAct(null);
    }
    if (t.closest("[data-payout-back]") && v.v === "payout" && v.back) {
      actView = v.back;
      return openAct(null, "[data-to-payout]");
    }
    if (t.closest("[data-payout-mine]") && evm) {
      payoutNew = evm;
      return redrawDlg(dlg, actBody());
    }
    if (t.closest("[data-payout-req]") && !(t.closest("[data-payout-req]") as HTMLButtonElement).disabled) {
      dlg.el.close();
      return go("payoutReq");
    }
    if (t.closest("[data-payout-apply]") && !(t.closest("[data-payout-apply]") as HTMLButtonElement).disabled) {
      dlg.el.close();
      return go("payoutApply");
    }
    const mx = t.closest<HTMLElement>("[data-dlg-max]");
    if (mx) {
      const k = mx.dataset.dlgMax!;
      if (k === "move") amt.move = trim(s!.posBal.debt, D.decimals, D.decimals);
      else if (k === "send-coll") amt[k] = trim(s!.wallet?.coll ?? 0n, C.decimals, 8);
      else if (k === "send-debt") amt[k] = trim(s!.wallet?.debt ?? 0n, D.decimals, D.decimals);
      return redrawDlg(dlg, actBody());
    }
    if (t.closest("[data-send]") && v.v === "send" && !(t.closest("[data-send]") as HTMLButtonElement).disabled) {
      const tok = v.token;
      dlg.el.close();
      return void sendIn(tok);
    }
    if (t.closest("[data-dlg-fund]") && v.v === "send") {
      const tok = v.token;
      dlg.el.close();
      return openFund(null, tok);
    }
  }
  /** Put new HTML in a dialog's body, keeping the focused control (by id or its data key), the caret and the scroll. */
  function redrawDlg(d: Dlg, html: string) {
    const a = document.activeElement as HTMLElement | null;
    const inside = !!a && d.el.contains(a) && a !== d.el.querySelector("[data-dlg-close]");
    const key = inside ? (a!.id ? `#${a!.id}` : (() => {
      const k = Object.keys(a!.dataset)[0];
      return k ? `[data-${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}${a!.dataset[k] ? `="${a!.dataset[k]}"` : ""}]` : null;
    })()) : null;
    const sel = a instanceof HTMLInputElement ? [a.selectionStart, a.selectionEnd] : null;
    const top = d.el.scrollTop;
    d.html = html;
    d.el.querySelector("[data-dlg-body]")!.innerHTML = html;
    d.el.scrollTop = top;
    if (key) {
      const el = d.el.querySelector<HTMLElement>(`[data-dlg-body] ${key}`);
      if (el) {
        el.focus({ preventScroll: true });
        if (sel && el instanceof HTMLInputElement) el.setSelectionRange(sel[0], sel[1]);
      }
    }
  }
  /** Redraw the open dialogs' bodies from the latest reading (keeping focus where it was). */
  function refreshDialogs(full: boolean) {
    for (const d of dialogs.values()) {
      if (!d.el.open) continue;
      if (!full) {
        d.el.close();
        continue;
      }
      const html = d.body();
      if (html === d.html) continue;
      redrawDlg(d, html);
    }
    refreshSteward(full);
  }

  // the steward's view of the live rescue: the leading bidder while the auction runs, else the winners
  let sv: HTMLDialogElement | null = null;
  let svOpener: HTMLElement | null = null;
  let svFocus = 0;
  let svHtml = "";
  const SV_NOTE = "Read from Stead's contract on NEAR mainnet as the rescue runs. Times are the contract's own where it records them (or the proof's Ethereum block); bids and the other untimed steps show when this page first saw them.";
  const svView = () => {
    const r = s?.rescue;
    if (!r || !s?.pos) return null;
    const exact = new Map(rescueFlow(r, s.claims, { coll: C, evmName: net.evmName, ...flowOpts() }).map((f) => [f.key, f.exactMs]));
    const seenMs = (k: string) => {
      const e = exact.get(k);
      if (e != null) return e;
      if (k.startsWith("bid:")) return lad?.seen?.get(k.split(":")[2])?.seenMs ?? null;
      if (!seenAt.has(k)) seenAt.set(k, Date.now()); // no time on chain: when this page first saw it
      return seenAt.get(k)!;
    };
    return liveStewardView(r, s.claims, { posId: s.pos.id, coll: C, seenMs, evmTxUrl: net.evmTx, evmBlockUrl: net.evmBlock });
  };
  function openSteward(account: string | null, opener: HTMLElement | null) {
    const v = svView();
    if (!v) return;
    if (!sv) {
      const t = document.createElement("template");
      t.innerHTML = svDialogHtml(SV_NOTE).trim();
      sv = t.content.firstElementChild as HTMLDialogElement;
      document.body.append(sv);
      const el = sv;
      el.addEventListener("click", (ev) => {
        const tg = ev.target as HTMLElement;
        if (tg === el || tg.closest("[data-sv-close]")) return el.close();
        const tab = tg.closest<HTMLButtonElement>("[data-sv-tab]");
        const now = svView();
        if (tab && now) {
          svFocus = Number(tab.dataset.svTab);
          showSteward(el, now, svFocus, true);
          svHtml = stewardPanel(now.stewards[svFocus], now);
        }
      });
      trapTab(el);
      el.addEventListener("close", () => svOpener?.focus());
    }
    const k = account ? v.stewards.findIndex((x) => x.steward === account.split(".")[0]) : 0;
    svFocus = Math.max(0, k);
    svOpener = opener;
    showSteward(sv, v, svFocus);
    svHtml = stewardPanel(v.stewards[svFocus], v);
    if (!sv.open) sv.showModal();
    sv.querySelector<HTMLElement>(v.pooled ? `[data-sv-tab="${svFocus}"]` : "[data-sv-close]")?.focus();
  }
  /** The open steward's view follows the rescue (a new bid, the top-up, the claim) without losing its scroll. */
  function refreshSteward(full: boolean) {
    if (!sv?.open) return;
    const v = full ? svView() : null;
    if (!v) return sv.close();
    if (svFocus >= v.stewards.length) svFocus = 0;
    const html = stewardPanel(v.stewards[svFocus], v);
    if (html === svHtml) return;
    svHtml = html;
    const panel = sv.querySelector<HTMLElement>(".st-sv-panel")!;
    const top = sv.scrollTop, ptop = panel.scrollTop;
    const tabFocus = (document.activeElement as HTMLElement | null)?.dataset?.svTab;
    showSteward(sv, v, svFocus, tabFocus !== undefined);
    sv.scrollTop = top;
    panel.scrollTop = ptop;
  }

  // keep what the visitor is typing (and which control has focus) across re-renders
  const FOCUS_KEYS = ["amt", "payout", "disc", "mode", "repayFrom", "copy", "max", "moreTxs", "risk", "fund", "prot", "prots", "tile", "tileGo", "resume", "parkX", "offer", "ask", "go"] as const;
  function render() {
    if (gone) return;
    // a redraw never moves the page: re-focusing a control would scroll it into view on every reading
    const scrollY = window.scrollY;
    const focused = document.activeElement as HTMLElement | null;
    const inRoot = !!focused && root.contains(focused);
    const fk = inRoot ? FOCUS_KEYS.find((k) => focused!.dataset[k] !== undefined) : undefined;
    const focusSel = fk ? `[data-${fk.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}${focused!.dataset[fk] ? `="${focused!.dataset[fk]}"` : ""}]` : null;
    const inp = fk === "amt" || fk === "payout" ? (focused as HTMLInputElement) : null;
    const sel = inp ? [inp.selectionStart, inp.selectionEnd] : null;
    const netSwitch = `<nav class="st-own-net" aria-label="Network"><div class="st-own-netseg"><a href="${location.pathname}#/try">TESTNET</a><a href="${location.pathname}?net=mainnet#/try" aria-current="page">MAINNET · REAL FUNDS</a></div></nav>`;
    const pos = s?.pos ?? null;
    const fresh = freshShown();
    if (!fresh && !busy) freshFrom = null;
    const full = !!s && !!pos?.evm_address && !fresh;
    const body = !s
      ? `<p class="st-empty">${near ? "Reading the contract and Ethereum…" : ""}</p>`
      : fresh
        ? newPositionHtml()
        : full
        ? `${statusHtml()}${activityHtml(true)}`
        : pos
          ? `<p class="st-own-hint">Position ${pos.id} is registered; its Ethereum address is being derived.</p>`
          : newPositionHtml();
    // the page is drawn in two parts around the bid ladder, which stays in place so its rows glide
    let shell = root.querySelector<HTMLElement>(":scope > section.st-dash");
    if (!shell) {
      root.innerHTML = `<section class="st-panel st-sect st-own is-mainnet st-dash"><div class="st-dash-part" data-part="pre"></div><div class="st-dash-part" data-part="ladder"></div><div class="st-dash-part" data-part="post"></div></section>`;
      shell = root.querySelector<HTMLElement>(":scope > section.st-dash")!;
    }
    shell.querySelector<HTMLElement>('[data-part="pre"]')!.innerHTML = `
      <header class="st-list-head"><div class="st-label">YOUR AAVE POSITION · NEAR MAINNET AND ETHEREUM</div><h1 class="st-page-title">Protected Aave position</h1>
        <p class="st-list-sub">Only the Stead contract can sign for it; your NEAR account owns it. Under health 1.15, stewards top it up.</p></header>
      ${netSwitch}
      ${bannerHtml()}
      ${walletsHtml()}
      ${notice ? `<p class="st-own-notice" role="status">${esc(notice)}</p>` : ""}
      ${error ? `<p class="st-own-error" role="alert">${esc(error)}</p>` : ""}
      ${busy && (!pos?.evm_address || fresh) ? `<p class="st-own-notice" role="status">${esc(busy)} <span class="st-own-elapsed" data-elapsed="${busySince}">${mmss(Date.now() - busySince)}</span></p>` : ""}
      ${body}`;
    const ladHost = shell.querySelector<HTMLElement>('[data-part="ladder"]')!;
    if (full && lad && s?.rescue?.id === lad.rid) {
      if (lad.el.parentElement !== ladHost) ladHost.replaceChildren(lad.el);
      updateLadder();
    } else if (ladHost.firstChild) ladHost.replaceChildren();
    shell.querySelector<HTMLElement>('[data-part="post"]')!.innerHTML = full ? `${actionsHtml()}${positionWalletHtml()}${activityHtml()}` : "";
    refreshDialogs(!!s && !!pos?.evm_address);
    flashArrival = false; // the arrival highlight plays once
    bind();
    if (focusSel) {
      const el = root.querySelector<HTMLElement>(focusSel);
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus({ preventScroll: true });
        if (sel && el instanceof HTMLInputElement) el.setSelectionRange(sel[0], sel[1]);
      }
    }
    if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
  }
  /** Update one action's projection and button as the visitor types, without redrawing the page. */
  function updateAction(id: Act | "move") {
    const el = root.querySelector<HTMLElement>(`[data-act="${id}"] .st-dash-live`);
    if (!el || !s?.pos) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = actionsHtml();
    const fresh = tmp.querySelector<HTMLElement>(`[data-act="${id}"] .st-dash-live`);
    if (!fresh) return;
    el.replaceWith(fresh);
    fresh.querySelector(`[data-go="${id}"]`)?.addEventListener("click", () => go(id));
    fresh.querySelector<HTMLElement>(`[data-ask="${id}"]`)?.addEventListener("click", (ev) => ask(id as "withdraw", ev.currentTarget as HTMLElement));
  }
  function go(id: string) {
    const f: Record<string, (() => unknown) | undefined> = { deposit, borrow, repay, withdraw, buyback: buyBack, sweep, move, wethout: wethOut, payoutReq: requestPayout, payoutApply: applyPayout, register };
    void f[id]?.();
  }
  function bind() {
    root.querySelector("[data-near]")?.addEventListener("click", () => run("Connecting your NEAR wallet", async () => {
      near = await connectNear();
      loadTxs();
    }));
    root.querySelector("[data-evm]")?.addEventListener("click", () => run("Connecting your Ethereum wallet", connectEvm));
    root.querySelector("[data-evm-off]")?.addEventListener("click", () => void disconnectEvm());
    root.querySelector("[data-near-off]")?.addEventListener("click", () => run("Disconnecting your NEAR wallet", async () => {
      await disconnectNear();
      near = null;
      s = null;
      freshFrom = null;
      noPosUntil = 0;
      loadTxs();
    }));
    root.querySelector("[data-fresh]")?.addEventListener("click", () => {
      if (!s?.pos || !isEmpty()) return;
      freshFrom = s.pos.id;
      render();
      root.querySelector<HTMLElement>("[data-fresh-back]")?.focus({ preventScroll: true });
    });
    root.querySelector("[data-fresh-back]")?.addEventListener("click", () => {
      const id = freshFrom;
      freshFrom = null;
      render();
      if (id !== null) root.querySelector<HTMLElement>("[data-fresh]")?.focus({ preventScroll: true });
    });
    root.querySelector("[data-register]")?.addEventListener("click", register);
    root.querySelector("[data-risk]")?.addEventListener("click", openRisk);
    root.querySelectorAll<HTMLElement>("[data-fund]").forEach((b) => b.addEventListener("click", () => openFund(b)));
    root.querySelector("[data-more-txs]")?.addEventListener("click", () => {
      showAllTxs = !showAllTxs;
      render();
    });
    root.querySelectorAll<HTMLButtonElement>("[data-prot]").forEach((b) => b.addEventListener("click", () => openProt(Number(b.dataset.prot), b)));
    root.querySelector<HTMLElement>("[data-prots]")?.addEventListener("click", (ev) => openProt(null, ev.currentTarget as HTMLElement));
    root.querySelectorAll<HTMLElement>("[data-ask]").forEach((b) => b.addEventListener("click", () => ask(b.dataset.ask as "withdraw" | "sweep", b)));
    // a balance tile's + and −; an off one says why (touch has no tooltip)
    root.querySelectorAll<HTMLElement>("[data-tile]").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.getAttribute("aria-disabled") === "true") {
          tileWhy = b.dataset.why ?? "";
          tileWhyAt = Date.now();
          render();
          setTimeout(render, 8100);
          return;
        }
        const [sign, tok] = b.dataset.tile!.split(":") as ["plus" | "minus", "coll" | "debt" | "eth"];
        if (sign === "plus") {
          if (evm) {
            actView = { v: "send", token: tok };
            openAct(b);
          } else openFund(b, tok);
          return;
        }
        ask(tok === "coll" ? "wethout" : tok === "debt" ? "move" : "sweep", b);
      }),
    );
    // "Supply it" / "Repay with it": the Aave card, set up to use what is at the address
    root.querySelectorAll<HTMLElement>("[data-tile-go]").forEach((b) =>
      b.addEventListener("click", () => {
        const supply = b.dataset.tileGo === "supply";
        if (supply) {
          wethMode = "deposit";
          amt.deposit = autoDeposit = trim(readyUnits(s?.posBal.coll ?? 0n), C.decimals, 6);
        } else {
          usdcMode = "repay";
          repayPicked = "position";
        }
        render();
        const card = root.querySelector<HTMLElement>(supply ? "#dash-aave-weth" : "#dash-aave-usdc");
        card?.scrollIntoView({ block: "center", behavior: "smooth" });
        root.querySelector<HTMLElement>(supply ? "#dash-amt-deposit" : "[data-offer], #dash-amt-repay")?.focus({ preventScroll: true });
      }),
    );
    root.querySelectorAll<HTMLElement>("[data-resume]").forEach((b) => b.addEventListener("click", () => parked && go(parked.act)));
    root.querySelectorAll<HTMLElement>("[data-park-x]").forEach((b) =>
      b.addEventListener("click", () => {
        parked = null;
        render();
      }),
    );
    root.querySelector("[data-offer]")?.addEventListener("click", () => {
      const a = s?.acct;
      if (!a || !s) return;
      const o = positionRepayOffer({ repayOn: true, debtBase: a.debtBase, allUnits: repayAllUnits(a.debtBase, s.prices.debt, D.decimals), idleUnits: s.posBal.debt });
      if (!o) return;
      repayPicked = "position";
      all.repay = o.all;
      amt.repay = o.all ? "" : trim(o.units, D.decimals, D.decimals);
      go("repay");
    });
    root.querySelectorAll<HTMLButtonElement>("[data-disc]").forEach((b) =>
      b.addEventListener("click", () => {
        const k = b.dataset.disc!;
        if (!opened.delete(k)) opened.add(k);
        render();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        const [card, m] = b.dataset.mode!.split(":");
        if (card === "weth") wethMode = m as "deposit" | "withdraw";
        else usdcMode = m as "borrow" | "repay";
        render();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go!)));
    root.querySelectorAll<HTMLButtonElement>("[data-try]").forEach((b) => b.addEventListener("click", () => void tryAnyway(b.dataset.try as "withdraw" | "borrow")));
    root.querySelector<HTMLInputElement>("[data-payout]")?.addEventListener("input", (ev) => {
      payoutText = (ev.target as HTMLInputElement).value;
      render();
    });
    root.querySelectorAll<HTMLInputElement>("[data-amt]").forEach((i) =>
      i.addEventListener("input", () => {
        const id = i.dataset.amt as Act | "move";
        amt[id] = i.value;
        if (id === "deposit") autoDeposit = "";
        if (all[id]) {
          all[id] = false;
          root.querySelector(`[data-act="${id}"] .st-dash-sym`)!.textContent = id === "deposit" || id === "withdraw" ? C.symbol : D.symbol;
        }
        updateAction(id);
      }),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-max]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = b.dataset.max!;
        const a = s?.acct;
        if (!a) return;
        all[id] = false;
        if (id === "deposit") amt[id] = trim(depositMax(s!.wallet?.coll ?? 0n, s!.posBal.coll, a.collBase, capBase(), s!.prices.coll, C.decimals), C.decimals, 6);
        if (id === "borrow") amt[id] = trim(borrowMax(a, s!.prices.debt, D.decimals), D.decimals, 2);
        if (id === "repay") all[id] = true;
        if (id === "move") amt[id] = trim(s!.posBal.debt, D.decimals, D.decimals);
        if (id === "withdraw") {
          const m = withdrawMax(a, s!.prices.coll, C.decimals);
          if (m.all) all[id] = true;
          else amt[id] = trim(m.units, C.decimals, 6);
        }
        render();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-repay-from]").forEach((r) =>
      r.addEventListener("click", () => {
        repayPicked = r.dataset.repayFrom as "position" | "wallet";
        render();
      }),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) =>
      b.addEventListener("click", () => {
        void navigator.clipboard?.writeText(b.dataset.copy!).then(
          () => {
            copiedAt = Date.now();
            render();
            setTimeout(render, 1700);
          },
          () => undefined,
        );
      }),
    );
  }
  /** Units → a decimal string rounded DOWN to `dp` places (a max never rounds up past what is there). */
  const trim = (u: bigint, dec: number, dp: number) => {
    const step = 10n ** BigInt(Math.max(0, dec - dp));
    const v = (u / step) * step;
    const whole = v / 10n ** BigInt(dec);
    const frac = (v % 10n ** BigInt(dec)).toString().padStart(dec, "0").slice(0, dp).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole.toString();
  };

  // ── start ──
  bindCrowns();
  let stopNear: () => void = () => {};
  void (async () => {
    root.innerHTML = `<section class="st-panel st-page"><div class="st-label">YOUR AAVE POSITION · MAINNET</div><p class="st-empty">Loading the wallets…</p></section>`;
    try {
      near = await nearAccount();
    } catch (e) {
      error = `NEAR wallets could not load (${(e as Error).message}).`;
    }
    loadTxs();
    stopNear = onNearAccount((a) => {
      near = a;
      noPosUntil = 0;
      s = null;
      freshFrom = null;
      loadTxs();
      void refresh();
    });
    const eth = (window as any).ethereum;
    if (eth && !evmOff()) {
      const accts: string[] = await eth.request({ method: "eth_accounts" }).catch(() => []);
      if (accts[0]) evm = accts[0] as Address;
    }
    await refresh();
  })();
  const timer = window.setInterval(() => void refresh(), POLL_MS);
  const fastTimer = window.setInterval(() => void refreshEvm(), FAST_MS);
  let unwatch: (() => void) | null = null;
  const watchBlocks = () => {
    if (unwatch || document.hidden || gone) return;
    unwatch = pub.watchBlockNumber({ onBlockNumber: () => void refreshEvm(), onError: () => undefined, pollingInterval: 4000 });
  };
  const onVisible = () => {
    if (document.hidden) {
      unwatch?.();
      unwatch = null;
    } else {
      watchBlocks();
      void refreshEvm();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  watchBlocks();
  const tick = window.setInterval(() => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-countdown]")) el.textContent = mmss(Number(el.dataset.countdown) - Date.now());
    for (const el of root.querySelectorAll<HTMLElement>("[data-elapsed]")) el.textContent = mmss(Date.now() - Number(el.dataset.elapsed));
  }, 1000);
  return () => {
    gone = true;
    clearInterval(timer);
    clearInterval(fastTimer);
    clearInterval(tick);
    unwatch?.();
    document.removeEventListener("visibilitychange", onVisible);
    for (const d of dialogs.values()) {
      d.el.close();
      d.el.remove();
    }
    sv?.close();
    sv?.remove();
    stopNear();
    setNearNetwork("testnet");
  };
}

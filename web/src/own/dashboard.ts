// "Protect a position" on mainnet: a position dashboard (the testnet page keeps its guided demo).
// The visitor connects a NEAR mainnet wallet (it owns the position and signs its Stead calls) and an
// Ethereum wallet (it funds the position and is its payout). The page reads the contract and
// Ethereum every few seconds and offers the normal actions: deposit, borrow, repay, withdraw, buy
// back while a claim is open, and return leftover gas ETH. Each action shows the health factor it
// would leave before anything is signed. Nothing here holds a key: the wallets sign.
// Without an Ethereum wallet the visitor pastes the payout address and sends WETH and gas ETH
// straight to the position's address (shown with a QR code); every step after that is a NEAR call.
import { connectNear, nearAccount, onNearAccount, setNearNetwork, steadCall } from "../wallet/near";
import { createPublicClient, createWalletClient, custom, fallback, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { icon } from "../icons";
import { crown, bindCrowns } from "../crown";
import { CODE } from "../board/model";
import { NETS, gasFromMarket, marketMismatch, allowed, capUsd, directLines, ladder, units as fmtUnits, type MarketView, type LimitsView, type ParamsView, type RescueView, type ClaimView } from "./net";
import {
  project, depositMax, borrowMax, withdrawMax, repayAllUnits, sweepAmount, sweepSupported, gasTopUp, phaseOf, availability, fallLine,
  hfFromWad, hfText, hfBarPct, TRIGGER_BPS, TRANSFER_GAS, KEEPER_TOPS_UP_GAS, UNDER_TRIGGER_WARNING,
  checkPayout, gasAsk, arrived, depositPlan, buybackDue, fundPrompt, qrSvg,
  hfBand, hfPulses, riskLines, pctText, ltvView, premiumCapBase, barZones, BAR_MARKS, EARLY_SETTLE_BPS, linePrice,
  ladderStep, bidBarPct, premiumCostBase, stewardIdOf,
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

type Position = { id: number; owner: string; evm_address: string | null; payout: string; next_nonce: number; pending: unknown; active_auction: number | null; open_rescues: number[]; health?: unknown; premium_cap_base?: string; premium_used_base?: string };
type Books = { escrow: { collateral_units: string; debt_units: string; collateral_committed: string; debt_committed: string }; outflows: unknown[] };
type TxRow = { at: number; label: string; chain: "near" | "ethereum"; hash: string; ok: boolean; pos?: number };
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
  // what the visitor typed in each action, kept across the re-renders
  const amt: Record<string, string> = {};
  const all: Record<string, boolean> = {};
  let repayFrom: "position" | "wallet" = "wallet";
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
    await pub.waitForTransactionReceipt({ hash });
  }

  // ── Stead calls (the visitor's NEAR wallet) ──
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
    await stead("sign_action", { position_id: pid, action, gas: g }, label);
    busy = `${label}: signed by the contract, waiting for Ethereum`;
    render();
    for (let i = 0; i < 90; i++) {
      const p = await nearView<Position>("get_position", { position_id: pid });
      if (p.next_nonce > before && p.pending === null) return;
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
        }
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
      s = { nearYocto, pos, books, rescue, claims, ...evmPart };
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
      repayFromWallet: repayFrom === "wallet",
      sweepSupported: sweepSupported(cfg?.codeHash ?? null),
      sweepUnits: sweepAmount(s?.posBal.eth ?? 0n, maxFee),
    };
  };
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
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = label;
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
          ? `${label} paused: you cancelled the request in your wallet, so nothing was sent from that step on.`
          : `${label} stopped: ${raw.split("\n")[0].slice(0, 200)}`;
    }
    busy = "";
    await refresh();
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
      try {
        localStorage.removeItem(POSKEY());
      } catch {
        /* ignore */
      }
      await stead("register_position", { market_id: net.market, payout }, `Protect a new position (payout ${payout.slice(0, 8)}…; its Ethereum address is derived by NEAR's MPC network)`, 100n);
      noPosUntil = 0;
      let p: Position | null = null;
      for (let i = 0; i < 20 && !(p = await findPosition())?.evm_address; i++) {
        noPosUntil = 0;
        await sleep(2000);
      }
      if (!p?.evm_address) throw new Error("the new position didn't appear yet; it will show on the next read");
      for (const t of txs) if (t.pos === undefined && /^Protect a new position/.test(t.label)) t.pos = p.id;
      saveTxs();
    });

  const deposit = () => {
    const units = parse("deposit", C.decimals);
    if (!units) return;
    return run(`Depositing ${fmt(units, C.decimals, 6)} ${C.symbol}`, async () => {
      const addr = posAddr();
      const idle = await readBal(C.address, addr);
      if (!evm && idle < units) throw new Error(`the position holds ${fmt(idle, C.decimals, 6)} ${C.symbol}: send the rest (${fmt(units - idle, C.decimals, 6)} ${C.symbol}) to the position's address`);
      if (idle < units) await evmSend(`Send ${fmt(units - idle, C.decimals, 6)} ${C.symbol} to the position`, () => evmWallet().writeContract({ address: C.address, abi: erc20, functionName: "transfer", args: [addr, units - idle] }));
      if (capBase() > 0n && !(await nearView<Position>("get_position", { position_id: pid() })).health) {
        // the size cap is checked against a price reading of the position, which the keeper proves once it sees it
        busy = "Waiting for the first proven reading of the position (the size cap needs a price before a supply)";
        render();
        for (let i = 0; i < 60 && !(await nearView<Position>("get_position", { position_id: pid() })).health; i++) await sleep(5000);
      }
      if ((await readAllowance(C.address)) < units) await signAction(pid(), { type: "approve", token: "collateral", amount: "max" }, `Let Aave take the position's ${C.symbol}`);
      await signAction(pid(), { type: "supply", amount: units.toString() }, `Supply ${fmt(units, C.decimals, 6)} ${C.symbol} on Aave`);
      amt.deposit = "";
    });
  };
  const borrow = () => {
    const units = parse("borrow", D.decimals);
    if (!units) return;
    return run(`Borrowing ${fmt(units, D.decimals, 2)} ${D.symbol}`, async () => {
      // the borrowed USDC stays at the position: moving it to the wallet is its own action
      await signAction(pid(), { type: "borrow", amount: units.toString() }, `Borrow ${fmt(units, D.decimals, 2)} ${D.symbol}`);
      amt.borrow = "";
    });
  };
  const repay = () => {
    const op = opOf("repay");
    if (!op || !s?.acct) return;
    const repayAll = !!(op as any).all;
    const need = repayAll ? repayAllUnits(s.acct.debtBase, s.prices.debt, D.decimals) : op.units;
    return run(repayAll ? "Repaying all the debt" : `Repaying ${fmt(need, D.decimals, 2)} ${D.symbol}`, async () => {
      const addr = posAddr();
      const idle = await readBal(D.address, addr);
      if (repayFrom === "wallet") {
        const send = repayAll ? (need > idle ? need - idle : 0n) : need;
        if (send > 0n) await evmSend(`Send ${fmt(send, D.decimals, 2)} ${D.symbol} to the position to repay`, () => evmWallet().writeContract({ address: D.address, abi: erc20, functionName: "transfer", args: [addr, send] }));
      } else if (idle < need) throw new Error(`the position holds ${fmt(idle, D.decimals, 2)} ${D.symbol}, less than the ${fmt(need, D.decimals, 2)} this repay needs: repay from your wallet instead`);
      if ((await readAllowance(D.address)) < need) await signAction(pid(), { type: "approve", token: "debt", amount: "max" }, `Let Aave take the position's ${D.symbol}`);
      await signAction(pid(), { type: "repay", amount: repayAll ? "max" : { exact: need.toString() } }, repayAll ? "Repay all the debt" : `Repay ${fmt(need, D.decimals, 2)} ${D.symbol}`);
      amt.repay = "";
      all.repay = false;
    });
  };
  const withdraw = () => {
    const op = opOf("withdraw");
    if (!op) return;
    const wAll = !!(op as any).all;
    return run(wAll ? `Withdrawing all the ${C.symbol}` : `Withdrawing ${fmt(op.units, C.decimals, 6)} ${C.symbol}`, async () => {
      await signAction(pid(), { type: "withdraw", amount: wAll ? "max" : { exact: op.units.toString() } }, wAll ? `Withdraw all the ${C.symbol} to your wallet` : `Withdraw ${fmt(op.units, C.decimals, 6)} ${C.symbol} to your wallet`);
      amt.withdraw = "";
      all.withdraw = false;
    });
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
      notice = "Paid into your position. The keeper proves the balance, the contract commits the buy-back and pays the claim owner exactly what it is owed; anything extra is refunded to your wallet.";
    });
  const sweep = () =>
    run("Returning the position's leftover ETH", async () => {
      const bal = await pub.getBalance({ address: posAddr() });
      const maxFee = BigInt(gas.evmGas.max_fee_per_gas);
      const amount = sweepAmount(bal, maxFee);
      if (amount === 0n) throw new Error("nothing to return");
      const g = { gas_limit: TRANSFER_GAS.toString(), max_fee_per_gas: gas.evmGas.max_fee_per_gas, max_priority_fee_per_gas: gas.evmGas.max_priority_fee_per_gas };
      // a native transfer pays its own fee from the balance it leaves: no gas top-up first
      const before = (await nearView<Position>("get_position", { position_id: pid() })).next_nonce;
      await stead("sign_action", { position_id: pid(), action: { type: "sweep_eth", amount: amount.toString() }, gas: g }, `Return ${fmt(amount, 18, 6)} ETH to your wallet`);
      for (let i = 0; i < 90; i++) {
        const p = await nearView<Position>("get_position", { position_id: pid() });
        if (p.next_nonce > before && p.pending === null) return;
        await sleep(4000);
      }
    });
  /** USDC at the position → the payout: the typed amount, or all of it when nothing is typed. */
  const move = () => {
    const typed = parse("move", D.decimals);
    return run(`Moving the position's ${D.symbol} to your wallet`, async () => {
      const idle = await readBal(D.address, posAddr());
      if (idle === 0n) throw new Error(`the position holds no ${D.symbol}`);
      const units = typed && typed > 0n ? typed : idle;
      if (units > idle) throw new Error(`the position holds ${fmt(idle, D.decimals, 6)} ${D.symbol}, less than the ${fmt(units, D.decimals, 6)} typed`);
      await signAction(pid(), { type: "transfer_debt", amount: units.toString() }, `Move ${fmt(units, D.decimals, 2)} ${D.symbol} to your wallet`);
      amt.move = "";
    });
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
  function hfBarHtml(hf: bigint | null, on: boolean): string {
    const label = hf === null ? "no debt" : hfText(hf);
    const zones = barZones().map((z) => `<span class="st-dash-zone is-${z.band}" style="left:${z.left}%;width:${z.width}%"></span>`).join("");
    const marks = BAR_MARKS.map((m) => `<span class="st-dash-bar-mark${m.rescue ? " is-trigger" : ""}" style="left:${hfBarPct(m.bps)}%"><i>${m.label}</i></span>`).join("");
    const rescue = `<span class="st-dash-bar-rescue" style="left:${hfBarPct(TRIGGER_BPS)}%" title="Stewards rescue it automatically here">${icon("stewards", 14)}<span>rescue</span></span>`;
    const now = on ? `<span class="st-dash-bar-now${hfCls(hf)}${hfPulses(hf) ? " is-pulse" : ""}" style="left:${hfBarPct(hf)}%;animation-delay:-${Date.now() % PULSE_MS}ms"></span>` : "";
    return `<div class="st-dash-bar" role="img" aria-label="Health factor ${label}. Aave liquidates under 1.00, a claim settles early under 1.10, and stewards rescue it automatically under 1.15."><div class="st-dash-bar-track">${zones}${marks}${rescue}${now}</div></div>`;
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
          ? `<p class="st-own-stop" role="alert"><strong>${esc(near)}</strong> is not on the borrower allow-list (${listed}). The sidebar's NEAR button disconnects with a second click.</p>`
          : `<p class="st-dash-wsub">Reading the allow-list…</p>`;
    const w = s?.wallet;
    const payoutOff = s?.pos && evm && s.pos.payout.toLowerCase() !== evm.toLowerCase();
    const lowNear = s?.nearYocto != null && s.nearYocto < 50_000_000_000_000_000_000_000n;
    return `<section class="st-dash-wallets" aria-label="Your wallets">
      <div class="st-dash-wallet">
        <div class="st-label">${icon("near", 14)} NEAR · OWNS THE POSITION</div>
        ${near
          ? `<p class="st-dash-who">${esc(near)}</p><p class="st-dash-wsub">${s?.nearYocto != null ? `${fmt(s.nearYocto, 24, 3)} NEAR` : "…"}${lowNear ? ` · <strong>needs 0.05 NEAR to sign</strong>` : ""}</p>`
          : `<div class="st-own-buttons">${btn("Connect NEAR wallet", "data-near", true)}</div><p class="st-dash-wsub">Signs the position's Stead calls (a key for ${esc(net.contract)} only).</p>`}
        ${allowLine}
      </div>
      <div class="st-dash-wallet">
        <div class="st-label">${icon("ethereum", 14)} ETHEREUM · FUNDS IT, GETS PAYOUTS</div>
        ${evm
          ? `<p class="st-dash-who"><span class="st-mono">${short(evm)}</span><button type="button" class="st-own-x" data-evm-off title="Disconnect this Ethereum wallet" aria-label="Disconnect this Ethereum wallet"${busy ? " disabled" : ""}>${icon("close", 12)}</button></p>
             <dl class="st-dash-wbal">
               <div><dt>ETH</dt><dd>${w ? fmt(w.eth, 18, 5) : "…"}</dd></div>
               <div><dt>${C.symbol}</dt><dd>${w ? fmt(w.coll, C.decimals, 5) : "…"}</dd></div>
               <div><dt>${D.symbol}</dt><dd>${w ? fmt(w.debt, D.decimals, 2) : "…"}</dd></div>
             </dl>`
          : `<div class="st-own-buttons">${btn("Connect Ethereum wallet", "data-evm", !!near)}</div><p class="st-dash-wsub">${s?.pos ? `Payout <span class="st-mono">${short(s.pos.payout)}</span> · without a wallet, send funds to the position's address.` : `Sends the ${C.symbol} and ${D.symbol}; receives withdrawals and refunds. No wallet here? Paste a payout address below.`}</p>`}
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
    const why = !near ? "Connect your NEAR wallet first." : allow === "no" ? "This NEAR account is not on the allow-list." : pasted && !pasted.ok ? "Connect your Ethereum wallet, or paste a payout address: it receives withdrawals and refunds." : mismatch.length ? "The contract's market does not match this page." : !cfg ? "Reading the contract…" : "";
    const payoutShown = evm ? `<span class="st-mono">${short(evm)}</span>` : pasted?.ok ? `<span class="st-mono">${short(pasted.address)}</span>` : "your Ethereum wallet";
    return `<div class="st-dash-new">
      <div class="st-label">NO POSITION ON MARKET ${net.market} YET${near ? ` · ${esc(near)}` : ""}</div>
      <h2>Protect a new position</h2>
      <p>${C.symbol} collateral, ${D.symbol} debt, Aave V3 on Ethereum · up to $${capUsd(cfg?.limits ?? null) || 150} · payout ${payoutShown}</p>
      ${evm ? "" : disc("payout", "No Ethereum wallet? Paste a payout address", payoutHtml)}
      <div class="st-dash-go">${btn("Protect a new position", "data-register", true, !!why)}${why ? `<p class="st-dash-why">${esc(why)}</p>` : ""}</div>
      ${disc("how-new", "How it works", () => `<p>One NEAR call registers the position on ${esc(net.contract)}. NEAR's chain signatures derive its Ethereum address, and only the contract can sign for it. Withdrawals and refunds go to the payout. Then supply ${C.symbol} and borrow below.</p>`)}
    </div>`;
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
    const ends = (s!.claims ?? []).filter((c) => c.status === "open" && c.expires_at).map((c) => nsMs(c.expires_at));
    const winEnd = ends.length ? Math.min(...ends) : 0;
    const params = cfg?.params;
    let now: string;
    if (busy) now = `${esc(busy)} <span class="st-own-elapsed" data-elapsed="${busySince}">${mmss(Date.now() - busySince)}</span>`;
    else if (r?.state === "auction") now = `Rescue #${r.id}: stewards bidding · <strong data-countdown="${nsMs(r.closes_at)}">${mmss(nsMs(r.closes_at) - Date.now())}</strong> left`;
    else if (r?.state === "top_up_pending") {
      const due = nsMs(r.closes_at) + (params ? Number(BigInt(params.topup_deadline_ns) / 1_000_000n) : 0);
      now = `Rescue #${r.id}: the winner is topping up${params ? ` · due in <strong data-countdown="${due}">${mmss(due - Date.now())}</strong>` : ""}`;
    } else if (r?.state === "open") now = `Rescue #${r.id}: claim open · <strong data-countdown="${winEnd}">${mmss(winEnd - Date.now())}</strong> to buy back`;
    else if (r?.state === "settling") now = `Rescue #${r.id}: the claim owner is settling at the oracle price`;
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
      <div class="st-np-head"><span class="${lamp}" aria-hidden="true"></span><span class="st-np-label">POSITION ${pos.id}</span>${chip}<span class="st-np-now">${now}</span></div>
      <dl class="st-dash-kpis">
        <div class="st-dash-kpi-hf"><dt>HEALTH FACTOR</dt><dd class="st-dash-big st-dash-hfrow">${hf === null ? `<span class="st-dash-nodebt">no debt</span>` : `<span class="st-num st-dash-hf${hfCls(hf)}">${hfLabel}</span>`}${riskBtn}</dd><dd class="st-dash-cons">${hf === null ? "nothing to liquidate" : fallLine(hf, C.symbol)}</dd><dd>${bar}</dd></div>
        <div><dt>COLLATERAL</dt><dd class="st-dash-big">${collNum}</dd><dd class="st-dash-cons">${collSub}</dd></div>
        <div><dt>DEBT</dt><dd class="st-dash-big"><span class="st-num">${a ? usd8(a.debtBase, 2) : "…"}</span></dd><dd class="st-dash-cons">${a ? (a.debtBase > 0n ? `${fmt(debtUnits, D.decimals, 2)} ${D.symbol} borrowed` : "nothing borrowed") : ""}</dd></div>
      </dl>
      <p class="st-dash-src">${C.symbol} ${s!.prices.coll ? usd8(s!.prices.coll, 2) : "…"} · Aave V3 and ${esc(net.contract)}, Ethereum read every ${FAST_MS / 1000} s and on each block</p>
    </section>`;
  }

  /** Send to the position's address (no wallet connected, or an action waiting for gas): what to
   *  send, the address large with a copy button, and its QR code. Ethereum mainnet only. */
  function fundHtml(): string {
    const f = facts();
    const fp = fundPrompt({ registered: f.registered, evmConnected: f.evmConnected, locked: f.locked, claimOpen: f.claimOpen, ethWei: s!.posBal.eth, upfrontWei: gas.txUpfrontWei, gasWaitWei: gasWait, dueUnits: buybackDue(owedUnits(), s!.posBal.coll) });
    if (fp.kind === "none") return "";
    const addr = s!.pos!.evm_address!;
    const eth = (w: bigint) => `${fmt(w, 18, 4)} ETH`;
    const gasTail = (w: bigint) => (w > 0n ? ` <span class="st-dash-fund-gas">and about ${eth(w)} for its gas</span>` : "");
    const say = fp.kind === "gas"
      ? `Send about <strong>${eth(fp.gasWei)}</strong> to this address for the position's gas`
      : fp.kind === "buyback"
        ? `Send exactly <strong>${trim(fp.wethUnits, C.decimals, C.decimals)} ${C.symbol}</strong> on Ethereum to this address${gasTail(fp.gasWei)}`
        : `Send <strong>${C.symbol}</strong> on Ethereum to this address${gasTail(fp.gasWei)}`;
    const only = fp.kind === "gas" ? `<strong>Ethereum mainnet only.</strong> ETH only.` : `<strong>Ethereum mainnet only.</strong> ${C.symbol}${fp.gasWei > 0n ? " and ETH" : ""} only: no other token, no other network.`;
    const sub = fp.kind === "gas"
      ? "The action goes on by itself once it arrives."
      : fp.kind === "buyback"
        ? "Once the balance is proven, the contract pays the claim owner exactly what it is owed and refunds any extra to your payout."
        : "Then supply it below: one NEAR call, no Ethereum wallet needed.";
    const copied = Date.now() - copiedAt < 1600;
    const head = fp.kind === "gas" ? "GAS NEEDED" : fp.kind === "buyback" ? "BUY BACK BY SENDING" : "FUND THE POSITION";
    return `<section class="st-dash-fund" aria-label="Send to the position's address">
      <div class="st-label">${head} · ETHEREUM MAINNET</div>
      <div class="st-dash-fund-row">
        <figure class="st-dash-qr">${qrSvg(addr, `QR code of the position's address, ${addr}`)}<figcaption>Position address</figcaption></figure>
        <div class="st-dash-fund-main">
          <p class="st-dash-fund-say">${say}</p>
          <p class="st-dash-fund-addr"><span class="st-mono">${esc(addr)}</span><button type="button" class="st-dash-copy" data-copy="${addr}" aria-label="Copy the position's address">${copied ? icon("check", 16) : copyGlyph()}</button><span class="st-dash-copied" role="status">${copied ? "Copied" : ""}</span></p>
          <p class="st-dash-fund-only">${only}</p>
          <p class="st-dash-fund-sub">${sub}</p>
        </div>
      </div>
    </section>`;
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
        <div class="st-dash-lclock" data-l-clock><span class="st-mini-clock" role="timer" data-l-count></span><span class="st-label" data-l-clocklbl></span></div>
      </div>
      <div class="st-ladder-head" aria-hidden="true"><span>#</span><span>STEWARD</span><span class="st-dash-axis"><span>0</span><span data-l-cap></span></span><span>PREMIUM</span><span>COST</span></div>
      <div class="st-ladder" role="list" aria-label="Bids, lowest premium first" data-l-ladder>${[0, 1, 2].map((i) => `<div class="st-placeholder" style="--rank:${i}" aria-hidden="true">watching</div>`).join("")}</div>
      <div class="st-dash-pipes" data-l-pipes></div>
      <div class="st-dash-tags" data-l-tags></div>`;
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
    const ends = (s!.claims ?? []).filter((c) => c.status === "open" && c.expires_at).map((c) => nsMs(c.expires_at));
    const topupDue = nsMs(r.closes_at) + (params ? Number(BigInt(params.topup_deadline_ns) / 1_000_000n) : 0);
    const clock: { at: number; label: string } | null =
      r.state === "auction" ? { at: nsMs(r.closes_at), label: "TO CLOSE" }
      : r.state === "top_up_pending" && params ? { at: topupDue, label: "TOP-UP DUE" }
      : r.state === "open" && ends.length ? { at: Math.min(...ends), label: "TO BUY BACK" }
      : null;
    const topupUsd = s!.prices.coll ? usdOf(BigInt(r.topup_units), s!.prices.coll, C.decimals) : "";
    q("[data-l-label]").textContent = `RESCUE #${r.id} · ${r.state === "auction" ? "LOWEST PREMIUM WINS" : r.state.replace(/_/g, " ").toUpperCase()} · CAP ${r.cap_bps} BPS`;
    q("[data-l-title]").textContent =
      r.state === "auction" ? (lead ? `${lead.name} leads at ${lead.bps} bps` : "Stewards are pricing the top-up")
      : r.state === "top_up_pending" ? `${wName || "The winner"} won: topping up`
      : r.state === "open" ? `Rescued by ${wName || "the winner"}: claim open`
      : r.state === "settling" ? "Settling at the oracle price"
      : `Rescue ${r.state.replace(/_/g, " ")}`;
    q("[data-l-sub]").textContent = `Top-up ${fmtUnits(r.topup_units, C.decimals, 6)} ${C.symbol}${topupUsd ? ` (${topupUsd})` : ""} back to health ${params ? (params.target_hf_bps / 10_000).toFixed(2) : "1.50"} · bids stamped when this page first saw them`;
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

  function positionWalletHtml(): string {
    const pos = s!.pos!;
    const b = s!.posBal;
    const addr = pos.evm_address!;
    const upfront = gas.txUpfrontWei;
    const txsLeft = upfront > 0n ? b.eth / upfront : 0n;
    const copied = Date.now() - copiedAt < 1600;
    const gasNote = KEEPER_TOPS_UP_GAS
      ? "Gas is topped up by the keeper when short."
      : evm
        ? `When it can't cover the next one, your Ethereum wallet is asked for a small top-up (${fmt(2n * upfront, 18, 6)} ETH at most) first.`
        : `When it can't cover the next one, the page asks you to send about ${fmt(gasAsk(0n, upfront), 18, 4)} ETH to this address and waits for it.`;
    return `<section class="st-dash-poswallet" aria-label="The position's address">
      <div class="st-label">POSITION ADDRESS · ETHEREUM</div>
      <p class="st-dash-addr"><span class="st-mono">${esc(addr)}</span><button type="button" class="st-dash-copy" data-copy="${addr}" aria-label="Copy the position's address">${copied ? icon("check", 16) : copyGlyph()}</button><span class="st-dash-copied" role="status">${copied ? "Copied" : ""}</span></p>
      <p class="st-dash-links">${ext(net.evmAddress(addr), "Etherscan")}${ext(`https://debank.com/profile/${addr}`, "DeBank")}<span>${ext("https://app.aave.com/?marketName=proto_mainnet_v3", "Aave")}: Watch wallet, then paste the address</span></p>
      <dl class="st-dash-bal">
        <div${flashArrival ? ' class="is-flash"' : ""}><dt>${C.symbol} HERE</dt><dd>${fmt(b.coll, C.decimals, 8)}</dd></div>
        <div><dt>${D.symbol} HERE</dt><dd>${fmt(b.debt, D.decimals, 6)}</dd></div>
        <div><dt>ETH · GAS</dt><dd>${fmt(b.eth, 18, 6)}<span> · ~${txsLeft.toString()} tx</span></dd></div>
      </dl>
      ${disc("how-gas", "About these balances and gas", () => `<p>Tokens here sit at the position's address, not supplied on Aave. Each transaction the contract signs may cost at most ${Number(gas.evmGas.gas_limit).toLocaleString("en-US")} gas at ${fmt(BigInt(gas.evmGas.max_fee_per_gas), 9, 2)} gwei (${fmt(upfront, 18, 6)} ETH, wanted up front; the real cost is lower). ${gasNote}</p>`)}
    </section>`;
  }

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
      <div class="st-dash-go">${btn(label, `data-go=${id}`, true, off)}${proj}</div>
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
    const wethCard = `<div class="st-dash-act${wv.on ? "" : " is-off"}" data-act="${wm}">
      <div class="st-dash-act-head"><h3>${C.symbol}</h3>${seg(`${C.symbol} action`, "data-mode", [{ v: "weth:deposit", t: "SUPPLY" }, { v: "weth:withdraw", t: "WITHDRAW" }], `weth:${wm}`)}</div>
      <p class="st-dash-have">${evm ? `wallet ${w ? fmt(w.coll, C.decimals, 5) : "…"} · ` : ""}supplied ${fmt(collUnits, C.decimals, 5)}${idleColl > 0n ? ` · ${fmt(idleColl, C.decimals, 6)} waiting` : ""}</p>
      ${wm === "deposit"
        ? arrivedLine + input("deposit", C.symbol, "MAX", !av.deposit.on) + liveHtml("deposit", av.deposit, opLabel("deposit", "Supply", C.symbol, C.decimals, 6), !!shortV, shortV ?? av.deposit)
          + disc("how-deposit", "How it works", () => evm
            ? `<p>Your Ethereum wallet sends the ${C.symbol} to the position (one signature; ${C.symbol} already waiting there counts), then the contract supplies it on Aave (one NEAR call, two the first time for Aave's approval). MAX: what you hold, within the $${capUsd(cfg?.limits ?? null) || 150} cap (${usd8(dMax && P.coll ? (dMax * P.coll) / 10n ** 18n : 0n)}).</p>`
            : `<p>Send ${C.symbol} to the position's address; once it is there the contract supplies it on Aave (one NEAR call, two the first time for Aave's approval). Nothing is sent from a wallet here. Up to the $${capUsd(cfg?.limits ?? null) || 150} cap.</p>`)
        : input("withdraw", C.symbol, "MAX", !av.withdraw.on) + liveHtml("withdraw", av.withdraw, opLabel("withdraw", "Withdraw", C.symbol, C.decimals, 6)) + tryBtn("withdraw", av.withdraw)
          + disc("how-withdraw", "How it works", () => `<p>One NEAR call: the contract signs Aave's withdraw, which sends the ${C.symbol} straight to your payout <span class="st-mono">${short(pos.payout)}</span>. MAX: down to health 1.16, or all of it with no debt.</p>`)}
    </div>`;

    // USDC: borrow | repay
    const um = usdcMode;
    const fromPos = s!.posBal.debt > 0n;
    // the repay rules without the source: whether the switch and the amount are usable at all
    const repayAny = availability({ ...f, repayFromWallet: false }).repay;
    const uv = um === "borrow" ? av.borrow : av.repay;
    const usdcCard = `<div class="st-dash-act${uv.on ? "" : " is-off"}" data-act="${um}">
      <div class="st-dash-act-head"><h3>${D.symbol}</h3>${seg(`${D.symbol} action`, "data-mode", [{ v: "usdc:borrow", t: "BORROW" }, { v: "usdc:repay", t: "REPAY" }], `usdc:${um}`)}</div>
      <p class="st-dash-have">${evm ? `wallet ${w ? fmt(w.debt, D.decimals, 2) : "…"} · ` : ""}debt ${fmt(debtUnits, D.decimals, 2)}${fromPos ? ` · ${fmt(s!.posBal.debt, D.decimals, 2)} at the position` : ""}</p>
      ${um === "borrow"
        ? input("borrow", D.symbol, "MAX 1.16", !av.borrow.on) + liveHtml("borrow", av.borrow, opLabel("borrow", "Borrow", D.symbol, D.decimals, 2)) + tryBtn("borrow", av.borrow)
          + disc("how-borrow", "How it works", () => `<p>One NEAR call: the contract signs the Aave borrow and the ${D.symbol} lands at the position (Aave only lends to the position itself). Move it to your wallet below, or keep some there for a later repay. MAX stops at health 1.16, just above the trigger.</p>`)
        : `<div class="st-dash-from"><span class="st-label">FROM</span>${seg("Repay from", "data-repay-from", [{ v: "wallet", t: "MY WALLET", off: !repayAny.on }, { v: "position", t: "THE POSITION", off: !repayAny.on || !fromPos }], repayFrom)}</div>`
          + input("repay", D.symbol, "ALL", !repayAny.on) + liveHtml("repay", av.repay, opLabel("repay", "Repay", D.symbol, D.decimals, 2), repayFrom === "wallet" && !evm)
          + disc("how-repay", "How it works", () => `<p>${repayFrom === "wallet" ? `Your Ethereum wallet sends the ${D.symbol} to the position (one signature), then` : `From the ${fmt(s!.posBal.debt, D.decimals, 2)} ${D.symbol} already at the position:`} the contract repays Aave (one NEAR call, two the first time). ALL repays the debt plus 0.2% for interest; Aave takes only what is owed.</p>`)}
    </div>`;

    // buy back (only while a claim is open)
    let buyCard = "";
    if (f.claimOpen) {
      const owed = owedUnits();
      const held = s!.posBal.coll;
      buyCard = `<div class="st-dash-act st-dash-buy${av.buyback.on ? "" : " is-off"}" data-act="buyback">
        <div class="st-dash-act-head"><h3>Buy back</h3></div>
        <p class="st-dash-owed"><span class="st-label">OWED</span><span class="st-num">${fmt(owed, C.decimals, 8)}</span><span class="st-dash-unit">${C.symbol}</span>${held > 0n ? `<span class="st-dash-have">${fmt(held, C.decimals, 8)} already at the position counts</span>` : ""}</p>
        <div class="st-dash-go">${btn(`Buy back for ${fmt(owed > held ? owed - held : 0n, C.decimals, 10)} ${C.symbol}`, "data-go=buyback", true, !av.buyback.on)}</div>
        ${av.buyback.on ? "" : `<p class="st-dash-why">${esc(!evm ? `Send exactly ${trim(buybackDue(owed, held), C.decimals, C.decimals)} ${C.symbol} to the position's address above, or connect your Ethereum wallet.` : av.buyback.why)}</p>`}
        ${disc("how-buyback", "How it works", () => `<p>Pay exactly what is owed into the position (one Ethereum signature). The contract checks the proven balance and pays the claim owner exactly that; any excess is refunded to your wallet.</p>`)}
      </div>`;
    }

    // small, secondary: leftover gas ETH, USDC left at the position
    const sw = f.sweepUnits;
    const minor = [`<div class="st-dash-minor-item" data-act="sweep"><span class="st-dash-minor-lbl">Leftover gas ETH</span>${btn(`Return ${fmt(sw, 18, 6)} ETH`, "data-go=sweep", false, !av.sweep.on)}${av.sweep.on ? "" : `<span class="st-dash-minor-why">${esc(av.sweep.why)}</span>`}</div>`];

    // USDC at the position → the wallet: separate from the borrow, so some can stay for a repay
    const idleDebt = s!.posBal.debt;
    let moveCard = "";
    if (idleDebt > 0n) {
      const typed = parse("move", D.decimals);
      const units = typed && typed > 0n ? typed : idleDebt;
      const tooMuch = units > idleDebt;
      const typedBad = (amt.move ?? "").trim() !== "" && typed === null;
      moveCard = `<div class="st-dash-act st-dash-move${av.move.on ? "" : " is-off"}" data-act="move">
        <div class="st-dash-act-head"><h3>${D.symbol} at the position</h3><p class="st-dash-move-have"><span class="st-num">${fmt(idleDebt, D.decimals, 2)}</span><span class="st-dash-unit">${D.symbol}</span></p></div>
        <div class="st-dash-amt"><label class="st-visually-hidden" for="dash-amt-move">Amount in ${D.symbol} to move to your wallet</label><input id="dash-amt-move" data-amt="move" inputmode="decimal" autocomplete="off" placeholder="${trim(idleDebt, D.decimals, 6)}" value="${esc(amt.move ?? "")}"${av.move.on ? "" : " disabled"}><span class="st-dash-sym">${D.symbol}</span><button type="button" class="st-dash-max" data-max="move"${!av.move.on || busy ? " disabled" : ""}>ALL</button></div>
        <div class="st-dash-live">
          <div class="st-dash-go">${btn(`Move ${fmt(units, D.decimals, 2)} ${D.symbol} to my wallet`, "data-go=move", true, !av.move.on || tooMuch || typedBad)}</div>
          ${!av.move.on ? `<p class="st-dash-why">${esc(av.move.why)}</p>` : tooMuch ? `<p class="st-own-stop" role="alert">The position holds ${fmt(idleDebt, D.decimals, 6)} ${D.symbol}: move that much or less.</p>` : ""}
        </div>
        ${disc("how-move", "How it works", () => `<p>One NEAR call: the contract signs a transfer of the ${D.symbol} from the position to your payout <span class="st-mono">${short(pos.payout)}</span>. Empty moves all of it. ${D.symbol} left here can repay later (Repay, from THE POSITION).</p>`)}
      </div>`;
    }

    return `${buyCard}<div class="st-dash-actions">${wethCard}${usdcCard}</div>${moveCard}<div class="st-dash-minor">${minor.join("")}</div>`;
  }

  /** Every activity row for the position (its transactions and the rescue's events), newest first. */
  function activityHtml(): string {
    if (!s?.pos) return "";
    const rows: { at: number; html: string }[] = shown().map((t) => {
      const reason = t.ok ? "" : t.label.match(/refused by the contract \("(.*)"\)$/)?.[1] ?? "";
      const link = t.hash ? `<a class="st-dash-txlink" href="${t.chain === "near" ? net.nearTx(t.hash) : net.evmTx(t.hash)}" target="_blank" rel="noopener">${t.chain === "near" ? "NearBlocks" : "Etherscan"}${icon("external", 11)}</a>` : "";
      return { at: t.at, html: `${t.ok ? "" : '<span class="st-own-chip-refused">refused</span> '}${esc(t.label.replace(/: refused by the contract.*$/, ""))}${reason ? ` <span class="st-dash-reason">"${esc(reason)}"</span>` : ""}${link}` };
    });
    if (s.rescue) for (const l of directLines(s.rescue, s.claims, C, net.evmName)) {
      if (!seenAt.has(l.key)) seenAt.set(l.key, l.atMs ?? Date.now());
      rows.push({ at: l.atMs ?? seenAt.get(l.key)!, html: l.html });
    }
    if (!rows.length) return "";
    rows.sort((x, y) => y.at - x.at);
    const li = (r: { at: number; html: string }) => `<li><span class="st-np-t">${new Date(r.at).toISOString().slice(11, 19)}</span><span>${r.html}</span></li>`;
    const more = rows.length - 1;
    return `<div class="st-np-journal st-dash-journal">
      <div class="st-dash-jhead"><span class="st-journal-head">ACTIVITY · POSITION ${s.pos.id}</span>${more > 0 ? `<button type="button" class="st-dash-jmore" data-more-txs aria-expanded="${showAllTxs}" aria-controls="dash-activity">${showAllTxs ? "Hide" : `${more} earlier`}${chevron()}</button>` : ""}</div>
      <ol class="st-np-lines" id="dash-activity">${li(rows[0])}${showAllTxs ? rows.slice(1, 80).map(li).join("") : ""}</ol>
    </div>`;
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
  let dlg: HTMLDialogElement | null = null;
  function openRisk() {
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "st-dash-risk";
      dlg.setAttribute("aria-labelledby", "dash-risk-title");
      dlg.innerHTML = `<div class="st-dash-risk-head"><div><div class="st-label">POSITION ${s?.pos?.id ?? ""} · LIQUIDATION RISK</div><h2 id="dash-risk-title">Risk details</h2></div><button type="button" class="st-dash-risk-x" data-risk-close aria-label="Close risk details">${icon("close", 16)}</button></div><div class="st-dash-risk-body" data-risk-body></div>`;
      document.body.append(dlg);
      dlg.querySelector("[data-risk-close]")!.addEventListener("click", () => dlg!.close());
      // a click on the backdrop closes it; Esc closes it natively
      dlg.addEventListener("click", (ev) => {
        if (ev.target === dlg) dlg!.close();
      });
      // keep Tab inside the dialog
      dlg.addEventListener("keydown", (ev) => {
        if (ev.key !== "Tab") return;
        const f = [...dlg!.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])")].filter((x) => !(x as HTMLButtonElement).disabled);
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
      dlg.addEventListener("close", () => root.querySelector<HTMLElement>("[data-risk]")?.focus());
    }
    dlg.querySelector("[data-risk-body]")!.innerHTML = riskHtml();
    if (!dlg.open) dlg.showModal();
    dlg.querySelector<HTMLElement>("[data-risk-close]")!.focus();
  }

  // keep what the visitor is typing (and which control has focus) across re-renders
  const FOCUS_KEYS = ["amt", "payout", "disc", "mode", "repayFrom", "copy", "max", "moreTxs", "risk"] as const;
  function render() {
    if (gone) return;
    const focused = document.activeElement as HTMLElement | null;
    const inRoot = !!focused && root.contains(focused);
    const fk = inRoot ? FOCUS_KEYS.find((k) => focused!.dataset[k] !== undefined) : undefined;
    const focusSel = fk ? `[data-${fk.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}${focused!.dataset[fk] ? `="${focused!.dataset[fk]}"` : ""}]` : null;
    const inp = fk === "amt" || fk === "payout" ? (focused as HTMLInputElement) : null;
    const sel = inp ? [inp.selectionStart, inp.selectionEnd] : null;
    const netSwitch = `<nav class="st-own-net" aria-label="Network"><div class="st-own-netseg"><a href="${location.pathname}#/try">TESTNET</a><a href="${location.pathname}?net=mainnet#/try" aria-current="page">MAINNET · REAL FUNDS</a></div></nav>`;
    const pos = s?.pos ?? null;
    const full = !!s && !!pos?.evm_address;
    const body = !s
      ? `<p class="st-empty">${near ? "Reading the contract and Ethereum…" : ""}</p>`
      : full
        ? `${statusHtml()}${activityHtml()}${fundHtml()}`
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
      ${busy && !pos?.evm_address ? `<p class="st-own-notice" role="status">${esc(busy)} <span class="st-own-elapsed" data-elapsed="${busySince}">${mmss(Date.now() - busySince)}</span></p>` : ""}
      ${body}`;
    const ladHost = shell.querySelector<HTMLElement>('[data-part="ladder"]')!;
    if (full && lad && s?.rescue?.id === lad.rid) {
      if (lad.el.parentElement !== ladHost) ladHost.replaceChildren(lad.el);
      updateLadder();
    } else if (ladHost.firstChild) ladHost.replaceChildren();
    shell.querySelector<HTMLElement>('[data-part="post"]')!.innerHTML = full ? `${actionsHtml()}${positionWalletHtml()}` : "";
    if (dlg?.open) {
      if (full) dlg.querySelector("[data-risk-body]")!.innerHTML = riskHtml();
      else dlg.close();
    }
    flashArrival = false; // the arrival highlight plays once
    bind();
    if (focusSel) {
      const el = root.querySelector<HTMLElement>(focusSel);
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus();
        if (sel && el instanceof HTMLInputElement) el.setSelectionRange(sel[0], sel[1]);
      }
    }
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
  }
  function go(id: string) {
    const f: Record<string, (() => unknown) | undefined> = { deposit, borrow, repay, withdraw, buyback: buyBack, sweep, move };
    void f[id]?.();
  }
  function bind() {
    root.querySelector("[data-near]")?.addEventListener("click", () => run("Connecting your NEAR wallet", async () => {
      near = await connectNear();
      loadTxs();
    }));
    root.querySelector("[data-evm]")?.addEventListener("click", () => run("Connecting your Ethereum wallet", connectEvm));
    root.querySelector("[data-evm-off]")?.addEventListener("click", () => void disconnectEvm());
    root.querySelector("[data-register]")?.addEventListener("click", register);
    root.querySelector("[data-risk]")?.addEventListener("click", openRisk);
    root.querySelector("[data-more-txs]")?.addEventListener("click", () => {
      showAllTxs = !showAllTxs;
      render();
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
        repayFrom = r.dataset.repayFrom as "position" | "wallet";
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
    dlg?.close();
    dlg?.remove();
    stopNear();
    setNearNetwork("testnet");
  };
}

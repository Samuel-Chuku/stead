// "Protect a position" on mainnet: a position dashboard (the testnet page keeps its guided demo).
// The visitor connects a NEAR mainnet wallet (it owns the position and signs its Stead calls) and an
// Ethereum wallet (it funds the position and is its payout). The page reads the contract and
// Ethereum every few seconds and offers the normal actions: deposit, borrow, repay, withdraw, buy
// back while a claim is open, and return leftover gas ETH. Each action shows the health factor it
// would leave before anything is signed. Nothing here holds a key: the wallets sign.
import { connectNear, nearAccount, onNearAccount, setNearNetwork, steadCall } from "../wallet/near";
import { createPublicClient, createWalletClient, custom, fallback, http, parseAbi, parseUnits, type Address, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { icon } from "../icons";
import { NETS, gasFromMarket, marketMismatch, allowed, capUsd, directLines, ladder, units as fmtUnits, type MarketView, type LimitsView, type ParamsView, type RescueView, type ClaimView } from "./net";
import {
  project, depositMax, borrowMax, withdrawMax, repayAllUnits, sweepAmount, sweepSupported, gasTopUp, phaseOf, availability, fallLine,
  hfFromWad, hfText, hfBarPct, TRIGGER_BPS, LIQUIDATION_BPS, TRANSFER_GAS, KEEPER_TOPS_UP_GAS, UNDER_TRIGGER_WARNING,
  type Account, type Avail, type Op, type Phase, type Projection,
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: bigint, dec = 18, dp = 4) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dp });
const usd8 = (v: bigint, dp = 2) => "$" + (Number(v) / 1e8).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
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

type Position = { id: number; owner: string; evm_address: string | null; payout: string; next_nonce: number; pending: unknown; active_auction: number | null; open_rescues: number[]; health?: unknown };
type Books = { escrow: { collateral_units: string; debt_units: string; collateral_committed: string; debt_committed: string }; outflows: unknown[] };
type TxRow = { at: number; label: string; chain: "near" | "ethereum"; hash: string; ok: boolean; pos?: number };
type Bal = { eth: bigint; coll: bigint; debt: bigint };
type State = {
  nearYocto: bigint | null;
  wallet: Bal | null;
  pos: Position | null;
  acct: Account | null;
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
  async function refresh() {
    if (gone || refreshing) return;
    refreshing = true;
    try {
      await readCfg();
      const pos = await findPosition();
      const pa = (pos?.evm_address ?? null) as Address | null;
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
      const out = (await pub.multicall({ contracts: calls, allowFailure: false })) as any[];
      let k = 2;
      const wallet: Bal | null = evm ? { eth: out[k++], coll: out[k++], debt: out[k++] } : null;
      let acct: Account | null = null, hf: bigint | null = null;
      let posBal: Bal = { eth: 0n, coll: 0n, debt: 0n }, allow = { coll: 0n, debt: 0n };
      if (pa) {
        const d = out[k++] as readonly bigint[];
        acct = { collBase: d[0], debtBase: d[1], availBase: d[2], ltBps: d[3] };
        hf = hfFromWad(d[1], d[5]); // null without debt (never Aave's no-debt sentinel as a number)
        posBal = { eth: out[k++], coll: out[k++], debt: out[k++] };
        allow = { coll: out[k++], debt: out[k++] };
      }
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
      s = { nearYocto, wallet, pos, acct, hf, prices: { coll: out[0], debt: out[1] }, posBal, allow, books, rescue, claims };
      if (error.startsWith("Reading the chains failed")) error = "";
    } catch (e) {
      error = `Reading the chains failed (${(e as Error).message.split("\n")[0].slice(0, 160)}); retrying.`;
    } finally {
      refreshing = false;
    }
    render();
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

  const register = () =>
    run("Protecting a new position", async () => {
      if (!evm) throw new Error("connect your Ethereum wallet first: it becomes the position's payout");
      try {
        localStorage.removeItem(POSKEY());
      } catch {
        /* ignore */
      }
      await stead("register_position", { market_id: net.market, payout: evm }, `Protect a new position (payout ${evm.slice(0, 8)}…; its Ethereum address is derived by NEAR's MPC network)`, 100n);
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
      await signAction(pid(), { type: "borrow", amount: units.toString() }, `Borrow ${fmt(units, D.decimals, 2)} ${D.symbol}`);
      try {
        await signAction(pid(), { type: "transfer_debt", amount: units.toString() }, `Move the borrowed ${fmt(units, D.decimals, 2)} ${D.symbol} to your wallet`);
      } catch (e) {
        if (!(e as any).refused) throw e;
        // under the trigger, the auction can open before this lands: from then on the contract signs
        // only repays and supplies, so the USDC stays in the position until the rescue ends
        notice = `A rescue opened before the borrowed ${fmt(units, D.decimals, 2)} ${D.symbol} left your position. While a rescue runs the contract only signs repays and supplies, so it stays there; move it to your wallet once the rescue ends (or it pays the buy-back's debt side).`;
      }
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
  const move = () =>
    run(`Moving the position's ${D.symbol} to your wallet`, async () => {
      const idle = await readBal(D.address, posAddr());
      if (idle === 0n) throw new Error(`the position holds no ${D.symbol}`);
      await signAction(pid(), { type: "transfer_debt", amount: idle.toString() }, `Move ${fmt(idle, D.decimals, 2)} ${D.symbol} to your wallet`);
    });

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
          : `<div class="st-own-buttons">${btn("Connect Ethereum wallet", "data-evm", !!near)}</div><p class="st-dash-wsub">Sends the ${C.symbol} and ${D.symbol}; receives withdrawals and refunds.</p>`}
        ${payoutOff ? `<p class="st-own-stop">Position ${s!.pos!.id} pays out to <span class="st-mono">${esc(s!.pos!.payout)}</span>, not this wallet: withdrawals and refunds go there.</p>` : ""}
      </div>
    </section>`;
  }

  function newPositionHtml(): string {
    const allow = allowed(cfg?.limits ?? null, near);
    const why = !near ? "Connect your NEAR wallet first." : allow === "no" ? "This NEAR account is not on the allow-list." : !evm ? "Connect your Ethereum wallet: it becomes the position's payout." : mismatch.length ? "The contract's market does not match this page." : !cfg ? "Reading the contract…" : "";
    return `<div class="st-dash-new">
      <div class="st-label">NO POSITION ON MARKET ${net.market} YET${near ? ` · ${esc(near)}` : ""}</div>
      <h2>Protect a new position</h2>
      <p>${C.symbol} collateral, ${D.symbol} debt, Aave V3 on Ethereum · up to $${capUsd(cfg?.limits ?? null) || 150} · payout ${evm ? `<span class="st-mono">${short(evm)}</span>` : "your Ethereum wallet"}</p>
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
    const bar = `<div class="st-dash-bar${exposedHf ? " is-exposed" : ""}" role="img" aria-label="Health factor ${hfLabel}; stewards rescue under 1.15; Aave liquidates under 1.00">
        <span class="st-dash-bar-fill" style="width:${a && (a.collBase > 0n || hf !== null) ? hfBarPct(hf) : 0}%"></span>
        <span class="st-dash-bar-mark" style="left:${hfBarPct(LIQUIDATION_BPS)}%"><i>1.00</i></span>
        <span class="st-dash-bar-mark is-trigger" style="left:${hfBarPct(TRIGGER_BPS)}%"><i>1.15</i></span>
      </div>`;
    const collNum = !a
      ? `<span class="st-num">…</span>`
      : waiting
        ? `<span class="st-num">${fmt(s!.posBal.coll, C.decimals, 6)}</span><span class="st-dash-unit">${C.symbol}</span>`
        : `<span class="st-num">${usd8(a.collBase, 2)}</span>`;
    const collSub = !a ? "" : waiting ? `waiting to be supplied · ${usdOf(s!.posBal.coll, s!.prices.coll, C.decimals)}` : a.collBase > 0n ? `${fmt(collUnits, C.decimals, 6)} ${C.symbol} supplied` : "nothing supplied";
    return `<section class="st-own-live st-dash-status" data-own-live aria-label="Your position" role="status">
      <div class="st-np-head"><span class="${lamp}" aria-hidden="true"></span><span class="st-np-label">POSITION ${pos.id}</span>${chip}<span class="st-np-now">${now}</span></div>
      <dl class="st-dash-kpis">
        <div class="st-dash-kpi-hf"><dt>HEALTH FACTOR</dt><dd class="st-dash-big">${hf === null ? `<span class="st-dash-nodebt">no debt</span>` : `<span class="st-num${exposedHf ? " is-exposed" : ""}">${hfLabel}</span>`}</dd><dd class="st-dash-cons">${hf === null ? "nothing to liquidate" : fallLine(hf, C.symbol)}</dd><dd>${bar}</dd></div>
        <div><dt>COLLATERAL</dt><dd class="st-dash-big">${collNum}</dd><dd class="st-dash-cons">${collSub}</dd></div>
        <div><dt>DEBT</dt><dd class="st-dash-big"><span class="st-num">${a ? usd8(a.debtBase, 2) : "…"}</span></dd><dd class="st-dash-cons">${a ? (a.debtBase > 0n ? `${fmt(debtUnits, D.decimals, 2)} ${D.symbol} borrowed` : "nothing borrowed") : ""}</dd></div>
      </dl>
      <p class="st-dash-src">${C.symbol} ${s!.prices.coll ? usd8(s!.prices.coll, 2) : "…"} · Aave V3 and ${esc(net.contract)}, read every ${POLL_MS / 1000} s</p>
    </section>`;
  }

  function rescueHtml(): string {
    const r = s?.rescue;
    if (!r) return "";
    const won = new Set(r.members.map((m) => m.steward));
    const bids = ladder(r)
      .map((b) => `<tr><td>${esc(b.steward.split(".")[0])}</td><td class="st-num-cell">${b.premium_bps} bps</td><td class="st-num-cell">${fmtUnits(b.amount_units, C.decimals, 6)} ${C.symbol}</td><td>${r.state !== "auction" && won.has(b.steward) ? "won" : r.state === "auction" ? "bidding" : ""}</td></tr>`)
      .join("");
    const claims = s!.claims
      .map((c) => `<tr><td class="st-mono">${esc(c.token_id)}</td><td>${esc(c.owner.split(".")[0])}</td><td class="st-num-cell">${fmtUnits(c.owed_units, C.decimals, 8)} ${C.symbol}</td><td>${esc(c.status.replace(/_/g, " "))}</td></tr>`)
      .join("");
    const owed = owedUnits();
    return `<div class="st-own-ladder st-dash-rescue">
      <div class="st-label">RESCUE #${r.id} · ${esc(r.state.replace(/_/g, " ").toUpperCase())} · LOWEST PREMIUM WINS · CAP ${r.cap_bps} BPS · TOP-UP ${fmtUnits(r.topup_units, C.decimals, 6)} ${C.symbol}</div>
      ${bids ? `<table><thead><tr><th>Steward</th><th>Premium</th><th>Amount</th><th></th></tr></thead><tbody>${bids}</tbody></table>` : `<p class="st-own-hint">No bid yet: the stewards are pricing the top-up.</p>`}
      ${claims ? `<div class="st-label">CLAIMS · OWED IN ${C.symbol}${owed > 0n ? ` · ${fmt(owed, C.decimals, 8)} ${C.symbol} OPEN` : ""}</div><table><thead><tr><th>Claim</th><th>Owner</th><th>Owed</th><th>Status</th></tr></thead><tbody>${claims}</tbody></table>` : ""}
    </div>`;
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
      : `When it can't cover the next one, your Ethereum wallet is asked for a small top-up (${fmt(2n * upfront, 18, 6)} ETH at most) first.`;
    return `<section class="st-dash-poswallet" aria-label="The position's address">
      <div class="st-label">POSITION ADDRESS · ETHEREUM</div>
      <p class="st-dash-addr"><span class="st-mono">${esc(addr)}</span><button type="button" class="st-dash-copy" data-copy="${addr}" aria-label="Copy the position's address">${copied ? icon("check", 16) : copyGlyph()}</button><span class="st-dash-copied" role="status">${copied ? "Copied" : ""}</span></p>
      <p class="st-dash-links">${ext(net.evmAddress(addr), "Etherscan")}${ext(`https://debank.com/profile/${addr}`, "DeBank")}<span>${ext("https://app.aave.com/?marketName=proto_mainnet_v3", "Aave")}: Watch wallet, then paste the address</span></p>
      <dl class="st-dash-bal">
        <div><dt>${C.symbol} HERE</dt><dd>${fmt(b.coll, C.decimals, 8)}</dd></div>
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
      ? `<p class="st-dash-proj" aria-label="Health factor now ${nowHf}, after ${hfText(p.hfBps)}">${usd}<span class="st-dash-projlbl">HF</span><span class="st-dash-projnow">${nowHf}</span>${toGlyph()}<strong class="st-dash-projnum${p.hfBps !== null && p.hfBps < TRIGGER_BPS ? " is-exposed" : ""}">${hfText(p.hfBps)}</strong></p>`
      : `<p class="st-dash-proj is-empty"><span class="st-dash-projlbl">HF</span><span class="st-dash-projnow">${nowHf}</span></p>`;
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
    const wethCard = `<div class="st-dash-act${wv.on ? "" : " is-off"}" data-act="${wm}">
      <div class="st-dash-act-head"><h3>${C.symbol}</h3>${seg(`${C.symbol} action`, "data-mode", [{ v: "weth:deposit", t: "SUPPLY" }, { v: "weth:withdraw", t: "WITHDRAW" }], `weth:${wm}`)}</div>
      <p class="st-dash-have">wallet ${w ? fmt(w.coll, C.decimals, 5) : "…"} · supplied ${fmt(collUnits, C.decimals, 5)}${idleColl > 0n ? ` · ${fmt(idleColl, C.decimals, 6)} waiting` : ""}</p>
      ${wm === "deposit"
        ? input("deposit", C.symbol, "MAX", !av.deposit.on) + liveHtml("deposit", av.deposit, opLabel("deposit", "Supply", C.symbol, C.decimals, 6))
          + disc("how-deposit", "How it works", () => `<p>Your Ethereum wallet sends the ${C.symbol} to the position (one signature; ${C.symbol} already waiting there counts), then the contract supplies it on Aave (one NEAR call, two the first time for Aave's approval). MAX: what you hold, within the $${capUsd(cfg?.limits ?? null) || 150} cap (${usd8(dMax && P.coll ? (dMax * P.coll) / 10n ** 18n : 0n)}).</p>`)
        : input("withdraw", C.symbol, "MAX", !av.withdraw.on) + liveHtml("withdraw", av.withdraw, opLabel("withdraw", "Withdraw", C.symbol, C.decimals, 6)) + tryBtn("withdraw", av.withdraw)
          + disc("how-withdraw", "How it works", () => `<p>One NEAR call: the contract signs Aave's withdraw, which sends the ${C.symbol} straight to your payout <span class="st-mono">${short(pos.payout)}</span>. MAX: down to health 1.16, or all of it with no debt.</p>`)}
    </div>`;

    // USDC: borrow | repay
    const um = usdcMode;
    const fromPos = s!.posBal.debt > 0n;
    const repayV: Avail = repayFrom === "wallet" && f.locked && av.repay.on ? { on: false, why: `While a rescue runs, tokens sent to the position are held for the buy-back: repay from the position's ${D.symbol}, or after the rescue.`, tryAnyway: false } : av.repay;
    const uv = um === "borrow" ? av.borrow : repayV;
    const usdcCard = `<div class="st-dash-act${uv.on ? "" : " is-off"}" data-act="${um}">
      <div class="st-dash-act-head"><h3>${D.symbol}</h3>${seg(`${D.symbol} action`, "data-mode", [{ v: "usdc:borrow", t: "BORROW" }, { v: "usdc:repay", t: "REPAY" }], `usdc:${um}`)}</div>
      <p class="st-dash-have">wallet ${w ? fmt(w.debt, D.decimals, 2) : "…"} · debt ${fmt(debtUnits, D.decimals, 2)}${fromPos ? ` · ${fmt(s!.posBal.debt, D.decimals, 2)} at the position` : ""}</p>
      ${um === "borrow"
        ? input("borrow", D.symbol, "MAX 1.16", !av.borrow.on) + liveHtml("borrow", av.borrow, opLabel("borrow", "Borrow", D.symbol, D.decimals, 2)) + tryBtn("borrow", av.borrow)
          + disc("how-borrow", "How it works", () => `<p>Two NEAR calls: the contract signs the Aave borrow (the ${D.symbol} lands at the position), then a transfer of it to your wallet; Aave only lends to the position itself. MAX stops at health 1.16, just above the trigger.</p>`)
        : `<div class="st-dash-from"><span class="st-label">FROM</span>${seg("Repay from", "data-repay-from", [{ v: "wallet", t: "MY WALLET", off: !av.repay.on }, { v: "position", t: "THE POSITION", off: !av.repay.on || !fromPos }], repayFrom)}</div>`
          + input("repay", D.symbol, "ALL", !av.repay.on) + liveHtml("repay", av.repay, opLabel("repay", "Repay", D.symbol, D.decimals, 2), repayFrom === "wallet" && !evm, repayV)
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
        ${av.buyback.on ? "" : `<p class="st-dash-why">${esc(av.buyback.why)}</p>`}
        ${disc("how-buyback", "How it works", () => `<p>Pay exactly what is owed into the position (one Ethereum signature). The contract checks the proven balance and pays the claim owner exactly that; any excess is refunded to your wallet.</p>`)}
      </div>`;
    }

    // small, secondary: leftover gas ETH, USDC left at the position
    const sw = f.sweepUnits;
    const minor = [`<div class="st-dash-minor-item" data-act="sweep"><span class="st-dash-minor-lbl">Leftover gas ETH</span>${btn(`Return ${fmt(sw, 18, 6)} ETH`, "data-go=sweep", false, !av.sweep.on)}${av.sweep.on ? "" : `<span class="st-dash-minor-why">${esc(av.sweep.why)}</span>`}</div>`];
    if (s!.posBal.debt > 0n)
      minor.push(`<div class="st-dash-minor-item" data-act="move"><span class="st-dash-minor-lbl">${D.symbol} at the position</span>${btn(`Move ${fmt(s!.posBal.debt, D.decimals, 2)} ${D.symbol} to my wallet`, "data-go=move", false, !av.move.on)}${av.move.on ? "" : `<span class="st-dash-minor-why">${esc(av.move.why)}</span>`}</div>`);

    return `${buyCard}<div class="st-dash-actions">${wethCard}${usdcCard}</div><div class="st-dash-minor">${minor.join("")}</div>`;
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

  // keep what the visitor is typing (and which control has focus) across re-renders
  const FOCUS_KEYS = ["amt", "disc", "mode", "repayFrom", "copy", "max", "moreTxs"] as const;
  function render() {
    if (gone) return;
    const focused = document.activeElement as HTMLElement | null;
    const inRoot = !!focused && root.contains(focused);
    const fk = inRoot ? FOCUS_KEYS.find((k) => focused!.dataset[k] !== undefined) : undefined;
    const focusSel = fk ? `[data-${fk.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}${focused!.dataset[fk] ? `="${focused!.dataset[fk]}"` : ""}]` : null;
    const inp = fk === "amt" ? (focused as HTMLInputElement) : null;
    const sel = inp ? [inp.selectionStart, inp.selectionEnd] : null;
    const netSwitch = `<nav class="st-own-net" aria-label="Network"><div class="st-own-netseg"><a href="${location.pathname}#/try">TESTNET</a><a href="${location.pathname}?net=mainnet#/try" aria-current="page">MAINNET · REAL FUNDS</a></div></nav>`;
    const pos = s?.pos ?? null;
    const body = !s
      ? `<p class="st-empty">${near ? "Reading the contract and Ethereum…" : ""}</p>`
      : pos?.evm_address
        ? `${statusHtml()}${activityHtml()}${rescueHtml()}${actionsHtml()}${positionWalletHtml()}`
        : pos
          ? `<p class="st-own-hint">Position ${pos.id} is registered; its Ethereum address is being derived.</p>`
          : newPositionHtml();
    root.innerHTML = `<section class="st-panel st-sect st-own is-mainnet st-dash">
      <header class="st-list-head"><div class="st-label">YOUR AAVE POSITION · NEAR MAINNET AND ETHEREUM</div><h1 class="st-page-title">Protected Aave position</h1>
        <p class="st-list-sub">Only the Stead contract can sign for it; your NEAR account owns it. Under health 1.15, stewards top it up.</p></header>
      ${netSwitch}
      ${bannerHtml()}
      ${walletsHtml()}
      ${notice ? `<p class="st-own-notice" role="status">${esc(notice)}</p>` : ""}
      ${error ? `<p class="st-own-error" role="alert">${esc(error)}</p>` : ""}
      ${busy && !pos?.evm_address ? `<p class="st-own-notice" role="status">${esc(busy)} <span class="st-own-elapsed" data-elapsed="${busySince}">${mmss(Date.now() - busySince)}</span></p>` : ""}
      ${body}
    </section>`;
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
  function updateAction(id: Act) {
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
    root.querySelectorAll<HTMLInputElement>("[data-amt]").forEach((i) =>
      i.addEventListener("input", () => {
        const id = i.dataset.amt as Act;
        amt[id] = i.value;
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
  const tick = window.setInterval(() => {
    for (const el of root.querySelectorAll<HTMLElement>("[data-countdown]")) el.textContent = mmss(Number(el.dataset.countdown) - Date.now());
    for (const el of root.querySelectorAll<HTMLElement>("[data-elapsed]")) el.textContent = mmss(Date.now() - Number(el.dataset.elapsed));
  }, 1000);
  return () => {
    gone = true;
    clearInterval(timer);
    clearInterval(tick);
    stopNear();
    setNearNetwork("testnet");
  };
}

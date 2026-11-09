// READ-ONLY feed for the front end's mainnet panel: real Aave V3 positions on Ethereum mainnet
// near Stead's trigger, positions that crossed it, and real Aave liquidations beside what a Stead
// rescue would have charged. Public reads only (logs and view calls): no account, no key, no
// transaction. RPC URLs (which may carry a key) never appear in the output or the logs.
//
// Each cycle: new Borrow and LiquidationCall logs since the last cycle (the borrower list only
// grows, so coverage improves the longer it runs), one account-data read for every known
// borrower, the near-trigger subset priced with the contract's formulas and the stewards' real
// strategies (`mainnet.ts`), and the result as one JSON file.
import { createPublicClient, fallback, http, parseAbi, parseAbiItem, hexToString, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { AAVE_POOL, STEAD, scan, reserveInfo, steadView, type MainnetPosition, type ReserveInfo } from "./mainnet.js";

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const BORROW = parseAbiItem("event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)");
export const LIQUIDATION = parseAbiItem("event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)");
const poolAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getUserEMode(address) view returns (uint256)",
  "function ADDRESSES_PROVIDER() view returns (address)",
]);
const providerAbi = parseAbi(["function getPriceOracle() view returns (address)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const symbolAbi = parseAbi(["function symbol() view returns (string)"]);
const symbolBytesAbi = parseAbi(["function symbol() view returns (bytes32)"]);

/** Positions shown and counted as "near the trigger". */
export const NEAR = { maxHf: 1.3, minDebtUsd: 1_000 };
/** How much history the feed keeps. */
export const KEEP = { days: 30, triggers: 500, liquidations: 500 };
/** Log ranges per request (public RPCs cap them). */
const CHUNK = 2_000n;
/** At most this many liquidations get the archive reads (position and prices just before) per cycle, this many at a time. */
const DETAIL_PER_CYCLE = 300;
const DETAIL_PARALLEL = 8;
/** Liquidations repaying less than this are bots sweeping dust: counted, not listed. */
export const DUST_USD = 1;

// ───────────────────────────── types ─────────────────────────────

export interface TriggerEvent {
  address: Address;
  at: string;
  block: number;
  hfBefore: number;
  hf: number;
  debtUsd: number;
  collateralUsd: number;
  /** What Stead would have done at 1.15: the top-up, the cap and the winning bid. */
  stead: { topupUsd: number; capUsd: number; winner?: { steward: string; bps: number; premiumUsd: number } };
}

export interface Liquidation {
  tx: string;
  block: number;
  logIndex: number;
  at: string;
  user: Address;
  liquidator: Address;
  collateral: { asset: Address; symbol: string; units: string; usd: number };
  debt: { asset: Address; symbol: string; units: string; usd: number };
  /** Collateral seized minus debt repaid, at the oracle price. A lower bound: Aave's protocol fee comes on top. */
  bonusPaidUsd: number;
  priceAt: "block" | "latest";
  /** A Stead rescue of the same position at its trigger (from the position just before the liquidation). */
  stead: { debtUsd: number; topupUsd: number; capUsd: number; steward: string; bps: number; premiumUsd: number; savedUsd: number } | null;
  steadNote?: string;
}

export interface PanelState {
  version: 1;
  /** Logs are covered from `fromBlock` to `toBlock` (inclusive). */
  fromBlock: number;
  toBlock: number;
  borrowers: Address[];
  /** Last health factor of every known borrower with debt (non-eMode), for crossing detection. */
  lastHf: Record<string, number>;
  triggers: TriggerEvent[];
  liquidations: Liquidation[];
  /** Liquidations still waiting for their detail reads. */
  pending: Liquidation[];
  coverageNote?: string;
}

export interface PanelPosition {
  address: Address;
  hf: number;
  debtUsd: number;
  collateralUsd: number;
  ltBps: number;
  bonusBps: number;
  collateral: { symbol: string; usd: number }[];
  /** How far all collateral prices may fall together (debt prices fixed) before the trigger / Aave's liquidation line. */
  dropToTrigger: number;
  dropToLiquidation: number;
  atTrigger: MainnetPosition["atTrigger"];
}

export interface PanelFeed {
  generated: string;
  chain: "ethereum";
  readOnly: true;
  source: string;
  block: number;
  blockTime: string;
  params: typeof STEAD;
  coverage: { borrowers: number; fromBlock: number; toBlock: number; note?: string };
  summary: {
    nearTrigger: number;
    belowTrigger: number;
    debtNearTriggerUsd: number;
    triggers24h: number;
    liquidations24h: number;
    /** Dust sweeps (under $1 repaid), not in `liquidations24h`. */
    dust24h: number;
    /** Liquidations found but not yet priced (their reads come next cycle). */
    unpriced: number;
    bonusPaid24hUsd: number;
    /** Over the 24 h liquidations that have a Stead estimate. */
    compared24h: number;
    steadPremium24hUsd: number;
    saved24hUsd: number;
  };
  positions: PanelPosition[];
  triggers: TriggerEvent[];
  liquidations: Liquidation[];
}

// ───────────────────────────── pure parts (tested offline) ─────────────────────────────

/** An error as one line with every URL removed (a keyed RPC URL must never reach a log). */
export function scrub(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/(?:https?|wss?):\/\/[^\s"'<>)\]]+/gi, "<rpc>").split("\n")[0].slice(0, 200);
}

export function emptyState(): PanelState {
  return { version: 1, fromBlock: 0, toBlock: 0, borrowers: [], lastHf: {}, triggers: [], liquidations: [], pending: [] };
}

/** Positions that went from at/above the trigger to below it since the last reading. The first reading of an address never counts. */
export function crossings(prev: Record<string, number>, now: Record<string, { hf: number; debtUsd: number; collateralUsd: number; ltBps: number }>, at: string, block: number): TriggerEvent[] {
  const out: TriggerEvent[] = [];
  for (const [address, p] of Object.entries(now)) {
    const before = prev[address];
    if (before === undefined || before < STEAD.trigger || p.hf >= STEAD.trigger) continue;
    if (p.debtUsd < NEAR.minDebtUsd) continue;
    const v = steadView(Number.POSITIVE_INFINITY, p.collateralUsd, p.debtUsd, p.ltBps); // valued at the trigger
    out.push({
      address: address as Address,
      at,
      block,
      hfBefore: before,
      hf: p.hf,
      debtUsd: p.debtUsd,
      collateralUsd: p.collateralUsd,
      stead: { topupUsd: v.topupUsd, capUsd: v.liquidationCostUsd, winner: v.winner && { steward: v.winner.steward, bps: v.winner.bps, premiumUsd: v.winner.premiumUsd } },
    });
  }
  return out;
}

/** USD value of `units` of a token with `decimals`, at an 8-dp oracle price. */
export function usdOf(units: bigint, decimals: number, price8: bigint): number {
  return (Number(units) / 10 ** decimals) * (Number(price8) / 1e8);
}

/**
 * What the liquidation took from the borrower beyond the debt it repaid, and what a Stead rescue
 * at the trigger would have charged for the same position (debt and LT just before the
 * liquidation; the collateral reserve's bonus as Aave's baseline).
 */
export function compareLiquidation(
  ev: { debtToCover: bigint; liquidatedCollateralAmount: bigint },
  coll: { decimals: number; price: bigint; bonusBps: number },
  debt: { decimals: number; price: bigint },
  before?: { debtUsd: number; ltBps: number; emode?: boolean },
): { collateralUsd: number; debtUsd: number; bonusPaidUsd: number; stead: Liquidation["stead"] } {
  const collateralUsd = usdOf(ev.liquidatedCollateralAmount, coll.decimals, coll.price);
  const debtUsd = usdOf(ev.debtToCover, debt.decimals, debt.price);
  const bonusPaidUsd = Math.max(0, collateralUsd - debtUsd);
  let stead: Liquidation["stead"] = null;
  if (before && !before.emode && before.debtUsd >= NEAR.minDebtUsd && before.ltBps > 0) {
    const v = steadView(Number.POSITIVE_INFINITY, 0, before.debtUsd, before.ltBps, coll.bonusBps);
    if (v.winner) {
      stead = { debtUsd: before.debtUsd, topupUsd: v.topupUsd, capUsd: v.liquidationCostUsd, steward: v.winner.steward, bps: v.winner.bps, premiumUsd: v.winner.premiumUsd, savedUsd: bonusPaidUsd - v.winner.premiumUsd };
    }
  }
  return { collateralUsd, debtUsd, bonusPaidUsd, stead };
}

/** Keep the newest entries within the time and count limits. */
export function trim<T extends { at: string }>(xs: T[], nowMs: number, max: number): T[] {
  const since = nowMs - KEEP.days * 86_400_000;
  return xs.filter((x) => Date.parse(x.at) >= since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, max);
}

export function summarize(positions: PanelPosition[], triggers: TriggerEvent[], liquidations: Liquidation[], nowMs: number, unpriced = 0): PanelFeed["summary"] {
  const day = (x: { at: string }) => Date.parse(x.at) >= nowMs - 86_400_000;
  const all = liquidations.filter(day);
  const liq = all.filter((l) => l.debt.usd >= DUST_USD);
  const compared = liq.filter((l) => l.stead);
  return {
    nearTrigger: positions.length,
    belowTrigger: positions.filter((p) => p.hf < STEAD.trigger).length,
    debtNearTriggerUsd: positions.reduce((s, p) => s + p.debtUsd, 0),
    triggers24h: triggers.filter(day).length,
    liquidations24h: liq.length,
    dust24h: all.length - liq.length,
    unpriced,
    bonusPaid24hUsd: liq.reduce((s, l) => s + l.bonusPaidUsd, 0),
    compared24h: compared.length,
    steadPremium24hUsd: compared.reduce((s, l) => s + l.stead!.premiumUsd, 0),
    saved24hUsd: compared.reduce((s, l) => s + l.stead!.savedUsd, 0),
  };
}

export function toPanelPosition(p: MainnetPosition, symbols: Map<string, string>): PanelPosition {
  return {
    address: p.address,
    hf: p.hf,
    debtUsd: p.debtUsd,
    collateralUsd: p.collateralUsd,
    ltBps: p.ltBps,
    bonusBps: p.bonusBps,
    collateral: p.collateral.map((c) => ({ symbol: symbols.get(c.asset.toLowerCase()) ?? short(c.asset), usd: c.usd })),
    dropToTrigger: p.hf > STEAD.trigger ? 1 - STEAD.trigger / p.hf : 0,
    dropToLiquidation: p.hf > 1 ? 1 - 1 / p.hf : 0,
    atTrigger: p.atTrigger,
  };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ───────────────────────────── chain reads ─────────────────────────────

/** A client that tries each URL in order. */
export function panelClient(urls: string[]): PublicClient {
  return createPublicClient({ chain: mainnet, batch: { multicall: false }, transport: fallback(urls.map((u) => http(u, { retryCount: 1, timeout: 20_000 }))) }) as PublicClient;
}

async function symbols(rpc: PublicClient, assets: Address[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const res = await rpc.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: assets.map((a) => ({ address: a, abi: symbolAbi, functionName: "symbol" }) as const) });
  const retry: Address[] = [];
  assets.forEach((a, i) => (res[i].status === "success" ? out.set(a.toLowerCase(), res[i].result as string) : retry.push(a)));
  if (retry.length) {
    // a few old tokens (MKR) return bytes32
    const r2 = await rpc.multicall({ multicallAddress: MULTICALL3, allowFailure: true, contracts: retry.map((a) => ({ address: a, abi: symbolBytesAbi, functionName: "symbol" }) as const) });
    retry.forEach((a, i) => out.set(a.toLowerCase(), r2[i].status === "success" ? hexToString(r2[i].result as `0x${string}`, { size: 32 }).replace(/\0/g, "") : short(a)));
  }
  return out;
}

/** Health of every borrower in one pass (200 per multicall). Non-eMode with debt only. */
async function healthOfAll(rpc: PublicClient, users: Address[]): Promise<Record<string, { hf: number; debtUsd: number; collateralUsd: number; ltBps: number }>> {
  const out: Record<string, { hf: number; debtUsd: number; collateralUsd: number; ltBps: number }> = {};
  for (let i = 0; i < users.length; i += 200) {
    const batch = users.slice(i, i + 200);
    const res = await rpc.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: batch.flatMap((u) => [
        { address: AAVE_POOL, abi: poolAbi, functionName: "getUserAccountData", args: [u] } as const,
        { address: AAVE_POOL, abi: poolAbi, functionName: "getUserEMode", args: [u] } as const,
      ]),
    });
    batch.forEach((u, j) => {
      const r = res[2 * j];
      const em = res[2 * j + 1];
      if (r.status !== "success" || em.status !== "success" || (em.result as bigint) !== 0n) return;
      const [cb, db, , lt, , hf] = r.result as readonly bigint[];
      if (db === 0n) return;
      out[u.toLowerCase()] = { hf: Number(hf) / 1e18, debtUsd: Number(db) / 1e8, collateralUsd: Number(cb) / 1e8, ltBps: Number(lt) };
    });
  }
  return out;
}

/** New Borrow and LiquidationCall logs. Backfill chunks older than the RPC serves are skipped and the coverage start moves up. */
async function readLogs(rpc: PublicClient, state: PanelState, head: number, backfill: number): Promise<{ borrowers: Address[]; liqs: { tx: string; block: number; logIndex: number; args: any }[] }> {
  const fresh = state.toBlock === 0;
  const start = fresh ? Math.max(0, head - backfill) : state.toBlock + 1;
  if (fresh) state.fromBlock = start;
  const borrowers: Address[] = [];
  const liqs: { tx: string; block: number; logIndex: number; args: any }[] = [];
  for (let from = BigInt(start); from <= BigInt(head); from += CHUNK) {
    const to = from + CHUNK - 1n > BigInt(head) ? BigInt(head) : from + CHUNK - 1n;
    try {
      const [b, l] = await Promise.all([
        rpc.getLogs({ address: AAVE_POOL, event: BORROW, fromBlock: from, toBlock: to }),
        rpc.getLogs({ address: AAVE_POOL, event: LIQUIDATION, fromBlock: from, toBlock: to }),
      ]);
      for (const x of b) borrowers.push(x.args.onBehalfOf as Address);
      for (const x of l) liqs.push({ tx: x.transactionHash!, block: Number(x.blockNumber), logIndex: Number(x.logIndex), args: x.args });
    } catch (e) {
      // a backfill chunk the RPC no longer serves: start coverage after it
      if (fresh && Number(to) < head - 9_000) {
        state.fromBlock = Number(to) + 1;
        state.coverageNote = `history before block ${state.fromBlock} not served by the RPCs (${scrub(e)})`;
        continue;
      }
      throw e;
    }
  }
  return { borrowers, liqs };
}

async function blockTimes(rpc: PublicClient, blocks: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const b of [...new Set(blocks)]) {
    const blk = await rpc.getBlock({ blockNumber: BigInt(b) });
    out.set(b, new Date(Number(blk.timestamp) * 1000).toISOString());
  }
  return out;
}

/** The archive reads for a liquidation: the position and both prices one block before. Falls back to latest prices (marked). */
async function detail(rpc: PublicClient, l: Liquidation, oracle: Address, byAsset: Map<string, ReserveInfo>): Promise<void> {
  const c = byAsset.get(l.collateral.asset.toLowerCase());
  const d = byAsset.get(l.debt.asset.toLowerCase());
  if (!c || !d) {
    l.steadNote = "reserve not listed";
    return;
  }
  const blockNumber = BigInt(l.block - 1);
  let before: { debtUsd: number; ltBps: number; emode: boolean } | undefined;
  let cp = c.price;
  let dp = d.price;
  l.priceAt = "latest";
  try {
    const [acc, em, p1, p2] = await Promise.all([
      rpc.readContract({ address: AAVE_POOL, abi: poolAbi, functionName: "getUserAccountData", args: [l.user], blockNumber }),
      rpc.readContract({ address: AAVE_POOL, abi: poolAbi, functionName: "getUserEMode", args: [l.user], blockNumber }),
      rpc.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [c.asset], blockNumber }),
      rpc.readContract({ address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [d.asset], blockNumber }),
    ]);
    before = { debtUsd: Number(acc[1]) / 1e8, ltBps: Number(acc[3]), emode: em !== 0n };
    cp = p1;
    dp = p2;
    l.priceAt = "block";
  } catch (e) {
    l.steadNote = `no archive read at block ${l.block - 1}: Stead comparison skipped, latest prices used (${scrub(e)})`;
  }
  const r = compareLiquidation(
    { debtToCover: BigInt(l.debt.units), liquidatedCollateralAmount: BigInt(l.collateral.units) },
    { decimals: c.decimals, price: cp, bonusBps: c.bonusBps },
    { decimals: d.decimals, price: dp },
    before,
  );
  l.collateral.usd = r.collateralUsd;
  l.debt.usd = r.debtUsd;
  l.bonusPaidUsd = r.bonusPaidUsd;
  l.stead = r.stead;
  if (before && !r.stead)
    l.steadNote = before.emode
      ? "eMode position (correlated assets): Stead doesn't take these yet"
      : before.debtUsd < NEAR.minDebtUsd
        ? "under $1,000 of debt: too small for a Stead rescue"
        : "no steward would bid on this position";
}

// ───────────────────────────── one cycle ─────────────────────────────

export async function cycle(rpc: PublicClient, state: PanelState, opts: { backfill?: number; nowMs?: number } = {}): Promise<PanelFeed> {
  const nowMs = opts.nowMs ?? Date.now();
  const headBlock = await rpc.getBlock({ blockTag: "latest" });
  const head = Number(headBlock.number) - 2; // a couple of blocks back: every RPC in the list has them
  const at = new Date(Number(headBlock.timestamp) * 1000).toISOString();

  const logs = await readLogs(rpc, state, head, opts.backfill ?? 50_400);
  const known = new Set(state.borrowers.map((a) => a.toLowerCase()));
  for (const b of logs.borrowers) if (!known.has(b.toLowerCase())) (known.add(b.toLowerCase()), state.borrowers.push(b));

  const reserves = await reserveInfo(rpc);
  const byAsset = new Map(reserves.map((r) => [r.asset.toLowerCase(), r]));
  const syms = await symbols(rpc, reserves.map((r) => r.asset));
  const provider = await rpc.readContract({ address: AAVE_POOL, abi: poolAbi, functionName: "ADDRESSES_PROVIDER" });
  const oracle = await rpc.readContract({ address: provider, abi: providerAbi, functionName: "getPriceOracle" });

  // liquidations: recorded now, detailed (archive reads) a bounded number per cycle
  if (logs.liqs.length) {
    const times = await blockTimes(rpc, logs.liqs.map((l) => l.block));
    for (const x of logs.liqs) {
      const a = x.args;
      state.pending.push({
        tx: x.tx,
        block: x.block,
        logIndex: x.logIndex,
        at: times.get(x.block)!,
        user: a.user,
        liquidator: a.liquidator,
        collateral: { asset: a.collateralAsset, symbol: syms.get(String(a.collateralAsset).toLowerCase()) ?? short(a.collateralAsset), units: String(a.liquidatedCollateralAmount), usd: 0 },
        debt: { asset: a.debtAsset, symbol: syms.get(String(a.debtAsset).toLowerCase()) ?? short(a.debtAsset), units: String(a.debtToCover), usd: 0 },
        bonusPaidUsd: 0,
        priceAt: "latest",
        stead: null,
      });
    }
  }
  state.pending.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex); // newest first
  const todo = state.pending.splice(0, DETAIL_PER_CYCLE);
  for (let i = 0; i < todo.length; i += DETAIL_PARALLEL) {
    await Promise.all(todo.slice(i, i + DETAIL_PARALLEL).map((l) => detail(rpc, l, oracle, byAsset)));
  }
  state.liquidations.push(...todo);

  // every borrower's health; crossings since the last cycle
  const health = await healthOfAll(rpc, state.borrowers);
  state.triggers.push(...crossings(state.lastHf, health, at, head));
  state.lastHf = Object.fromEntries(Object.entries(health).map(([a, p]) => [a, p.hf]));

  // the near-trigger subset, with collateral mix and the stewards' bids
  const near = state.borrowers.filter((u) => {
    const h = health[u.toLowerCase()];
    return h && h.hf >= 1 && h.hf < NEAR.maxHf && h.debtUsd >= NEAR.minDebtUsd;
  });
  const rows = near.length ? await scan({ users: near, rpc, reserves, maxHf: NEAR.maxHf, minDebtUsd: NEAR.minDebtUsd }) : [];

  state.toBlock = head;
  state.triggers = trim(state.triggers, nowMs, KEEP.triggers);
  state.liquidations = trim(state.liquidations, nowMs, KEEP.liquidations);
  state.pending = trim(state.pending, nowMs, KEEP.liquidations);

  const positions = rows.map((p) => toPanelPosition(p, syms));
  return {
    generated: new Date(nowMs).toISOString(),
    chain: "ethereum",
    readOnly: true,
    source: "Aave V3 Ethereum mainnet, public reads only; Stead's figures use the contract's formulas and the stewards' real strategies",
    block: head,
    blockTime: at,
    params: STEAD,
    coverage: { borrowers: state.borrowers.length, fromBlock: state.fromBlock, toBlock: state.toBlock, ...(state.coverageNote ? { note: state.coverageNote } : {}) },
    summary: summarize(positions, state.triggers, state.liquidations, nowMs, state.pending.length),
    positions: positions.slice(0, 50),
    triggers: state.triggers.slice(0, 50),
    liquidations: state.liquidations.filter((l) => l.debt.usd >= DUST_USD).slice(0, 50),
  };
}

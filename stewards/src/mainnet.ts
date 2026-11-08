// READ-ONLY view of real Aave V3 positions on Ethereum mainnet, and what Stead would do for each.
// Public reads only (logs and view calls through a public RPC): no account, no key, no transaction.
//
// It finds recent borrowers from the Pool's Borrow events, reads each one's account data in one
// multicall, keeps those near Stead's trigger, and applies the contract's own formulas: the top-up
// to the target HF and the premium cap (liquidation bonus × 50 % close × debt). The stewards' bids
// come from their real strategies on that hypothetical auction.
import { createPublicClient, http, parseAbi, parseAbiItem, type Address } from "viem";
import { mainnet } from "viem/chains";
import { strategies, type AuctionView } from "./strategy.js";

export const MAINNET_RPC = process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
export const AAVE_POOL: Address = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"; // Aave V3 Ethereum (bgd-labs address book)
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BORROW = parseAbiItem("event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)");
const poolAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getUserEMode(address) view returns (uint256)",
  "function getReservesList() view returns (address[])",
  "function getConfiguration(address) view returns ((uint256 data))",
  "function getUserConfiguration(address) view returns ((uint256 data))",
  "function getReserveData(address) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function ADDRESSES_PROVIDER() view returns (address)",
]);
const providerAbi = parseAbi(["function getPriceOracle() view returns (address)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Stead's parameters (as deployed): trigger 1.15, target 1.50, early settlement 1.10. */
export const STEAD = { trigger: 1.15, target: 1.5, early: 1.1 };
/** Used only if a position's collateral mix can't be read. */
const FALLBACK_BONUS_BPS = 500;

export interface MainnetPosition {
  address: Address;
  /** eMode positions (correlated-asset loops) run near HF 1 by design; Stead doesn't take them yet. */
  emode: boolean;
  hf: number;
  collateralUsd: number;
  debtUsd: number;
  ltBps: number;
  /** Liquidation bonus, weighted by the position's collateral reserves (bps above 100 %). */
  bonusBps: number;
  /** Collateral reserves by value, largest first (symbol-free: token addresses). */
  collateral: { asset: Address; usd: number; bonusBps: number }[];
  /** At Stead's trigger (prices scaled down uniformly until HF = 1.15, if it's above now). */
  atTrigger: {
    topupUsd: number;
    capBps: number;
    liquidationCostUsd: number; // Aave's baseline: bonus × 50 % close × debt
    bids: { steward: string; bps: number | null; why: string }[];
    winner?: { steward: string; bps: number; premiumUsd: number; savedUsd: number };
  };
}

export const client = createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) });

/** Borrowers seen in the last `blocks` blocks (chunks of 9,000: public RPCs cap log ranges). */
export async function recentBorrowers(blocks = 9_000): Promise<Address[]> {
  const head = await client.getBlockNumber();
  const seen = new Set<Address>();
  for (let to = head; to > head - BigInt(blocks); to -= 9_000n) {
    const from = to - 8_999n;
    try {
      const logs = await client.getLogs({ address: AAVE_POOL, event: BORROW, fromBlock: from, toBlock: to });
      for (const l of logs) seen.add(l.args.onBehalfOf as Address);
    } catch (e) {
      if (seen.size && /archive/i.test(String(e))) break; // a free public RPC serves only recent logs
      throw e;
    }
  }
  return [...seen];
}

/** What Stead would do for a position at its trigger, with the contract's formulas. */
export function steadView(hf: number, collateralUsd: number, debtUsd: number, ltBps: number, bonusBps = FALLBACK_BONUS_BPS): MainnetPosition["atTrigger"] {
  const lt = ltBps / 10_000;
  const c = hf > STEAD.trigger ? (STEAD.trigger * debtUsd) / lt : collateralUsd; // collateral value at the trigger
  const topupUsd = Math.max(0, (STEAD.target * debtUsd) / lt - c);
  const capUsd = (debtUsd * bonusBps) / 10_000 / 2;
  const capBps = topupUsd > 0 ? Math.floor((capUsd * 10_000) / topupUsd) : 0;
  const a: AuctionView = {
    capBps,
    topupUnits: BigInt(Math.round(topupUsd * 1e6)) * 10n ** 12n, // units are only for sizing here
    topupBase: BigInt(Math.round(topupUsd * 1e8)),
    openedAtNs: 0n,
    closesAtNs: 45n * 10n ** 9n,
    nowNs: 40n * 10n ** 9n, // late in the window: every strategy has decided
    netHf: (c * lt) / debtUsd,
    ltBps,
    debtBase: BigInt(Math.round(debtUsd * 1e8)),
    earlyHf: STEAD.early,
  };
  const bids = (["deep", "patient", "swift", "pool"] as const).map((s) => {
    const d = strategies[s](a);
    return { steward: s, bps: d.bid ? d.bps : null, why: d.why };
  });
  const best = bids.filter((b) => b.bps !== null).sort((x, y) => x.bps! - y.bps!)[0];
  const liquidationCostUsd = capUsd; // the cap is Aave's conservative liquidation cost
  return {
    topupUsd,
    capBps,
    liquidationCostUsd,
    bids,
    winner: best && { steward: best.steward, bps: best.bps!, premiumUsd: (topupUsd * best.bps!) / 10_000, savedUsd: liquidationCostUsd - (topupUsd * best.bps!) / 10_000 },
  };
}

/** Real positions with debt ≥ `minDebtUsd` and HF in [1, maxHf), most at risk first. */
export async function scan(opts: { blocks?: number; maxHf?: number; minDebtUsd?: number; includeEmode?: boolean } = {}): Promise<MainnetPosition[]> {
  const { blocks = 9_000, maxHf = 1.3, minDebtUsd = 1_000, includeEmode = false } = opts;
  const users = await recentBorrowers(blocks);
  const out: MainnetPosition[] = [];
  for (let i = 0; i < users.length; i += 200) {
    const batch = users.slice(i, i + 200);
    const res = await client.multicall({
      multicallAddress: MULTICALL3,
      contracts: batch.flatMap((u) => [
        { address: AAVE_POOL, abi: poolAbi, functionName: "getUserAccountData", args: [u] } as const,
        { address: AAVE_POOL, abi: poolAbi, functionName: "getUserEMode", args: [u] } as const,
      ]),
      allowFailure: true,
    });
    batch.forEach((_, j) => {
      const r = res[2 * j];
      const em = res[2 * j + 1];
      if (r.status !== "success" || em.status !== "success") return;
      const emode = (em.result as bigint) !== 0n;
      if (emode && !includeEmode) return;
      const [cb, db, , ltRaw, , hfWad] = r.result as readonly bigint[];
      const debtUsd = Number(db) / 1e8;
      const hf = Number(hfWad) / 1e18;
      if (debtUsd < minDebtUsd || hf < 1 || hf >= maxHf) return;
      const collateralUsd = Number(cb) / 1e8;
      const ltBps = Number(ltRaw);
      out.push({ address: batch[j], emode, hf, collateralUsd, debtUsd, ltBps, bonusBps: FALLBACK_BONUS_BPS, collateral: [], atTrigger: steadView(hf, collateralUsd, debtUsd, ltBps) });
    });
  }
  await addBonuses(out);
  return out.sort((a, b) => a.hf - b.hf);
}

interface ReserveInfo { asset: Address; bit: number; aToken: Address; decimals: number; bonusBps: number; price: bigint }

/** Every reserve's bonus, decimals, aToken and oracle price (all found from the Pool itself). */
async function reserveInfo(): Promise<ReserveInfo[]> {
  const assets = await client.readContract({ address: AAVE_POOL, abi: poolAbi, functionName: "getReservesList" });
  const provider = await client.readContract({ address: AAVE_POOL, abi: poolAbi, functionName: "ADDRESSES_PROVIDER" });
  const oracle = await client.readContract({ address: provider, abi: providerAbi, functionName: "getPriceOracle" });
  const res = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: assets.flatMap((a) => [
      { address: AAVE_POOL, abi: poolAbi, functionName: "getReserveData", args: [a] } as const,
      { address: oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [a] } as const,
    ]),
  });
  return assets.map((asset, k) => {
    const rd = res[2 * k] as { configuration: bigint; id: number; aTokenAddress: Address };
    const cfg = rd.configuration;
    return {
      asset,
      bit: rd.id,
      aToken: rd.aTokenAddress,
      decimals: Number((cfg >> 48n) & 0xffn),
      bonusBps: Math.max(0, Number((cfg >> 32n) & 0xffffn) - 10_000),
      price: res[2 * k + 1] as bigint,
    };
  });
}

/** Each position's liquidation bonus, weighted by the value of the reserves it uses as collateral. */
async function addBonuses(rows: MainnetPosition[]): Promise<void> {
  if (!rows.length) return;
  const reserves = await reserveInfo();
  const confs = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: true,
    contracts: rows.map((r) => ({ address: AAVE_POOL, abi: poolAbi, functionName: "getUserConfiguration", args: [r.address] }) as const),
  });
  for (let k = 0; k < rows.length; k++) {
    const c = confs[k];
    if (c.status !== "success") continue;
    const bits = (c.result as { data: bigint }).data;
    const used = reserves.filter((x) => ((bits >> BigInt(2 * x.bit + 1)) & 1n) === 1n);
    if (!used.length) continue;
    const bal = await client.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: used.map((x) => ({ address: x.aToken, abi: erc20, functionName: "balanceOf", args: [rows[k].address] }) as const),
    });
    const parts = used
      .map((x, j) => ({ asset: x.asset, bonusBps: x.bonusBps, usd: bal[j].status === "success" ? (Number(bal[j].result as bigint) / 10 ** x.decimals) * (Number(x.price) / 1e8) : 0 }))
      .filter((x) => x.usd > 0)
      .sort((a, b) => b.usd - a.usd);
    const total = parts.reduce((s, x) => s + x.usd, 0);
    if (total <= 0) continue;
    const r = rows[k];
    r.collateral = parts;
    r.bonusBps = Math.round(parts.reduce((s, x) => s + x.bonusBps * x.usd, 0) / total);
    r.atTrigger = steadView(r.hf, r.collateralUsd, r.debtUsd, r.ltBps, r.bonusBps);
  }
}

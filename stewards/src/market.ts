// The market this process serves: its collateral and debt assets, decimals and symbols, read from
// the contract (and the tokens) once. Nothing here assumes LINK/DAI or 18 decimals.
import { parseAbi, type Address } from "viem";
import { cfg } from "./config.js";
import { view } from "./near.js";
import { pub } from "./fork.js";

export interface MarketAssets {
  collateral: Address;
  debt: Address;
  cDec: number;
  dDec: number;
  cSym: string;
  dSym: string;
  gasCap: string;
  ltBps: number;
}

const symAbi = parseAbi(["function symbol() view returns (string)"]);
const cache = new Map<number, Promise<MarketAssets>>();

export function marketAssets(id: number = cfg.marketId): Promise<MarketAssets> {
  if (!cache.has(id)) cache.set(id, load(id));
  return cache.get(id)!;
}

function load(id: number): Promise<MarketAssets> {
  return (async () => {
    const m = await view<{ collateral: string; debt: string; collateral_decimals: number; debt_decimals: number; gas_limit_cap: string; lt_bps: number } | null>("get_market", { market_id: id });
    if (!m) throw new Error(`market ${id} not found on ${cfg.contract}`);
    const sym = (a: Address) => pub.readContract({ address: a, abi: symAbi, functionName: "symbol" }).catch(() => a.slice(0, 8)) as Promise<string>;
    const [cSym, dSym] = await Promise.all([sym(m.collateral as Address), sym(m.debt as Address)]);
    return { collateral: m.collateral as Address, debt: m.debt as Address, cDec: m.collateral_decimals, dDec: m.debt_decimals, cSym, dSym, gasCap: m.gas_limit_cap, ltBps: m.lt_bps };
  })().catch((e) => {
    cache.delete(id); // retry on the next call
    throw e;
  });
}

/** Whole-unit amount `n` (may be fractional) in a token's smallest units. */
export function units(n: number, decimals: number): bigint {
  // plain decimal digits, never exponent notation (String(1.9e-8) is "1.9e-8")
  const [i, f = ""] = n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }).split(".");
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

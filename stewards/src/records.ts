// The list pages' data (positions, rescues, claims, stewards), built from the contracts' own
// records: get_position, get_rescues, get_claim, get_roles, get_market. Read-only. `buildRecords`
// is pure (tested offline); `fetchRecords` reads the views through any view function.
import type { Claim, Position, Rescue } from "./types.js";

export type MarketRec = { id: number; chainId: number; collateral: string; debt: string; cDec: number; dDec: number; cSym: string; dSym: string };
export type RawContract = { contract: string; positions: Position[]; rescues: Rescue[]; claims: Claim[]; markets: MarketRec[]; stewards: string[] };

export type PositionRow = {
  key: string;
  contract: string;
  id: number;
  owner: string;
  pair: string;
  chain: string;
  hf: number | null;
  hfBlock: number | null;
  /** "verified" (OutLayer proof) or the reporter's name. */
  hfSource: string | null;
  hfAtMs: number | null;
  collateralUsd: number | null;
  debtUsd: number | null;
  status: "in rescue" | "below trigger" | "protected" | "no reading" | "empty";
  openRescues: number[];
};
export type RescueRow = {
  key: string;
  contract: string;
  id: number;
  positionId: number;
  pair: string;
  chain: string;
  state: string;
  openedAtMs: number;
  topUp: string;
  asset: string;
  topUpUsd: number;
  capBps: number;
  bids: number;
  winners: { steward: string; bps: number; share: string }[];
  premiumUsd: number;
  claims: string[];
};
export type ClaimRow = {
  token: string;
  contract: string;
  rescueId: number;
  positionId: number;
  owner: string;
  share: string;
  premium: string;
  owed: string;
  asset: string;
  bps: number;
  status: string;
  expiresAtMs: number;
};
export type StewardRow = { name: string; account: string; contracts: string[]; bids: number; wins: number; claimsOpen: number; claimsTotal: number; premiumUsd: number; lastWinAtMs: number | null };
export type Records = { version: 1; generated: string; contracts: string[]; positions: PositionRow[]; rescues: RescueRow[]; claims: ClaimRow[]; stewards: StewardRow[] };

const CHAIN: Record<number, string> = { 11155111: "Sepolia", 1: "Ethereum", 31337: "local fork" };
const TRIGGER = 1.15;
const usd = (base: string | number | bigint) => Number(BigInt(base)) / 1e8;
const nsToMs = (ns: string) => Number(BigInt(ns) / 1_000_000n);
/** Token units as a decimal string, trimmed (exact: no float rounding). */
export function units(v: string, dec: number): string {
  const s = BigInt(v).toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec), frac = s.slice(s.length - dec).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
const short = (account: string) => account.split(".")[0];

export function buildRecords(all: RawContract[], now = new Date()): Records {
  const out: Records = { version: 1, generated: now.toISOString(), contracts: all.map((c) => c.contract), positions: [], rescues: [], claims: [], stewards: [] };
  const stew = new Map<string, StewardRow>();
  const steward = (account: string, contract: string) => {
    const name = short(account);
    let s = stew.get(name);
    if (!s) stew.set(name, (s = { name, account, contracts: [], bids: 0, wins: 0, claimsOpen: 0, claimsTotal: 0, premiumUsd: 0, lastWinAtMs: null }));
    if (!s.contracts.includes(contract)) s.contracts.push(contract);
    return s;
  };
  for (const c of all) {
    const market = new Map(c.markets.map((m) => [m.id, m]));
    const pos = new Map(c.positions.map((p) => [p.id, p]));
    const mOf = (pid: number) => market.get(pos.get(pid)?.market_id ?? -1);
    for (const s of c.stewards) steward(s, c.contract);

    for (const p of c.positions) {
      const m = market.get(p.market_id);
      const h = p.health;
      const hf = h ? Number(BigInt(h.hf_wad) / 10n ** 12n) / 1e6 : null;
      const coll = h ? usd(h.collateral_base) : null;
      const inRescue = p.active_auction !== null || p.open_rescues.length > 0;
      out.positions.push({
        key: `${c.contract}#p${p.id}`,
        contract: c.contract,
        id: p.id,
        owner: p.owner,
        pair: m ? `${m.cSym}/${m.dSym}` : `market ${p.market_id}`,
        chain: m ? (CHAIN[m.chainId] ?? `chain ${m.chainId}`) : "?",
        hf: hf !== null && hf > 1e6 ? null : hf, // no debt: Aave reports the max value
        hfBlock: h?.block ?? null,
        hfSource: h?.source ?? null,
        hfAtMs: h ? nsToMs(h.at_ns) : null,
        collateralUsd: coll,
        debtUsd: h ? usd(h.debt_base) : null,
        status: inRescue ? "in rescue" : !h ? "no reading" : coll === 0 ? "empty" : hf !== null && hf < TRIGGER ? "below trigger" : "protected",
        openRescues: [...(p.active_auction !== null ? [p.active_auction] : []), ...p.open_rescues],
      });
    }

    for (const r of c.rescues) {
      const m = mOf(r.position_id);
      const winners = r.members.map((x) => ({ steward: short(x.steward), bps: x.premium_bps, share: m ? units(x.share_units, m.cDec) : x.share_units }));
      out.rescues.push({
        key: `${c.contract}#${r.id}`,
        contract: c.contract,
        id: r.id,
        positionId: r.position_id,
        pair: m ? `${m.cSym}/${m.dSym}` : "?",
        chain: m ? (CHAIN[m.chainId] ?? `chain ${m.chainId}`) : "?",
        state: r.state,
        openedAtMs: nsToMs(r.opened_at),
        topUp: m ? units(r.topup_units, m.cDec) : r.topup_units,
        asset: m?.cSym ?? "",
        topUpUsd: usd(r.topup_base),
        capBps: r.cap_bps,
        bids: r.bids.length,
        winners,
        premiumUsd: r.members.reduce((a, x) => a + usd(x.premium_base), 0),
        claims: r.members.map((x) => x.claim_id).filter((x): x is string => !!x),
      });
      for (const b of r.bids) steward(b.steward, c.contract).bids++;
      for (const x of r.members) {
        const s = steward(x.steward, c.contract);
        s.wins++;
        s.premiumUsd += usd(x.premium_base);
        s.lastWinAtMs = Math.max(s.lastWinAtMs ?? 0, nsToMs(r.opened_at));
      }
    }

    for (const cl of c.claims) {
      const m = mOf(cl.position_id);
      const dec = m?.cDec ?? 18;
      out.claims.push({
        token: cl.token_id,
        contract: c.contract,
        rescueId: cl.rescue_id,
        positionId: cl.position_id,
        owner: short(cl.owner),
        share: units(cl.share_units, dec),
        premium: units(cl.premium_units, dec),
        owed: units(cl.owed_units, dec),
        asset: m?.cSym ?? "",
        bps: cl.premium_bps,
        status: cl.status,
        expiresAtMs: nsToMs(cl.expires_at),
      });
      const s = steward(cl.owner, c.contract);
      s.claimsTotal++;
      if (cl.status === "open") s.claimsOpen++;
    }
  }
  out.positions.sort((a, b) => a.contract.localeCompare(b.contract) || b.id - a.id);
  out.rescues.sort((a, b) => b.openedAtMs - a.openedAtMs);
  out.claims.sort((a, b) => b.expiresAtMs - a.expiresAtMs);
  out.stewards = [...stew.values()].sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
  return out;
}

/** Read one contract's records. `view` is any read-only view call; `symbol` resolves a token address. */
export async function fetchContract(contract: string, view: <T>(contract: string, method: string, args: object) => Promise<T>, symbol: (address: string) => Promise<string>): Promise<RawContract> {
  const rescues: Rescue[] = [];
  for (let from = 0; ; from += 100) {
    const page = await view<Rescue[]>(contract, "get_rescues", { from, limit: 100 });
    rescues.push(...page);
    if (page.length < 100) break;
  }
  const positions: Position[] = [];
  for (let id = 0, misses = 0; misses < 3; id++) {
    const p = await view<Position | null>(contract, "get_position", { position_id: id });
    if (p) {
      positions.push(p);
      misses = 0;
    } else misses++;
  }
  const claims: Claim[] = [];
  for (const id of rescues.flatMap((r) => r.members.map((m) => m.claim_id)).filter((x): x is string => !!x)) {
    const cl = await view<Claim | null>(contract, "get_claim", { token_id: id });
    if (cl) claims.push(cl);
  }
  const markets: MarketRec[] = [];
  for (const id of new Set(positions.map((p) => p.market_id))) {
    const m = await view<{ chain_id: number; collateral: string; debt: string; collateral_decimals: number; debt_decimals: number } | null>(contract, "get_market", { market_id: id });
    if (!m) continue;
    const sym = async (a: string) => symbol(a).catch(() => a.slice(0, 8));
    markets.push({ id, chainId: m.chain_id, collateral: m.collateral, debt: m.debt, cDec: m.collateral_decimals, dDec: m.debt_decimals, cSym: await sym(m.collateral), dSym: await sym(m.debt) }); // the local fork copies Sepolia: same token addresses
  }
  const roles = await view<[string, string[], string[], boolean]>(contract, "get_roles", {});
  return { contract, positions, rescues, claims, markets, stewards: roles[2] };
}

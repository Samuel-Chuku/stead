// The homepage totals, computed from the contracts' own records (get_rescues, get_position,
// get_market). Only rescues on a real chain count (Sepolia today, Ethereum later); runs on the
// local fork (chain 31337) are reported separately and never mixed into the totals.

export type RescueRec = {
  id: number;
  position_id: number;
  state: string;
  opened_at: string; // ns
  claims_opened_at: string; // ns, 0 if no claim
  cap_bps: number;
  topup_base: string;
  members: { steward: string; premium_bps: number; premium_base: string }[];
};
export type ContractRecords = {
  contract: string;
  rescues: RescueRec[];
  positionMarket: Record<number, number>; // position id → market id
  marketChain: Record<number, number>; // market id → EVM chain id
};
export type SiteStats = {
  generatedAt: string;
  contracts: string[];
  chains: number[];
  rescues: number; // finished: bought back or settled
  boughtBack: number;
  settled: number;
  worseOff: number; // rescues whose premiums exceeded the contract's cap (derived from the liquidation penalty)
  medianPremiumBps: number | null; // the lowest winning premium of each rescue
  medianTriggerToClaimS: number | null;
  forkRescues: number; // finished runs on the local fork, not counted above
};

const FINISHED = new Set(["bought_back", "settled"]);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** I1 on the contract's own numbers: total premium ≤ the cap it set from the liquidation penalty. */
export function worseOff(r: RescueRec): boolean {
  const paid = r.members.reduce((a, m) => a + BigInt(m.premium_base), 0n);
  const cap = (BigInt(r.topup_base) * BigInt(r.cap_bps)) / 10_000n;
  return paid > cap + 1n; // 1 unit of rounding
}

export function siteStats(all: ContractRecords[], now = new Date()): SiteStats {
  const real: RescueRec[] = [];
  let fork = 0;
  const chains = new Set<number>();
  for (const c of all) {
    for (const r of c.rescues) {
      if (!FINISHED.has(r.state)) continue;
      const chain = c.marketChain[c.positionMarket[r.position_id]];
      if (chain === 31337 || chain === undefined) fork++;
      else {
        real.push(r);
        chains.add(chain);
      }
    }
  }
  const premiums = real.map((r) => Math.min(...r.members.map((m) => m.premium_bps))).filter(Number.isFinite);
  const toClaim = real.filter((r) => BigInt(r.claims_opened_at) > 0n).map((r) => Number((BigInt(r.claims_opened_at) - BigInt(r.opened_at)) / 1_000_000n) / 1000);
  return {
    generatedAt: now.toISOString(),
    contracts: all.map((c) => c.contract),
    chains: [...chains],
    rescues: real.length,
    boughtBack: real.filter((r) => r.state === "bought_back").length,
    settled: real.filter((r) => r.state === "settled").length,
    worseOff: real.filter(worseOff).length,
    medianPremiumBps: median(premiums),
    medianTriggerToClaimS: median(toClaim),
    forkRescues: fork,
  };
}

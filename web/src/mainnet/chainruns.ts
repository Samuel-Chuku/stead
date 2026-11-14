// The On mainnet page's list of real rescues, read straight from Stead's contract on NEAR mainnet:
// the pure part (no DOM, no network: tested offline). Which rescues still need reading, how the
// list splits (real rescues, rescues whose bids never became a proven top-up, rescues nobody bid
// on), the header's totals, and which Ethereum blocks give the proof steps their times.
import { evmRef, protectionRows, rescueFinished, type ClaimView, type ProtectionRow, type RescueView } from "../own/net";

/** Where the next `get_rescues` page starts: just after the run of finished rescues the page
 *  already holds from id 0 up (a finished rescue never changes; anything later may still). */
export function readFrom(held: ReadonlyMap<number, RescueView>): number {
  let n = 0;
  while (held.has(n) && rescueFinished(held.get(n)!)) n++;
  return n;
}

/** The claims a rescue's flow needs: one per winner that was minted one. */
export const claimIdsOf = (r: Pick<RescueView, "members">) => r.members.map((m) => m.claim_id).filter((x): x is string => !!x);

/** The Ethereum blocks the contract's proofs name (a proven top-up, a proven buy-back payment):
 *  their times are the times of those steps. */
export function proofBlocks(r: RescueView, claims: ClaimView[]): number[] {
  const out = new Set<number>();
  for (const s of [...r.members.map((m) => m.evm_tx), ...claims.map((c) => c.paid_by_tx)]) {
    const ref = evmRef(s);
    if (ref && "block" in ref) out.add(ref.block);
  }
  return [...out].sort((a, b) => a - b);
}

export type ChainRow = ProtectionRow & { positionId: number | null };
export type ChainRuns = {
  /** rescues that reached a top-up: running, bought back or settled; newest first */
  real: ChainRow[];
  /** rescues with bids but no proven top-up (failed); newest first */
  failed: ChainRow[];
  /** how many ended with no bid at all (not listed) */
  noBids: number;
  /** the positions the real rescues ran on, lowest first */
  positions: number[];
  /** "3 real rescues on Ethereum mainnet" */
  headline: string;
  /** how the real rescues ended: "2 bought back · 1 settled" ("" when there are none) */
  tally: string;
};

/** Every rescue the contract has, as the On mainnet page lists them. */
export function chainRuns(rs: RescueView[], chain = "Ethereum mainnet"): ChainRuns {
  const pos = new Map(rs.map((r) => [r.id, r.position_id ?? null]));
  const { rows, noBids } = protectionRows(rs);
  const withPos = (x: ProtectionRow): ChainRow => ({ ...x, positionId: pos.get(x.id) ?? null });
  const real = rows.filter((x) => x.outcome !== "failed").map(withPos);
  const failed = rows.filter((x) => x.outcome === "failed").map(withPos);
  const n = (o: ProtectionRow["outcome"]) => real.filter((x) => x.outcome === o).length;
  const tally = ([["running", "running"], ["bought_back", "bought back"], ["settled", "settled"]] as const)
    .filter(([o]) => n(o) > 0)
    .map(([o, w]) => `${n(o)} ${w}`)
    .join(" · ");
  const positions = [...new Set(real.map((x) => x.positionId).filter((x): x is number => x !== null))].sort((a, b) => a - b);
  const headline = real.length ? `${real.length} real rescue${real.length === 1 ? "" : "s"} on ${chain}` : `No rescue has run on ${chain} yet`;
  return { real, failed, noBids: noBids.length, positions, headline, tally };
}

/** The rescues a checked trail recorded (by rescue id), so a contract row can point at its trail. */
export function trailRescueIds(runs: { rescues?: { rescue: string }[] }[] | null | undefined): Map<number, { run: number; rescue: number }> {
  const out = new Map<number, { run: number; rescue: number }>();
  (runs ?? []).forEach((r, i) =>
    (r.rescues ?? []).forEach((x, j) => {
      const id = Number(x.rescue);
      if (Number.isInteger(id) && !out.has(id)) out.set(id, { run: i, rescue: j });
    }),
  );
  return out;
}

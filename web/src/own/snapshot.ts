// A mainnet contract's records in one cached file from the live feed (every rescue, position, claim,
// market and steward, re-read there every minute, plus the times of the Ethereum blocks the proofs
// name). Pages build their mainnet lists and rescue flows from it, so a visit makes no chain calls.
// When the feed can't be reached, or its copy is older than `MAX_AGE_MS`, the callers read the
// chain themselves as before.
import { feedBase } from "./flowlinks";
import type { RawContract } from "../../../stewards/src/records";

export type Snapshot = { version: 1; generated: string; contract: string; raw: RawContract; blockMs: Record<string, number> };

/** Older than this, the feed's copy is not used (its reads have been failing). */
export const MAX_AGE_MS = 10 * 60_000;
/** Kept in the page this long before it is asked for again. */
const KEEP_MS = 20_000;

/** The snapshot, if it is the right contract's, well formed and fresh enough. */
export function usable(j: unknown, contract: string, nowMs: number): Snapshot | null {
  const s = j as Snapshot | null;
  if (!s || s.version !== 1 || s.contract !== contract || !s.raw || !Array.isArray(s.raw.rescues) || !Array.isArray(s.raw.claims)) return null;
  const at = Date.parse(s.generated);
  return Number.isFinite(at) && nowMs - at <= MAX_AGE_MS ? s : null;
}

const cache = new Map<string, { at: number; p: Promise<Snapshot | null> }>();
export function contractSnapshot(contract: string, fetcher: typeof fetch = fetch): Promise<Snapshot | null> {
  const base = feedBase();
  if (!base) return Promise.resolve(null);
  const hit = cache.get(contract);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.p;
  const p = fetcher(`${base}/contract/${contract}.json`, { signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => usable(j, contract, Date.now()))
    .catch(() => null);
  cache.set(contract, { at: Date.now(), p });
  return p;
}

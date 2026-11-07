// Live rescues without re-reading history: rescue ids only grow, and a bought-back, settled or
// failed rescue never changes again, so each reader pages from the oldest rescue still live.
import { view } from "./near.js";
import type { Rescue } from "./types.js";

export const FINAL = ["bought_back", "settled", "failed"];
const PAGE = 50;

export class RescueCursor {
  /** The oldest rescue id that may still change (everything below it is final). */
  from = 0;

  /** Every rescue from the cursor on (live ones and any final ones above the oldest live). */
  async read(): Promise<Rescue[]> {
    const out: Rescue[] = [];
    for (let from = this.from; ; ) {
      const page = await view<Rescue[]>("get_rescues", { from, limit: PAGE }); // ids ≥ from
      out.push(...page);
      if (page.length < PAGE) break;
      from = page[page.length - 1].id + 1;
    }
    const live = out.filter((r) => !FINAL.includes(r.state));
    // nothing live: start after the newest one seen; else at the oldest live one
    this.from = live.length ? Math.min(...live.map((r) => r.id)) : out.length ? Math.max(...out.map((r) => r.id)) + 1 : this.from;
    return out;
  }
}

/** The wait before the next poll: the base interval, doubled per failure in a row, ≤ 1 min. */
export function pollDelay(baseMs: number, failures: number): number {
  return failures > 0 ? Math.min(60_000, baseMs * 2 ** Math.min(failures, 6)) : baseMs;
}

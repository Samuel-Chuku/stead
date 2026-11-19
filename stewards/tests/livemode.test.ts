import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RescueLog } from "../src/rescuelog.js";
import { feedRescue, type LiveFeed } from "../src/livefeed.js";
import { DELAY_S, demoPick, liveT, NO_ANSWER_MS, screenFor, startState, stepIndex, type DemoStatus, rescueTxs } from "../../web/src/board/live.js";
import { boardAt } from "../../web/src/board/model.js";

const C = "sepolia-demo.steadfi.testnet";
const r10: RescueLog = JSON.parse(readFileSync(new URL("../../web/public/replays/sepolia-demo-rescue-10.json", import.meta.url), "utf8"));
const now = 1_800_000_000_000;
const feed = (over: Partial<LiveFeed> = {}): LiveFeed => ({
  version: 1, generated: new Date(now - 1000).toISOString(), nowMs: now, contracts: [C], head: { height: 1, tsMs: now - 1500 },
  mode: "idle", watching: 14, rescues: [], stalled: [], stale: false, lastError: null, ...over,
});

describe("LIVE board: the clock", () => {
  it("runs the chain clock minus the delay, corrects the feed's clock skew, and never moves backwards", () => {
    expect(liveT(now, 0, now - 10_000)).toBeCloseTo(10 - DELAY_S);
    expect(liveT(now, 2000, now - 10_000)).toBeCloseTo(12 - DELAY_S);
    // a new skew estimate that would move time back holds the board where it was
    const t1 = liveT(now, 2000, now - 10_000);
    expect(liveT(now + 100, -3000, now - 10_000, t1)).toBe(t1);
    // there is no end and no wrap: a day later it is a day later
    expect(liveT(now + 86_400_000, 0, now - 10_000, t1)).toBeCloseTo(86_410 - DELAY_S);
  });
});

describe("LIVE board: what it shows", () => {
  it("loading at first, then the error panel if the feed never answers", () => {
    expect(screenFor(null, null, now, now + 1000).kind).toBe("loading");
    expect(screenFor(null, null, now, now + NO_ANSWER_MS + 1).kind).toBe("stale");
  });
  it("a fresh feed with nothing open: the calm empty state with the watched count", () => {
    expect(screenFor(feed(), now, now - 60_000, now)).toEqual({ kind: "empty", watching: 14 });
  });
  it("a stale or silent feed is an error, never the calm empty state", () => {
    expect(screenFor(feed({ stale: true }), now, 0, now).kind).toBe("stale");
    expect(screenFor(feed({ generated: new Date(now - 25_000).toISOString() }), now, 0, now).kind).toBe("stale");
    expect(screenFor(feed(), now - NO_ANSWER_MS - 1, 0, now).kind).toBe("stale");
  });
  it("an open rescue: the newest by default, or the one picked", () => {
    const a = feedRescue(C, { ...r10, rescueId: 21, openedAtMs: now - 20_000 }, "auction");
    const b = feedRescue(C, { ...r10, rescueId: 20, openedAtMs: now - 900_000 }, "open");
    const s = screenFor(feed({ rescues: [a, b] }), now, 0, now);
    expect(s.kind === "rescue" && s.rescue.rescueId).toBe(21);
    const p = screenFor(feed({ rescues: [a, b] }), now, 0, now, `${C}#20`);
    expect(p.kind === "rescue" && p.rescue.rescueId).toBe(20);
  });
});

describe("LIVE board: the derived bidding cue", () => {
  const bid = r10.events.find((e) => e.kind === "BID")!;
  const cue = r10.events.find((e) => e.kind === "BIDDING" && e.steward === (bid as any).steward)!;
  it("shows 'bidding…' when the board's delayed time reaches the cue before the bid", () => {
    expect(cue.t).toBeLessThan(bid.t);
    const b = boardAt(r10, (cue.t + bid.t) / 2);
    expect(b.subtitle).toMatch(/bidding…/);
  });
  it("a bid that arrived after its cue time shows directly, without the cue", () => {
    // the feed only has events that happened; at a board time past the bid there is no cue left
    const b = boardAt(r10, bid.t + 0.01);
    expect(b.rows.find((r) => r.steward === (bid as any).steward)!.bps).toBe((bid as any).bps);
  });
});

describe("DEMO board", () => {
  const st = (over: Partial<DemoStatus> = {}): DemoStatus => ({
    generated: now, free: 1, nextStartAt: now, paused: false, leftToday: 50, recent: [],
    slots: [
      { slot: 0, positionId: 7, run: { runId: "r-a", startedAt: now - 60_000, step: "auction", stepText: "Auction open", rescueId: 31, error: null } },
      { slot: 1, positionId: 8, run: null },
    ],
    ...over,
  });

  it("START is offered per kind only when that kind's slot is free, the 2-minute spacing has passed, funds allow, and the visitor has no run going", () => {
    // slot 0 (single) runs rescue 31; slot 1 (pooled) is free
    expect(startState(st(), now, false, "pooled").can).toBe(true);
    expect(startState(st(), now, false, "single")).toMatchObject({ can: false, reason: expect.stringContaining("Running now (rescue 31)") });
    expect(startState(st({ nextStartAt: now + 60_000 }), now, false, "pooled")).toMatchObject({ can: false, reason: expect.stringContaining("Next start possible at") });
    expect(startState(st({ paused: true }), now, false)).toMatchObject({ can: false, reason: expect.stringContaining("Demo paused") });
    expect(startState(st({ leftToday: 0 }), now, false).can).toBe(false);
    expect(startState(st(), now, true)).toMatchObject({ can: false, reason: "Your demo rescue is running below." });
    expect(startState(null, now, false)).toMatchObject({ can: false, reason: "Demo runner not answering." });
  });

  it("the run's stepper never runs ahead: settling sits on the buy-back step, reset and done count as finished", () => {
    expect(stepIndex("trigger")).toBe(0);
    expect(stepIndex("reading")).toBe(1);
    expect(stepIndex("auction")).toBe(2);
    expect(stepIndex("settling")).toBe(4);
    expect(stepIndex("reset")).toBe(6);
  });

  it("DEMO shows only rescues on the demo positions, the visitor's own first", () => {
    const d = demoPick(st(), "r-a");
    expect([...d.positions]).toEqual([7, 8]);
    expect(d.rescueId).toBe(31);
    // a real (non-demo) rescue in the feed never appears on the DEMO board
    const other = feedRescue(C, r10, "open"); // position 4
    const f = feed({ rescues: [other] });
    expect(screenFor(f, now, now - 1000, now, undefined, (r) => d.positions.has(r.positionId)).kind).toBe("empty");
    expect(screenFor(f, now, now - 1000, now).kind).toBe("rescue"); // LIVE still shows it
  });
});

describe("demo run log", () => {
  const tx = (label: string, step?: any) => ({ at: 0, label, chain: "near" as const, hash: "h", step });
  it("leaves out the transactions that put the position back to rest, by step", () => {
    const kept = rescueTxs([tx("repay to HF 1.17", "reset"), tx("Move the borrowed DAI", "reset"), tx("Borrow DAI until health is 1.14", "trigger"), tx("Buy-back: pays", "buyback")]);
    expect(kept.map((t) => t.label)).toEqual(["Borrow DAI until health is 1.14", "Buy-back: pays"]);
  });
  it("tells older runs' reset transactions apart by label, the transfer going with its borrow", () => {
    const kept = rescueTxs([tx("Reset: DAI sent into the position for the repay"), tx("repay to HF 1.17 (the contract signs it)"), tx("withdraw the extra collateral to the payout"), tx("Borrow DAI until health is 1.17"), tx("Move the borrowed DAI to the borrower's wallet"), tx("Borrow DAI until health is 1.14"), tx("Move the borrowed DAI to the borrower's wallet")]);
    expect(kept.map((t) => t.label)).toEqual(["Borrow DAI until health is 1.14", "Move the borrowed DAI to the borrower's wallet"]);
  });
});

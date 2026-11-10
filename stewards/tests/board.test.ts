import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RescueLog } from "../src/rescuelog.js";
import { boardAt, consequence, duration } from "../../web/src/board/model.js";

// The live board is a pure function of the recorded log and a time; these pin what it shows for
// the real rescue 8 replay the front end ships.
const log: RescueLog = JSON.parse(readFileSync(new URL("../../web/public/replays/sepolia-demo-rescue-8.json", import.meta.url), "utf8"));
const rankOf = (t: number) => Object.fromEntries(boardAt(log, t).rows.filter((r) => r.rank !== null).map((r) => [r.steward, r.rank]));

describe("live board from a recorded rescue", () => {
  it("shows no amber and no health factor before the board holds a reading", () => {
    const b = boardAt(log, -1);
    expect(b.hf).toBeNull();
    expect(Object.values(b.lamps).some(Boolean)).toBe(false);
    expect(b.phase).toBe("before");
  });

  it("lights TRIGGER and AUCTION on the proven opening reading", () => {
    const b = boardAt(log, 0);
    expect(b.lamps).toMatchObject({ TRIGGER: true, AUCTION: true, "TOP-UP": false, "CLAIM OPEN": false, TRIP: false });
    expect(b.hfEvidence).toMatchObject({ mark: "proven", rpcs: 4 });
    expect(b.clock).toBe(45);
  });

  it("ranks the lowest premium first as bids arrive (ties: earlier bid)", () => {
    expect(rankOf(12)).toEqual({ swift: 0 });
    expect(rankOf(18)).toEqual({ hedged: 0, swift: 1 });
    expect(rankOf(20)).toEqual({ hedged: 0, deep: 1, swift: 2 });
    expect(rankOf(40)).toEqual({ hedged: 0, deep: 1, patient: 2, swift: 3 });
    expect(boardAt(log, 18).rows.find((r) => r.steward === "hedged")!.badge).toBe("LEADING");
  });

  it("shows 'bidding…' only between a steward's cue and its real bid", () => {
    expect(boardAt(log, 16.5).subtitle).toBe("hedged bidding…");
    expect(boardAt(log, 17.7).stewards.find((s) => s.steward === "hedged")!.bidding).toBe(false);
  });

  it("counts the window down and freezes at 00:00", () => {
    expect(boardAt(log, 44.2).clock).toBe(1);
    expect(boardAt(log, 46).clock).toBe(0);
    expect(boardAt(log, 46).phase).toBe("closing");
    expect(boardAt(log, 50).title).toBe("hedged won · topping up");
  });

  it("keeps TRIGGER lit until a proven reading is back above the trigger", () => {
    expect(boardAt(log, 110).lamps.TRIGGER).toBe(true);
    const after = boardAt(log, 123);
    expect(after.lamps.TRIGGER).toBe(false);
    expect(after.hf).toBeGreaterThanOrEqual(1.15);
  });

  it("flows the pipe only between the supply and its proof", () => {
    expect(boardAt(log, 60).pipe).toMatchObject({ steward: "hedged", flowing: false, done: false });
    expect(boardAt(log, 70).pipe).toMatchObject({ flowing: true });
    expect(boardAt(log, 123).pipe).toMatchObject({ flowing: false, done: true });
  });

  it("opens the claim with the contract's window and closes it on the buy-back", () => {
    const open = boardAt(log, 125);
    expect(open.lamps["CLAIM OPEN"]).toBe(true);
    expect(open.claim).toMatchObject({ id: "3-5-0", holder: "hedged", owed: "0.00865215", premium: "0.00008652", closed: false });
    expect(open.claim!.windowLeft).toBeGreaterThan(170);
    const done = boardAt(log, duration(log));
    expect(done.lamps["CLAIM OPEN"]).toBe(false);
    expect(done.claim).toMatchObject({ closed: true, closedText: "bought back" });
    expect(Object.values(done.lamps).some(Boolean)).toBe(false);
  });

  it("states each health factor's consequence: (1 − 1/HF) × 100, one decimal", () => {
    expect(consequence(1.14)).toBe("12.3");
    expect(consequence(1.5)).toBe("33.3");
    expect(consequence(0.95)).toBe("0.0");
  });
});

describe("pooled rescue from a recorded log (rescue 10, four stewards)", () => {
  const pooled: RescueLog = JSON.parse(readFileSync(new URL("../../web/public/replays/sepolia-demo-rescue-10.json", import.meta.url), "utf8"));
  const single = boardAt(log, 60);

  it("shows the gap section only for a pooled rescue", () => {
    expect(single.pool).toBeNull();
    expect(boardAt(pooled, 0).pool).not.toBeNull();
  });

  it("fills the gap from the lowest premium up as offers arrive, trimming the last to fit", () => {
    const early = boardAt(pooled, 3)!.pool!; // only swift has offered
    expect(early.blocks.map((b) => b.steward)).toEqual(["swift"]);
    const p = boardAt(pooled, 40).pool!; // all four offers in
    expect(p.blocks.map((b) => b.steward)).toEqual(["deep", "hedged", "patient", "swift"]);
    expect(p.blocks.at(-1)!.amount).toBeCloseTo(83.104743016 - 75, 6);
    expect(p.committed).toBeCloseTo(83.104743016, 6);
    expect(p.final).toBe(false);
  });

  it("uses the contract's coalition after the close and says the premiums range", () => {
    const b = boardAt(pooled, 51);
    expect(b.pool!.final).toBe(true);
    expect(b.pool!.funded).toBe(true);
    expect(b.pool!.cards.find((c) => c.steward === "pool")!.state).toBe("nobid");
    expect(b.title).toBe("4 stewards won · topping up");
  });

  it("drains the column while the supplies are in flight and stops the pipe on the proof", () => {
    expect(boardAt(pooled, 70).pool).toMatchObject({ draining: true, flowing: true, confirmed: false });
    expect(boardAt(pooled, 121).pool).toMatchObject({ flowing: false, confirmed: true });
  });

  it("opens one claim per member and shows each one's exact payout as it lands", () => {
    const open = boardAt(pooled, 150).pool!;
    expect(open.tags.map((t) => t.holder)).toEqual(["deep", "hedged", "patient", "swift"]);
    expect(open.claimsOpen).toBe(true);
    const later = boardAt(pooled, 300).pool!;
    expect(later.claimsOpen).toBe(false);
    expect(later.tags.filter((t) => t.paid).map((t) => t.paid)).toEqual(["761.25 DAI", "761.25 DAI"]);
    const done = boardAt(pooled, duration(pooled)).pool!;
    expect(done.tags.every((t) => t.paid)).toBe(true);
  });
});

describe("settling warning", () => {
  it("warns not to repay on Aave directly only while a settlement runs", () => {
    // rescue 8 as if its buy-back window had run out: claims open, then a settlement starts and ends
    const claimT = log.events.find((e) => e.kind === "CLAIM_MINTED")!.t;
    const ev = { mark: "proven", chain: "near-testnet", tx: "x" } as any;
    const base = log.events.filter((e) => !["PAYMENT_IN", "ESCROW_PROVEN", "BUYBACK", "BOUGHT_BACK", "PAYOUT"].includes(e.kind));
    const settling: RescueLog = { ...log, outcome: "settled", events: [...base, { t: claimT + 200, kind: "SETTLE_START", evidence: ev }, { t: claimT + 300, kind: "SETTLED", evidence: ev }] as any };
    expect(boardAt(settling, claimT + 100).warning).toBeNull();
    expect(boardAt(settling, claimT + 250).warning).toMatch(/don't repay this position on Aave directly/);
    expect(boardAt(settling, claimT + 310).warning).toBeNull();
    expect(boardAt(log, 1e6).warning).toBeNull(); // a bought-back rescue never shows it
  });
});

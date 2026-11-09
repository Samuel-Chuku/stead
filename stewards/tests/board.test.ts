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

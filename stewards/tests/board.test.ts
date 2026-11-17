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

// Rescue 82 (pooled, settled on Ethereum mainnet), rebuilt from its chain data: between the
// window closing and SETTLED the board shows each settlement step as it lands, not a jump.
describe("live board through a settlement", async () => {
  const { buildLog } = await import("../src/rescuelog.js");
  const raw = JSON.parse(readFileSync(new URL("./fixtures/mainnet-rescue-82-chain.json", import.meta.url), "utf8"));
  const s82 = buildLog(raw) as RescueLog;
  const at = (k: string) => s82.events.find((e) => e.kind === k)!.t;
  const state = (t: number) => Object.fromEntries(boardAt(s82, t).settlement!.steps.map((x) => [x.key, x.state]));

  it("counts the buy-back window down and shows the borrower's payment before the settlement", () => {
    const b = boardAt(s82, at("PAYMENT_IN") + 1);
    expect(b.settlement).toBeNull();
    expect(b.window!.left).toBeGreaterThan(0);
    expect(b.window!.paidIn).toMatch(/WETH$/);
    expect(b.window!.proven).toBe(false);
  });

  it("moves through start, takeover, repay, payouts and settled in order", () => {
    expect(state(at("SETTLE_START"))).toMatchObject({ start: "done", takeover: "active", repay: "pending", legs: "pending", settled: "pending" });
    expect(state(at("SETTLE_TAKEOVER"))).toMatchObject({ takeover: "done", repay: "active" });
    expect(state(at("SETTLE_REPAY"))).toMatchObject({ repay: "done", legs: "active" });
    const firstLeg = at("SETTLE_LEG");
    expect(boardAt(s82, firstLeg).settlement!.steps.find((x) => x.key === "legs")!.detail).toMatch(/^1 of 5 · last /);
    expect(state(at("SETTLED"))).toMatchObject({ legs: "done", settled: "done", refund: "active" });
    expect(state(duration(s82))).toMatchObject({ refund: "done" });
    const steps = boardAt(s82, duration(s82)).settlement!.steps;
    const legs = s82.events.filter((e) => e.kind === "SETTLE_LEG");
    expect(steps.find((x) => x.key === "legs")!.link!.tx).toBe((legs[legs.length - 1] as any).evidence.tx);
    expect(steps.find((x) => x.key === "repay")!.link!.chain).toBe("ethereum");
    for (const x of steps) expect(x.link?.url, x.key).toMatch(/^https:\/\//);
  });

  it("names who did what on the steward cards and pays each claim's tag", () => {
    const b = boardAt(s82, at("SETTLED") - 0.01);
    const status = Object.fromEntries(b.stewards.map((c) => [c.steward, c.status]));
    expect(status.deep).toMatch(/repaid 22\.48 USDC/);
    expect(status.patient).toMatch(/handed the settlement over/);
    const swiftTag = b.pool!.tags.find((t) => t.holder === "swift")!;
    expect(swiftTag.settledLines).toEqual(["Paid 0.006 WETH: supplied units", "Paid 0.000168 WETH: premium"]);
  });

  it("drains each funder's colour on the replay's clock, from the supply sent to the top-up proven", () => {
    const sent = at("TOPUP_SENT"), proven = at("TOPUP_CONFIRMED");
    expect(boardAt(s82, sent - 1).pool!.drain).toBe(0);
    expect(boardAt(s82, (sent + proven) / 2).pool!.drain).toBeCloseTo(0.5, 2);
    expect(boardAt(s82, proven).pool!.drain).toBe(1);
    // the funders stay in the column after it drained
    expect(boardAt(s82, proven + 100).pool!.blocks.map((x) => x.steward).sort()).toEqual(["patient", "swift"]);
  });

  it("shows small pooled amounts in full, never 0.00", () => {
    const p = boardAt(s82, at("SETTLE_START")).pool!;
    expect(p.blocks.map((x) => x.amountText).join(" ")).not.toMatch(/\b0\.00 /);
    expect(p.gapText).not.toBe("0.01 WETH");
  });
});

// Rescue 81 (bought back on Ethereum mainnet): the board shows the buy-back's steps as they land,
// from the borrower's payment to the holder's payout, instead of jumping to "bought back".
describe("live board through a buy-back", () => {
  const s81: RescueLog = JSON.parse(readFileSync(new URL("../../web/public/replays/mainnet-rescue-81.json", import.meta.url), "utf8"));
  const at = (k: string) => s81.events.find((e) => e.kind === k)!.t;
  const state = (t: number) => Object.fromEntries((boardAt(s81, t).buyback?.steps ?? []).map((x) => [x.key, x.state]));

  it("has no buy-back steps before the borrower pays", () => {
    expect(boardAt(s81, at("PAYMENT_IN") - 1).buyback).toBeNull();
  });

  it("moves through paid in, proven, bought back and the holder's payout in order", () => {
    expect(state(at("PAYMENT_IN"))).toEqual({ paid: "done", proven: "active", bought: "pending", payout: "pending" });
    expect(state(at("BOUGHT_BACK"))).toEqual({ paid: "done", proven: "done", bought: "done", payout: "active" });
    const end = boardAt(s81, at("PAYOUT"));
    expect(end.buyback!.done).toBe(true);
    const payout = end.buyback!.steps.find((x) => x.key === "payout")!;
    expect(payout.label).toBe("PAID TO DEEP");
    expect(payout.detail).toMatch(/^exactly 0\.00940684 WETH$/);
    expect(end.stewards.find((c) => c.steward === "deep")!.status).toBe("won · 150 bps · paid back 0.00940684 WETH");
    // every finished step links its own transaction; the payout links the Ethereum transfer
    for (const x of end.buyback!.steps) expect(x.link?.url, x.key).toMatch(/^https:\/\//);
    const payoutEv = s81.events.find((e) => e.kind === "PAYOUT") as any;
    expect(payout.link!.tx).toBe((payoutEv.transfer ?? payoutEv.evidence).tx);
  });

  it("gives way to the settlement when one starts first", () => {
    const log: RescueLog = { ...s81, events: [...s81.events.filter((e) => e.t <= at("PAYMENT_IN")), { t: at("PAYMENT_IN") + 1, kind: "SETTLE_START", evidence: s81.events[0].evidence } as any] };
    const b = boardAt(log, at("PAYMENT_IN") + 2);
    expect(b.buyback).toBeNull();
    expect(b.settlement).not.toBeNull();
  });
});

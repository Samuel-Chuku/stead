// The keeper's proof cadence near the trigger: pay for a proof when the health moves or is under the
// trigger, not every minute for a position that sits still. Offline.
import { describe, expect, it } from "vitest";
import { healthDropping, nearTriggerCadence } from "../src/keeper.js";

const W = 10n ** 18n;
const TRIGGER = (115n * W) / 100n;
const hf = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

describe("proof cadence near the trigger", () => {
  it("proves every minute while the health moves, every 10 minutes while it sits still", () => {
    expect(nearTriggerCadence(hf(1.175), undefined, TRIGGER)).toBe(60_000); // never proven
    expect(nearTriggerCadence(hf(1.175), hf(1.175), TRIGGER)).toBe(600_000); // parked
    expect(nearTriggerCadence(hf(1.1751), hf(1.175), TRIGGER)).toBe(60_000); // moved 1 bp
    expect(nearTriggerCadence(hf(1.17505), hf(1.175), TRIGGER)).toBe(600_000); // interest dust
  });
  it("under the trigger, always every minute", () => {
    expect(nearTriggerCadence(hf(1.14), hf(1.14), TRIGGER)).toBe(60_000);
  });
});

describe("proof right after a relayed transaction", () => {
  it("a borrower's borrow or withdraw asks for a proof at once; other actions wait for the cadence", () => {
    expect(healthDropping({ type: "borrower", action: "borrow" })).toBe(true);
    expect(healthDropping({ type: "borrower", action: "withdraw" })).toBe(true);
    expect(healthDropping({ type: "borrower", action: "supply" })).toBe(false);
    expect(healthDropping({ type: "settlement" })).toBe(false);
    expect(healthDropping(null)).toBe(false);
  });
});


describe("an empty position's first reading", () => {
  it("is proven once when the position was never read (the size cap needs a price before the first supply)", async () => {
    const { skipEmptyProof } = await import("../src/keeper.js");
    expect(skipEmptyProof(0n, 0n, false, false, false)).toBe(false);
  });
  it("is skipped once the empty position has a reading, unless there is evidence or it is forced", async () => {
    const { skipEmptyProof } = await import("../src/keeper.js");
    expect(skipEmptyProof(0n, 0n, true, false, false)).toBe(true);
    expect(skipEmptyProof(0n, 0n, true, true, false)).toBe(false);
    expect(skipEmptyProof(0n, 0n, true, false, true)).toBe(false);
  });
  it("never skips a position with collateral or debt", async () => {
    const { skipEmptyProof } = await import("../src/keeper.js");
    expect(skipEmptyProof(1n, 0n, true, false, false)).toBe(false);
    expect(skipEmptyProof(0n, 1n, true, false, false)).toBe(false);
  });
});

describe("a relay whose transaction was already mined", () => {
  const raw = "0x02f86b01808405f5e1008477359400825208940000000000000000000000000000000000000001808080c0" as const;
  it("returns the signed bytes' own hash when a receipt exists, so the keeper confirms instead of retrying forever", async () => {
    const { minedAlready } = await import("../src/keeper.js");
    const { keccak256 } = await import("viem");
    const asked: string[] = [];
    expect(await minedAlready(raw, async (h) => (asked.push(h), { status: "success" }))).toBe(keccak256(raw));
    expect(asked).toEqual([keccak256(raw)]);
  });
  it("returns null when no receipt exists (the send really failed: keep retrying)", async () => {
    const { minedAlready } = await import("../src/keeper.js");
    expect(await minedAlready(raw, async () => null)).toBeNull();
    expect(await minedAlready(raw, async () => { throw new Error("not found"); })).toBeNull();
  });
});

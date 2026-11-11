// The keeper's proof cadence near the trigger: pay for a proof when the health moves or is under the
// trigger, not every minute for a position that sits still. Offline.
import { describe, expect, it } from "vitest";
import { nearTriggerCadence } from "../src/keeper.js";

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

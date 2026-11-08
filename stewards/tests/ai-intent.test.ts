import { describe, it, expect } from "vitest";
import { intended } from "../src/ai.js";
import { DEFAULTS } from "../src/risk.js";

// The AI layer applies only the settings its reason names (a model asked for the full set sometimes
// changes one while saying it keeps everything).
describe("AI tuning: only named changes apply", () => {
  it("a change the reason doesn't name is dropped", () => {
    const r = intended({ ...DEFAULTS.deep, minMargin: 0.01 }, DEFAULTS.deep, "No recent auctions, so keep the current settings unchanged.");
    expect(r.keep).toEqual({});
    expect(r.dropped).toEqual(["minMargin"]);
  });
  it("a change the reason names is kept; unchanged values are not proposals", () => {
    const r = intended({ ...DEFAULTS.deep, spreadBps: 180, minMargin: 0.01 }, DEFAULTS.deep, "Two lost auctions: raise the spread to 180 bps.");
    expect(r.keep).toEqual({ spreadBps: 180 });
    expect(r.dropped).toEqual(["minMargin"]);
  });
  it("a setting outside the tuning bounds stays as it is unless named (swift's margin of 0)", () => {
    const r = intended({ ...DEFAULTS.swift, minMargin: 0.01 }, DEFAULTS.swift, "Keep everything.");
    expect(r.keep).toEqual({});
  });
  it("no reason: nothing applies", () => {
    expect(intended({ ...DEFAULTS.deep, spreadBps: 200 }, DEFAULTS.deep, undefined).keep).toEqual({});
  });
});

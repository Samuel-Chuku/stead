// The site's mainnet pages read the live feed's copy of the contract (web/src/own/snapshot.ts) and
// fall back to the chain when that copy is missing, malformed, another contract's or too old.
import { describe, expect, it } from "vitest";
import { MAX_AGE_MS, usable } from "../../web/src/own/snapshot.js";

const now = Date.parse("2026-11-16T12:00:00Z");
const snap = (over: object = {}) => ({ version: 1, generated: new Date(now - 60_000).toISOString(), contract: "app.usestead.near", raw: { contract: "app.usestead.near", rescues: [], claims: [], positions: [], markets: [], stewards: [] }, blockMs: {}, ...over });

describe("the feed's copy of a contract", () => {
  it("is used when it is that contract's, well formed and fresh", () => {
    expect(usable(snap(), "app.usestead.near", now)).not.toBeNull();
  });
  it("is not used for another contract", () => {
    expect(usable(snap({ contract: "steadfi.testnet" }), "app.usestead.near", now)).toBeNull();
  });
  it("is not used once older than the limit (the feed's reads have been failing)", () => {
    expect(usable(snap({ generated: new Date(now - MAX_AGE_MS - 1).toISOString() }), "app.usestead.near", now)).toBeNull();
    expect(usable(snap({ generated: new Date(now - MAX_AGE_MS).toISOString() }), "app.usestead.near", now)).not.toBeNull();
  });
  it("is not used when malformed or missing", () => {
    expect(usable(null, "app.usestead.near", now)).toBeNull();
    expect(usable({ error: "first read still running" }, "app.usestead.near", now)).toBeNull();
    expect(usable(snap({ raw: { rescues: [] } }), "app.usestead.near", now)).toBeNull();
    expect(usable(snap({ generated: "not a date" }), "app.usestead.near", now)).toBeNull();
  });
});

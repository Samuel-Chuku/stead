import { describe, it, expect } from "vitest";
import { strategies, netHfAfter, type AuctionView } from "../src/strategy.js";

const S = 1_000_000_000n;
const base = (over: Partial<AuctionView> = {}): AuctionView => ({
  capBps: 1000, topupUnits: 30n * 10n ** 18n, topupBase: 886n * 10n ** 8n,
  openedAtNs: 0n, closesAtNs: 45n * S, nowNs: 40n * S,
  netHf: 1.14, ltBps: 7500, debtBase: 1900n * 10n ** 8n, earlyHf: 1.1, ...over,
});

describe("strategies (net HF drives every decision)", () => {
  it("never bids above the cap", () => {
    for (const s of Object.values(strategies)) {
      const d = s(base({ capBps: 120, netHf: 1.25 }));
      if (d.bid) expect(d.bps).toBeLessThanOrEqual(120);
    }
  });
  it("net HF after the rescue falls with the premium", () => {
    expect(netHfAfter(base(), 500)).toBeLessThan(netHfAfter(base(), 100));
  });
  it("deep skips thin margins that patient takes, at a higher premium", () => {
    const thin = base({ netHf: 1.115 });
    expect(strategies.deep(thin).bid).toBe(false);
    const p = strategies.patient(thin);
    expect(p.bid).toBe(true);
    const comfy = strategies.patient(base({ netHf: 1.3 }));
    if (p.bid && comfy.bid) expect(p.bps).toBeGreaterThan(comfy.bps);
  });
  it("deep bids low with a comfortable margin, full amount", () => {
    const d = strategies.deep(base({ netHf: 1.2, nowNs: 20n * S }));
    expect(d.bid && d.bps).toBe(150);
    expect(d.bid && d.amountUnits).toBe(30n * 10n ** 18n);
  });
  it("patient waits until the last 12 s; swift bids at once", () => {
    expect(strategies.patient(base({ nowNs: 10n * S })).bid).toBe(false);
    expect(strategies.swift(base({ nowNs: 1n * S })).bid).toBe(true);
  });
  it("pool bids a partial amount", () => {
    const d = strategies.pool(base({ netHf: 1.2, nowNs: 10n * S }));
    expect(d.bid && d.amountUnits).toBe((30n * 10n ** 18n * 40n) / 100n);
  });
});

describe("capacity limits (pooled rescues)", () => {
  const E = 10n ** 18n;
  it("no steward ever bids more than its capacity", () => {
    for (const s of Object.values(strategies)) {
      const d = s(base({ netHf: 1.2, nowNs: 40n * S, topupBase: 900n * 10n ** 8n, capacityUnits: 12n * E }));
      if (d.bid) expect(d.amountUnits).toBeLessThanOrEqual(12n * E);
    }
  });
  it("a capacity above the wanted amount changes nothing", () => {
    const a = base({ netHf: 1.2, nowNs: 20n * S, topupBase: 900n * 10n ** 8n });
    const d1 = strategies.deep(a);
    const d2 = strategies.deep({ ...a, capacityUnits: 1_000n * E });
    expect(d2).toEqual(d1);
  });
  it("two capacity-limited stewards together cover a top-up neither covers alone", () => {
    const a = base({ netHf: 1.2, nowNs: 40n * S, topupBase: 900n * 10n ** 8n });
    const deep = strategies.deep({ ...a, capacityUnits: 18n * E });
    const pool = strategies.pool({ ...a, capacityUnits: 18n * E });
    expect(deep.bid && pool.bid).toBe(true);
    if (deep.bid && pool.bid) {
      expect(deep.amountUnits).toBeLessThan(a.topupUnits);
      expect(deep.amountUnits + pool.amountUnits).toBeGreaterThanOrEqual(a.topupUnits);
    }
  });
});

describe("a steward never bids more than it can supply", () => {
  it("caps the bid at the wallet's collateral when it can't source more", async () => {
    const { bidCapacity } = await import("../src/steward.js");
    expect(bidCapacity(undefined, 12_000_000_000_000_000n)).toBe(12_000_000_000_000_000n);
    expect(bidCapacity(20_000_000_000_000_000n, 12_000_000_000_000_000n)).toBe(12_000_000_000_000_000n);
    expect(bidCapacity(6_000_000_000_000_000n, 12_000_000_000_000_000n)).toBe(6_000_000_000_000_000n);
  });
  it("keeps the configured limit when it can source capital (testnets, or NEAR Intents on mainnet)", async () => {
    const { bidCapacity } = await import("../src/steward.js");
    expect(bidCapacity(undefined, undefined)).toBeUndefined();
    expect(bidCapacity(6n, undefined)).toBe(6n);
  });
});

import { withHeadroom } from "../src/fork.js";
describe("gas for a steward's Ethereum write", () => {
  it("sends the estimate plus 30 %, never the bare estimate", () => {
    expect(withHeadroom(146_549n)).toBe(190_513n);
    expect(withHeadroom(146_549n) > 146_549n).toBe(true);
  });
});

import { intentsFrom } from "../src/steward.js";
describe("a steward's NEAR Intents setting from the environment", () => {
  it("is off unless a positive number of seconds is set, and never waits past 10 minutes", () => {
    expect(intentsFrom(undefined)).toBeUndefined();
    expect(intentsFrom("")).toBeUndefined();
    expect(intentsFrom("0")).toBeUndefined();
    expect(intentsFrom("abc")).toBeUndefined();
    expect(intentsFrom("120")).toEqual({ maxWaitMs: 120_000 });
    expect(intentsFrom("9999")).toEqual({ maxWaitMs: 600_000 });
  });
});

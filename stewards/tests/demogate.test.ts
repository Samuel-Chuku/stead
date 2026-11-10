// Demo rescues from the web page: who may start, budget pacing, exact buy-back, reset to rest,
// signer check, HTTP answers. No network, no keys.
import { describe, expect, it } from "vitest";
import { DEMO, admit, allowancePerDay, buybackUnits, checkSigners, freshGate, refuelPlan, resetPlan, route, stepOf, visitorOf, type Budget, type ChainView } from "../src/demogate.js";

const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const OPEN: Budget = { leftToday: 100, canPayOne: true };
const MIN = 60_000;

describe("who may start a demo rescue", () => {
  it("a third start while two run is refused as busy", () => {
    const g = freshGate();
    expect(admit(g, T0, "a", "token-aaaa", OPEN).ok).toBe(true);
    expect(admit(g, T0 + 2 * MIN, "b", "token-bbbb", OPEN).ok).toBe(true);
    const r = admit(g, T0 + 5 * MIN, "c", "token-cccc", OPEN);
    expect(r).toEqual({ ok: false, reason: "busy", nextAt: null });
  });

  it("a start within 2 minutes of the last one is refused with the time it becomes possible", () => {
    const g = freshGate();
    admit(g, T0, "a", "token-aaaa", OPEN);
    const r = admit(g, T0 + 90_000, "b", "token-bbbb", OPEN);
    expect(r).toEqual({ ok: false, reason: "too_soon", nextAt: T0 + DEMO.gapMs });
    expect(admit(g, T0 + DEMO.gapMs, "b", "token-bbbb", OPEN).ok).toBe(true);
  });

  it("the same visitor can't start twice in 10 minutes (so one visitor can't hold both slots)", () => {
    const g = freshGate();
    admit(g, T0, "1.2.3.4", "token-aaaa", OPEN);
    const r = admit(g, T0 + 3 * MIN, "1.2.3.4", "token-bbbb", OPEN);
    expect(r).toEqual({ ok: false, reason: "visitor_wait", nextAt: T0 + DEMO.perVisitorMs });
    expect(admit(g, T0 + 3 * MIN, "5.6.7.8", "token-cccc", OPEN).ok).toBe(true);
  });

  it("the same token twice starts one run, and the repeat gets that run back", () => {
    const g = freshGate();
    const a = admit(g, T0, "a", "token-aaaa", OPEN);
    const b = admit(g, T0 + 1000, "a", "token-aaaa", OPEN);
    expect(a.ok && b.ok && b.repeat && b.runId === a.runId).toBe(true);
    expect(g.slots.filter((s) => s.run).length).toBe(1);
    expect(g.startsToday).toBe(1);
  });

  it("over today's allowance: refused until the next UTC day; funds for no run at all: paused", () => {
    expect(admit(freshGate(), T0, "a", "token-aaaa", { leftToday: 0, canPayOne: true })).toEqual({ ok: false, reason: "over_allowance", nextAt: Date.UTC(2026, 10, 13) });
    expect(admit(freshGate(), T0, "a", "token-aaaa", { leftToday: 5, canPayOne: false })).toEqual({ ok: false, reason: "paused", nextAt: null });
  });

  it("the visitor key is Cloudflare's connecting IP when it looks like an address, else the socket", () => {
    expect(visitorOf({ "cf-connecting-ip": "203.0.113.9" }, "172.18.0.5")).toBe("203.0.113.9");
    expect(visitorOf({ "cf-connecting-ip": "<script>" }, "172.18.0.5")).toBe("172.18.0.5");
    expect(visitorOf({}, undefined)).toBe("unknown");
  });
});

describe("budget pacing", () => {
  it("runs per day = reserve / (2 M gas × gas price × 1.5) / days left, the smaller of ETH and NEAR", () => {
    const gwei = 1_000_000_000n;
    // 4 ETH at 1 gwei: 4e18 / 3e15 = 1333 runs; NEAR plenty; 10 days left → 133 a day
    const a = allowancePerDay({ reserveWei: 4n * 10n ** 18n, gasPriceWei: gwei, reporterYocto: 10n ** 30n, now: DEMO.endMs - 10 * 86_400_000 });
    expect(a).toEqual({ perDay: 133, canPayOne: true });
    // a 10-gwei spike: 133 runs over 10 days → 13 a day, still running
    expect(allowancePerDay({ reserveWei: 4n * 10n ** 18n, gasPriceWei: 10n * gwei, reporterYocto: 10n ** 30n, now: DEMO.endMs - 10 * 86_400_000 }).perDay).toBe(13);
    // NEAR binds: 20 NEAR / 0.08 = 250 runs
    expect(allowancePerDay({ reserveWei: 10n ** 20n, gasPriceWei: gwei, reporterYocto: 20n * 10n ** 24n, now: DEMO.endMs - 10 * 86_400_000 }).perDay).toBe(25);
    // less than one run's worth: pause
    expect(allowancePerDay({ reserveWei: 10n ** 15n, gasPriceWei: gwei, reporterYocto: 10n ** 30n, now: T0 }).canPayOne).toBe(false);
    // past the end date: the whole reserve is today's
    expect(allowancePerDay({ reserveWei: 3n * 10n ** 15n, gasPriceWei: gwei, reporterYocto: 10n ** 30n, now: DEMO.endMs + 86_400_000 }).perDay).toBe(1);
  });

  it("refuel fills only wallets below their floor, and never past the reserve", () => {
    const e = 10n ** 15n;
    const plan = refuelPlan(
      [
        { address: "0xa", balanceWei: 1n * e, floorWei: 4n * e, targetWei: 10n * e },
        { address: "0xb", balanceWei: 5n * e, floorWei: 4n * e, targetWei: 10n * e },
        { address: "0xc", balanceWei: 0n, floorWei: 4n * e, targetWei: 10n * e },
      ],
      15n * e,
    );
    expect(plan).toEqual([{ to: "0xa", wei: 9n * e }]); // 0xb is fine; 0xc would overdraw the reserve
  });
});

describe("the run", () => {
  const base: ChainView = { hfBps: 11_700, collateralUnits: 60n * 10n ** 18n, restUnits: 60n * 10n ** 18n, activeAuction: null, openRescues: [], rescueState: null, outflows: 0 };
  it("a restarted runner picks up at the right step from chain state", () => {
    expect(stepOf(base)).toBe("trigger");
    expect(stepOf({ ...base, hfBps: 11_400 })).toBe("reading");
    expect(stepOf({ ...base, activeAuction: 31, rescueState: "auction" })).toBe("auction");
    expect(stepOf({ ...base, openRescues: [31], rescueState: "top_up_pending" })).toBe("topup");
    expect(stepOf({ ...base, openRescues: [31], rescueState: "open" })).toBe("buyback");
    expect(stepOf({ ...base, openRescues: [31], rescueState: "settling" })).toBe("settling");
    expect(stepOf({ ...base, outflows: 1 })).toBe("payouts");
    expect(stepOf({ ...base, collateralUnits: 79n * 10n ** 18n, hfBps: 15_000 })).toBe("reset");
  });

  it("the buy-back pays exactly the owed units of the open claims (nothing left to refund)", () => {
    expect(buybackUnits([
      { owed_units: "19000000000000000000", status: "open" },
      { owed_units: "189000000000000000", status: "open" },
      { owed_units: "5", status: "bought_back" },
    ])).toBe(19_189_000_000_000_000_000n);
  });

  it("reset returns the position to rest: debt for HF 1.17 on the resting collateral, extra collateral withdrawn", () => {
    const priceC = 30n * 10n ** 8n, priceD = 10n ** 8n, lt = 7_500n, rest = 60n * 10n ** 18n;
    const restBase = 60n * priceC; // $1,800
    // after a rescue: collateral rest + 19 LINK top-up, debt at HF 1.14 on the resting collateral
    const debtBase = (restBase * lt) / 11_400n;
    const p = resetPlan({ collateralBase: restBase + 19n * priceC, debtBase, ltBps: lt, priceC, priceD, cDec: 18, dDec: 18, restUnits: rest });
    const repaidBase = (p.repayUnits * priceD) / 10n ** 18n;
    const debtAfter = debtBase - repaidBase;
    const collAfter = restBase + 19n * priceC - (p.withdrawUnits * priceC) / 10n ** 18n;
    const hf = Number((collAfter * lt * 10_000n) / debtAfter / 10_000n) / 10_000;
    expect(p.supplyUnits).toBe(0n);
    expect(p.borrowUnits).toBe(0n);
    expect(hf).toBeGreaterThanOrEqual(1.17);
    expect(hf).toBeLessThan(1.175);
    const collUnits = (collAfter * 10n ** 18n) / priceC;
    expect(Number(collUnits - rest) / Number(rest)).toBeLessThan(0.01); // within 1 % of rest
    // and the result reads as "ready for the next run"
    expect(stepOf({ hfBps: Math.floor(hf * 10_000), collateralUnits: collUnits, restUnits: rest, activeAuction: null, openRescues: [], rescueState: null, outflows: 0 })).toBe("trigger");
  });

  it("reset after a settlement (collateral below rest): supply the gap, then borrow back to 1.17", () => {
    const priceC = 30n * 10n ** 8n, priceD = 10n ** 8n, lt = 7_500n, rest = 60n * 10n ** 18n;
    const p = resetPlan({ collateralBase: 50n * priceC, debtBase: 900n * 10n ** 8n, ltBps: lt, priceC, priceD, cDec: 18, dDec: 18, restUnits: rest });
    expect(p.supplyUnits).toBe(10n * 10n ** 18n);
    expect(p.repayUnits).toBe(0n);
    expect(p.borrowUnits).toBeGreaterThan(0n);
    expect(p.withdrawUnits).toBe(0n);
  });

  it("the runner signs only for demo borrower accounts", () => {
    expect(() => checkSigners(["demo.steadfi.testnet", "demo-2.steadfi.testnet"], ["borrower.steadfi.testnet"])).not.toThrow();
    for (const bad of [["borrower.steadfi.testnet"], ["reporter.steadfi.testnet"], ["deep.steadfi.testnet"], ["sepolia-demo.steadfi.testnet"], [], ["demo.steadfi.testnet", "demo.steadfi.testnet"]])
      expect(() => checkSigners(bad, ["borrower.steadfi.testnet"])).toThrow();
  });
});

describe("HTTP", () => {
  const ORIGIN = "https://app.usestead.xyz";
  const make = () => {
    const started: [number, string][] = [];
    const gate = freshGate();
    const d = { allowedOrigins: [ORIGIN], now: T0, gate, budget: () => OPEN, start: (s: number, id: string) => void started.push([s, id]), status: () => ({ ok: 1 }), save: () => {} };
    return { d, started };
  };
  const post = (body: string, origin: string | undefined = ORIGIN) => ({ method: "POST", path: "/demo/start", origin, body, visitor: "v" });

  it("non-POST start 405, wrong origin 403, bad bodies and tokens 400, unknown path 404", () => {
    const { d, started } = make();
    expect(route({ ...post(""), method: "GET" }, d).status).toBe(405);
    expect(route(post('{"token":"token-aaaa"}', "https://evil.example"), d).status).toBe(403);
    expect(route({ ...post('{"token":"token-aaaa"}'), origin: undefined }, d).status).toBe(403);
    expect(route(post("not json"), d).status).toBe(400);
    expect(route(post('{"token":"short"}'), d).status).toBe(400);
    expect(route(post('{"token":"has space in it"}'), d).status).toBe(400);
    expect(route(post('{"token":"token-aaaa","extra":1}'), d).status).toBe(400);
    expect(route(post(`{"token":"${"a".repeat(2000)}"}`), d).status).toBe(400);
    expect(route({ ...post(""), path: "/demo/other" }, d).status).toBe(404);
    expect(route({ ...post(""), method: "POST", path: "/demo/status" }, d).status).toBe(405);
    expect(started).toEqual([]);
  });

  it("a good start runs once; the repeat answers 200 without a second run; a refusal is 429 with a reason", () => {
    const { d, started } = make();
    expect(route(post('{"token":"token-aaaa"}'), d)).toMatchObject({ status: 202, json: { started: true, slot: 0 } });
    expect(route(post('{"token":"token-aaaa"}'), d).status).toBe(200);
    expect(started.length).toBe(1);
    const r = route({ ...post('{"token":"token-bbbb"}'), visitor: "w" }, d);
    expect(r.status).toBe(429);
    expect(r.json).toMatchObject({ started: false, reason: "too_soon", nextAt: T0 + DEMO.gapMs });
  });
});

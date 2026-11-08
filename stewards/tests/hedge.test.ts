import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";

// The hedged steward: its bid formula, and the hedge rules. One test per rule.
const ev = vi.hoisted(() => ({ supplies: 0, claims: new Map<string, { status: string; owner: string }>() }));

vi.mock("../src/near.js", () => ({
  NEAR: 10n ** 24n,
  TGAS: 10n ** 12n,
  viewReport: () => "",
  view: vi.fn(async (method: string, args: any) => {
    if (method === "get_position") return { evm_address: "0x00000000000000000000000000000000000000aa", market_id: 0 };
    if (method === "get_market") return { collateral: "0xf8fb3713d459d7c1018bd0a49d19b4c44290ebe5", debt: "0xff34b3d4aee8ddcd6f9afffb6fe49bd371b8a357", collateral_decimals: 18, debt_decimals: 18, gas_limit_cap: "400000", lt_bps: 7500 };
    if (method === "get_claim") return { token_id: args.token_id, ...ev.claims.get(args.token_id) };
    throw new Error(`unexpected view ${method}`);
  }),
  call: vi.fn(),
}));
vi.mock("../src/intents.js", () => ({ sourceCapital: vi.fn(async () => 0n) }));
vi.mock("../src/fork.js", async (orig) => {
  const real = await orig<typeof import("../src/fork.js")>();
  return {
    ...real,
    pub: { readContract: vi.fn(async (q: { functionName: string }) => (q.functionName === "symbol" ? "LINK" : real.MAX)) },
    write: vi.fn(async (_w: unknown, _a: unknown, _abi: unknown, fn: string, _args: unknown[], onSent?: (h: string) => void) => {
      if (fn !== "supply") throw new Error(`unexpected write ${fn}`);
      ev.supplies++;
      onSent?.("0xsupply");
      return "0xsupply";
    }),
  };
});

const { Steward } = await import("../src/steward.js");
const { Hedger } = await import("../src/hedge.js");
const { strategies } = await import("../src/strategy.js");
const { ORDERLY_API } = await import("../src/orderly.js");
type Venue = import("../src/hedge.js").Venue;

/** A fake venue: LINK at $10, tick 0.01, $10 minimum; records orders. */
function fakeVenue(start = 0) {
  const v = {
    pos: start,
    down: false,
    free: 1000,
    funding: 0.0001,
    depth: 1e9, // bids within 1 % of the mark
    fill: 1, // fraction of each order the venue fills (the rest is cancelled)
    orders: [] as { side: string; qty: number; reduceOnly: boolean }[],
    venue: {} as Venue,
  };
  const guard = () => {
    if (v.down) throw new Error("venue unreachable");
  };
  v.venue = {
    market: async () => (guard(), { baseTick: 0.01, minNotional: 10, mark: 10, estFunding: v.funding }),
    freeCollateral: async () => (guard(), v.free),
    takerFeeBps: async () => (guard(), 10),
    position: async () => (guard(), v.pos),
    bidDepth: async () => (guard(), v.depth),
    order: async (_s, side, qty, reduceOnly) => {
      guard();
      v.orders.push({ side, qty, reduceOnly });
      const filled = Math.floor(qty * v.fill * 100) / 100;
      v.pos = Number((v.pos + (side === "SELL" ? -filled : filled)).toFixed(8));
      return { orderId: 1000 + v.orders.length };
    },
  };
  return v;
}

const E18 = 10n ** 18n;
const S = 1_000_000_000n;
const ME = "hedged.steadfi.testnet";
const auction = (over: object = {}) => ({
  capBps: 1000,
  topupUnits: 20n * E18,
  topupBase: 600n * 10n ** 8n,
  openedAtNs: 0n,
  closesAtNs: 45n * S,
  nowNs: 20n * S,
  netHf: 1.2,
  ltBps: 7500,
  debtBase: 1800n * 10n ** 8n,
  earlyHf: 1.1,
  ...over,
});
const quote = (ok = true, fundingBps = 0) => ({ ok, priceRiskBps: 112.5, fundingBps, feeBps: 25, why: ok ? "hedge ok" : "venue unavailable" });

beforeEach(() => {
  ev.supplies = 0;
  ev.claims.clear();
  process.env.STEWARD_ACCOUNT = ME;
  process.env.STEWARD_EVM_KEY = generatePrivateKey();
});
afterEach(() => {
  delete process.env.STEWARD_ACCOUNT;
  delete process.env.STEWARD_EVM_KEY;
});

describe("bid formula (floor − price risk + funding + fees)", () => {
  it("LINK today: 150 − 112.5 + 0 + 25 → 63 bps, below deep's 150", () => {
    const d = strategies.hedged(auction({ hedge: quote() }) as any);
    expect(d.bid && d.bps).toBe(63);
    const deep = strategies.deep(auction() as any);
    expect(deep.bid && deep.bps).toBe(150);
  });
  it("negative funding is a cost to the short and is added", () => {
    const d = strategies.hedged(auction({ hedge: quote(true, 6) }) as any);
    expect(d.bid && d.bps).toBe(69);
  });
  it("without a hedge it never bids the hedged price: deep's unhedged floor", () => {
    const d = strategies.hedged(auction({ hedge: quote(false) }) as any);
    expect(d.bid && d.bps).toBe(150);
    expect(d.why).toContain("UNHEDGED");
  });
  it("never below the 50 bps bound, never above the auction cap", () => {
    expect(strategies.hedged(auction({ hedge: { ...quote(), priceRiskBps: 200 } }) as any)).toMatchObject({ bps: 50 });
    expect(strategies.hedged(auction({ capBps: 40, hedge: quote() }) as any)).toMatchObject({ bps: 40 });
  });
  it("the venue quote: computed from live fees and funding; any venue problem means not ok", async () => {
    const v = fakeVenue();
    v.funding = -0.0002;
    const q = await new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue).quote(20);
    expect(q).toMatchObject({ ok: true, priceRiskBps: 112.5, feeBps: 25 });
    expect(q.fundingBps).toBeCloseTo(6);
    expect((await new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue).quote(0.5)).ok).toBe(false); // $5 < $10 minimum
    v.free = 20; // needs 1.5 × $200 / 10 = $30
    expect((await new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue).quote(20)).ok).toBe(false);
    v.free = 1000;
    v.depth = 8; // the live LINK book: too thin for a 20 LINK hedge → no hedged price
    const thin = await new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue).quote(20);
    expect(thin.ok).toBe(false);
    expect(thin.why).toContain("too thin");
    v.depth = 1e9;
    v.down = true;
    expect((await new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue).quote(20)).ok).toBe(false);
  });
});

/** A rescue as the contract returns it, with this steward as the only member. */
const rescue = (state: string, extra: object = {}) => ({
  id: 7,
  position_id: 3,
  state,
  topup_deadline: (BigInt(Date.now()) * 1_000_000n + 170n * S).toString(),
  members: [{ steward: ME, confirmed: state !== "top_up_pending", premium_bps: 63, share_units: (20n * E18).toString(), claim_id: state === "top_up_pending" ? undefined : "3-0-0" }],
  ...extra,
});
const steward = (v: ReturnType<typeof fakeVenue>) => Object.assign(new Steward("hedged"), { venue: v.venue });
const sync = (s: any, rs: unknown[]) => s.syncHedge(rs);
const topUp = (s: any, r: unknown) => s.onTopUp(r);

describe("hedge lifecycle", () => {
  it("the top-up comes first: venue down → the supply is still sent, 'unhedged' logged, the hedge opens once the venue is back", async () => {
    const v = fakeVenue();
    v.down = true;
    const s = steward(v);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    const r = rescue("top_up_pending");
    await topUp(s, r);
    await sync(s, [r]);
    expect(ev.supplies).toBe(1);
    expect(logs.some((l) => l.includes("unhedged"))).toBe(true);
    v.down = false;
    await sync(s, [r]);
    spy.mockRestore();
    expect(v.pos).toBe(-20);
  });

  it("no hedge before this steward's own supply is broadcast", async () => {
    const v = fakeVenue();
    const s = steward(v);
    await sync(s, [rescue("top_up_pending")]); // won, but hasn't supplied yet
    expect(v.orders).toHaveLength(0);
  });

  it("the short follows what is still owed: top-up → claim → a settlement leg paid → settled", async () => {
    const v = fakeVenue();
    const s = steward(v);
    const pending = rescue("top_up_pending");
    await topUp(s, pending);
    await sync(s, [pending]);
    expect(v.pos).toBe(-20);
    ev.claims.set("3-0-0", { status: "open", owner: ME });
    await sync(s, [rescue("open")]);
    expect(v.orders).toHaveLength(1); // same target: no order
    (s as any).hedger.last = undefined;
    const legs = [{ to: "0x1", amount: { exact: (8n * E18).toString() }, claim_id: "3-0-0", done: true }, { to: "0x1", amount: { exact: (12n * E18).toString() }, claim_id: "3-0-0", done: false }];
    await sync(s, [rescue("settling", { settlement: { legs } })]);
    expect(v.pos).toBe(-12);
    expect(v.orders.at(-1)).toMatchObject({ side: "BUY", qty: 8, reduceOnly: true });
    await sync(s, [rescue("settled")]);
    expect(v.pos).toBe(0);
  });

  it("every claim exit closes the hedge", async () => {
    const exits: [string, (s: any) => unknown[]][] = [
      ["buy-back", () => [rescue("bought_back")]],
      ["settlement", () => [rescue("settled")]],
      ["failed or refunded top-up", () => [rescue("failed")]],
      ["claim forfeited or bought back alone (claim no longer open)", () => (ev.claims.set("3-0-0", { status: "settled", owner: ME }), [rescue("open")])],
      ["claim sold (no longer ours)", () => (ev.claims.set("3-0-0", { status: "open", owner: "someone.testnet" }), [rescue("open")])],
      ["rescue gone from the cursor (final)", () => []],
    ];
    for (const [name, rs] of exits) {
      const v = fakeVenue(-20); // a short is open
      const s = steward(v);
      await sync(s, rs(s));
      expect([name, v.pos]).toEqual([name, 0]);
      expect(v.orders.at(-1)).toMatchObject({ side: "BUY", reduceOnly: true });
    }
  });

  it("a takeover keeps the hedge while the claim is still owed", async () => {
    const v = fakeVenue(-20);
    const s = steward(v);
    ev.claims.set("3-0-0", { status: "open", owner: ME });
    await sync(s, [rescue("settling", { settlement: { settler: "patient.steadfi.testnet", legs: [] } })]);
    expect(v.orders).toHaveLength(0);
    expect(v.pos).toBe(-20);
  });

  it("every open, adjust and close is logged with the venue's order id", async () => {
    const v = fakeVenue();
    const h = new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    await h.reconcile(20, "rescue 7");
    (h as any).last = undefined;
    await h.reconcile(5, "rescue 7");
    await h.reconcile(0, "rescue 7");
    spy.mockRestore();
    expect(logs.filter((l) => /hedge (OPEN|ADJUST|CLOSE).*venue order \d+/.test(l))).toHaveLength(3);
  });

  it("never more short than owed: a restart with the short already open sends nothing; an excess is bought back reduce-only", async () => {
    const v = fakeVenue(-20);
    await new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue).reconcile(20, "restart");
    expect(v.orders).toHaveLength(0);
    const w = fakeVenue(-25);
    await new Hedger(ME, "PERP_LINK_USDC", "LINK", w.venue).reconcile(20, "excess");
    expect(w.orders).toEqual([{ side: "BUY", qty: 5, reduceOnly: true }]);
  });

  it("a partial fill (the venue cancels the rest) is retried until the short matches the target", async () => {
    const v = fakeVenue();
    v.fill = 0.25;
    const h = new Hedger(ME, "PERP_LINK_USDC", "LINK", v.venue);
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now");
    for (let i = 0; i < 12; i++) {
      clock.mockReturnValue(t0 + i * 16_000); // each check 16 s after the last
      await h.reconcile(20, "rescue 7");
    }
    clock.mockRestore();
    // within one venue minimum ($10 at $10 = 1 LINK) of the target, never past it
    expect(v.pos).toBeLessThanOrEqual(-19);
    expect(v.pos).toBeGreaterThanOrEqual(-20);
    expect(v.orders.every((o) => o.side === "SELL" && !o.reduceOnly)).toBe(true);
    expect(v.orders.length).toBeGreaterThan(1);
  });

  it("testnet only: the venue host is a constant, never read from the environment", () => {
    expect(new URL(ORDERLY_API).host).toBe("testnet-api.orderly.org");
    const src = readFileSync(new URL("../src/orderly.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/ORDERLY_API\s*=\s*process\.env/);
    const hosts = [...src.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(0);
    for (const h of hosts) expect(h).toMatch(/^testnet-/); // no mainnet venue anywhere in the client
  });
});

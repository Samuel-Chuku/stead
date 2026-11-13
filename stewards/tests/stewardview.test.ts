import { describe, it, expect } from "vitest";
import { rescueViews, type ViewEntry } from "../src/stewardview.js";

// A winning steward's own moves, read back from a run's trail. Offline: the entries are written the
// way src/record.ts describes NEAR calls and Ethereum transactions.
let n = 0;
const T0 = Date.parse("2026-11-13T20:00:00Z");
const e = (sec: number, actor: string, what: string, extra: Partial<ViewEntry> = {}): ViewEntry => ({
  chain: extra.chain ?? (extra.method ? "near-mainnet" : "ethereum"),
  tx: `tx${++n}`,
  at: new Date(T0 + sec * 1000).toISOString(),
  step: "2: run",
  what,
  actor,
  ok: true,
  ...extra,
});
const KEEPER = "keeper (temporary reporter)";

// run 1: deep alone, own WETH, bought back. run 2: pooled, deep buys its share through NEAR Intents,
// patient uses its own WETH, deep settles and patient's start is refused.
const trail: ViewEntry[] = [
  e(0, "deep", "bids 150 bps on rescue 7", { method: "bid" }),
  e(5, "patient", "bids 268 bps on rescue 7", { method: "bid" }),
  e(30, "deep", "supplies 0.0115 WETH to Aave on behalf of position A (3) (top-up)"),
  e(32, KEEPER, "asks OutLayer for a verified reading of position 3", { method: "request_verified" }),
  e(40, "borrower", "borrower pays 24.67 USDC into the position (owed 23.67 + 1 extra, refunded)"),
  e(50, KEEPER, "confirms the buy-back balance held by position 3", { method: "confirm_escrow" }),
  e(60, "position A (3)", "sends 23.67 USDC to deep"),
  e(61, "position A (3)", "sends 1 USDC to borrower"),
  e(70, "deep", "deep returns 23.67 USDC to the borrower (our own wallets)"),
  // run 2
  e(200, "deep", "bids 150 bps on rescue 8", { method: "bid" }),
  e(205, "patient", "bids 300 bps on rescue 8", { method: "bid" }),
  e(206, "patient", "bids 268 bps on rescue 8", { method: "bid" }),
  e(230, "patient", "supplies 0.0055 WETH to Aave on behalf of position B (4) (top-up)"),
  e(232, "deep", "registers c91a0eee… on the USDC contract (NEAR Intents deposit address)", { method: "storage_deposit" }),
  e(236, "deep", "sends 3.998958 USDC to the NEAR Intents deposit address c91a0eee…", { method: "ft_transfer" }),
  e(236 + 73, "NEAR Intents solver", "a NEAR Intents solver delivers deep's share as ETH (bought with 3.998958 USDC on NEAR, 311 bps)"),
  e(320, "deep", "wraps 0.006 ETH into WETH"),
  e(332, "deep", "supplies 0.006 WETH to Aave on behalf of position B (4) (top-up)"),
  e(335, KEEPER, "confirms deep's top-up on rescue 8", { method: "confirm_topup" }),
  e(336, KEEPER, "confirms patient's top-up on rescue 8", { method: "confirm_topup" }),
  e(500, "deep", "starts the settlement of rescue 8", { method: "start_settlement" }),
  e(510, "patient", "starts the settlement of rescue 8", { method: "start_settlement", ok: false }),
  e(520, "deep", "repays 30.3 USDC to Aave for position B (4)"),
  e(560, "position B (4)", "withdraws 0.0209 WETH from Aave to deep"),
  e(580, "position B (4)", "withdraws 0.0055 WETH from Aave to patient"),
  e(600, KEEPER, "confirms the buy-back balance held by position 4", { method: "confirm_escrow" }), // closing, after the settlement
];

describe("steward's view", () => {
  const views = rescueViews(trail);
  it("finds each rescue's winners; a steward that bid but never topped up is not one", () => {
    expect(views.map((r) => [r.rescue, r.position, r.pooled, r.stewards.map((s) => s.steward)])).toEqual([
      ["7", "position A (3)", false, ["deep"]],
      ["8", "position B (4)", true, ["deep", "patient"]],
    ]);
  });
  it("single steward, own WETH, bought back: bid, capital, supply, verified top-up, claim, buy-back, exact payout", () => {
    const d = views[0].stewards[0];
    expect([d.premiumBps, d.capital, d.outcome, d.share]).toEqual([150, "own", "bought back", { amount: "0.0115", asset: "WETH" }]);
    expect(d.moves.map((m) => m.kind)).toEqual(["bid", "capital-own", "supply", "verified", "claim", "escrow", "payout"]);
    expect(d.moves[0].title).toBe("Bid won");
    // the claim is minted by the verified reading's transaction
    expect(d.moves[4].tx).toBe(d.moves[3].tx);
    // only the payout to deep, not the borrower's refund
    expect(d.moves.filter((m) => m.kind === "payout").map((m) => m.figure)).toEqual([{ value: "23.67", unit: "USDC" }]);
  });
  it("NEAR Intents capital: 1Click quote, register, USDC sent on NEAR, the solver's delivery (timed), wrap, supply", () => {
    const d = views[1].stewards[0];
    expect([d.capital, d.intentsSeconds]).toEqual(["intents", 73]);
    expect(d.moves.map((m) => m.kind)).toEqual(["bid", "intents-quote", "intents-register", "intents-send", "intents-delivery", "wrap", "supply", "reported", "claim", "settle-start", "settle-repay", "settle-leg"]);
    const del = d.moves.find((m) => m.kind === "intents-delivery")!;
    expect([del.actor, del.figure]).toEqual(["NEAR Intents solver", { value: "73", unit: "s" }]);
    expect(d.moves.find((m) => m.kind === "intents-quote")!.detail).toContain("3.998958 USDC on NEAR, 311 bps");
    expect(d.moves.filter((m) => m.intents).length).toBe(5);
    expect(d.moves[0].title).toBe("Bid filled"); // pooled: not "the lowest"
  });
  it("pooled settlement: the settler's legs and repay; the other owner's refused start and its own leg; a closing escrow is not a buy-back", () => {
    const [d, p] = views[1].stewards;
    expect([d.outcome, p.outcome]).toEqual(["settled", "settled"]);
    expect(p.premiumBps).toBe(268); // its last bid
    expect(p.moves.map((m) => m.kind)).toEqual(["bid", "capital-own", "supply", "reported", "claim", "settle-refused", "settle-leg"]);
    expect(p.moves.find((m) => m.kind === "settle-leg")!.figure).toEqual({ value: "0.0055", unit: "WETH" });
    expect(d.moves.filter((m) => m.kind === "settle-leg").length).toBe(1);
  });
  it("Intents sent but nothing delivered: the steward falls back to its own WETH, and says so", () => {
    const t = trail.filter((x) => !/solver|wraps/.test(x.what));
    const d = rescueViews(t)[1].stewards[0];
    expect(d.capital).toBe("intents-fallback");
    expect(d.moves.map((m) => m.kind).slice(1, 4)).toEqual(["intents-register", "intents-send", "intents-missed"]);
  });
  it("a trail with no rescue (setup, the Intents preflight) has no steward's view", () => {
    expect(rescueViews(trail.filter((x) => !/^bids/.test(x.what)))).toEqual([]);
  });
});

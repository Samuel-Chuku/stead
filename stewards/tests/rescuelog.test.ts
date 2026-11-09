import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildLog, units, type Inputs, type RescueEvent } from "../src/rescuelog.js";

// What the chains recorded for rescue 8 on sepolia-demo (2026-11-07): the contract's EVENT_JSON
// logs, its rescue/claim records and the position's Sepolia transfers, as fetched by
// scripts/rescue-log.ts --raw. Public data only.
const raw: Inputs = JSON.parse(readFileSync(new URL("./fixtures/rescue-8-chain.json", import.meta.url), "utf8"));
const log = buildLog(raw);
const of = <K extends RescueEvent["kind"]>(k: K) => log.events.filter((e) => e.kind === k) as Extract<RescueEvent, { kind: K }>[];

describe("rescue event log from the chain", () => {
  it("formats integer units exactly, never through a float", () => {
    expect(units("865215", 8)).toBe("0.00865215");
    expect(units("524320200000000000000", 18)).toBe("524.3202");
    expect(units("1000000000000000000", 18)).toBe("1");
    expect(units("0", 8)).toBe("0");
  });

  it("starts at the contract's own opening time, on the proven reading that opened it", () => {
    const [trigger] = of("TRIGGER");
    expect(trigger.t).toBe(0);
    expect(trigger.hf).toBeCloseTo(1.139998, 6);
    // the event says "TEMPORARY reporter", but the verified reading with the same HF opened it
    expect(trigger.evidence).toMatchObject({ mark: "proven", block: 12082525, rpcs: 4 });
    expect(of("AUCTION_OPEN")[0]).toMatchObject({ durationS: 45, capBps: 1041, topUp: { asset: "WBTC", amount: "0.00865215" } });
  });

  it("keeps every real bid, in chain order, each with its transaction", () => {
    const bids = of("BID");
    expect(bids.map((b) => [b.steward, b.bps])).toEqual([["swift", 400], ["hedged", 100], ["deep", 150], ["patient", 268]]);
    for (const b of bids) expect(b.evidence.tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(bids.every((b, i) => i === 0 || b.t >= bids[i - 1].t)).toBe(true);
  });

  it("marks the only non-chain events (the 'bidding' cues) as derived, 1.4 s before each bid", () => {
    const cues = of("BIDDING");
    expect(cues).toHaveLength(4);
    for (const c of cues) expect(c.derived).toBe(true);
    const bids = of("BID");
    cues.forEach((c, i) => expect(+(bids[i].t - c.t).toFixed(3)).toBe(1.4));
  });

  it("names the lowest premium the winner and the claim owes exactly the supplied units plus the premium", () => {
    expect(of("AUCTION_CLOSE")[0].winners).toEqual([{ steward: "hedged", bps: 100, amount: "0.00865215" }]);
    const [claim] = of("CLAIM_MINTED");
    expect(claim).toMatchObject({ claim: "3-5-0", holder: "hedged", owed: "0.00865215", premium: "0.00008652", asset: "WBTC" });
    expect(claim.windowEndsT - claim.t).toBeCloseTo(180, 0);
  });

  it("ties the top-up to its Sepolia supply and its proven confirmation", () => {
    const [sent] = of("TOPUP_SENT");
    expect(sent).toMatchObject({ steward: "hedged", amount: "0.00865215", evidence: { chain: "sepolia", block: 12082534 } });
    expect(sent.evidence.tx).toMatch(/^0x7e36f856/);
    expect(of("TOPUP_CONFIRMED")[0]).toMatchObject({ steward: "hedged", evidence: { mark: "proven", block: 12082535 } });
  });

  it("pays the claim owner exactly the committed buy-back and refunds the rest, each with its transfer", () => {
    const [buyback] = of("BUYBACK");
    const payouts = of("PAYOUT");
    const owner = payouts.find((p) => p.purpose === "buyback")!;
    const refund = payouts.find((p) => p.purpose === "refund")!;
    expect(owner.amount).toBe(buyback.amount);
    expect(owner.amount).toBe("524.3202");
    expect(refund.amount).toBe("1");
    expect(of("PAYMENT_IN")[0].amount).toBe("525.3202");
    expect((owner as any).transfer.tx).toMatch(/^0x06de00e9/);
    expect(log.outcome).toBe("bought back");
  });
});

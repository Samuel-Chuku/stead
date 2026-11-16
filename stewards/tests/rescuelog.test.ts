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

describe("a pooled rescue bought back in the claim asset (real rescue 14, sepolia-demo)", () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/rescue-14-chain.json", import.meta.url), "utf8"));
  const log = buildLog(raw);
  const of = (k: string) => log.events.filter((e) => e.kind === k) as any[];
  it("ties each top-up to the steward whose wallet sent it, for its exact share", () => {
    expect(of("TOPUP_SENT").map((e) => [e.steward, e.amount]).sort()).toEqual([["deep", "25"], ["hedged", "25"], ["patient", "13.157771771"]]);
  });
  it("records the buy-back paid in LINK, and each payout in LINK, exactly what its claim was owed", () => {
    const pay = of("PAYMENT_IN");
    expect(pay.map((e) => [e.amount, e.asset])).toEqual([["64.2604000544628", "LINK"]]); // the reset's later DAI repay is not a buy-back
    const owed = Object.fromEntries(of("CLAIM_MINTED").map((c) => [c.claim, Number(c.owed) + Number(c.premium)]));
    for (const p of of("PAYOUT")) {
      expect(p.asset).toBe("LINK");
      expect(Number(p.amount)).toBeCloseTo(owed[p.claim], 12);
      expect(p.transfer?.url).toMatch(/^https:\/\/sepolia\.etherscan\.io\/tx\//);
    }
  });
});

// Rescue 82 on Ethereum mainnet (2026-11-15): pooled (swift and patient), not bought back in time;
// patient started the settlement without the repay in hand, deep took over, repaid the debt and the
// contract paid five legs, each an Aave withdraw the position signed. Public chain data only.
describe("a settlement's takeover, repay and legs, each with its own transaction (rescue 82, mainnet)", () => {
  const raw: Inputs = JSON.parse(readFileSync(new URL("./fixtures/mainnet-rescue-82-chain.json", import.meta.url), "utf8"));
  const log = buildLog(raw);
  const of = (k: string) => log.events.filter((e) => e.kind === k) as any[];
  it("records the takeover: who stalled, who took over, the fee", () => {
    expect(of("SETTLE_TAKEOVER")).toEqual([expect.objectContaining({ from: "patient", to: "deep", fee: "0.000103209768036914", asset: "WETH", evidence: expect.objectContaining({ chain: "near-mainnet" }) })]);
  });
  it("links the repay to the Ethereum transaction that burned the position's debt, and to the contract's record of it", () => {
    const [r] = of("SETTLE_REPAY");
    expect(r).toMatchObject({ steward: "deep", amount: "22.482001", asset: "USDC", evidence: { chain: "ethereum" } });
    expect(r.evidence.tx).toMatch(/^0x6c4b07dd0e/);
    expect(r.near.chain).toBe("near-mainnet");
  });
  it("links every leg to its own withdraw, paid to that leg's recipient (the fee leg pays the taker)", () => {
    const legs = of("SETTLE_LEG");
    expect(legs.map((l) => [l.leg, l.steward, l.purpose, l.amount])).toEqual([
      [0, "swift", "supplied", "0.006"],
      [1, "patient", "supplied", "0.003659920852372862"],
      [2, "deep", "repay", "0.012639646641752305"],
      [3, "swift", "premium", "0.000168"],
      [4, "deep", "fee", "0.000103209768036914"],
    ]);
    expect(new Set(legs.map((l) => l.evidence.tx)).size).toBe(5);
    expect(legs[0].evidence.tx).toMatch(/^0xe55d0e35e6/);
    expect(legs.map((l) => l.to)).toEqual(raw.rescue.settlement!.legs.map((l) => l.to.toLowerCase()));
  });
  it("keeps the late buy-back's refund a payout, never a leg", () => {
    expect(of("PAYOUT").some((p) => p.purpose === "refund" && p.transfer?.tx?.startsWith("0x75a813b1a3"))).toBe(true);
    expect(of("SETTLE_LEG").some((l) => l.evidence.tx.startsWith("0x75a813b1a3"))).toBe(false);
  });
  it("never counts a failed transaction as a leg", () => {
    const failed = { ...raw, sent: raw.sent!.map((x) => (x.tx.startsWith("0xa4cdad20c9") ? { ...x, ok: false } : x)) };
    const legs = buildLog(failed).events.filter((e) => e.kind === "SETTLE_LEG") as any[];
    expect(legs.map((l) => l.leg)).toEqual([0, 2, 3, 4]);
  });
  it("matches a withdraw to a leg by its recipient too: the same amount sent elsewhere is never a leg", () => {
    const real = raw.sent!.find((x) => x.tx.startsWith("0xe55d0e35e6"))!;
    const stranger = "000000000000000000000000" + "de".repeat(20);
    const fake = { ...real, tx: "0x" + "ab".repeat(32), nonce: real.nonce - 1, block: real.block - 1, input: real.input.slice(0, 10 + 128) + stranger };
    const legs = buildLog({ ...raw, sent: [fake, ...raw.sent!] }).events.filter((e) => e.kind === "SETTLE_LEG") as any[];
    expect(legs.find((l) => l.leg === 0).evidence.tx).toBe(real.tx);
    expect(legs.some((l) => l.evidence.tx === fake.tx)).toBe(false);
  });
  it("without the position's transactions, records no leg rather than guessing", () => {
    expect(buildLog({ ...raw, sent: undefined }).events.some((e) => e.kind === "SETTLE_LEG")).toBe(false);
  });
});

// A batched settlement on Sepolia (test contract, 2026-11-15): one Aave withdraw to the position,
// then one transfer per payout covering all of that payout's legs.
describe("a batched settlement: one withdraw, then one transfer per payout", () => {
  const raw: Inputs = JSON.parse(readFileSync(new URL("./fixtures/batched-settlement-chain.json", import.meta.url), "utf8"));
  const legs = buildLog(raw).events.filter((e) => e.kind === "SETTLE_LEG") as any[];
  it("links the withdraw to the position as the batch, and each payout's legs to its one transfer", () => {
    expect(legs.find((l) => l.leg === 0)).toMatchObject({ purpose: "batch", to: raw.position.evm_address.toLowerCase() });
    const byTx = new Map<string, string[]>();
    for (const l of legs.filter((x) => x.purpose !== "batch")) byTx.set(l.evidence.tx, [...(byTx.get(l.evidence.tx) ?? []), `${l.steward}:${l.purpose}`]);
    expect([...byTx.values()].map((v) => v.sort())).toEqual([["patient:premium", "patient:supplied"], ["swift:premium", "swift:supplied"]]);
    expect(legs).toHaveLength(raw.rescue.settlement!.legs.length);
  });
});

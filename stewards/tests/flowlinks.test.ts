// A rescue's flow linked to its transactions from the board's recording (web/src/own/flowlinks.ts),
// and the Positions page's protections (web/src/lists/posflow.ts). Offline: the recordings are the
// files the site ships.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { attachRecorded, txLink, RECORDINGS, recordingFile, recordingNow, type Recording } from "../../web/src/own/flowlinks.js";
import { NETS, rescueFlow, type ClaimView, type RescueView } from "../../web/src/own/net.js";
import { flowMoves } from "../../web/src/own/dashlogic.js";
import { positionProtections, rowOutcome } from "../../web/src/lists/posflow.js";
import type { RescueRow } from "../src/records.js";

const replay = (f: string) => JSON.parse(readFileSync(new URL(`../../web/public/replays/${f}`, import.meta.url), "utf8")) as Recording;
const rec81 = replay("mainnet-rescue-81.json");
const M = NETS.mainnet;
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const T0 = rec81.events.length ? 1794660277683 : 0;
const amount = "9267820696990934";

// rescue 81 as the contract records it: three stewards bid (swift twice), deep wins and is bought back
const r81: RescueView = {
  id: 81,
  position_id: 2,
  state: "bought_back",
  opened_at: ns(T0),
  closes_at: ns(T0 + 120_000),
  topup_units: amount,
  cap_bps: 593,
  bids: [
    { steward: "swift.usestead.near", premium_bps: 400, amount_units: amount, seq: 1 },
    { steward: "deep.usestead.near", premium_bps: 150, amount_units: amount, seq: 2 },
    { steward: "swift.usestead.near", premium_bps: 280, amount_units: amount, seq: 3 },
    { steward: "patient.usestead.near", premium_bps: 253, amount_units: amount, seq: 4 },
  ],
  members: [{ steward: "deep.usestead.near", premium_bps: 150, share_units: amount, confirmed: true, evm_tx: "verified@26413317", claim_id: "2-0-0" }],
  claims_opened_at: ns(T0 + 184_000),
  settlement: null,
};
const claims81: ClaimView[] = [{ token_id: "2-0-0", owner: "deep.usestead.near", owed_units: "9406838007445798", status: "bought_back", opened_at: ns(T0 + 184_000), paid_by_tx: "escrow@26413329" }];
const flow81 = () => rescueFlow(r81, claims81, { coll: M.collateral, debt: M.debt, evmName: M.evmName, evmTx: M.evmTx, evmBlock: M.evmBlock, evmAddress: M.evmAddress });
const linked = () => attachRecorded(flow81(), rec81, "app.usestead.near");
const step = (key: string) => linked().find((s) => s.key === key)!;
const hrefs = (key: string) => (step(key).txs ?? []).map((t) => t.href);

describe("a recorded rescue's steps link to their transactions", () => {
  it("each bid links that steward's own bid, in the order it sent them", () => {
    expect(hrefs("bid:81:swift.usestead.near:1")).toEqual(["https://nearblocks.io/txns/E29rEu9zqE7sQszgEu7uAUaiWcoUWZhYvhP8a5HLYmMA"]);
    expect(hrefs("bid:81:swift.usestead.near:3")).toEqual(["https://nearblocks.io/txns/BJH6QJbRwyKUo2gUuZRGfVT4K7u6gaHnvMGVqLLfLza6"]);
    expect(hrefs("bid:81:deep.usestead.near:2")).toEqual(["https://nearblocks.io/txns/3sFLqnMa1FVKNnfj5zExhJZ9EbZnj2N6uK7gwE21Z9Lu"]);
    expect(hrefs("bid:81:patient.usestead.near:4")).toEqual(["https://nearblocks.io/txns/226pDQSTHLobEqjSsVcDrmdFwofAG8T4tNWKeRQ7eu4r"]);
    expect(step("bid:81:deep.usestead.near:2").txs![0].label).toBe("NearBlocks");
  });
  it("a steward's bid the contract kept (its latest) links that bid, not its first", () => {
    const r = { ...r81, bids: r81.bids.filter((b) => b.seq !== 1) };
    const f = attachRecorded(rescueFlow(r, claims81, { coll: M.collateral, evmName: M.evmName }), rec81, "app.usestead.near");
    expect(f.find((s) => s.key === "bid:81:swift.usestead.near:3")!.txs![0].ref).toBe("BJH6QJbRwyKUo2gUuZRGfVT4K7u6gaHnvMGVqLLfLza6");
  });
  it("the auction's open and close link their NEAR transactions", () => {
    expect(hrefs("open:81")).toEqual(["https://nearblocks.io/txns/HFpBeiKBQfPmgVZtwrTw3YWww7Txd9GPfP81aVxiivok"]);
    expect(hrefs("close:81")).toEqual(["https://nearblocks.io/txns/4rT3AtTRq9mkT1CyJJV5SxJus7vvTUUGeMheMZdd4YC7"]);
  });
  it("the proof links the verified read; the claim links the transaction that minted it", () => {
    expect(hrefs("proven:81:deep.usestead.near")).toEqual(["https://nearblocks.io/txns/6Xt4psYmjb1tSh8d95FvQrgXGQP3fTN2R1oGnCD6Ugz6"]);
    expect(hrefs("claim:2-0-0")).toEqual(["https://nearblocks.io/txns/6Xt4psYmjb1tSh8d95FvQrgXGQP3fTN2R1oGnCD6Ugz6"]);
  });
  it("the buy-back links the borrower's Ethereum transfer and its proof; the payout the pay call and the transfer", () => {
    const esc = step("escrow:2-0-0").txs!;
    expect(esc.map((t) => [t.label, t.ref])).toEqual([
      ["Etherscan", "0x549c293ee072211154e9090d2b2ee6f4eabdb4d01ddf50b0ebddcbff54345173"],
      ["NearBlocks", "HvpHzHzV5QjBJnyrunZaf666VGcFMTSetgGysWacybAA"],
    ]);
    expect(hrefs("payout:2-0-0")).toEqual(["https://nearblocks.io/txns/8FzY7znBwmN9NWxusSBYNtT8Crt4RnQHCkvk4baoDPpi", "https://etherscan.io/tx/0xe5212b4c3c2e9a03c46de534f3c86e3e4679cdbf79c2008b122c9a9e518749d8"]);
    expect(hrefs("bought:81")).toEqual(["https://nearblocks.io/txns/HvpHzHzV5QjBJnyrunZaf666VGcFMTSetgGysWacybAA"]);
  });
  it("a top-up links the steward's supply on Etherscan", () => {
    const r = { ...r81, members: [{ ...r81.members[0], evm_tx: "0xe2f3616f2d23ba27770acab6d0bb8d5b3f180724261c37043217b8484babf6b4" }] };
    const f = attachRecorded(rescueFlow(r, claims81, { coll: M.collateral, evmName: M.evmName, evmTx: M.evmTx }), rec81, "app.usestead.near");
    const top = f.find((s) => s.kind === "topup")!;
    expect(top.txs).toEqual([{ href: "https://etherscan.io/tx/0xe2f3616f2d23ba27770acab6d0bb8d5b3f180724261c37043217b8484babf6b4", label: "Etherscan", ref: "0xe2f3616f2d23ba27770acab6d0bb8d5b3f180724261c37043217b8484babf6b4" }]);
  });
  it("a settled recording links the settlement's start and end", () => {
    const rec78 = replay("mainnet-rescue-78.json");
    const r78: RescueView = { ...r81, id: 78, position_id: 0, state: "settled", settlement: { started_at: ns(T0 + 400_000), legs: [] }, members: [{ ...r81.members[0], claim_id: "0-78-0" }] };
    const f = attachRecorded(rescueFlow(r78, [{ ...claims81[0], token_id: "0-78-0", status: "settled" }], { coll: M.collateral, evmName: M.evmName }), rec78, "app.usestead.near");
    expect(f.find((s) => s.kind === "settle")!.txs![0].ref).toBe("76d3fkTHNzT48atYJ1FSsneJFxjWfvWHFXw4rU6rzHk5");
    expect(f.find((s) => s.kind === "settled")!.txs![0].ref).toBe("89krk7CSYWuGpyocbdLom351T1XebR3MYVDCJUz1p9xF");
    expect(f.find((s) => s.kind === "claim")!.txs![0].ref).toBe("FbRYxAihJN3T74CoAnpKeySFNxn14m1Q5KYCK4kgRapD");
  });
  it("a recording of another rescue or another contract adds nothing", () => {
    expect(attachRecorded(flow81(), { ...rec81, rescueId: 80 }, "app.usestead.near").some((s) => s.txs)).toBe(false);
    expect(attachRecorded(flow81(), rec81, "sepolia-demo.steadfi.testnet").some((s) => s.txs)).toBe(false);
    expect(attachRecorded(flow81(), null, "app.usestead.near")).toEqual(flow81());
  });
  it("links go only to the two explorers, over https", () => {
    expect(txLink({ tx: "a", url: "https://evil.example/txns/a" })).toBeNull();
    expect(txLink({ tx: "a", url: "http://nearblocks.io/txns/a" })).toBeNull();
    expect(txLink({ tx: "a" })).toBeNull();
    expect(txLink({ tx: "a", url: "https://testnet.nearblocks.io/txns/a" })?.label).toBe("NearBlocks");
    expect(txLink({ tx: "0x1", url: "https://sepolia.etherscan.io/tx/0x1" })?.label).toBe("Etherscan");
  });
  it("the timeline shows each linked step on chain, not as a bare contract record; the proof keeps its block", () => {
    const moves = flowMoves(linked());
    const bid = moves.find((m) => m.title === "deep bids")!;
    expect(bid.note).toBeUndefined();
    expect(bid.confirmed).toBe(true);
    expect(bid.chain).toBe("near-mainnet");
    expect(bid.links).toEqual([{ href: "https://nearblocks.io/txns/3sFLqnMa1FVKNnfj5zExhJZ9EbZnj2N6uK7gwE21Z9Lu", label: "NearBlocks" }]);
    const proven = moves.find((m) => m.title === "Top-up proven")!;
    expect(proven.links!.map((l) => l.href)).toEqual(["https://nearblocks.io/txns/6Xt4psYmjb1tSh8d95FvQrgXGQP3fTN2R1oGnCD6Ugz6", "https://etherscan.io/block/26413317"]);
    // with no recording, the same step stays a contract record
    expect(flowMoves(flow81()).find((m) => m.title === "deep bids")!.note).toBe("contract record");
  });
  it("every listed recording is the rescue it says it is", () => {
    for (const r of RECORDINGS) {
      const j = replay(r.file);
      expect([j.contract, j.rescueId]).toEqual([r.contract, r.rescueId]);
    }
    expect(recordingFile("app.usestead.near", 80)).toBeNull();
  });
});

describe("a position's protections on the Positions page", () => {
  const row = (o: Partial<RescueRow>): RescueRow => ({ key: "", contract: "c", id: 1, positionId: 2, pair: "WETH/USDC", chain: "Ethereum", state: "bought_back", openedAtMs: 0, topUp: "1", asset: "WETH", topUpUsd: 0, capBps: 500, bids: 2, winners: [{ steward: "deep", bps: 150, share: "0.5" }], premiumUsd: 0, claims: [], ...o });
  it("lists only that position's rescues on that contract, newest first, the no-bid ones apart", () => {
    const rs = [row({ id: 3 }), row({ id: 9, state: "settled" }), row({ id: 5, positionId: 7 }), row({ id: 6, contract: "other" }), row({ id: 8, state: "failed", bids: 0, winners: [] })];
    const p = positionProtections(rs, { contract: "c", id: 2 });
    expect(p.rows.map((x) => x.id)).toEqual([9, 3]);
    expect(p.noBids.map((x) => x.id)).toEqual([8]);
    expect(p.rows[0].chip).toBe("Settled");
    expect(p.rows[1].topUp).toBe("0.5");
  });
  it("names how each rescue ended, or its stage", () => {
    expect(rowOutcome(row({ state: "failed", bids: 3, winners: [] }))).toBe("failed");
    expect(rowOutcome(row({ state: "failed", bids: 0, winners: [] }))).toBe("no_bids");
    expect(rowOutcome(row({ state: "open" }))).toBe("running");
    expect(positionProtections([row({ state: "top_up_pending" })], { contract: "c", id: 2 }).rows[0].chip).toBe("topping up");
  });
});

describe("a recorded settlement on the timeline (rescue 82, mainnet)", async () => {
  const { buildLog } = await import("../src/rescuelog.js");
  const raw = JSON.parse(readFileSync(new URL("./fixtures/mainnet-rescue-82-chain.json", import.meta.url), "utf8"));
  const rec = buildLog(raw) as unknown as Recording;
  const claims: ClaimView[] = raw.claims.map((c: any) => ({ ...c, status: "settled" }));
  const flow = attachRecorded(rescueFlow({ ...raw.rescue, state: "settled" } as RescueView, claims, { coll: M.collateral, debt: M.debt, evmName: M.evmName, evmTx: M.evmTx, evmBlock: M.evmBlock, evmAddress: M.evmAddress }), rec, "app.usestead.near");
  const at = (key: string) => flow.find((s) => s.key === key)!;
  it("links each leg to its own withdraw on Etherscan, at its recorded time", () => {
    const legs = flow.filter((s) => s.kind === "leg");
    expect(legs).toHaveLength(5);
    for (const l of legs) {
      expect(l.txs?.[0]?.label).toBe("Etherscan");
      expect(l.exactMs).not.toBeNull();
    }
    expect(at("leg:82:0").txs![0].ref).toMatch(/^0xe55d0e35e6/);
    expect(new Set(legs.map((l) => l.txs![0].ref)).size).toBe(5);
  });
  it("names the fee leg's real recipient (the steward that took over)", () => {
    expect(at("leg:82:4").title).toBe("WETH paid to deep");
    expect(at("leg:82:4").text).toContain("takeover fee, from patient's premium");
  });
  it("links the repay to Ethereum and NEAR, and shows the takeover as its own step after the start", () => {
    expect(at("repay:82").txs!.map((t) => t.label)).toEqual(["Etherscan", "NearBlocks"]);
    const i = flow.findIndex((s) => s.kind === "settle");
    expect(flow[i + 1]).toMatchObject({ kind: "takeover", actor: "deep", title: "Settlement taken over" });
    expect(flow[i + 1].txs![0].label).toBe("NearBlocks");
  });
  it("names who started the settlement and what each steward was really paid", () => {
    expect(at("settle:82").actor).toBe("patient");
    expect(at("settled:82").text).toBe("Every leg landed: swift paid 0.006168 WETH in all, patient paid 0.00366 WETH in all, deep paid 0.012743 WETH in all. The claim is closed.");
  });
  it("every step of the settlement is on chain in the timeline (no contract-record step left)", () => {
    const moves = flowMoves(flow.filter((s) => ["settle", "takeover", "repay", "leg", "settled"].includes(s.kind)));
    expect(moves.filter((m) => m.note === "contract record")).toEqual([]);
  });
});

// A dashboard opened while the rescue ran asks for the recording before it exists; it must keep
// asking and redraw with the transactions linked once the recording is written (rescue 83: the
// payout to deep showed without its Etherscan link because the first miss was kept for good).
describe("a recording that appears after the page asked", () => {
  it("is picked up within a minute and redraws once", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { hostname: "app.usestead.xyz" }); // the site's feed URL
    try {
      let written = false;
      const rec = { contract: "test.near", rescueId: 7, events: [{ t: 0, kind: "TRIGGER" }] };
      const fetcher = (async () => (written ? { ok: true, json: async () => rec } : { ok: false, json: async () => null })) as unknown as typeof fetch;
      let redraws = 0;
      expect(recordingNow("test.near", 7, () => redraws++, fetcher)).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recordingNow("test.near", 7, () => redraws++, fetcher)).toBeNull(); // still not written
      written = true;
      await vi.advanceTimersByTimeAsync(61_000); // the miss expires; the next render asks again
      recordingNow("test.near", 7, () => redraws++, fetcher);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(recordingNow("test.near", 7, () => redraws++, fetcher)).toMatchObject({ rescueId: 7 });
      expect(redraws).toBe(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

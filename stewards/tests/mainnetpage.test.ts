// The On mainnet page's list of real rescues, read from the contract (web/src/mainnet/chainruns.ts):
// which rescues still need reading, how the list splits, the header's totals, the proof blocks that
// time the flow, and the link from a contract row to a checked trail. Built on rescue 78 as
// app.usestead.near returned it, varied into the other rescues the contract holds.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chainRuns, claimIdsOf, proofBlocks, readFrom, trailRescueIds } from "../../web/src/mainnet/chainruns.js";
import type { ClaimView, RescueView } from "../../web/src/own/net.js";

const F78 = JSON.parse(readFileSync(new URL("./fixtures/mainnet-rescue-78.json", import.meta.url), "utf8")) as { rescue: RescueView; claims: ClaimView[] };
const R78 = F78.rescue;
const C78 = F78.claims;
const at = (id: number) => String(BigInt(R78.opened_at) + BigInt(id - 78) * 60_000_000_000n);
const noBid = (id: number): RescueView => ({ ...R78, id, position_id: 0, opened_at: at(id), state: "failed", bids: [], members: [], settlement: null });
// rescues 0 and 1: bids for the whole top-up, no top-up proven (the contract keeps no member)
const missed = (id: number): RescueView => ({ ...noBid(id), bids: R78.bids.slice(0, 2) });
const bought = (id: number, pos: number, block: number): RescueView => ({
  ...R78,
  id,
  position_id: pos,
  opened_at: at(id),
  state: "bought_back",
  settlement: null,
  members: [{ ...R78.members[0], evm_tx: `verified@${block}`, claim_id: `${pos}-${id}-0` }],
});
// the contract's list as it stands: 0 and 1 missed, 2..77 no bid, 78 settled, 79 missed, 80 and 81 bought back
const ALL: RescueView[] = [missed(0), missed(1), ...Array.from({ length: 76 }, (_, k) => noBid(k + 2)), R78, missed(79), bought(80, 1, 26413001), bought(81, 2, 26413317)];

describe("the contract's real rescues", () => {
  it("splits the list: rescues that reached a top-up, newest first, with their position; bids with no proven top-up apart; no-bid ones only counted", () => {
    const v = chainRuns(ALL);
    expect(v.real.map((x) => [x.id, x.positionId, x.outcome])).toEqual([[81, 2, "bought_back"], [80, 1, "bought_back"], [78, 0, "settled"]]);
    expect(v.failed.map((x) => [x.id, x.covered, x.bids])).toEqual([[79, true, 2], [1, true, 2], [0, true, 2]]);
    expect(v.noBids).toBe(76);
    expect(v.positions).toEqual([0, 1, 2]);
  });
  it("each row: the winner and its premium, the WETH topped up, when the auction opened", () => {
    const r = chainRuns(ALL).real.find((x) => x.id === 78)!;
    expect(r.winners).toEqual([{ steward: "deep.usestead.near", name: "deep", bps: 150, units: "12384387129772345" }]);
    expect(r.topupUnits).toBe("12384387129772345");
    expect(r.openedMs).toBe(Number(BigInt(R78.opened_at) / 1_000_000n));
  });
  it("the header's totals: how many real rescues, and how they ended", () => {
    const v = chainRuns(ALL);
    expect(v.headline).toBe("3 real rescues on Ethereum mainnet");
    expect(v.tally).toBe("2 bought back · 1 settled");
    const one = chainRuns([R78]);
    expect([one.headline, one.tally]).toEqual(["1 real rescue on Ethereum mainnet", "1 settled"]);
    // a rescue still running counts, first, in its own words
    const running = chainRuns([...ALL, { ...R78, id: 82, position_id: 3, state: "open", settlement: null }]);
    expect(running.tally).toBe("1 running · 2 bought back · 1 settled");
    expect(running.real[0]).toMatchObject({ id: 82, stage: "claim open", positionId: 3 });
  });
  it("with nothing that reached a top-up, it says so rather than inventing a count", () => {
    const v = chainRuns([missed(0), noBid(2)]);
    expect(v.real).toEqual([]);
    expect(v.headline).toBe("No rescue has run on Ethereum mainnet yet");
    expect(v.tally).toBe("");
    expect(v.failed.map((x) => x.id)).toEqual([0]);
  });
});

describe("reading gently from rate-limited RPCs", () => {
  const held = (rs: RescueView[]) => new Map(rs.map((r) => [r.id, r]));
  it("starts after the run of finished rescues it already holds; a running one is read again", () => {
    expect(readFrom(new Map())).toBe(0);
    expect(readFrom(held(ALL))).toBe(82);
    expect(readFrom(held([...ALL.slice(0, 78), { ...R78, state: "settling" }, ...ALL.slice(79)]))).toBe(78);
    // a gap (a rescue not held) is read from there
    expect(readFrom(held(ALL.filter((r) => r.id !== 40)))).toBe(40);
  });
  it("reads only the claims the winners were minted", () => {
    expect(claimIdsOf(R78)).toEqual(["0-78-0"]);
    expect(claimIdsOf(missed(0))).toEqual([]);
  });
  it("the Ethereum blocks that time the proven steps: the top-up's verified read and the buy-back payment's", () => {
    expect(proofBlocks(R78, C78)).toEqual([26411620]);
    const b = bought(80, 1, 26413001);
    expect(proofBlocks(b, [{ ...C78[0], token_id: "1-80-0", status: "bought_back", paid_by_tx: "escrow@26413100" }])).toEqual([26413001, 26413100]);
    expect(proofBlocks({ ...R78, members: [{ ...R78.members[0], evm_tx: "0xabc" }] }, [])).toEqual([]);
  });
});

describe("a checked trail beside the contract's list", () => {
  it("names the run and rescue a contract row was recorded in; none without trails", () => {
    const m = trailRescueIds([{ rescues: [{ rescue: "78" }] }, { rescues: [{ rescue: "80" }, { rescue: "x" }] }, {}]);
    expect([...m]).toEqual([[78, { run: 0, rescue: 0 }], [80, { run: 1, rescue: 0 }]]);
    expect(trailRescueIds(null).size).toBe(0);
  });
});

describe("copy", () => {
  it("no emoji-capable glyphs and no internal labels in the On mainnet page's modules", () => {
    for (const f of ["../../web/src/mainnet/chainruns.ts", "../../web/src/mainnet/chainlist.ts", "../../web/src/mainnet/runs.ts", "../../web/src/mainnet/page.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      // runs.ts strips the trails' arrows, so it names one
      if (!f.endsWith("runs.ts") || f.endsWith("chainruns.ts")) expect(src, f).not.toMatch(/[←-⇿☀-➿\u{1F000}-\u{1FFFF}]/u);
      expect(src, f).not.toMatch(/Gate ?[0-9]|\bD[0-9]{1,2}\b|SPEC §|planned/i);
    }
  });
});

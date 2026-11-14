// The board's control bar (Watch menu groups, the one market chip), the list pages' network switch,
// the one token-amount formatter, and the mainnet rescue recordings the board replays: what each
// shows, pinned so a regression fails here.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RescueLog } from "../src/rescuelog.js";
import { recordingChains } from "../src/recorder.js";
import { buildRecords, type MarketRec } from "../src/records.js";
import { evmName, marketChip, replayGroups, type Recording } from "../../web/src/board/controls.js";
import { boardAt, fmtAmt } from "../../web/src/board/model.js";
import { listNet, symbolOf } from "../../web/src/lists/mainnet.js";
import { pageHref } from "../../web/src/lists/pages.js";

const replay = (f: string): RescueLog => JSON.parse(readFileSync(new URL(`../../web/public/replays/${f}`, import.meta.url), "utf8"));

describe("Watch menu", () => {
  const list: Recording[] = [
    { id: "8", label: "Rescue 8", url: "", net: "testnet" },
    { id: "mainnet-81", label: "Rescue 81 · bought back", url: "", net: "mainnet" },
    { id: "10", label: "Rescue 10 · pooled", url: "", net: "testnet" },
    { id: "mainnet-78", label: "Rescue 78 · settled", url: "", net: "mainnet" },
  ];
  it("puts real funds first, then Sepolia, each group in its own order", () => {
    const g = replayGroups(list);
    expect(g.map((x) => x.label)).toEqual(["Ethereum mainnet (real funds)", "Sepolia"]);
    expect(g[0].items.map((x) => x.id)).toEqual(["mainnet-81", "mainnet-78"]);
    expect(g[1].items.map((x) => x.id)).toEqual(["8", "10"]);
  });
  it("drops an empty group and treats an unlabelled recording as testnet", () => {
    const g = replayGroups([{ id: "8", label: "Rescue 8" }]);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("Sepolia");
  });
});

describe("market chip", () => {
  it("names Ethereum mainnet for a real-funds recording and Sepolia's market otherwise", () => {
    expect(marketChip(replay("mainnet-rescue-81.json"))).toBe("ETHEREUM MAINNET · WETH/USDC");
    const s = replay("sepolia-demo-rescue-8.json");
    expect(marketChip(s)).toBe(`SEPOLIA · MARKET ${s.market.id} · ${s.market.collateral}/${s.market.debt}`);
    expect(evmName("ethereum")).toBe("Ethereum");
    expect(evmName("sepolia")).toBe("Sepolia");
  });
});

describe("token amounts", () => {
  it("never prints a raw 18-decimal string", () => {
    expect(fmtAmt("19.269960139721666667")).toBe("19.27");
    expect(fmtAmt("0.009406838007445798")).toBe("0.00940684");
    expect(fmtAmt("0.000000001")).toBe("0.000000001");
    expect(fmtAmt("1234.5")).toBe("1,234.50");
    expect(fmtAmt("0")).toBe("0");
    expect(fmtAmt("")).toBe("");
  });
  it("the board's buy-back and payout lines use it", () => {
    const log = replay("mainnet-rescue-81.json");
    const text = boardAt(log, 1e9).journal.map((l) => l.text).join("\n");
    expect(text).not.toMatch(/\d\.0*[1-9]\d{6,}/); // never more than 6 significant decimals
    expect(text).toMatch(/0\.00940684 WETH/);
  });
});

describe("list pages' network", () => {
  it("defaults to testnet; ?net= wins over this tab's last choice", () => {
    expect(listNet("", null)).toBe("testnet");
    expect(listNet("", "mainnet")).toBe("mainnet");
    expect(listNet("?net=mainnet", null)).toBe("mainnet");
    expect(listNet("?net=testnet", "mainnet")).toBe("testnet");
    expect(listNet("?net=bogus", null)).toBe("testnet");
  });
  it("names the mainnet market's tokens from the app's addresses", () => {
    expect(symbolOf("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2")).toBe("WETH");
    expect(symbolOf("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toBe("USDC");
  });
  it("builds mainnet rows on Ethereum with the shared builder, and a recorded one opens its replay", () => {
    const f = JSON.parse(readFileSync(new URL("./fixtures/mainnet-rescue-78.json", import.meta.url), "utf8"));
    const market: MarketRec = { id: 0, chainId: 1, collateral: "0xc02a", debt: "0xa0b8", cDec: 18, dDec: 6, cSym: "WETH", dSym: "USDC" };
    const pos = { id: 0, owner: "borrower.usestead.near", market_id: 0, active_auction: null, open_rescues: [], health: null } as any;
    const rec = buildRecords([{ contract: "app.usestead.near", positions: [pos], rescues: [f.rescue], claims: [], markets: [market], stewards: [] }]);
    expect(rec.rescues[0].chain).toBe("Ethereum");
    expect(rec.rescues[0].asset).toBe("WETH");
    expect(rec.positions[0].chain).toBe("Ethereum");
    expect(pageHref("app.usestead.near", 81)).toBe("?replay=mainnet-81#/live");
    expect(pageHref("sepolia-demo.steadfi.testnet", 8)).toBe("?rescue=sepolia-demo:8#/rescues");
  });
});

describe("mainnet recordings", () => {
  it("a .near contract on chain 1 is real funds on NEAR mainnet and Ethereum", () => {
    expect(recordingChains("app.usestead.near", 1)).toMatchObject({ nearNetwork: "mainnet", evmChain: "ethereum" });
    expect(recordingChains("app.usestead.near", 1).label).toMatch(/^Real funds/);
    expect(recordingChains("sepolia-demo.steadfi.testnet", 11155111)).toMatchObject({ nearNetwork: "testnet", evmChain: "sepolia", label: "Recorded on NEAR testnet and Sepolia" });
    expect(recordingChains("steadfi.testnet", 31337).evmChain).toBe("fork");
  });
  for (const [f, outcome] of [["mainnet-rescue-81.json", "bought back"], ["mainnet-rescue-78.json", "settled"]] as const) {
    it(`${f}: every event links to nearblocks.io or etherscan.io, never a testnet explorer`, () => {
      const log = replay(f);
      expect(log.nearNetwork).toBe("mainnet");
      expect(log.evmChain).toBe("ethereum");
      expect(log.contract).toBe("app.usestead.near");
      expect(log.label).toMatch(/^Real funds/);
      expect(log.outcome).toBe(outcome);
      const urls = log.events.flatMap((e: any) => [e.evidence?.url, e.transfer?.url]).filter(Boolean) as string[];
      expect(urls.length).toBeGreaterThan(10);
      for (const u of urls) expect(u).toMatch(/^https:\/\/(nearblocks\.io\/txns\/|etherscan\.io\/tx\/0x)/);
    });
  }
  it("rescue 81 mid-auction: deep leads at 150 bps, the chip says Ethereum mainnet", () => {
    const log = replay("mainnet-rescue-81.json");
    const b = boardAt(log, 40);
    expect(b.lamps.AUCTION).toBe(true);
    const lead = b.rows.find((r) => r.rank === 0)!; // rank 0 leads
    expect(lead.steward).toBe("deep");
    expect(lead.bps).toBe(150);
    const close = log.events.find((e) => e.kind === "AUCTION_CLOSE") as any;
    expect(close.winners).toEqual([expect.objectContaining({ steward: "deep", bps: 150 })]);
  });
});

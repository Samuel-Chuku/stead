import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { CostPath } from "../src/costpath.js";
import type { RescueLog } from "../src/rescuelog.js";
import { render } from "../../web/src/rescue/page.js";

// The rescue page as rendered from the shipped replay and price path (no browser needed).
const dir = new URL("../../web/public/replays/", import.meta.url);
const log: RescueLog = JSON.parse(readFileSync(new URL("sepolia-demo-rescue-8.json", dir), "utf8"));
const path: CostPath = JSON.parse(readFileSync(new URL("sepolia-demo-rescue-8-path.json", dir), "utf8"));
const html = render(log, path);

describe("rescue page", () => {
  it("renders every value (no undefined, NaN or empty amounts)", () => {
    expect(html).not.toMatch(/undefined|NaN|Infinity|\$-|null/);
  });

  it("sets only numbers in Big Shoulders (no word inside .st-num)", () => {
    const nums = [...html.matchAll(/<span class="st-num">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(nums.length).toBeGreaterThan(5);
    for (const n of nums) expect(n).toMatch(/^[#$0-9.,:–\- ]+$/);
  });

  it("links every proof row to a real record on NearBlocks or Etherscan", () => {
    const table = html.slice(html.indexOf('class="st-proofs"'), html.indexOf("</table>", html.indexOf('class="st-proofs"')));
    const rows = table.split("<tr>").slice(2);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const r of rows) expect(r).toMatch(/href="https:\/\/(testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}|sepolia\.etherscan\.io\/tx\/0x[0-9a-f]{64})"/);
  });

  it("states the counterfactual price path plainly and shows the chain's numbers", () => {
    expect(html).toContain("fixed at $60,000");
    expect(html).toContain("BTC/USDT hourly closes");
    expect(html).toContain("524.3202 DAI");
    expect(html).toContain("0.00865215 + 0.00008652 WBTC");
    expect(html).toContain("$49–103");
  });

  it("does not show a closed claim in amber", () => {
    expect(html).toMatch(/st-tag st-tag--xl st-cut st-cut--xl is-closed/);
    expect(html).not.toContain("st-chip--open");
  });
});

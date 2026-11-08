// npx tsx scripts/evidence.ts [--no-live] [--no-sweep] : the evidence harness. Writes ../evidence/.
//
//  1. Borrower replay: real 2026 hourly prices (LINK, BTC, ETH), one position a day touching Stead's
//     trigger, followed with and without Stead (model: src/evidence.ts). Aave's liquidation
//     threshold and bonus are read from the Aave V3 Ethereum Pool (read-only).
//  2. Steward replay: hedged vs unhedged steward PnL on the same paths (scripts/replay.ts).
//  3. Stress sweep: the contract crate's random-path and latency sweeps, when its tests are present.
//  4. Live runs: every recorded transaction in evidence/live-runs.json, re-read on chain.
// Read-only throughout: public market data and RPC reads, no account, no transaction.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { mainnet } from "viem/chains";
import { REPO } from "../src/config.js";
import { replayPath, summarize, STEAD_PARAMS, type PathResult, type Reserve } from "../src/evidence.js";

const OUT = join(REPO, "evidence");
const DATA = join(OUT, "data");
const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2026, 10, 6);
const args = new Set(process.argv.slice(2));
/** How long each position is followed: the buy-back window alone, and a week. */
const HORIZONS = [24, 168];

// Aave V3 Ethereum (bgd-labs address book); token addresses: the canonical mainnet tokens.
const POOL: Address = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ASSETS = [
  { sym: "LINK", pair: "LINKUSDT", token: "0x514910771AF9Ca656af840dff83E8264EcF986CA" as Address },
  { sym: "BTC", pair: "BTCUSDT", token: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as Address }, // WBTC
  { sym: "ETH", pair: "ETHUSDT", token: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address }, // WETH
];

/** Liquidation threshold and bonus from the reserve's configuration bitmap (bits 16–31, 32–47). */
async function reserves(): Promise<Record<string, Reserve & { from: string }>> {
  const cache = join(DATA, "aave-reserves.json");
  try {
    const c = createPublicClient({ chain: mainnet, transport: http(process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com") });
    const abi = parseAbi(["function getConfiguration(address) view returns ((uint256 data))"]);
    const out: Record<string, Reserve & { from: string }> = {};
    const block = await c.getBlockNumber();
    for (const a of ASSETS) {
      const { data } = await c.readContract({ address: POOL, abi, functionName: "getConfiguration", args: [a.token] });
      const lt = Number((data >> 16n) & 0xffffn) / 10_000;
      const bonus = Number((data >> 32n) & 0xffffn) / 10_000 - 1;
      out[a.sym] = { lt, bonus, from: `Aave V3 Ethereum Pool, block ${block}` };
    }
    writeFileSync(cache, JSON.stringify(out, null, 1));
    return out;
  } catch (e) {
    if (!existsSync(cache)) throw e;
    console.log(`(mainnet read failed, using cached reserve parameters: ${(e as Error).message.split("\n")[0]})`);
    return JSON.parse(readFileSync(cache, "utf8"));
  }
}

const usd = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)} %` : "-");

async function borrowerReplay(): Promise<string> {
  const res = await reserves();
  const lines = [
    "| Asset | Followed for | LT / bonus | Days | Rescued | Liquidated without Stead | Liquidated with Stead | Early settlements | Mean premium | Mean cost without / with | Worst without / with | Stead saved a liquidation | Stead cost more | Rule violations |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const all: Record<string, unknown> = {};
  let violations = 0;
  for (const a of ASSETS) {
    const f = join(DATA, `${a.pair}-1h.json`);
    if (!existsSync(f)) throw new Error(`missing ${f}: run scripts/replay.ts once to fetch the price data`);
    const px: [number, number][] = JSON.parse(readFileSync(f, "utf8"));
    const r = res[a.sym];
    for (const horizonH of HORIZONS) {
    const rows: PathResult[] = [];
    for (let i = 0; i < px.length; i++) {
      const [t] = px[i];
      if (t < START || t >= END || new Date(t).getUTCHours() !== 0) continue;
      if (i + STEAD_PARAMS.windowH >= px.length) break;
      rows.push(replayPath(px, i, r, { ...STEAD_PARAMS, horizonH }));
    }
    const s = summarize(rows);
    violations += s.violations;
    all[`${a.sym}-${horizonH}h`] = { reserve: r, horizonH, summary: s };
    writeFileSync(
      join(OUT, `borrower-${a.sym}-${horizonH}h.csv`),
      "day,exit,exit_hours,later_liquidated,move,premium_bps,fills,cap_bps,baseline_usd,cost_without_usd,cost_with_usd,i1,i2\n" +
        rows
          .map((x) => [new Date(x.start).toISOString().slice(0, 10), x.exit, x.exitHours, x.laterLiquidated, x.move.toFixed(5), x.premiumBps.toFixed(1), x.fills.map((f) => `${f.steward}:${f.bps}@${(f.share * 100).toFixed(0)}%`).join(" "), x.capBps, x.baselineUsd.toFixed(2), x.costWithoutUsd.toFixed(2), x.costWithUsd.toFixed(2), x.i1, x.i2].join(","))
          .join("\n") +
        "\n",
    );
    lines.push(
      `| ${a.sym} | ${horizonH === 24 ? "24 h" : `${horizonH / 24} days`} | ${(r.lt * 100).toFixed(1)} % / ${(r.bonus * 100).toFixed(1)} % | ${s.paths} | ${s.rescued} | ${s.liquidatedWithout} | ${s.liquidatedWith} | ${s.early} | ${s.meanPremiumBps.toFixed(0)} bps | ${usd(s.meanCostWithout)} / ${usd(s.meanCostWith)} | ${usd(s.worstWithout)} / ${usd(s.worstWith)} | ${s.saved} (saved ${usd(s.meanSavedWhenSaved)} each) | ${s.costMore} (${usd(s.meanExtraWhenMore)} each) | ${s.violations} |`,
    );
    }
  }
  writeFileSync(join(OUT, "borrower.json"), JSON.stringify({ at: new Date().toISOString(), replay: true, params: STEAD_PARAMS, debtUsd: 10_000, assets: all }, null, 1));
  if (violations) process.exitCode = 1;
  return lines.join("\n");
}

function stewardReplay(): string {
  execFileSync("npx", ["tsx", "scripts/replay.ts"], { cwd: join(REPO, "stewards"), stdio: "inherit" });
  const md = readFileSync(join(OUT, "steward-replay.md"), "utf8");
  return md.split("\n").filter((l) => l.startsWith("|")).join("\n");
}

function stressSweep(): string {
  const t = join(REPO, "contract", "core", "tests", "invariant.rs");
  if (!existsSync(t)) return "_The contract's test files are not in this checkout; run `cargo test --test invariant -- --nocapture` in `contract/core` where they are._";
  const out = execFileSync("cargo", ["test", "--release", "--test", "invariant", "--", "--nocapture", "--test-threads=1"], { cwd: join(REPO, "contract", "core"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // internal decision labels are not part of the published evidence
  const clean = out.replace(/\bD\d{1,2}(\.\d)?\s+/g, "").replace(/\bSPEC example\b/g, "Worked example");
  writeFileSync(join(OUT, "stress-sweep.txt"), clean);
  return "```\n" + clean.split("\n").filter((l) => !/^(running|test |\s*Finished|\s*Running|ok|$)/.test(l)).join("\n").trim() + "\n```";
}

async function rpc(url: string, method: string, params: unknown): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}

async function liveRuns(): Promise<string> {
  const list: { run: string; step: string; chain: string; tx: string; signer?: string }[] = JSON.parse(readFileSync(join(OUT, "live-runs.json"), "utf8"));
  const lines = ["| Run | Step | Transaction | On chain |", "|---|---|---|---|"];
  for (const x of list) {
    let ok = "not found";
    let link = "";
    try {
      if (x.chain === "sepolia") {
        link = `https://sepolia.etherscan.io/tx/${x.tx}`;
        let r: any = {};
        for (const u of [process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia"]) {
          r = await rpc(u, "eth_getTransactionReceipt", [x.tx]).catch(() => ({}));
          if (r.result) break;
        }
        if (r.result) ok = r.result.status === "0x1" ? `✓ block ${parseInt(r.result.blockNumber, 16)}` : "✗ reverted";
      } else if (x.chain === "ethereum") {
        link = `https://etherscan.io/tx/${x.tx}`;
        const r = await rpc(process.env.MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com", "eth_getTransactionReceipt", [x.tx]);
        if (r.result) ok = r.result.status === "0x1" ? `✓ block ${parseInt(r.result.blockNumber, 16)}` : "✗ reverted";
      } else {
        const testnet = x.chain === "near-testnet";
        link = `https://${testnet ? "testnet." : ""}nearblocks.io/txns/${x.tx}`;
        const r = await rpc(testnet ? "https://archival-rpc.testnet.fastnear.com" : "https://archival-rpc.mainnet.fastnear.com", "tx", { tx_hash: x.tx, sender_account_id: x.signer, wait_until: "NONE" });
        const st = r.result?.status;
        if (st) ok = "SuccessValue" in st || "SuccessReceiptId" in st ? "✓" : "✗ failed";
        else if (r.error) ok = `not found (${r.error.cause?.name ?? r.error.message})`;
      }
    } catch (e) {
      ok = `unreachable (${(e as Error).message})`;
    }
    lines.push(`| ${x.run} | ${x.step} | [\`${x.tx.slice(0, 10)}…\`](${link}) | ${ok} |`);
    console.log(`${ok.padEnd(16)} ${x.chain} ${x.tx.slice(0, 12)}… ${x.step}`);
  }
  return lines.join("\n");
}

async function main() {
  mkdirSync(DATA, { recursive: true });
  console.log("EVIDENCE: replays of real 2026 prices and re-reads of recorded runs. Read-only.\n");
  const borrower = await borrowerReplay();
  console.log(borrower + "\n");
  const steward = stewardReplay();
  const sweep = args.has("--no-sweep") ? "_skipped (--no-sweep)_" : stressSweep();
  const live = args.has("--no-live") ? "_skipped (--no-live)_" : await liveRuns();
  const day = new Date().toISOString().slice(0, 10);
  const md = `# Stead: evidence

Generated by \`stewards/scripts/evidence.ts\` on ${day}. Everything below is reproducible from this repository: \`cd stewards && npx tsx scripts/evidence.ts\`. Read-only: public market data and chain reads.

## 1. Borrowers on real 2026 prices (REPLAY)

One position a day (2026-01-01 to 2026-11-05) with $10,000 of stablecoin debt, sitting exactly at Stead's trigger (HF ${STEAD_PARAMS.trigger}) at 00:00 UTC, followed hour by hour on real prices (Binance hourly closes), for the ${STEAD_PARAMS.windowH} h buy-back window and for a week. After a claim ends, the rescued position is followed on: bought back, it keeps the top-up; settled, it sits at HF ${STEAD_PARAMS.target}; a later liquidation is charged on the full debt.

- **Without Stead:** Aave liquidates the first hour its health is below 1; the borrower loses bonus × 50 % × debt.
- **With Stead:** the stewards' real strategies bid; the lowest premiums top the position up to HF ${STEAD_PARAMS.target}. The claim then ends in a buy-back at 24 h, an early settlement at the oracle price (own HF net of the claim below ${STEAD_PARAMS.early}), or an Aave liquidation (premiums forfeited). The cost is the premium, in units of the collateral, at the exit price.
- **"Stead cost more"** counts the days the price recovered: the borrower paid a premium for a rescue that, in hindsight, wasn't needed. It is the price of the insurance and is shown, not hidden.
- **Rule violations** checks every path: the premium at the trigger price is at most Aave's liquidation cost, and the claim is owed exactly the supplied units plus the premium units.
- Liquidation threshold and bonus: read from the Aave V3 Ethereum Pool (\`data/aave-reserves.json\`). Not modelled: interest over the day, the price impact of an Aave liquidation, a borrower who adds collateral on their own.

${borrower}

Per-day rows: \`borrower-<asset>-<hours>h.csv\`; machine-readable: \`borrower.json\`.

## 2. Stewards on the same prices (REPLAY)

PnL in bps of the capital a steward supplies, per claim; the hedged steward shorts the top-up on a perp while its claim is open. Details: \`steward-replay.md\`.

${steward}

## 3. Stress sweep (simulated random paths)

The contract crate's random-path sweep (the invariant on every path, stacked claims, early settlement, liquidations) and the settlement latency sweep (how fast a price can fall before a settler's repay is at risk).

${sweep}

## 4. Live runs, re-read on chain

${live}
`;
  writeFileSync(join(OUT, "README.md"), md);
  console.log(`\nwritten ${join(OUT, "README.md")}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(`EVIDENCE FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);

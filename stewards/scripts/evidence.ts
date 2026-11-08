// npx tsx scripts/evidence.ts [--no-live] [--no-sweep] : the evidence harness. Writes ../evidence/.
//
//  1. Borrower replay: real 2026 hourly prices (LINK, BTC, ETH), rescue events (every day at the
//     trigger, and real falls through it, with and without the hedged steward), followed 7 days with and without Stead (model: src/evidence.ts). Aave's liquidation
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
import { fallThroughEvents, replayPath, summarize, STEAD_PARAMS, type PathResult, type Reserve } from "../src/evidence.js";

const OUT = join(REPO, "evidence");
const DATA = join(OUT, "data");
const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2026, 10, 6);
const args = new Set(process.argv.slice(2));

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

const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const pc = (x: number) => `${(100 * x).toFixed(1)} %`;
const VOL: Record<string, number> = { LINK: 0.045, BTC: 0.03, ETH: 0.04 }; // the hedged steward's σ₂₄ (src/hedge.ts)

type Scenario = { id: string; label: string; events: (px: [number, number][]) => { i: number; p0?: number }[]; hedged: boolean };
const SCENARIOS: Scenario[] = [
  {
    id: "every-day",
    label: "Every day at the trigger",
    hedged: false,
    events: (px) => px.flatMap(([t], i) => (t >= START && t < END && new Date(t).getUTCHours() === 0 && i + STEAD_PARAMS.horizonH < px.length ? [{ i }] : [])),
  },
  { id: "falls-through", label: "Falls through the trigger", hedged: false, events: (px) => fallThroughEvents(px, START, END, STEAD_PARAMS.trigger).filter((e) => e.i + STEAD_PARAMS.horizonH < px.length) },
  { id: "falls-through-hedged", label: "Falls through, hedged steward bidding (MODELLED)", hedged: true, events: (px) => fallThroughEvents(px, START, END, STEAD_PARAMS.trigger).filter((e) => e.i + STEAD_PARAMS.horizonH < px.length) },
];

async function borrowerReplay(): Promise<{ table: string; method: string }> {
  const res = await reserves();
  const lines = [
    "| Asset | Scenario | Rescue events | Liquidated within 7 days: without → with Stead | Liquidation calls (repeats counted): without / with | Liquidation loss when it happens | Mean premium paid | Break-even premium | Mean loss per event: without / with | 95th-percentile loss: without / with | Worst loss: without / with | Biggest single loss avoided | Events Stead cost more / saved | Rule violations |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const method: string[] = [];
  const all: Record<string, unknown> = {};
  let violations = 0;
  for (const a of ASSETS) {
    const f = join(DATA, `${a.pair}-1h.json`);
    if (!existsSync(f)) throw new Error(`missing ${f}: run scripts/replay.ts once to fetch the price data`);
    const px: [number, number][] = JSON.parse(readFileSync(f, "utf8"));
    const r: Reserve = { ...res[a.sym], vol: VOL[a.sym] };
    const half = r.bonus * 0.5 * 10_000;
    method.push(`  - **${a.sym}** (LT ${pc(r.lt)}, bonus ${pc(r.bonus)}): a 50 % liquidation repays $5,000 of debt and seizes ${usd(5_000 * (1 + r.bonus))} of collateral, so the borrower loses **${usd(half)}**; a full liquidation (health below 0.95) loses **${usd(2 * half)}**.`);
    for (const sc of SCENARIOS) {
      const rows: PathResult[] = sc.events(px).map((e) => replayPath(px, e.i, r, { p0: e.p0, hedged: sc.hedged }));
      const s = summarize(rows);
      violations += s.violations;
      all[`${a.sym}/${sc.id}`] = { reserve: r, summary: s };
      writeFileSync(
        join(OUT, `borrower-${a.sym}-${sc.id}.csv`),
        "trigger_hour,exit,exit_hours,move,premium_bps,fills,cap_bps,premium_usd,liq_calls_without,loss_without_usd,liq_calls_with,loss_with_usd,i1,i2\n" +
          rows
            .map((x) => [new Date(x.start).toISOString().slice(0, 13), x.exit, x.exitHours, x.move.toFixed(5), x.premiumBps.toFixed(1), x.fills.map((f) => `${f.steward}:${f.bps}@${(f.share * 100).toFixed(0)}%`).join(" "), x.capBps, x.premiumUsd.toFixed(2), x.liqWithout.count, x.lossWithoutUsd.toFixed(2), x.liqWith.count, x.lossWithUsd.toFixed(2), x.i1, x.i2].join(","))
            .join("\n") +
          "\n",
      );
      lines.push(
        `| ${a.sym} | ${sc.label} | ${s.events} | ${pc(s.pLiqWithout)} → ${pc(s.pLiqWith)} | ${s.liquidationsWithout} / ${s.liquidationsWith} | ${usd(s.meanLiqLossWhenLiquidated)} | ${s.meanPremiumBps.toFixed(0)} bps (${usd(s.meanPremiumUsd)}) | ${s.breakEvenBps.toFixed(0)} bps | ${usd(s.meanLossWithout)} / ${usd(s.meanLossWith)} | ${usd(s.p95Without)} / ${usd(s.p95With)} | ${usd(s.worstWithout)} / ${usd(s.worstWith)} | ${usd(s.worstAvoided)} | ${s.costMore} / ${s.saved} | ${s.violations} |`,
      );
    }
  }
  writeFileSync(join(OUT, "borrower.json"), JSON.stringify({ at: new Date().toISOString(), replay: true, params: STEAD_PARAMS, debtUsd: 10_000, results: all }, null, 1));
  if (violations) process.exitCode = 1;
  return { table: lines.join("\n"), method: method.join("\n") };
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
        // public RPCs sometimes answer null for a known tx: try three, twice
        const urls = [process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia", "https://sepolia.gateway.tenderly.co"];
        for (const u of [...urls, ...urls]) {
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
  console.log(borrower.table + "\n");
  const steward = stewardReplay();
  const sweep = args.has("--no-sweep") ? "_skipped (--no-sweep)_" : stressSweep();
  const live = args.has("--no-live") ? "_skipped (--no-live)_" : await liveRuns();
  const day = new Date().toISOString().slice(0, 10);
  const md = `# Stead: evidence

Generated by \`stewards/scripts/evidence.ts\` on ${day}. Everything below is reproducible from this repository: \`cd stewards && npx tsx scripts/evidence.ts\`. Read-only: public market data and chain reads.

## 1. Borrowers on real 2026 prices (REPLAY)

Stead works like insurance: each rescue costs a premium, and in return the borrower avoids an Aave liquidation that would cost several times more. Whether that pays on average depends on how often a rescue is followed by a fall that would have liquidated the position. This section measures it on real 2026 prices (Binance hourly closes, 2026-01-01 to 2026-11-05), per rescue event, for a position with $10,000 of stablecoin debt, followed for 7 days.

**Three scenarios, all shown:**
- **Every day at the trigger:** a position sits exactly at HF ${STEAD_PARAMS.trigger} at 00:00 UTC every day, calm days included. This overstates rescues that turn out not to be needed: real positions reach the trigger because the price is falling.
- **Falls through the trigger:** positions opened each day at HF 1.25, 1.35 and 1.50; a rescue event is the hour the real price pushes one down through ${STEAD_PARAMS.trigger} (one event per hour). This is the realistic case.
- **Falls through, hedged steward bidding (MODELLED):** the same events with the hedged steward in the auction. Its quote is modelled (venue depth assumed available, funding 0 at bid time); live on Sepolia it won at 100 bps.

**How a loss is counted:**
- **Without Stead:** every hour the health is below 1, Aave liquidates: 50 % of the debt, or all of it when the health is below 0.95 (Aave V3.3); the borrower loses the bonus on what is repaid. Repeat liquidations within the 7 days are counted.
${borrower.method}
- **With Stead:** the stewards' real strategies bid at the trigger; the lowest premiums top the position up to HF ${STEAD_PARAMS.target}. The claim ends in a buy-back at 24 h, an early settlement at the oracle price (the borrower's own HF net of the claim below ${STEAD_PARAMS.early}), or an Aave liquidation (premiums forfeited). The loss is the premium paid plus any Aave liquidation later in the 7 days.
- **Break-even premium:** the premium at which the mean loss with Stead equals the mean loss without. Analysis only: rescue pricing is unchanged.
- **Rule violations:** every event is checked: the premium at the trigger price is at most Aave's liquidation cost, and the claim is owed exactly the supplied units plus the premium units.
- Liquidation threshold and bonus: read from the Aave V3 Ethereum Pool (\`data/aave-reserves.json\`). Not modelled: interest, the price impact of a liquidation, prices between hourly closes, a borrower who adds collateral on their own.

${borrower.table}

Per-event rows: \`borrower-<asset>-<scenario>.csv\`; machine-readable: \`borrower.json\`.

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

// npx tsx scripts/evidence.ts [--no-live] [--no-sweep] : the evidence harness. Writes ../evidence/.
//
//  1. Borrower replay: real 2026 hourly prices (LINK, BTC, ETH), rescue events (every day at the
//     trigger, and real falls through it, with and without the hedged steward), followed 7 days with and without Stead (model: src/evidence.ts). Aave's liquidation
//     threshold and bonus are read from the Aave V3 Ethereum Pool (read-only).
//  2. Steward replay: hedged vs unhedged steward PnL on the same paths (scripts/replay.ts).
//  3. Stress sweep: the contract crate's random-path and latency sweeps, when its tests are present.
//  4. Live on mainnet: every run trail in evidence/mainnet/ (written by the run script as it runs),
//     each transaction re-checked on chain (sender, target, method, outcome) and the contract's state
//     re-read and compared with the trail's snapshot.
//  5. Testnet runs: every recorded transaction in evidence/live-runs.json, re-read on chain.
//  Also writes evidence/live-checked.json: every checked transaction, for the front end.
//  `--trail <file>` checks one trail only and prints it (writes nothing): for a rehearsal.
// Read-only throughout: public market data and RPC reads, no account, no transaction.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { mainnet } from "viem/chains";
import { REPO, env, hasEnv } from "../src/config.js";
import { checkTrail, renderTrail, rpcAny, explorerLink, type Rpcs, type CheckedTrail } from "../src/trailcheck.js";
import type { TrailFile, TrailChain } from "../src/record.js";
import { fallThroughEvents, replayPath, summarize, STEAD_PARAMS, type PathResult, type Reserve } from "../src/evidence.js";

const OUT = join(REPO, "evidence");
const DATA = join(OUT, "data");
const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2026, 10, 6);
const args = new Set(process.argv.slice(2));
const argAfter = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** RPCs per chain: the ones in .env first (never printed: some carry a key), then public ones. */
function rpcs(): Rpcs {
  const list = (...names: string[]) => names.flatMap((n) => (hasEnv(n) ? env(n).split(",") : [])).map((u) => u.trim()).filter(Boolean);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    ethereum: uniq([...list("MAINNET_RPC_URL", "MAINNET_RPC_FALLBACK"), "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"]),
    sepolia: uniq([...list("SEPOLIA_RPC_URL", "SEPOLIA_RPC_FALLBACK"), "https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia", "https://sepolia.gateway.tenderly.co"]),
    "ethereum-copy": [argAfter("--copy-rpc") ?? "http://127.0.0.1:8546"],
    // archival first: a regular node forgets transactions after a few days
    "near-mainnet": uniq(["https://archival-rpc.mainnet.fastnear.com", ...list("MAINNET_NEAR_RPC_URL", "MAINNET_NEAR_RPC_FALLBACK"), "https://rpc.mainnet.near.org"]),
    "near-testnet": ["https://archival-rpc.testnet.fastnear.com", "https://rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"],
  };
}

async function mainnetRuns(): Promise<{ md: string; checked: CheckedTrail[] }> {
  const dir = join(OUT, "mainnet");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  if (!files.length) return { md: "_No mainnet run recorded yet._", checked: [] };
  const checked: CheckedTrail[] = [];
  for (const f of files) {
    const c = await checkTrail(`evidence/mainnet/${f}`, JSON.parse(readFileSync(join(dir, f), "utf8")) as TrailFile, rpcs());
    console.log(`${c.title}: ${c.confirmed}/${c.total} confirmed · state ${c.state.checked ? (c.state.matches ? "matches" : "DIFFERS") : "not checked"}`);
    checked.push(c);
  }
  return { md: checked.map(renderTrail).join("\n"), checked };
}

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

interface TestnetRow { run: string; step: string; chain: TrailChain; tx: string; signer?: string; link: string; confirmed: boolean; status: string }

async function liveRuns(): Promise<{ md: string; rows: TestnetRow[] }> {
  const list: { run: string; step: string; chain: TrailChain; tx: string; signer?: string }[] = JSON.parse(readFileSync(join(OUT, "live-runs.json"), "utf8"));
  const urls = rpcs();
  const lines = ["| Run | Step | Transaction | On chain |", "|---|---|---|---|"];
  const rows: TestnetRow[] = [];
  for (const x of list) {
    let ok = "not found";
    if (x.chain.startsWith("near")) {
      const r = await rpcAny(urls[x.chain], "tx", { tx_hash: x.tx, sender_account_id: x.signer, wait_until: "NONE" }, (v) => v?.result?.status != null);
      const st = r?.result?.status;
      if (st) ok = "SuccessValue" in st || "SuccessReceiptId" in st ? "✓" : "✗ failed";
      else if (r?.error) ok = `not found${r.error.cause?.name ? ` (${r.error.cause.name})` : ""}`;
    } else {
      // public RPCs sometimes answer null for a known tx: every RPC is tried, twice
      const r = await rpcAny(urls[x.chain] ?? [], "eth_getTransactionReceipt", [x.tx]);
      if (r?.result) ok = r.result.status === "0x1" ? `✓ block ${parseInt(r.result.blockNumber, 16)}` : "✗ reverted";
    }
    const link = explorerLink(x.chain, x.tx);
    rows.push({ ...x, link, confirmed: ok.startsWith("✓"), status: ok });
    lines.push(`| ${x.run} | ${x.step} | [\`${x.tx.slice(0, 10)}…\`](${link}) | ${ok} |`);
    console.log(`${ok.padEnd(16)} ${x.chain} ${x.tx.slice(0, 12)}… ${x.step}`);
  }
  return { md: lines.join("\n"), rows };
}

async function main() {
  const one = argAfter("--trail");
  if (one) {
    // a single trail (e.g. a rehearsal's): check it, print it, write nothing
    const c = await checkTrail(one, JSON.parse(readFileSync(one, "utf8")) as TrailFile, rpcs());
    console.log(renderTrail(c));
    for (const e of c.entries.filter((x) => !x.confirmed)) console.log(`NOT CONFIRMED: ${e.chain} ${e.tx} ${e.what}: ${e.status}`);
    console.log(`\n${c.confirmed}/${c.total} confirmed · state: ${c.state.note}${c.state.differences.length ? ` (${c.state.differences.join(", ")})` : ""}`);
    if (c.confirmed !== c.total || (c.state.checked && !c.state.matches)) process.exitCode = 1;
    return;
  }
  mkdirSync(DATA, { recursive: true });
  console.log("EVIDENCE: replays of real 2026 prices and re-reads of recorded runs. Read-only.\n");
  const borrower = await borrowerReplay();
  console.log(borrower.table + "\n");
  const steward = stewardReplay();
  const sweep = args.has("--no-sweep") ? "_skipped (--no-sweep)_" : stressSweep();
  const skip = args.has("--no-live");
  const main_ = skip ? { md: "_skipped (--no-live)_", checked: [] } : await mainnetRuns();
  const test_ = skip ? { md: "_skipped (--no-live)_", rows: [] } : await liveRuns();
  const live = test_.md;
  if (!skip) writeFileSync(join(OUT, "live-checked.json"), JSON.stringify({ generated: new Date().toISOString(), mainnet: main_.checked, testnet: test_.rows }, null, 1) + "\n");
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

## 4. Live on mainnet (real funds), re-checked on chain

Each run's script records every transaction as it happens: every NEAR call by every actor (the borrower, the stewards, the keeper) and every Ethereum transaction sent from the run's own addresses (the borrower, the stewards, each position's MPC-derived address), with the contract's state at the end. The trails are in \`mainnet/\`. Here every transaction is re-checked on chain (it exists; its sender, target or method match the record; it succeeded, or was refused when the record says so) and the contract's positions, rescues and claims are read again and compared with the snapshot. Machine-readable: \`live-checked.json\`.

${main_.md}

## 5. Testnet runs, re-read on chain

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

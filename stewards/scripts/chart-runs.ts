// npx tsx scripts/chart-runs.ts [--feed https://live.usestead.xyz]
//
// Builds the "How it works" cost chart's runs: each is one recorded rescue (its HF at the trigger,
// its proven HF after the top-up, its debt, every claim's premium) run along a real 2026 hourly
// price fall of its collateral, picked by a fixed rule (fastest or deepest liquidation). Each run
// also carries how the same position fares on every liquidating window of the year.
// Reads the rescue records from the live feed's archive; writes web/public/replays/chart-runs.json.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { costPath, windowStats, type ChartRun, type WindowRule } from "../src/costpath.js";
import type { RescueEvent, RescueLog } from "../src/rescuelog.js";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const FEED = arg("--feed") ?? "https://live.usestead.xyz";

const RUNS: { contract: string; id: number; rule: WindowRule; about: string }[] = [
  { contract: "sepolia-demo.steadfi.testnet", id: 8, rule: "fastest", about: "one steward" },
  { contract: "sepolia-demo.steadfi.testnet", id: 14, rule: "fastest", about: "a pooled rescue" },
  { contract: "sepolia-demo.steadfi.testnet", id: 18, rule: "deepest", about: "a visitor's own NEAR wallet" },
];

const of = <K extends RescueEvent["kind"]>(log: RescueLog, k: K) => log.events.filter((e) => e.kind === k) as Extract<RescueEvent, { kind: K }>[];

const out: ChartRun[] = [];
for (const r of RUNS) {
  const res = await fetch(`${FEED}/rescue/${r.contract}/${r.id}.json`);
  if (!res.ok) throw new Error(`rescue ${r.id}: ${res.status}`);
  const log = (await res.json()) as RescueLog;
  const trigger = of(log, "TRIGGER")[0] as any;
  const after = (of(log, "READING") as any[]).find((e) => e.hf >= log.params.triggerHf);
  const claims = of(log, "CLAIM_MINTED");
  const open = of(log, "AUCTION_OPEN")[0] as any;
  if (!trigger || !after || !claims.length || !log.atOpen || !open) throw new Error(`rescue ${r.id} needs a trigger, a proven reading above it, a claim and the opening position`);
  // the collateral's real-market twin: WBTC → BTC, WETH → ETH, LINK → LINK
  const sym = log.market.collateral.replace(/^W(BTC|ETH)$/, "$1");
  const series = JSON.parse(readFileSync(join(REPO, `evidence/data/${sym}USDT-1h.json`), "utf8"));
  const premium = claims.reduce((s, c) => s + Number(c.premium), 0);
  const premiumUsd = premium * log.atOpen.priceUsd;
  const o = { hfTrigger: trigger.hf, hfAfter: after.hf, debtUsd: log.atOpen.debtUsd, liqBonusBps: log.market.liqBonusBps, premiumUsd };
  const path = costPath(series, { ...o, source: `${sym}/USDT hourly closes, Binance spot, 2026`, rule: r.rule, before: 0 });
  if (!path) throw new Error(`no ${sym} window liquidates rescue ${r.id}'s position within 24 hours`);
  const short = r.contract.replace(/\.steadfi\.testnet$|\.testnet$/, "");
  out.push({
    key: `${short}:${r.id}`,
    rescueId: r.id,
    positionId: log.positionId,
    collateral: log.market.collateral,
    sym,
    pair: `${log.market.collateral}/${log.market.debt}`,
    about: r.about,
    stewards: [...new Set(claims.map((c) => c.holder))],
    claims: claims.length,
    rule: r.rule,
    triggerHf: trigger.hf,
    hfAfter: after.hf,
    debtUsd: log.atOpen.debtUsd,
    priceUsd: log.atOpen.priceUsd,
    premium: premium.toFixed(8).replace(/\.?0+$/, ""),
    premiumUsd,
    capBps: open.capBps,
    path,
    year: windowStats(series, { hfTrigger: trigger.hf, hfAfter: after.hf }),
  });
  const p = out[out.length - 1];
  console.log(`rescue ${r.id} (${p.pair}, ${p.claims} claim${p.claims > 1 ? "s" : ""}): ${r.rule} ${sym} fall from ${new Date(path.startMs).toISOString().slice(0, 13)}h, liquidated at +${path.liqHour}h, rescued low ${path.lowestWith.toFixed(3)}; held in ${p.year!.held} of ${p.year!.windows} windows`);
}
const file = join(REPO, "web/public/replays/chart-runs.json");
writeFileSync(file, JSON.stringify(out));
console.log(`→ ${file}`);

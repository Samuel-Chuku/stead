// npx tsx scripts/rescue-path.ts [--replay ../web/public/replays/sepolia-demo-rescue-8.json] [--prices ../evidence/data/BTCUSDT-1h.json]
//
// Offline. Runs one recorded rescue's position (its HF at the trigger, its proven HF after the
// top-up, its debt, its premium) along a real hourly price path, for the rescue page's cost chart.
// Writes <replay>-path.json next to the replay.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { costPath } from "../src/costpath.js";
import type { RescueLog } from "../src/rescuelog.js";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const replay = resolve(arg("--replay") ?? join(REPO, "web/public/replays/sepolia-demo-rescue-8.json"));
const log: RescueLog = JSON.parse(readFileSync(replay, "utf8"));
// the collateral's real-market twin: WBTC → BTC, WETH → ETH, LINK → LINK
const sym = log.market.collateral.replace(/^W(BTC|ETH)$/, "$1");
const prices = resolve(arg("--prices") ?? join(REPO, `evidence/data/${sym}USDT-1h.json`));

const trigger = log.events.find((e) => e.kind === "TRIGGER") as any;
const after = log.events.find((e) => e.kind === "READING" && e.hf >= log.params.triggerHf) as any;
const claims = log.events.filter((e) => e.kind === "CLAIM_MINTED") as any[];
const claim = claims[0];
if (!trigger || !after || !claim || !log.atOpen) throw new Error("the replay needs a trigger, a proven reading above the trigger, a claim and the opening position");

const out = costPath(JSON.parse(readFileSync(prices, "utf8")), {
  source: `${sym}/USDT hourly closes, Binance spot, 2026`,
  hfTrigger: trigger.hf,
  hfAfter: after.hf,
  debtUsd: log.atOpen.debtUsd,
  liqBonusBps: log.market.liqBonusBps,
  // every claim's premium: a pooled rescue has one claim per steward
  premiumUsd: claims.reduce((t, c) => t + Number(c.premium), 0) * log.atOpen.priceUsd,
});
if (!out) throw new Error(`no window in ${prices} liquidates this position within the horizon`);
const file = replay.replace(/\.json$/, "-path.json");
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`${new Date(out.startMs).toISOString().slice(0, 13)}h: without Stead liquidated at +${out.liqHour}h (HF ${out.hfAtLiq.toFixed(3)}); with Stead lowest HF ${out.lowestWith.toFixed(3)}; saved $${out.savedUsd.low.toFixed(2)}–${out.savedUsd.high.toFixed(2)} → ${file}`);

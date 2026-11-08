// npx tsx scripts/mainnet-watch.ts [--json out.json] : READ-ONLY. Real Aave V3 positions on Ethereum
// mainnet near Stead's trigger, and what Stead would do for each (top-up, premium cap, the
// stewards' bids, the saving against an Aave liquidation). Public reads only; no transaction.
import { writeFileSync } from "node:fs";
import { scan, STEAD } from "../src/mainnet.js";

const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : undefined;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
console.log(`READ-ONLY · Aave V3 Ethereum mainnet · Stead trigger ${STEAD.trigger}, target ${STEAD.target} · no transactions\n`);
const t0 = Date.now();
const rows = await scan();
console.log(`${rows.length} positions outside eMode with HF in [1.00, 1.30) and debt ≥ $1,000 among recent borrowers (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
console.log("HF      debt        top-up at 1.15  cap    winner         premium   vs Aave liquidation");
for (const p of rows.slice(0, 15)) {
  const t = p.atTrigger;
  const w = t.winner;
  console.log(
    `${p.hf.toFixed(3).padEnd(7)} ${usd(p.debtUsd).padEnd(11)} ${usd(t.topupUsd).padEnd(15)} ${String(t.capBps).padEnd(6)} ${(w ? `${w.steward} ${w.bps}` : "no bid").padEnd(14)} ${(w ? usd(w.premiumUsd) : "-").padEnd(9)} ${w ? `${usd(t.liquidationCostUsd)} (saves ${usd(w.savedUsd)})` : usd(t.liquidationCostUsd)}`,
  );
}
if (out) {
  writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), chain: "ethereum", readOnly: true, positions: rows }, null, 1));
  console.log(`\nwritten ${out}`);
}
process.exit(0);

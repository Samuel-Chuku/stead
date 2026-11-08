// npx tsx scripts/replay.ts : REPLAY of real 2026 price paths, hedged vs unhedged steward PnL.
// Read-only public market data (Binance spot hourly closes, Binance USDT-perp funding); no
// account, no transaction. Every result here is labelled a replay, never a live run.
//
// Model, per asset, one claim per day from 2026-01-01 00:00 UTC:
//  - The canonical position from the contract's rescue: 100 units of collateral at HF 1.14 (the
//    trigger), topped up to HF 1.50, so the steward supplies T = 100·(1.50/1.14 − 1) units.
//  - The claim is owed O = T·(1 + premium) units: 150 bps unhedged (deep), the hedged bid from
//    the hedged steward's bid formula (src/hedge.ts).
//  - Exit at 24 h (buy-back or settlement both return O units), or earlier when the borrower's
//    own HF net of the claim, (100 − T·premium)·P·LT/D, falls below 1.10 (early settlement), or
//    when Aave's HF falls below 1 (liquidation: the premium is forfeited, the share returns).
//  - The steward's capital is in USD: PnL = O·P_exit − T·P_0.
//  - The hedged steward also shorts T units at P_0 on the perp: + T·(P_0 − P_exit), + funding
//    received while short (Binance 8 h rates; negative rates are paid), − 2 × 10 bps taker fees
//    and 5 bps slippage on T·P_0.
// Limits: the perp's mark is taken equal to the spot close (no basis); the premium units are not
// hedged; a deep-crash pro-rata settlement isn't modelled (the 24 h paths never reach it).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../src/config.js";
import { LAMBDA, SLIPPAGE_BPS } from "../src/hedge.js";

const OUT = join(REPO, "evidence");
const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2026, 10, 6); // last full day before the run
const H = 3_600_000;
const ASSETS = [
  { sym: "LINK", pair: "LINKUSDT", vol: 0.045 },
  { sym: "BTC", pair: "BTCUSDT", vol: 0.03 },
  { sym: "ETH", pair: "ETHUSDT", vol: 0.04 },
];
const LT = 0.75;
const TRIGGER = 1.14;
const TARGET = 1.5;
const EARLY = 1.1;
const FLOOR_BPS = 150;
const TAKER_BPS = 10;

async function json(url: string): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    if (i >= 4) throw new Error(`${url}: HTTP ${r.status}`);
    await new Promise((s) => setTimeout(s, 1000 * 2 ** i));
  }
}

/** Hourly closes [openTime, close], cached under evidence/data (reproducible). */
async function closes(pair: string): Promise<[number, number][]> {
  const f = join(OUT, "data", `${pair}-1h.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const out: [number, number][] = [];
  for (let t = START; t < END + 2 * 86_400_000; ) {
    const rows: any[] = await json(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&startTime=${t}&limit=1000`);
    if (!rows.length) break;
    for (const r of rows) out.push([r[0], Number(r[4])]);
    t = rows[rows.length - 1][0] + H;
  }
  writeFileSync(f, JSON.stringify(out));
  return out;
}

/** Funding events [time, rate] (8 h; positive: longs pay shorts). */
async function funding(pair: string): Promise<[number, number][]> {
  const f = join(OUT, "data", `${pair}-funding.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8"));
  const out: [number, number][] = [];
  for (let t = START; t < END + 2 * 86_400_000; ) {
    const rows: any[] = await json(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&startTime=${t}&limit=1000`);
    if (!rows.length) break;
    for (const r of rows) out.push([r.fundingTime, Number(r.fundingRate)]);
    t = rows[rows.length - 1].fundingTime + 1;
  }
  writeFileSync(f, JSON.stringify(out));
  return out;
}

interface Row {
  day: string;
  exit: "24h" | "early" | "liquidated";
  hours: number;
  move: number; // P_exit / P_0 − 1
  unhedgedBps: number; // PnL in bps of the capital supplied (T·P_0)
  hedgedBps: number;
  fundingBps: number; // funding received by the short (negative: paid)
}

function replayDay(px: [number, number][], fund: [number, number][], i0: number, hedgedBps: number): Row {
  const [t0, p0] = px[i0];
  const T = 100 * (TARGET / TRIGGER - 1);
  const D = (100 * p0 * LT) / TRIGGER;
  // the exit is the same for both stewards (the borrower's path doesn't depend on who rescued);
  // the early-settle test uses the unhedged premium (the larger claim, so the earlier exit)
  let iE = i0 + 24;
  let exit: Row["exit"] = "24h";
  for (let i = i0 + 1; i <= i0 + 24 && i < px.length; i++) {
    const p = px[i][1];
    if (((100 + T) * p * LT) / D < 1) {
      iE = i;
      exit = "liquidated";
      break;
    }
    if (((100 - (T * FLOOR_BPS) / 10_000) * p * LT) / D < EARLY) {
      iE = i;
      exit = "early";
      break;
    }
  }
  iE = Math.min(iE, px.length - 1);
  const [tE, pE] = px[iE];
  const prem = (bps: number) => (exit === "liquidated" ? 0 : bps / 10_000);
  const capital = T * p0;
  const unhedged = T * (1 + prem(FLOOR_BPS)) * pE - capital;
  const fundRecv = fund.filter(([t]) => t > t0 && t <= tE).reduce((a, [, r]) => a + r * T * p0, 0);
  const fees = ((2 * TAKER_BPS + SLIPPAGE_BPS) / 10_000) * capital;
  const hedged = T * (1 + prem(hedgedBps)) * pE - capital + T * (p0 - pE) + fundRecv - fees;
  return {
    day: new Date(t0).toISOString().slice(0, 10),
    exit,
    hours: iE - i0,
    move: pE / p0 - 1,
    unhedgedBps: (unhedged / capital) * 10_000,
    hedgedBps: (hedged / capital) * 10_000,
    fundingBps: (fundRecv / capital) * 10_000,
  };
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const f1 = (x: number) => x.toFixed(1);

async function main() {
  mkdirSync(join(OUT, "data"), { recursive: true });
  console.log("REPLAY of real 2026 price paths (Binance spot hourly, Binance perp funding). Not a live run.\n");
  const summary: string[] = [
    "| Asset | Days | Hedged bid | Steward | Mean | Std dev | 5 % worst | Worst day | Days < 0 | Early / liquidated exits |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const a of ASSETS) {
    const px = await closes(a.pair);
    const fund = await funding(a.pair);
    const hedgedBps = Math.round(FLOOR_BPS - LAMBDA * a.vol * 10_000 + 2 * TAKER_BPS + SLIPPAGE_BPS); // funding term: past rates only at bid time, ≈0 here
    const rows: Row[] = [];
    for (let i = 0; i < px.length; i++) {
      const [t] = px[i];
      if (t < START || t >= END || new Date(t).getUTCHours() !== 0) continue;
      if (i + 24 >= px.length) break;
      rows.push(replayDay(px, fund, i, hedgedBps));
    }
    writeFileSync(join(OUT, `steward-${a.sym}.csv`), "day,exit,hours,move,unhedged_bps,hedged_bps,funding_bps\n" + rows.map((r) => [r.day, r.exit, r.hours, r.move.toFixed(5), f1(r.unhedgedBps), f1(r.hedgedBps), f1(r.fundingBps)].join(",")).join("\n") + "\n");
    const early = rows.filter((r) => r.exit === "early").length;
    const liq = rows.filter((r) => r.exit === "liquidated").length;
    for (const [who, xs] of [["unhedged (150 bps)", rows.map((r) => r.unhedgedBps)], [`hedged (${hedgedBps} bps)`, rows.map((r) => r.hedgedBps)]] as const) {
      summary.push(`| ${a.sym} | ${rows.length} | ${hedgedBps} bps | ${who} | ${f1(mean(xs))} | ${f1(sd(xs))} | ${f1(pct(xs, 0.05))} | ${f1(Math.min(...xs))} | ${xs.filter((x) => x < 0).length} | ${early} / ${liq} |`);
    }
    console.log(`${a.sym}: ${rows.length} days, ${early} early exits, ${liq} liquidations; hedged bid ${hedgedBps} bps`);
  }
  const md = `# Replay: hedged vs unhedged steward, real 2026 price paths\n\n**REPLAY, not a live run.** Generated by \`stewards/scripts/replay.ts\` on ${new Date().toISOString().slice(0, 10)}. PnL in bps of the capital supplied, per claim (one claim per day, 2026-01-01 to 2026-11-05).\n\n${summary.join("\n")}\n\nPer-day rows: \`steward-LINK.csv\`, \`steward-BTC.csv\`, \`steward-ETH.csv\`. Raw data cached in \`data/\`. Model and limits: header of the script.\n`;
  writeFileSync(join(OUT, "steward-replay.md"), md);
  console.log("\n" + summary.join("\n"));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`REPLAY FAILED: ${(e as Error).message}`);
    process.exit(1);
  },
);

// The demo runner: a visitor's click on the web page starts a real testnet rescue on one of two
// demo borrowers' positions (NEAR testnet + Sepolia). Serves POST /demo/start and GET /demo/status.
//
//   STEAD_EVM=sepolia NEAR_CONTRACT_ID=sepolia-demo.steadfi.testnet STEAD_MARKET_ID=1 \
//     npx tsx scripts/demo-runner.ts [--port 8789] [--host 127.0.0.1]
//   ... scripts/demo-runner.ts --prepare     register and open each demo position once, then exit
//
// Limits: 2 runs at a time (one per demo borrower), 2 min between starts, 1 start per visitor per
// 10 min, and a daily allowance that paces the test funds through judging. Signs only as the demo
// borrowers (NEAR) and their payout wallets and the reserve wallet (Sepolia). Never prints a key.
import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Address, Hex } from "viem";
import { cfg, env, nearKey, REPO, STEWARDS, stewardAccount } from "../src/config.js";
import { pub, wallet, price, E8 } from "../src/fork.js";
import { marketAssets } from "../src/market.js";
import { view } from "../src/near.js";
import { DEMO, DEMO_KINDS, STEP_TEXT, allowancePerDay, checkSigners, freshGate, refuelPlan, route, visitorOf, MAX_BODY, type Budget, type GateState, type Step } from "../src/demogate.js";
import { DemoRun, type DemoSlot } from "../src/demorun.js";
import { scrub } from "../src/chainread.js";
import { sleep } from "../src/log.js";

if (cfg.evm !== "sepolia") throw new Error("run with STEAD_EVM=sepolia");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const port = Number(arg("--port") ?? 8789);
const host = arg("--host") ?? "127.0.0.1";
const STATE = env("DEMO_STATE_FILE", join(REPO, "fork", "state", "demo-slots.json"));
const ORIGINS = env("DEMO_ALLOWED_ORIGINS", "https://app.usestead.xyz,http://127.0.0.1:4173,http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);
const accounts = env("DEMO_ACCOUNTS", "demo.steadfi.testnet,demo-2.steadfi.testnet").split(",").map((s) => s.trim());

// the runner signs only for the demo borrowers
checkSigners(accounts, [cfg.borrower, cfg.reporter, cfg.contract, ...STEWARDS.map(stewardAccount)]);
for (const a of accounts) nearKey(a); // throws (without printing anything) if a key file is missing
const reserve = wallet(env("DEMO_RESERVE_EVM_KEY") as Hex);

interface Saved {
  gate: GateState;
  slots: Omit<DemoSlot, "evmKey">[];
}
function load(): Saved {
  const fresh: Saved = { gate: freshGate(accounts.length), slots: accounts.map((account) => ({ account, positionId: null, restUnits: null })) };
  if (!existsSync(STATE)) return fresh;
  const s = JSON.parse(readFileSync(STATE, "utf8")) as Saved;
  if (s.slots.map((x) => x.account).join() !== accounts.join()) throw new Error("demo state file lists other accounts");
  return s;
}
const saved = load();
function save() {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(`${STATE}.tmp`, JSON.stringify(saved, null, 1));
  renameSync(`${STATE}.tmp`, STATE); // atomic
}
const slotOf = (i: number): DemoSlot => ({ ...saved.slots[i], evmKey: env(`DEMO_${i + 1}_EVM_KEY`) as Hex });
const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

if (process.argv.includes("--prepare")) {
  for (let i = 0; i < accounts.length; i++) {
    const r = new DemoRun(slotOf(i), { step: () => {}, log: (m) => say(`[${accounts[i]}] ${m}`) });
    const p = await r.prepare(reserve);
    Object.assign(saved.slots[i], p);
    save();
    say(`[${accounts[i]}] position ${p.positionId} at rest: ${p.restUnits} collateral units, payout ${r.payout}`);
  }
  process.exit(0);
}
for (const s of saved.slots) if (s.positionId === null || !s.restUnits) throw new Error(`${s.account} has no demo position yet: run with --prepare first`);

// the pooled slot rests larger: its top-up is more than any one steward's capacity. A slot whose
// resting size is off by more than 5 % is re-sized here; its next run's reset supplies the difference.
{
  const A = await marketAssets();
  const px = await price(A.collateral);
  saved.gate.slots.forEach((g, i) => {
    g.kind ??= DEMO_KINDS[i] ?? "single";
    const usd = g.kind === "pooled" ? DEMO.collateralUsdPooled : DEMO.collateralUsd;
    const want = (BigInt(usd) * E8 * 10n ** BigInt(A.cDec)) / px;
    const have = BigInt(saved.slots[i].restUnits!);
    const off = have > want ? have - want : want - have;
    if (off * 20n > want) {
      say(`[slot ${i}] ${g.kind}: resting collateral ${have} → ${want} units ($${usd})`);
      saved.slots[i].restUnits = want.toString();
    }
  });
  save();
}

// ── budget and refuel (refreshed every minute; a start never waits on the chain) ──
let budget: Budget = { leftToday: 0, canPayOne: false };
let budgetNote = "first check pending";
async function refreshBudget() {
  try {
    const [reserveWei, gasPriceWei] = await Promise.all([pub.getBalance({ address: reserve.address }), pub.getGasPrice()]);
    const r = await fetch(cfg.nearRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: cfg.reporter } }), signal: AbortSignal.timeout(10_000) });
    const reporterYocto = BigInt(((await r.json()) as { result: { amount: string } }).result.amount);
    const a = allowancePerDay({ reserveWei, gasPriceWei, reporterYocto, now: Date.now() });
    const today = new Date().toISOString().slice(0, 10);
    budget = { leftToday: a.perDay - (saved.gate.day === today ? saved.gate.startsToday : 0), canPayOne: a.canPayOne };
    budgetNote = `reserve ${(Number(reserveWei) / 1e18).toFixed(3)} ETH, gas ${(Number(gasPriceWei) / 1e9).toFixed(2)} gwei, reporter ${(Number(reporterYocto / 10n ** 21n) / 1000).toFixed(1)} NEAR: ${a.perDay} runs/day`;
    if (reporterYocto < 20n * 10n ** 24n) say(`WARNING reporter below 20 NEAR (${budgetNote})`);
  } catch (e) {
    budgetNote = `budget check failed: ${scrub((e as Error).message)}`; // keep the last good budget
  }
}
const FLOOR = { position: [4n, 10n], payout: [5n, 15n], steward: [20n, 50n] } as const; // milli-ETH: floor, fill to
async function refuel() {
  try {
    const targets: { address: string; kind: keyof typeof FLOOR }[] = [];
    for (let i = 0; i < accounts.length; i++) {
      const p = await view<{ evm_address: string }>("get_position", { position_id: saved.slots[i].positionId });
      targets.push({ address: p.evm_address, kind: "position" }, { address: wallet(slotOf(i).evmKey).address, kind: "payout" });
    }
    for (const a of env("DEMO_REFUEL_STEWARDS", "").split(",").map((s) => s.trim()).filter(Boolean)) targets.push({ address: a, kind: "steward" });
    const me = 10n ** 15n;
    const wallets = await Promise.all(targets.map(async (t) => ({ address: t.address, balanceWei: await pub.getBalance({ address: t.address as Address }), floorWei: FLOOR[t.kind][0] * me, targetWei: FLOOR[t.kind][1] * me })));
    for (const s of refuelPlan(wallets, (await pub.getBalance({ address: reserve.address })) - 50n * me)) {
      const h = await reserve.sendTransaction({ to: s.to as Address, value: s.wei, account: reserve.account!, chain: reserve.chain });
      await pub.waitForTransactionReceipt({ hash: h });
      say(`refuel ${s.to} +${(Number(s.wei) / 1e18).toFixed(4)} ETH (${h})`);
    }
  } catch (e) {
    say(`refuel failed: ${scrub((e as Error).message)}`);
  }
}

// ── runs ──
const recent: { slot: number; runId: string; rescueId: number | null; outcome: string; error: string | null; startedAt: number; endedAt: number }[] = [];
const running = new Set<number>();
async function drive(i: number) {
  if (running.has(i)) return;
  running.add(i);
  const run = () => saved.gate.slots[i].run!;
  const hooks = {
    step: (s: Step, d?: { rescueId?: number; tx?: string; note?: string }) => {
      run().step = s;
      run().error = null; // a new step means the run moved on from any earlier failure
      if (d?.rescueId !== undefined) run().rescueId = d.rescueId;
      save();
      say(`[slot ${i}] ${STEP_TEXT[s]}${d?.rescueId !== undefined ? ` · rescue ${d.rescueId}` : ""}${d?.tx ? ` · ${d.tx}` : ""}${d?.note ? ` · ${d.note}` : ""}`);
    },
    log: (m: string) => say(`[slot ${i}] ${m}`),
  };
  // resumable: on a failure, say where it stopped, then retry from chain state until the position
  // is back at rest. The slot frees only then, so a stuck run never overlaps the next one.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await new DemoRun(slotOf(i), hooks).run();
      const x = run();
      const rescueId = r.rescueId ?? x.rescueId;
      // a run resumed after its rescue ended only resets: its outcome is the rescue's own record
      let outcome: string = r.outcome;
      if (outcome === "reset_only" && rescueId !== null) outcome = (await view<{ state: string }>("get_rescue", { rescue_id: rescueId }).catch(() => ({ state: "reset_only" }))).state;
      recent.unshift({ slot: i, runId: x.id, rescueId, outcome, error: x.error, startedAt: x.startedAt, endedAt: Date.now() });
      recent.length = Math.min(recent.length, 8);
      saved.gate.slots[i].run = null;
      save();
      break;
    } catch (e) {
      const msg = scrub((e as Error).message).slice(0, 200);
      run().error = msg;
      save();
      say(`[slot ${i}] ${msg} (attempt ${attempt + 1}; retrying from chain state)`);
      await sleep(Math.min(10 * 60_000, 30_000 * 2 ** attempt));
    }
  }
  running.delete(i);
}

function status() {
  const now = Date.now();
  const free = saved.gate.slots.filter((s) => !s.run).length;
  return {
    label: "DEMO · NEAR testnet and Sepolia",
    generated: now,
    slots: saved.gate.slots.map((s, i) => ({
      slot: i,
      kind: s.kind ?? DEMO_KINDS[i] ?? "single",
      positionId: saved.slots[i].positionId,
      run: s.run && { runId: s.run.id, startedAt: s.run.startedAt, step: s.run.step, stepText: STEP_TEXT[s.run.step], rescueId: s.run.rescueId, error: s.run.error },
    })),
    free,
    nextStartAt: Math.max(now, saved.gate.lastStartAt + DEMO.gapMs),
    paused: !budget.canPayOne,
    leftToday: Math.max(0, budget.leftToday),
    recent: recent.filter((r) => now - r.endedAt < 30 * 60_000),
  };
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((ok) => {
    let b = "";
    req.on("data", (c: Buffer) => {
      b += c.toString();
      if (b.length > MAX_BODY) req.destroy();
    });
    req.on("end", () => ok(b));
    req.on("error", () => ok(b));
  });

createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store", vary: "origin" };
  if (origin && ORIGINS.includes(origin)) Object.assign(headers, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" });
  // the status is read-only: any page may read it (starting a run stays limited to the allowed origins)
  else if (req.method === "GET" && req.url?.startsWith("/demo/status")) headers["access-control-allow-origin"] = "*";
  if (req.method === "OPTIONS") return void res.writeHead(204, headers).end();
  const body = req.method === "POST" ? await readBody(req) : "";
  const out = route(
    { method: req.method ?? "", path: req.url?.split("?")[0] ?? "", origin, body, visitor: visitorOf(req.headers, req.socket.remoteAddress) },
    { allowedOrigins: ORIGINS, now: Date.now(), gate: saved.gate, budget: () => budget, start: (slot) => void drive(slot), status, save },
  );
  if (out.status === 202) budget.leftToday -= 1;
  res.writeHead(out.status, headers).end(JSON.stringify(out.json));
}).listen(port, host);

say(`demo runner · ${cfg.contract} market ${cfg.marketId} · ${accounts.join(", ")} · http://${host}:${port}/demo/status`);
await refreshBudget();
say(budgetNote);
setInterval(() => void refreshBudget(), 60_000);
setInterval(() => void refuel(), 5 * 60_000);
void refuel();
// a restart resumes the runs that were in progress
saved.gate.slots.forEach((s, i) => s.run && void drive(i));

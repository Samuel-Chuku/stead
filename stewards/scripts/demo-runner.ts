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
import { pub, wallet, price, write, faucetAbi, E8 } from "../src/fork.js";
import { account } from "../src/near.js";
import { FAUCET, SPONSOR as SPONSORED, addReceipt, checkFaucet, checkSponsor, freshFaucet, receiptsFor, recordFaucet, type FaucetState, type Receipts } from "../src/faucet.js";
import { accountData, balance } from "../src/fork.js";
import { marketAssets } from "../src/market.js";
import { view } from "../src/near.js";
import { DEMO, DEMO_KINDS, STEP_TEXT, BREAK_TEXT, allowancePerDay, checkTry, type RunTx, checkSigners, freshGate, refuelPlan, route, visitorOf, MAX_BODY, type Budget, type GateState, type Step } from "../src/demogate.js";
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
/** The NEAR account that sponsors visitors' test NEAR (sends only plain transfers). */
const SPONSOR = env("FAUCET_SPONSOR", "stead-sponsor.testnet");
if (!/^stead-sponsor\./.test(SPONSOR)) throw new Error(`refusing to use ${SPONSOR} as the faucet sponsor`);
const sponsorReady = (() => {
  try {
    nearKey(SPONSOR);
    return true;
  } catch {
    return false; // no key: the faucet answers 503, the demos run as before
  }
})();

interface Saved {
  gate: GateState;
  /** The sponsored faucet's limits (who was served when). */
  faucet?: FaucetState;
  /** NEAR-only visitors' sponsored actions done: "fund:<near>", "buyback:<rescue>", "repay:<position>" → time. */
  sponsorDone?: Record<string, number>;
  /** What the faucet and the sponsor sent each visitor (a week), for their page on any device. */
  receipts?: Receipts;
  /** Finished runs, newest first (kept across restarts for the page's history). */
  history?: { slot: number; kind: string; runId: string; rescueId: number | null; outcome: string; error: string | null; startedAt: number; endedAt: number; txs: RunTx[] }[];
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
/** "try to break it" attempts made, runId|action (each once per run). */
const tried = new Set<string>();
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
    tx: (label: string, chain: "near" | "sepolia", hash: string) => {
      (run().txs ??= []).push({ at: Date.now(), label, chain, hash });
      save();
    },
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
      saved.history = [{ slot: i, kind: saved.gate.slots[i].kind ?? DEMO_KINDS[i] ?? "single", runId: x.id, rescueId, outcome, error: x.error, startedAt: x.startedAt, endedAt: Date.now(), txs: x.txs ?? [] }, ...(saved.history ?? [])].slice(0, 30);
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
      run: s.run && { runId: s.run.id, startedAt: s.run.startedAt, step: s.run.step, stepText: STEP_TEXT[s.run.step], rescueId: s.run.rescueId, error: s.run.error, txs: s.run.txs ?? [] },
    })),
    free,
    nextStartAt: Math.max(now, saved.gate.lastStartAt + DEMO.gapMs),
    paused: !budget.canPayOne,
    leftToday: Math.max(0, budget.leftToday),
    recent: recent.filter((r) => now - r.endedAt < 30 * 60_000),
    history: (saved.history ?? []).slice(0, 12),
  };
}

const nearBalance = async (id: string): Promise<bigint | null> => {
  const r = await fetch(cfg.nearRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }), signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as { result?: { amount: string } };
  return j.result ? BigInt(j.result.amount) : null;
};
let faucetBusy = false;
/** Send one visitor's test funds: NEAR from the sponsor, Sepolia ETH from the reserve, LINK and DAI
 *  minted from Aave's public faucet. One at a time; every send is returned with its transaction. */
async function serveFaucet(body: string, origin: string | undefined, visitor: string): Promise<{ status: number; json: unknown }> {
  if (faucetBusy) return { status: 429, json: { error: "the faucet is serving someone else; try again in a few seconds" } };
  faucetBusy = true;
  try {
    saved.faucet ??= freshFaucet();
    const [reserveWei, sponsorYocto] = await Promise.all([pub.getBalance({ address: reserve.address }), nearBalance(SPONSOR)]);
    const v = checkFaucet(saved.faucet, Date.now(), body, origin, ORIGINS, visitor, { reserveWei, sponsorYocto: sponsorYocto ?? 0n });
    if (!v.ok) return { status: v.status, json: { error: v.error, nextAt: v.nextAt ?? null } };
    if ((await nearBalance(v.near)) === null) return { status: 400, json: { error: `${v.near} doesn't exist on NEAR testnet` } };
    recordFaucet(saved.faucet, Date.now(), v.near, v.evm, visitor);
    save();
    const A = await marketAssets();
    const sent: { label: string; chain: "near" | "sepolia"; hash: string }[] = [];
    const n = await account(SPONSOR).transfer({ receiverId: v.near, amount: FAUCET.nearYocto });
    sent.push({ label: `${Number(FAUCET.nearYocto / 10n ** 20n) / 10_000} NEAR to ${v.near}`, chain: "near", hash: (n as any).transaction?.hash ?? (n as any).transaction_outcome?.id ?? "" });
    const h = await reserve.sendTransaction({ to: v.evm as Address, value: FAUCET.ethWei, account: reserve.account!, chain: reserve.chain });
    await pub.waitForTransactionReceipt({ hash: h });
    sent.push({ label: `${Number(FAUCET.ethWei) / 1e18} Sepolia ETH`, chain: "sepolia", hash: h });
    sent.push({ label: `${FAUCET.link / 10n ** 18n} ${A.cSym} (Aave's test faucet)`, chain: "sepolia", hash: await write(reserve, cfg.aave.faucet!, faucetAbi, "mint", [A.collateral, v.evm, FAUCET.link]) });
    sent.push({ label: `${FAUCET.dai / 10n ** 18n} ${A.dSym} (Aave's test faucet)`, chain: "sepolia", hash: await write(reserve, cfg.aave.faucet!, faucetAbi, "mint", [A.debt, v.evm, FAUCET.dai]) });
    addReceipt((saved.receipts ??= {}), [`faucet:${v.near}`, `faucet:${v.evm.toLowerCase()}`], Date.now(), sent);
    save();
    say(`faucet ${v.near} ${v.evm}: ${sent.map((s) => s.hash.slice(0, 10)).join(" ")}`);
    return { status: 200, json: { sent } };
  } catch (e) {
    say(`faucet failed: ${scrub((e as Error).message)}`);
    return { status: 502, json: { error: "a send failed; nothing more was sent. Try again in a minute." } };
  } finally {
    faucetBusy = false;
  }
}

/** NEAR-only visitors: the sponsor holds the Sepolia side of their position. Acts only on a
 *  position the requesting NEAR account owns whose payout is the sponsor's address. */
async function serveSponsor(body: string, origin: string | undefined, visitor: string): Promise<{ status: number; json: unknown }> {
  if (faucetBusy) return { status: 429, json: { error: "the sponsor is serving someone else; try again in a few seconds" } };
  faucetBusy = true;
  try {
    saved.sponsorDone ??= {};
    const now = Date.now();
    for (const [k, t] of Object.entries(saved.sponsorDone)) if (now - t >= FAUCET.perWalletMs && !k.startsWith("buyback:")) delete saved.sponsorDone[k];
    const v = checkSponsor(body, origin, ORIGINS, saved.sponsorDone, now);
    if (!v.ok) return { status: v.status, json: { error: v.error } };
    const p = await view<{ owner: string; payout: string; evm_address: string | null; active_auction: number | null; open_rescues: number[] } | null>("get_position", { position_id: v.positionId });
    if (!p || p.owner !== v.near) return { status: 403, json: { error: `position ${v.positionId} isn't ${v.near}'s` } };
    if (p.payout.toLowerCase() !== reserve.address.toLowerCase() || !p.evm_address) return { status: 403, json: { error: "only positions whose payout is the sponsor's address are sponsored" } };
    const pos = p.evm_address as Address;
    const A = await marketAssets();
    const mint = async (token: Address, units: bigint) => write(reserve, cfg.aave.faucet!, faucetAbi, "mint", [token, pos, units]);
    const sent: { label: string; chain: "near" | "sepolia"; hash: string }[] = [];
    if (v.what === "fund") {
      saved.faucet ??= freshFaucet();
      const [reserveWei, sponsorYocto] = await Promise.all([pub.getBalance({ address: reserve.address }), nearBalance(SPONSOR)]);
      const day = new Date(now).toISOString().slice(0, 10);
      if (saved.faucet.day === day && saved.faucet.today >= FAUCET.perDay) return { status: 429, json: { error: "today's sponsored test funds are used up; try tomorrow" } };
      if (reserveWei < FAUCET.reserveFloorWei + SPONSORED.positionGasWei || (sponsorYocto ?? 0n) < FAUCET.sponsorFloorYocto + FAUCET.nearYocto) return { status: 503, json: { error: "the sponsor is being refilled" } };
      saved.sponsorDone[`fund:${v.near}`] = now;
      recordFaucet(saved.faucet, now, v.near, pos.toLowerCase(), visitor);
      save();
      const n = await account(SPONSOR).transfer({ receiverId: v.near, amount: FAUCET.nearYocto });
      sent.push({ label: `0.04 NEAR to ${v.near} for its Stead calls`, chain: "near", hash: (n as any).transaction?.hash ?? (n as any).transaction_outcome?.id ?? "" });
      if ((await pub.getBalance({ address: pos })) < SPONSORED.positionGasWei) {
        const h = await reserve.sendTransaction({ to: pos, value: SPONSORED.positionGasWei, account: reserve.account!, chain: reserve.chain });
        await pub.waitForTransactionReceipt({ hash: h });
        sent.push({ label: "0.0015 Sepolia ETH to your position for its gas", chain: "sepolia", hash: h });
      }
      const held = await balance(A.collateral, pos);
      if ((await accountData(pos)).collateralBase === 0n && held < SPONSORED.collateral) sent.push({ label: `${(SPONSORED.collateral - held) / 10n ** 18n} ${A.cSym} into your position (Aave's test faucet)`, chain: "sepolia", hash: await mint(A.collateral, SPONSORED.collateral - held) });
    } else if (v.what === "buyback") {
      const rid = p.open_rescues[0];
      if (rid === undefined) return { status: 409, json: { error: "no open claim to buy back" } };
      if (saved.sponsorDone[`buyback:${rid}`] !== undefined) return { status: 429, json: { error: "already paid for this rescue" } };
      const r = await view<{ state: string; members: { claim_id: string | null }[] }>("get_rescue", { rescue_id: rid });
      if (r.state !== "open") return { status: 409, json: { error: "the claims aren't open (yet): buy back once they are" } };
      const claims = await Promise.all(r.members.filter((m) => m.claim_id).map((m) => view<{ owed_units: string; status: string }>("get_claim", { token_id: m.claim_id })));
      const owed = claims.filter((c) => c.status === "open").reduce((s, c) => s + BigInt(c.owed_units), 0n);
      const held = await balance(A.collateral, pos);
      saved.sponsorDone[`buyback:${rid}`] = now;
      save();
      if (owed > held) sent.push({ label: `Buy-back: exactly the ${Number((owed - held) / 10n ** 12n) / 1e6} ${A.cSym} owed, into your position`, chain: "sepolia", hash: await mint(A.collateral, owed - held) });
    } else {
      if (p.active_auction !== null || p.open_rescues.length) return { status: 409, json: { error: "a rescue is still running on this position" } };
      const d = await accountData(pos);
      if (d.debtBase === 0n) return { status: 409, json: { error: "no debt to repay" } };
      const need = (d.debtBase * 10n ** BigInt(A.dDec) * 1002n) / 1000n / (await price(A.debt));
      const held = await balance(A.debt, pos);
      saved.sponsorDone[`repay:${v.positionId}`] = now;
      save();
      if (need > held) sent.push({ label: `${Number((need - held) / 10n ** 16n) / 100} ${A.dSym} into your position, to repay its debt`, chain: "sepolia", hash: await mint(A.debt, need - held) });
    }
    if (sent.length) {
      addReceipt((saved.receipts ??= {}), [v.what === "fund" ? `fund:${v.near}:${v.positionId}` : `${v.what}:${v.positionId}`], now, sent);
      save();
    }
    say(`sponsor ${v.what} ${v.near} position ${v.positionId}: ${sent.map((s) => s.hash.slice(0, 10)).join(" ") || "nothing needed"}`);
    return { status: 200, json: { sent, payout: reserve.address } };
  } catch (e) {
    say(`sponsor failed: ${scrub((e as Error).message)}`);
    return { status: 502, json: { error: "a send failed; try again in a minute." } };
  } finally {
    faucetBusy = false;
  }
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
  if (req.url?.split("?")[0] === "/demo/sponsor") {
    if (req.method !== "POST") return void res.writeHead(405, headers).end('{"error":"POST only"}');
    if (!sponsorReady) return void res.writeHead(503, headers).end('{"error":"the sponsor is not set up"}');
    const r = await serveSponsor(body, origin, visitorOf(req.headers, req.socket.remoteAddress));
    return void res.writeHead(r.status, headers).end(JSON.stringify(r.json));
  }
  if (req.url?.split("?")[0] === "/demo/receipts") {
    // read-only: a visitor's own sends, looked up by the ids their page already shows
    if (req.method !== "GET") return void res.writeHead(405, headers).end('{"error":"GET only"}');
    const q = new URL(req.url, "http://x").searchParams;
    return void res.writeHead(200, headers).end(JSON.stringify(receiptsFor(saved.receipts ?? {}, { near: q.get("near"), evm: q.get("evm"), position: q.get("position") })));
  }
  if (req.url?.split("?")[0] === "/demo/faucet") {
    if (req.method !== "POST") return void res.writeHead(405, headers).end('{"error":"POST only"}');
    if (!sponsorReady) return void res.writeHead(503, headers).end('{"error":"the faucet is not set up"}');
    const r = await serveFaucet(body, origin, visitorOf(req.headers, req.socket.remoteAddress));
    return void res.writeHead(r.status, headers).end(JSON.stringify(r.json));
  }
  if (req.url?.split("?")[0] === "/demo/try") {
    if (req.method !== "POST") return void res.writeHead(405, headers).end('{"error":"POST only"}');
    const c = checkTry(body, origin, ORIGINS, saved.gate, tried);
    if (!c.ok) return void res.writeHead(c.status, headers).end(JSON.stringify({ error: c.error }));
    const run = saved.gate.slots[c.slot].run!;
    tried.add(`${run.id}|${c.action}`);
    const r = await new DemoRun(slotOf(c.slot), { step: () => {}, log: () => {} }).tryBreak(c.action);
    if (r.hash) {
      (run.txs ??= []).push({ at: Date.now(), label: `A visitor tried: ${BREAK_TEXT[c.action]} : ${r.refused ? `refused by the contract ("${r.message}")` : "ACCEPTED"}`, chain: "near", hash: r.hash });
      save();
    }
    say(`[slot ${c.slot}] try ${c.action}: ${r.refused ? "refused" : "ACCEPTED"} ${r.message} ${r.hash ?? ""}`);
    return void res.writeHead(200, headers).end(JSON.stringify(r));
  }
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

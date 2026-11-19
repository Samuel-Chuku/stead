// Demo rescues started from the web page: the parts with no chain access, so each rule is tested
// on its own. Who may start a run (slots, spacing, one start per visitor), how many runs the test
// funds allow today, how the buy-back and the reset are sized, and the HTTP answers.
// The chain steps live in demorun.ts.

export const DEMO = {
  /** Runs at the same time: one per demo borrower, each with its own position. */
  slots: 2,
  /** Between any two starts. */
  gapMs: 2 * 60_000,
  /** Between two starts from the same visitor, so one visitor can't hold both slots. */
  perVisitorMs: 10 * 60_000,
  /** The position rests here between runs, above the 1.15 trigger. */
  baseHfBps: 11_700,
  /** A run borrows down to here, below the trigger, so the keeper's proven reading opens an auction. */
  triggerHfBps: 11_400,
  /** Collateral at rest, in USD: the top-up to 1.50 is then about $570, which one steward covers. */
  collateralUsd: 1_800,
  /** The pooled demo's collateral at rest: a top-up of about $1,900, more than any one steward's
   *  capacity (25 LINK each on the demo stack), so three stewards share it. */
  collateralUsdPooled: 6_000,
  /** Budget pacing spreads the test funds until this date (the hosted demo stays up through judging). */
  endMs: Date.UTC(2026, 10, 25),
  /** Sepolia gas for one demo run, everyone's transactions (measured ~1.9 M on a pooled rescue). */
  gasPerRun: 2_000_000n,
  /** NEAR for one run (the reporter's proven reads; measured 0.076). */
  nearPerRunYocto: 80_000_000_000_000_000_000_000n,
} as const;

// ── who may start ────────────────────────────────────────────────────────────────────────────

/** What a demo slot shows: one steward covering the top-up, or several sharing it. */
export type DemoKind = "single" | "pooled";
export const DEMO_KINDS: DemoKind[] = ["single", "pooled"];

export interface SlotState {
  kind?: DemoKind;
  /** null when free. */
  run: null | { id: string; token: string; startedAt: number; step: Step; rescueId: number | null; error: string | null; endedAt: number | null; txs?: RunTx[] };
}
/** One transaction a demo run sent, labelled for the page. */
export type RunTx = { at: number; label: string; chain: "near" | "sepolia"; hash: string; /** the run's step when it was sent ("reset" = putting the position back to rest, not part of the rescue) */ step?: Step };

export interface GateState {
  slots: SlotState[];
  lastStartAt: number;
  /** visitor key → last start time. */
  visitors: Record<string, number>;
  /** start token → run id, so a repeated click never starts a second run. */
  tokens: Record<string, string>;
  /** UTC day (YYYY-MM-DD) and the number of starts on it, for budget pacing. */
  day: string;
  startsToday: number;
}
/** Slot i runs DEMO_KINDS[i]: slot 0 single, slot 1 pooled. */
export const freshGate = (slots: number = DEMO.slots): GateState => ({ slots: Array.from({ length: slots }, (_, i) => ({ kind: DEMO_KINDS[i] ?? "single", run: null })), lastStartAt: 0, visitors: {}, tokens: {}, day: "", startsToday: 0 });
const kindOf = (g: GateState, i: number): DemoKind => g.slots[i].kind ?? DEMO_KINDS[i] ?? "single";

export interface Budget {
  /** Runs today's allowance still permits (the allowance minus starts so far). */
  leftToday: number;
  /** false when the funds can't pay for even one whole run: the demo pauses. */
  canPayOne: boolean;
}
export type Refusal = "busy" | "too_soon" | "visitor_wait" | "over_allowance" | "paused";
export type Admit = { ok: true; slot: number; runId: string; repeat: boolean } | { ok: false; reason: Refusal; nextAt: number | null };

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const nextDay = (ms: number) => Date.parse(dayOf(ms)) + 86_400_000;

/** Decide a start. Pure: the caller stores `g` afterwards. Order: a repeated token answers with its
 *  run; then funds, slots, spacing, the visitor. A refusal says when a start is next possible. */
export function admit(g: GateState, now: number, visitor: string, token: string, budget: Budget, kind: DemoKind = "single"): Admit {
  const known = g.tokens[token];
  if (known) {
    const slot = g.slots.findIndex((s) => s.run?.id === known);
    return { ok: true, slot, runId: known, repeat: true };
  }
  if (!budget.canPayOne) return { ok: false, reason: "paused", nextAt: null };
  if (g.day !== dayOf(now)) {
    g.day = dayOf(now);
    g.startsToday = 0;
  }
  if (budget.leftToday <= 0) return { ok: false, reason: "over_allowance", nextAt: nextDay(now) };
  // the slot that runs this kind of demo (one each)
  const free = g.slots.findIndex((s, i) => kindOf(g, i) === kind && s.run === null);
  if (free < 0) {
    // a slot frees when its run ends (including the off-screen reset): no fixed time to promise
    return { ok: false, reason: "busy", nextAt: null };
  }
  if (now - g.lastStartAt < DEMO.gapMs) return { ok: false, reason: "too_soon", nextAt: g.lastStartAt + DEMO.gapMs };
  const last = g.visitors[visitor];
  if (last !== undefined && now - last < DEMO.perVisitorMs) return { ok: false, reason: "visitor_wait", nextAt: last + DEMO.perVisitorMs };

  const runId = `${now.toString(36)}-${free}`;
  g.slots[free].run = { id: runId, token, startedAt: now, step: "trigger", rescueId: null, error: null, endedAt: null };
  g.lastStartAt = now;
  g.visitors[visitor] = now;
  g.tokens[token] = runId;
  g.startsToday += 1;
  // forget visitors and tokens nobody can repeat any more (keeps the state file small)
  for (const [v, t] of Object.entries(g.visitors)) if (now - t >= DEMO.perVisitorMs) delete g.visitors[v];
  const live = new Set(g.slots.map((s) => s.run?.id).filter(Boolean));
  for (const [t, id] of Object.entries(g.tokens)) if (!live.has(id) && t !== token) delete g.tokens[t];
  return { ok: true, slot: free, runId, repeat: false };
}

/** A visitor key from the request: Cloudflare's connecting-IP header (the runner is reachable only
 *  through the tunnel), else the socket address. */
export function visitorOf(headers: Record<string, string | string[] | undefined>, socketAddr: string | undefined): string {
  const h = headers["cf-connecting-ip"];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  return v && /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : socketAddr ?? "unknown";
}

// ── budget pacing ────────────────────────────────────────────────────────────────────────────

/** Runs the funds allow per day until DEMO.endMs, with a 1.5x margin on gas. Two limits: the
 *  Sepolia ETH reserve at the current gas price, and the reporter's NEAR. */
export function allowancePerDay(a: { reserveWei: bigint; gasPriceWei: bigint; reporterYocto: bigint; now: number; endMs?: number }): { perDay: number; canPayOne: boolean } {
  const runWei = (DEMO.gasPerRun * a.gasPriceWei * 3n) / 2n;
  const ethRuns = runWei === 0n ? 1_000_000n : a.reserveWei / runWei;
  const nearRuns = a.reporterYocto / DEMO.nearPerRunYocto;
  const runs = ethRuns < nearRuns ? ethRuns : nearRuns;
  const days = Math.max(1, Math.ceil(((a.endMs ?? DEMO.endMs) - a.now) / 86_400_000));
  return { perDay: Math.floor(Number(runs) / days), canPayOne: runs >= 1n };
}

/** Sepolia ETH to send from the reserve: each wallet below its floor is filled to its target. */
export function refuelPlan(wallets: { address: string; balanceWei: bigint; floorWei: bigint; targetWei: bigint }[], reserveWei: bigint): { to: string; wei: bigint }[] {
  const out: { to: string; wei: bigint }[] = [];
  let left = reserveWei;
  for (const w of wallets) {
    if (w.balanceWei >= w.floorWei) continue;
    const need = w.targetWei - w.balanceWei;
    if (need <= 0n || need > left) continue;
    out.push({ to: w.address, wei: need });
    left -= need;
  }
  return out;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────

export type Step = "trigger" | "reading" | "auction" | "topup" | "buyback" | "payouts" | "settling" | "reset" | "done" | "stopped";
/** What the page shows for each step (the runner's own steps; the board takes over from the auction). */
export const STEP_TEXT: Record<Step, string> = {
  trigger: "Demo borrower borrows on Aave Sepolia",
  reading: "Waiting for the proven reading",
  auction: "Auction open",
  topup: "Winner tops up on Sepolia",
  buyback: "Demo borrower buys back",
  payouts: "Claim owner paid",
  settling: "Buy-back missed: settlement running",
  reset: "Resetting the demo position",
  done: "Done",
  stopped: "Stopped",
};
/** Deadlines per step (ms): a run past one stops and says where. */
export const STEP_DEADLINE_MS: Partial<Record<Step, number>> = {
  trigger: 3 * 60_000,
  reading: 3 * 60_000,
  auction: 3 * 60_000,
  topup: 5 * 60_000,
  buyback: 5 * 60_000,
  payouts: 10 * 60_000,
  settling: 20 * 60_000,
  reset: 5 * 60_000,
};

export interface ChainView {
  /** Aave's HF on the position, in bps (unverified RPC view; only used to pick a step). */
  hfBps: number;
  collateralUnits: bigint;
  restUnits: bigint;
  activeAuction: number | null;
  openRescues: number[];
  /** State of the rescue in progress (the active auction or the first open rescue). */
  rescueState: string | null;
  outflows: number;
}
/** Where a run stands, from chain state only, so a restarted runner picks up at the right step. */
export function stepOf(v: ChainView): Step {
  if (v.activeAuction !== null || v.openRescues.length) {
    switch (v.rescueState) {
      case "auction":
        return "auction";
      case "top_up_pending":
        return "topup";
      case "open":
        return "buyback";
      case "settling":
        return "settling";
      default:
        return "payouts"; // closed but still listed: payouts going out
    }
  }
  if (v.outflows > 0) return "payouts";
  if (v.hfBps < 11_500) return "reading"; // below the trigger, no auction yet: the proven reading is pending
  // off its resting point (collateral grew by the top-up, or HF away from 1.17): reset first
  const drift = v.collateralUnits > v.restUnits ? v.collateralUnits - v.restUnits : v.restUnits - v.collateralUnits;
  if (drift * 100n > v.restUnits || Math.abs(v.hfBps - DEMO.baseHfBps) > 150) return "reset";
  return "trigger";
}

/** The buy-back the demo borrower pays: exactly the owed units of every open claim, in the claim
 *  asset. The contract pays each claim owner exactly that, so nothing is left to refund. */
export function buybackUnits(claims: { owed_units: string; status: string }[]): bigint {
  return claims.filter((c) => c.status === "open").reduce((s, c) => s + BigInt(c.owed_units), 0n);
}

export interface ResetIn {
  collateralBase: bigint;
  debtBase: bigint;
  ltBps: bigint;
  /** Aave oracle prices (8 decimals, USD). */
  priceC: bigint;
  priceD: bigint;
  cDec: number;
  dDec: number;
  restUnits: bigint;
}
/** Bring the position back to rest: collateral `restUnits`, HF 1.17. Supply what's missing, repay
 *  or borrow to the debt that gives 1.17 on the resting collateral, then withdraw the extra
 *  collateral (never past 1.17). Withdraw goes to the borrower's own payout (the contract's rule). */
export function resetPlan(a: ResetIn): { supplyUnits: bigint; repayUnits: bigint; borrowUnits: bigint; withdrawUnits: bigint } {
  const cu = 10n ** BigInt(a.cDec), du = 10n ** BigInt(a.dDec);
  const collUnits = (a.collateralBase * cu) / a.priceC;
  const supplyUnits = collUnits < a.restUnits ? a.restUnits - collUnits : 0n;
  const restBase = (a.restUnits * a.priceC) / cu;
  const targetDebt = (restBase * a.ltBps) / BigInt(DEMO.baseHfBps);
  const repayBase = a.debtBase > targetDebt ? a.debtBase - targetDebt : 0n;
  const borrowBase = targetDebt > a.debtBase ? targetDebt - a.debtBase : 0n;
  // ignore dust (< $1): interest moves the debt every block
  const repayUnits = repayBase >= 100_000_000n ? (repayBase * du + a.priceD - 1n) / a.priceD : 0n;
  const borrowUnits = borrowBase >= 100_000_000n ? (borrowBase * du) / a.priceD : 0n;
  // after the debt change, keep collateral ≥ debt · 1.17 / LT (+0.2 % for interest and rounding)
  const debtAfter = repayUnits ? targetDebt : borrowUnits ? targetDebt : a.debtBase;
  const needBase = (((debtAfter * BigInt(DEMO.baseHfBps)) / a.ltBps) * 1002n) / 1000n;
  const collAfter = a.collateralBase + (supplyUnits * a.priceC) / cu;
  const spareBase = collAfter > needBase ? collAfter - needBase : 0n;
  const extra = collUnits > a.restUnits ? collUnits - a.restUnits : 0n;
  const spare = (spareBase * cu) / a.priceC;
  const withdrawUnits = extra < spare ? extra : spare;
  return { supplyUnits, repayUnits, borrowUnits: repayUnits ? 0n : borrowUnits, withdrawUnits: withdrawUnits * a.priceC >= cu ? withdrawUnits : 0n };
}

/** The runner signs only for the demo borrowers. Checked at start-up: a configuration that names
 *  any other account (the main borrower, the reporter, a steward, the contract) is refused. */
export function checkSigners(demoAccounts: string[], forbidden: string[]): void {
  if (!demoAccounts.length) throw new Error("no demo borrower accounts configured");
  for (const a of demoAccounts) {
    if (!/^demo(-\d+)?\.[a-z0-9._-]+$/.test(a)) throw new Error(`refusing to sign for ${a}: not a demo borrower account`);
    if (forbidden.includes(a)) throw new Error(`refusing to sign for ${a}: reserved account`);
  }
  if (new Set(demoAccounts).size !== demoAccounts.length) throw new Error("a demo account is listed twice");
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

export interface HttpIn {
  method: string;
  path: string;
  origin: string | undefined;
  body: string;
  visitor: string;
}
export interface HttpOut {
  status: number;
  json: unknown;
}
export const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_BODY = 1024;
const REFUSAL_TEXT: Record<Refusal, string> = {
  busy: "That demo is already running. Watch it live; it can start again when it finishes.",
  too_soon: "A demo rescue started less than 2 minutes ago.",
  visitor_wait: "You started a demo rescue recently. One start per visitor every 10 minutes.",
  over_allowance: "Today's demo runs are used up; the test funds are paced to last through judging.",
  paused: "Demo paused: refilling test funds. Recorded rescues play meanwhile.",
};

/** Route one request. `start` is called only for an admitted, new run; `status` builds the status. */
export function route(req: HttpIn, d: { allowedOrigins: string[]; now: number; gate: GateState; budget: () => Budget; start: (slot: number, runId: string) => void; status: () => unknown; save: () => void }): HttpOut {
  if (req.path === "/demo/status") {
    if (req.method !== "GET") return { status: 405, json: { error: "GET only" } };
    return { status: 200, json: d.status() };
  }
  if (req.path !== "/demo/start") return { status: 404, json: { error: "not found" } };
  if (req.method !== "POST") return { status: 405, json: { error: "POST only" } };
  if (!req.origin || !d.allowedOrigins.includes(req.origin)) return { status: 403, json: { error: "origin not allowed" } };
  if (req.body.length > MAX_BODY) return { status: 400, json: { error: "body too large" } };
  let token: unknown;
  let kind: unknown;
  try {
    const b = JSON.parse(req.body) as Record<string, unknown>;
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "token" && k !== "kind")) throw new Error();
    token = b.token;
    kind = b.kind ?? "single";
  } catch {
    return { status: 400, json: { error: "body must be {\"token\": \"…\", \"kind\": \"single\" | \"pooled\"}" } };
  }
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { status: 400, json: { error: "bad token" } };
  if (kind !== "single" && kind !== "pooled") return { status: 400, json: { error: "bad kind" } };
  const a = admit(d.gate, d.now, req.visitor, token, d.budget(), kind);
  if (!a.ok) return { status: 429, json: { started: false, reason: a.reason, message: REFUSAL_TEXT[a.reason], nextAt: a.nextAt } };
  if (!a.repeat) {
    d.save();
    d.start(a.slot, a.runId);
  }
  return { status: a.repeat ? 200 : 202, json: { started: true, slot: a.slot, runId: a.runId } };
}

// ── "try to break it": a visitor asks the demo borrower to do what a locked position forbids ──

export type BreakAction = "withdraw" | "borrow";
export const BREAK_TEXT: Record<BreakAction, string> = {
  withdraw: "Withdraw 1 LINK of collateral while the claim is open",
  borrow: "Borrow 1 DAI more while the claim is open",
};
/** The run steps during which the position is locked (auction open or a claim open). */
const LOCKED: Step[] = ["auction", "topup", "buyback"];

/** Check a "try" request: `{runId, action}` for a run in progress whose position is locked; each
 *  action once per run. Pure: the caller records the attempt. */
export function checkTry(body: string, origin: string | undefined, allowedOrigins: string[], g: GateState, tried: Set<string>): { ok: true; slot: number; action: BreakAction } | { ok: false; status: number; error: string } {
  if (!origin || !allowedOrigins.includes(origin)) return { ok: false, status: 403, error: "origin not allowed" };
  if (body.length > MAX_BODY) return { ok: false, status: 400, error: "body too large" };
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(body);
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "runId" && k !== "action")) throw new Error();
  } catch {
    return { ok: false, status: 400, error: 'body must be {"runId": "…", "action": "withdraw" | "borrow"}' };
  }
  const { runId, action } = b as { runId: unknown; action: unknown };
  if (action !== "withdraw" && action !== "borrow") return { ok: false, status: 400, error: "bad action" };
  if (typeof runId !== "string" || !/^[a-z0-9-]{3,40}$/.test(runId)) return { ok: false, status: 400, error: "bad runId" };
  const slot = g.slots.findIndex((x) => x.run?.id === runId);
  if (slot < 0) return { ok: false, status: 404, error: "that demo run isn't running" };
  if (!LOCKED.includes(g.slots[slot].run!.step)) return { ok: false, status: 409, error: "the position is only locked from the auction until the buy-back; try again then" };
  if (tried.has(`${runId}|${action}`)) return { ok: false, status: 409, error: "already tried on this run" };
  return { ok: true, slot, action };
}

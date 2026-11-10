// LIVE mode: follows real rescues through the read-only live feed (stewards/scripts/live-feed.ts).
// The board is the same pure function of (event log, time) as REPLAY; here the log grows as the
// chains record events and the time is the chain's clock minus a fixed broadcast delay, so every
// event plays at its true moment. Nothing loops. When the feed can't see the chain, the board says
// so instead of claiming that nothing is open.
import type { FeedRescue, LiveFeed } from "../../../stewards/src/livefeed";
import { boardAt, isPooled } from "./model";
import { bindModeSwitch, modeSwitch, mountBoard, type BoardMode } from "./view";

/** Seconds the board runs behind the chain: the feed sees an event ~3–5 s after it lands. */
export const DELAY_S = 6;
/** No answer from the feed for this long (or a feed that says it is stale) = the board shows an error. */
export const NO_ANSWER_MS = 15_000;
/** A feed snapshot whose last cycle is older than this is stale even if the server answers. */
export const CYCLE_STALE_MS = 20_000;

export type LiveScreen =
  | { kind: "loading" }
  | { kind: "stale"; ageS: number | null; reason: string }
  | { kind: "empty"; watching: number | null }
  | { kind: "rescue"; rescue: FeedRescue; all: FeedRescue[] };

/** Board time for a rescue: chain time since the opening, minus the delay. Never moves backwards. */
export function liveT(clientNowMs: number, skewMs: number, openedAtMs: number, prevT: number | null = null): number {
  const t = (clientNowMs + skewMs - openedAtMs) / 1000 - DELAY_S;
  return prevT === null ? t : Math.max(prevT, t);
}

/** What the LIVE board shows, from the last feed snapshot and when it arrived. */
export function screenFor(feed: LiveFeed | null, lastOkMs: number | null, startedMs: number, nowMs: number, picked?: string, only?: (r: FeedRescue) => boolean): LiveScreen {
  if (!feed || lastOkMs === null) {
    return nowMs - startedMs < NO_ANSWER_MS ? { kind: "loading" } : { kind: "stale", ageS: null, reason: "The live feed is not answering." };
  }
  const silentMs = nowMs - lastOkMs;
  const cycleAgeMs = feed.nowMs - Date.parse(feed.generated);
  if (silentMs > NO_ANSWER_MS) return { kind: "stale", ageS: Math.round((silentMs + cycleAgeMs) / 1000), reason: "The live feed stopped answering." };
  if (feed.stale || cycleAgeMs > CYCLE_STALE_MS) return { kind: "stale", ageS: Math.round(cycleAgeMs / 1000), reason: "The live feed has not read NEAR testnet recently." };
  const rescues = only ? feed.rescues.filter(only) : feed.rescues;
  if (!rescues.length) return { kind: "empty", watching: feed.watching };
  const rescue = rescues.find((r) => r.key === picked) ?? rescues[0];
  return { kind: "rescue", rescue, all: rescues };
}

// ── DEMO: a visitor starts a real testnet rescue on a demo borrower's position ──

export type DemoStep = "trigger" | "reading" | "auction" | "topup" | "buyback" | "payouts" | "settling" | "reset" | "done" | "stopped";
export type DemoRunView = { runId: string; startedAt: number; step: DemoStep; stepText: string; rescueId: number | null; error: string | null };
export type DemoStatus = {
  generated: number;
  slots: { slot: number; positionId: number | null; run: DemoRunView | null }[];
  free: number;
  nextStartAt: number | null;
  paused: boolean;
  leftToday: number;
  recent: { slot: number; runId: string; rescueId: number | null; outcome: string; error: string | null; startedAt: number; endedAt: number }[];
};
/** The steps a demo run shows, in order (settling replaces buy-back when the window runs out). */
export const DEMO_STEPS: { id: DemoStep; title: string }[] = [
  { id: "trigger", title: "Borrow below 1.15" },
  { id: "reading", title: "Proven reading" },
  { id: "auction", title: "Auction" },
  { id: "topup", title: "Top-up" },
  { id: "buyback", title: "Buy-back" },
  { id: "payouts", title: "Paid" },
];
const STEP_ORDER: DemoStep[] = ["trigger", "reading", "auction", "topup", "buyback", "settling", "payouts", "reset", "done"];

/** Whether the START button is live, and the reason line when it isn't. */
export function startState(st: DemoStatus | null, nowMs: number, mineRunning: boolean): { can: boolean; reason: string } {
  if (!st) return { can: false, reason: "Demo runner not answering." };
  if (st.paused) return { can: false, reason: "Demo paused: refilling test funds. Recorded rescues play meanwhile." };
  if (mineRunning) return { can: false, reason: "Your demo rescue is running below." };
  if (st.leftToday <= 0) return { can: false, reason: "Today's demo runs are used up; the test funds are paced to last through judging." };
  if (!st.free) return { can: false, reason: "Two demo rescues are running. Watch them below; the next one can start when one finishes." };
  if (st.nextStartAt !== null && st.nextStartAt > nowMs) return { can: false, reason: `Next start possible at ${hhmm(st.nextStartAt)}.` };
  return { can: true, reason: "" };
}
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Step index for the stepper: done < current < pending. Reset and done count as past "Paid". */
export function stepIndex(step: DemoStep): number {
  if (step === "settling") return 4;
  if (step === "reset" || step === "done") return DEMO_STEPS.length;
  return Math.max(0, DEMO_STEPS.findIndex((s) => s.id === step));
}

/** Which rescues DEMO shows: only those on the demo positions, the visitor's own first. */
export function demoPick(st: DemoStatus | null, mine: string | null): { positions: Set<number>; rescueId: number | null } {
  const positions = new Set((st?.slots ?? []).map((s) => s.positionId).filter((p): p is number => p !== null));
  const own = st?.slots.find((s) => s.run?.runId === mine)?.run ?? null;
  const any = st?.slots.find((s) => s.run?.rescueId !== null && s.run?.rescueId !== undefined)?.run ?? null;
  return { positions, rescueId: own?.rescueId ?? any?.rescueId ?? null };
}

/** The live feed (and the demo runner behind it): VITE_LIVE_FEED if set; the local feed when the app
 *  itself runs locally; otherwise the public one. */
const feedUrl = () =>
  (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");

function quietAnnunciator(mode: BoardMode) {
  const lamps = ["TRIGGER", "AUCTION", "TOP-UP", "CLAIM OPEN", "TRIP"];
  return `<header class="st-annunciator" aria-label="Status">
      <div class="st-lamps">${lamps.map((l) => `<div class="st-lamp-cell"><span class="st-dot" aria-hidden="true"></span>${l}</div>`).join("")}</div>
      <div class="st-annunciator-right">${modeSwitch(mode)}</div>
    </header>`;
}

const MINE_KEY = "stead-demo-run";
const readMine = () => {
  try {
    return sessionStorage.getItem(MINE_KEY);
  } catch {
    return null;
  }
};
const writeMine = (v: string) => {
  try {
    sessionStorage.setItem(MINE_KEY, v);
  } catch {
    /* private window: the run still shows, just not after a reload */
  }
};
const newToken = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

export function mountLive(root: HTMLElement, onMode: (m: BoardMode) => void, mode: "live" | "demo" = "live"): () => void {
  const demo = mode === "demo";
  const started = Date.now();
  let feed: LiveFeed | null = null;
  let lastOk: number | null = null;
  let skew = 0;
  let picked: string | undefined;
  let screenKey = "";
  let view: ReturnType<typeof mountBoard> | null = null;
  let t: number | null = null;
  let raf = 0;
  let timer = 0;
  let demoTimer = 0;
  let gone = false;
  // DEMO state
  let status: DemoStatus | null = null;
  let mine: string | null = demo ? readMine() : null;
  let sending = false;
  let refusal: string | null = null;
  let demoKey = "";

  root.innerHTML = demo ? `<section class="st-panel st-demo" data-demo aria-label="Demo rescue"></section><div data-stage></div>` : `<div data-stage></div>`;
  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const ctl = root.querySelector<HTMLElement>("[data-demo]");

  async function poll() {
    try {
      const sent = Date.now();
      const r = await fetch(`${feedUrl()}/live.json`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      if (r.ok) {
        const f: LiveFeed = await r.json();
        const got = Date.now();
        feed = f;
        lastOk = got;
        skew = f.nowMs - (sent + got) / 2; // the feed's clock vs ours, half the round trip either side
      }
    } catch {
      // no answer: screenFor turns a long silence into the error panel
    }
    if (gone) return;
    const busy = feed?.rescues.some((x) => x.contractState === "auction");
    timer = window.setTimeout(poll, busy ? 1000 : 2000);
  }

  async function pollDemo() {
    try {
      const r = await fetch(`${feedUrl()}/demo/status`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      status = r.ok ? await r.json() : null;
    } catch {
      status = null;
    }
    if (gone) return;
    renderDemo();
    demoTimer = window.setTimeout(pollDemo, 3000);
  }

  async function start() {
    if (sending) return;
    sending = true;
    refusal = null;
    renderDemo(true);
    try {
      const r = await fetch(`${feedUrl()}/demo/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: newToken() }), signal: AbortSignal.timeout(10_000) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.runId) {
        mine = j.runId;
        writeMine(j.runId);
      } else refusal = j.message ?? j.error ?? "The demo runner refused the start.";
    } catch {
      refusal = "The demo runner did not answer. Try again in a minute.";
    }
    sending = false;
    await pollDemo().catch(() => {});
  }

  function renderDemo(force = false) {
    if (!ctl) return;
    const now = Date.now();
    const own = status?.slots.find((s) => s.run?.runId === mine)?.run ?? null;
    const ended = status?.recent.find((r) => r.runId === mine) ?? null;
    const gate = startState(status, now, !!own);
    const free = status ? `${status.slots.length} demo slots · ${status.free} free` : "demo runner not answering";
    const key = JSON.stringify([gate, free, own?.step, own?.rescueId, own?.error, ended?.outcome, sending, refusal]);
    if (key === demoKey && !force) return;
    demoKey = key;
    const idx = own ? stepIndex(own.step) : -1;
    const stepper = own
      ? `<ol class="st-demo-steps" aria-label="Your demo rescue">${DEMO_STEPS.map((s, i) => {
          const title = s.id === "buyback" && own.step === "settling" ? "Settlement" : s.title;
          return `<li class="${i < idx ? "is-done" : i === idx ? "is-now" : ""}"${i === idx ? ' aria-current="step"' : ""}><span class="st-demo-dot" aria-hidden="true"></span>${title}</li>`;
        }).join("")}</ol>
        <p class="st-demo-now">${own.rescueId !== null ? `Rescue ${own.rescueId} · ` : ""}${esc(own.stepText)}${own.error ? ` · <span class="st-demo-err">${esc(own.error)}; retrying from the chain state</span>` : ""}</p>`
      : ended
        ? `<p class="st-demo-now">Your demo rescue${ended.rescueId !== null ? ` ${ended.rescueId}` : ""} ended: ${ended.outcome === "bought_back" ? "bought back, the steward paid exactly what it was owed" : ended.outcome === "settled" ? "the buy-back window ran out and the claim was settled" : esc(ended.outcome)}.</p>`
        : "";
    ctl.innerHTML = `
      <div class="st-demo-head">
        <div>
          <div class="st-label">DEMO · NEAR TESTNET AND SEPOLIA</div>
          <h2 class="st-demo-title">Start a real rescue</h2>
          <p class="st-demo-body">A demo borrower borrows on Aave Sepolia until its health factor falls below 1.15. The keeper's proven reading opens a real auction; the stewards bid, top up, and are paid back. About 4 minutes, all on testnets.</p>
        </div>
        <div class="st-demo-go">
          <button type="button" class="st-push st-cut" data-demo-start${gate.can && !sending ? "" : ' aria-disabled="true"'}><span class="st-lamp" aria-hidden="true"></span>${sending ? "SENDING…" : "START A DEMO RESCUE"}</button>
          <p class="st-demo-reason" role="status">${esc(refusal ?? (gate.can ? `${free} · next start possible now` : `${free} · ${gate.reason}`))}</p>
        </div>
      </div>
      ${stepper}`;
    ctl.querySelector("[data-demo-start]")!.addEventListener("click", () => {
      if (gate.can && !sending) void start();
    });
  }

  function render(s: LiveScreen) {
    // rebuild the DOM only when what is on screen changes shape; otherwise update in place
    const key = s.kind === "rescue" ? `rescue|${s.rescue.key}|${isPooled(s.rescue)}|${!!s.rescue.atOpen}|${s.all.map((r) => r.key).join(",")}` : s.kind === "stale" ? `stale|${s.reason}` : s.kind;
    if (key !== screenKey) {
      screenKey = key;
      view = null;
      t = null;
      if (s.kind === "loading") {
        stage.innerHTML = `<div class="st-board st-live">${quietAnnunciator(mode)}
          <section class="st-panel st-calm" aria-busy="true"><div class="st-label">${demo ? "DEMO RESCUES" : "LIVE AUCTIONS"}</div><div class="st-gauge-loading" aria-hidden="true"><span></span></div><p class="st-empty">connecting…</p></section></div>`;
      } else if (s.kind === "empty") {
        stage.innerHTML = demo
          ? `<div class="st-board st-live">${quietAnnunciator(mode)}
          <section class="st-panel st-calm" aria-label="No demo rescue open">
            <h2 class="st-calm-title" data-demo-wait-title>No demo rescue open.</h2>
            <p class="st-calm-body" data-demo-wait>When a demo borrower's reading is proven below 1.15, its auction plays here, 6 s behind the chain.</p>
            <button type="button" class="st-secondary st-cut" data-watch-replay>Watch a recorded rescue</button>
          </section></div>`
          : `<div class="st-board st-live">${quietAnnunciator(mode)}
          <section class="st-panel st-calm" aria-label="No open auction">
            <h2 class="st-calm-title">All positions above the trigger.</h2>
            <p class="st-calm-body">${s.watching !== null ? `Stewards are watching ${s.watching} position${s.watching === 1 ? "" : "s"}.` : "Stewards are watching every registered position."} The next auction opens the moment one falls below 1.15.</p>
            <button type="button" class="st-secondary st-cut" data-watch-replay>Watch a recorded rescue</button>
          </section></div>`;
        stage.querySelector("[data-watch-replay]")!.addEventListener("click", () => onMode("replay"));
      } else if (s.kind === "stale") {
        stage.innerHTML = `<div class="st-board st-live">${quietAnnunciator(mode)}
          <section class="st-error" role="alert"><h2>Live feed not updating</h2><p data-stale-body></p></section></div>`;
      } else {
        const r = s.rescue;
        const choices = s.all.length > 1 ? s.all.map((x) => ({ id: x.key, label: `RESCUE ${x.rescueId}` })) : undefined;
        view = mountBoard(stage, r, { onToggle() {}, mode, onMode, delayS: DELAY_S, replays: choices, current: r.key, onPick(id) { picked = id; } });
      }
      if (s.kind !== "rescue") bindModeSwitch(stage, mode, onMode);
    }
    if (s.kind === "stale") {
      const el = stage.querySelector("[data-stale-body]");
      if (el) el.textContent = `${s.reason}${s.ageS !== null ? ` Last reading was ${s.ageS} s ago.` : ""} The board shows nothing rather than an old state. Retrying every 2 s.`;
    }
    if (demo && s.kind === "empty") {
      // a run that hasn't reached its auction yet: say which step it is on, not "nothing open"
      const prep = status?.slots.map((x) => x.run).find((r) => r && r.rescueId === null && (r.step === "trigger" || r.step === "reading"));
      const title = stage.querySelector("[data-demo-wait-title]"), body = stage.querySelector("[data-demo-wait]");
      const want = prep ? ["A demo rescue is starting.", `${prep.stepText}. Its auction plays here the moment the reading is proven below 1.15, 6 s behind the chain.`] : ["No demo rescue open.", "When a demo borrower's reading is proven below 1.15, its auction plays here, 6 s behind the chain."];
      if (title && title.textContent !== want[0]) title.textContent = want[0];
      if (body && body.textContent !== want[1]) body.textContent = want[1];
    }
    if (s.kind === "rescue" && view) {
      t = liveT(Date.now(), skew, s.rescue.openedAtMs, t);
      view.update(boardAt(s.rescue, t));
    }
  }

  function frame() {
    if (demo) {
      // only the demo positions' rescues; the visitor's own run first unless they picked another
      const d = demoPick(status, mine);
      const pick = picked ?? (d.rescueId !== null && feed ? feed.rescues.find((r) => r.rescueId === d.rescueId && d.positions.has(r.positionId))?.key : undefined);
      render(screenFor(feed, lastOk, started, Date.now(), pick, (r) => d.positions.has(r.positionId) && r.contract === DEMO_CONTRACT));
    } else render(screenFor(feed, lastOk, started, Date.now(), picked));
    raf = requestAnimationFrame(frame);
  }
  void poll();
  if (demo) {
    renderDemo(true);
    void pollDemo();
  }
  raf = requestAnimationFrame(frame);
  return () => {
    gone = true;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    clearTimeout(demoTimer);
  };
}

/** The demo positions live on the Sepolia demo contract. */
const DEMO_CONTRACT = "sepolia-demo.steadfi.testnet";
const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// REPLAY mode: plays a recorded log at 1× against the page's clock. PLAY / PAUSE only.
// The board is redrawn from (log, t) every frame; nothing animates on its own timer.
import type { RescueLog } from "../../../stewards/src/rescuelog";
import { boardAt, duration } from "./model";
import { mountBoard, type BoardMode, type ReplayChoice } from "./view";

const LEAD_IN = -3; // seconds of calm before the trigger
const HOLD_S = 6; // seconds the final state stays up before the replay loops
const FAST = 8; // the waits (proofs, Sepolia blocks, the buy-back window) play this much faster; the auction plays at 1×

export async function mountReplay(root: HTMLElement, url: string, choice?: { replays: ReplayChoice[]; current: string; onPick: (id: string) => void; onMode?: (m: BoardMode) => void; note?: string }) {
  root.innerHTML = `<section class="st-panel st-page"><div class="st-label">LIVE AUCTIONS</div><p class="st-empty">Loading the recorded rescue…</p></section>`;
  let log: RescueLog;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    log = await r.json();
  } catch (e) {
    root.innerHTML = `<section class="st-error" role="alert"><h2>Recording not loaded</h2><p>The replay file could not be read (${String((e as Error).message)}). Reload the page to try again.</p></section>`;
    return () => {};
  }

  const end = duration(log);
  // real time while the stewards bid (from just before the auction to just after it closes)
  const at = (k: string) => log.events.find((e) => e.kind === k)?.t;
  const live0 = (at("AUCTION_OPEN") ?? 0) - 2, live1 = (at("AUCTION_CLOSE") ?? at("AUCTION_OPEN") ?? 0) + 4;
  const speed = (x: number) => (x >= live0 && x <= live1 ? 1 : FAST);
  // ?t=SECONDS opens the replay paused at that moment (screenshots and tests).
  const tParam = Number(new URLSearchParams(location.search).get("t"));
  let t = Number.isFinite(tParam) && new URLSearchParams(location.search).has("t") ? tParam : LEAD_IN;
  let playing = false;
  let raf = 0;

  const view = mountBoard(root, log, {
    onToggle() {
      if (playing) pause();
      else play();
    },
    ...(choice ?? {}),
  });
  if (choice?.note) root.querySelector(".st-board")?.insertAdjacentHTML("afterbegin", `<p class="st-replay-note" role="status">${choice.note}</p>`);
  root.querySelector("[data-toggle]")?.insertAdjacentHTML("afterend", `<span class="st-ff" data-ff hidden>×${FAST} through the waits</span>`);

  // A recorded rescue can't change, so the replay loops: hold the final state, then start over
  // from just before the trigger. (LIVE mode follows real events instead and never loops.)
  let held = 0; // ms the final state has been up
  let prev = 0;
  const ff = root.querySelector<HTMLElement>("[data-ff]");
  function frame(now: number) {
    const dt = Math.min(0.25, (now - (prev || now)) / 1000);
    prev = now;
    if (t >= end) {
      held += dt * 1000;
      if (held >= HOLD_S * 1000) {
        held = 0;
        t = LEAD_IN;
      }
    } else t = Math.min(end, t + dt * speed(t));
    if (ff) ff.hidden = !(playing && t < end && speed(t) > 1);
    view.update(boardAt(log, t));
    raf = requestAnimationFrame(frame);
  }
  function play() {
    if (t >= end) t = LEAD_IN;
    playing = true;
    prev = 0;
    view.setPlaying(true, false);
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    view.setPlaying(false, false);
  }

  view.update(boardAt(log, t));
  view.setPlaying(false, t >= end);
  // plays on load and loops (?t= opens paused at a moment, for screenshots and tests)
  if (!new URLSearchParams(location.search).has("t") || new URLSearchParams(location.search).has("play")) play();
  return () => cancelAnimationFrame(raf);
}

// REPLAY mode: plays a recorded log at 1× against the page's clock. PLAY / PAUSE only.
// The board is redrawn from (log, t) every frame; nothing animates on its own timer.
import type { RescueLog } from "../../../stewards/src/rescuelog";
import { boardAt, duration } from "./model";
import { mountBoard, type BoardMode, type ReplayChoice } from "./view";

const LEAD_IN = -3; // seconds of calm before the trigger
const HOLD_S = 6; // seconds the final state stays up before the replay loops

export async function mountReplay(root: HTMLElement, url: string, choice?: { replays: ReplayChoice[]; current: string; onPick: (id: string) => void; onMode?: (m: BoardMode) => void }) {
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
  // ?t=SECONDS opens the replay paused at that moment (screenshots and tests).
  const tParam = Number(new URLSearchParams(location.search).get("t"));
  let t = Number.isFinite(tParam) && new URLSearchParams(location.search).has("t") ? tParam : LEAD_IN;
  let playing = false;
  let anchor = 0; // performance.now() when t was last set
  let tAtAnchor = t;
  let raf = 0;

  const view = mountBoard(root, log, {
    onToggle() {
      if (playing) pause();
      else play();
    },
    ...(choice ?? {}),
  });

  // A recorded rescue can't change, so the replay loops: hold the final state, then start over
  // from just before the trigger. (LIVE mode follows real events instead and never loops.)
  function frame(now: number) {
    const raw = tAtAnchor + (now - anchor) / 1000;
    if (raw >= end + HOLD_S) {
      anchor = now;
      tAtAnchor = LEAD_IN;
      t = LEAD_IN;
    } else t = Math.min(end, raw);
    view.update(boardAt(log, t));
    raf = requestAnimationFrame(frame);
  }
  function play() {
    if (t >= end) t = LEAD_IN;
    playing = true;
    anchor = performance.now();
    tAtAnchor = t;
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
  // ?play starts playback on load (tests).
  if (new URLSearchParams(location.search).has("play")) play();
  return () => cancelAnimationFrame(raf);
}

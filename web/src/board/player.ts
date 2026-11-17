// REPLAY mode: plays a recorded log at 1× against the page's clock. PLAY / PAUSE only.
// The board is redrawn from (log, t) every frame; nothing animates on its own timer.
import type { RescueLog } from "../../../stewards/src/rescuelog";
import { boardAt, duration, type Board } from "./model";
import { flowList, flowOf, txLink } from "./closing";
import { icon } from "../icons";
import { mountBoard, type BoardMode, type ReplayChoice } from "./view";

const LEAD_IN = -3; // seconds of calm before the trigger
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

  // At the end the replay stops on the final state and says so in a dialog: the outcome, the last
  // action with its transaction, and WATCH AGAIN. Only that (or REPLAY AGAIN, or a reload) restarts it.
  let prev = 0;
  const dlg = endDialog(root, () => { dlg.close(); restart(); });
  const ff = root.querySelector<HTMLElement>("[data-ff]");
  function frame(now: number) {
    const dt = Math.min(0.25, (now - (prev || now)) / 1000);
    prev = now;
    t = Math.min(end, t + dt * speed(t));
    if (ff) ff.hidden = !(playing && t < end && speed(t) > 1);
    const b = boardAt(log, t);
    view.update(b);
    if (t >= end) {
      finish(b);
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  function play() {
    if (t >= end) t = LEAD_IN;
    playing = true;
    prev = 0;
    view.setPlaying(true, false);
    raf = requestAnimationFrame(frame);
  }
  function finish(b: Board) {
    playing = false;
    if (ff) ff.hidden = true;
    view.setPlaying(false, true);
    dlg.fill(log, b);
    if (root.isConnected && !dlg.open) dlg.showModal();
  }
  function restart() {
    t = LEAD_IN;
    play();
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
  return () => {
    cancelAnimationFrame(raf);
    dlg.remove();
  };
}

/** The end-of-replay dialog: what the rescue came to, its last action and that action's transaction. */
function endDialog(root: HTMLElement, onAgain: () => void) {
  const d = document.createElement("dialog");
  d.className = "st-end-dialog";
  d.setAttribute("aria-labelledby", "st-end-title");
  root.appendChild(d);
  d.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("[data-end-again]")) onAgain();
    else if (el.closest("[data-end-close]") || el === d) d.close();
  });
  return Object.assign(d, {
    fill(log: RescueLog, b: Board) {
      const last = b.journal.find((l) => l.kind !== "READING");

      const outcome = b.settlement?.done ? "settled" : b.buyback ? "bought back" : b.claim?.closedText || b.pool?.closedText || "ended";
      d.innerHTML = `
        <div class="st-end-top">
          <div><div class="st-label">REPLAY FINISHED · RESCUE ${log.rescueId ?? ""}</div><h2 class="st-panel-title" id="st-end-title">Position ${log.positionId}: ${esc(outcome)}</h2></div>
          <button type="button" class="st-icon-btn" data-end-close aria-label="Close and stay on the final state">${icon("close", 16)}</button>
        </div>
        ${flowOf(b) ? `<div class="st-label">EVERY TRANSACTION, IN ORDER</div>${flowList(log, b)}` : last ? `<div class="st-end-last"><div class="st-label">LAST ACTION</div><p>${esc(last.text)}</p>${last.evidence?.url ? txLink(last.evidence) : ""}</div>` : ""}
        <div class="st-end-actions"><button type="button" class="st-push st-cut" data-end-again>WATCH AGAIN</button></div>`;
    },
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

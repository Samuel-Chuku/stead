// How the claims close, as its own strip under the board (before the journal): a buy-back (the
// borrower's payment, its proof, the commit, each holder's payout, any refund) or a settlement (start,
// takeover, repay, each payout, settled, refund). Steps run left to right joined by arrows; the
// arrow into the current step flows while its transaction is awaited, fills once when it lands, and
// the step that landed flashes. Every finished step links its own transaction.
import type { Evidence, RescueLog } from "../../../stewards/src/rescuelog";
import type { Board, SettleStep } from "./model";
import { icon } from "../icons";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const FRESH_S = 1.2; // a step that landed this recently flashes (only while watching it happen)
const clockText = (ms: number) => new Date(ms).toISOString().slice(11, 19);

/** A step's transaction: where it is (Etherscan or NearBlocks) and the start of its hash. */
export const txLink = (ev: Evidence) =>
  `<a class="st-txlink st-close-tx" href="${esc(ev.url)}" target="_blank" rel="noopener"><span>${ev.chain.startsWith("near") ? "NearBlocks" : "Etherscan"}</span><span class="st-txlink-where">${esc(ev.tx.slice(0, 10))}…</span>${icon("external", 12)}</a>`;

type Flow = { kind: "buyback" | "settlement"; steps: SettleStep[]; done: boolean };
export const flowOf = (b: Board): Flow | null =>
  b.settlement ? { kind: "settlement", steps: b.settlement.steps, done: b.settlement.done && b.settlement.steps.every((x) => x.state === "done") } : b.buyback ? { kind: "buyback", steps: b.buyback.steps, done: b.buyback.done } : null;
const keyOf = (f: Flow | null) => (f ? f.kind + f.steps.map((x) => `${x.key}:${x.state}:${x.detail}:${x.link?.tx ?? ""}`).join("|") : "");

export function closingMarkup(log: RescueLog): string {
  return `<section class="st-panel st-board-panel st-close" aria-label="How the claims close" data-close hidden>
    <div class="st-close-head"><div class="st-label" data-close-label>POSITION ${log.positionId}</div><div class="st-close-now" data-close-now></div></div>
    <ol class="st-close-flow" data-close-flow></ol>
  </section>`;
}

export function updateClosing(root: HTMLElement, log: RescueLog, b: Board, state: { key: string }) {
  const sect = root.querySelector<HTMLElement>("[data-close]");
  if (!sect) return;
  const f = flowOf(b);
  const key = keyOf(f);
  if (key === state.key) return;
  state.key = key;
  sect.hidden = !f;
  if (!f) return;
  const active = f.steps.find((x) => x.state === "active");
  const lastDone = [...f.steps].reverse().find((x) => x.state === "done");
  sect.querySelector("[data-close-label]")!.textContent = f.kind === "buyback" ? `BUY-BACK · POSITION ${log.positionId}` : `SETTLEMENT AT THE ORACLE PRICE · POSITION ${log.positionId}`;
  sect.querySelector("[data-close-now]")!.textContent = active ? `${lastDone ? `${lastDone.label.toLowerCase()} → ` : ""}next: ${active.label.toLowerCase()}` : "every step done";
  sect.querySelector("[data-close-flow]")!.innerHTML = f.steps
    .map((x, i) => {
      const fresh = x.state === "done" && x.t !== null && b.t - x.t >= 0 && b.t - x.t < FRESH_S;
      // the arrow into this step: done (solid), moving (its transaction is awaited), pending (quiet)
      const arrow = i === 0 ? "" : `<li class="st-close-arrow" data-state="${x.state === "done" ? "done" : x.state === "active" ? "moving" : "pending"}"${fresh ? ' data-fresh=""' : ""} aria-hidden="true"><span></span></li>`;
      return `${arrow}<li class="st-close-step${fresh ? " is-fresh" : ""}" data-state="${x.state}">
        <span class="st-close-label"><span class="st-close-mark" aria-hidden="true"></span>${esc(x.label)}</span>
        <span class="st-close-detail">${esc(x.detail)}</span>
        ${x.state === "done" && x.link?.url ? txLink(x.link) : ""}
      </li>`;
    })
    .join("");
}

/** The dialog's version: numbered, top to bottom with an arrow between steps, each with its time,
 *  the last transaction marked. */
export function flowList(log: RescueLog, b: Board): string {
  const f = flowOf(b);
  if (!f) return "";
  const done = f.steps.filter((x) => x.state === "done");
  const last = done[done.length - 1];
  return `<ol class="st-close-list" aria-label="${f.kind === "buyback" ? "Buy-back" : "Settlement"} transactions, in order">${f.steps
    .map((x, i) => `${i ? `<li class="st-close-down" aria-hidden="true">${icon("arrow-down", 14)}</li>` : ""}<li class="st-close-item${x === last ? " is-last" : ""}" data-state="${x.state}">
      <span class="st-close-n">${i + 1}</span>
      <div class="st-close-body">
        <div class="st-close-label">${esc(x.label)}${x === last ? ' <span class="st-close-lastflag">LAST TRANSACTION</span>' : ""}</div>
        <div class="st-close-detail">${esc(x.detail)}</div>
        <div class="st-close-meta">${x.t !== null && x.state === "done" ? `<span class="st-close-time">${clockText(log.openedAtMs + x.t * 1000)} UTC</span>` : ""}${x.state === "done" && x.link?.url ? txLink(x.link) : ""}</div>
      </div>
    </li>`)
    .join("")}</ol>`;
}

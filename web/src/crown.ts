// The crown on a winning bid: the icon alone; hovering or clicking it pops out a few key details
// from the crown itself. One document listener closes an open popout on an outside click or Escape.
import { icon } from "./icons";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A crown with its popout. `details` are short label/value pairs (values may hold markup). */
export function crown(who: string, details: [string, string][], size = 14): string {
  return `<span class="st-crown-wrap"><button type="button" class="st-crown" aria-expanded="false" aria-label="${esc(who)} won: show details">${icon("crown", size)}</button><span class="st-crown-pop" role="tooltip"><span class="st-crown-pop-title">${esc(who)} won</span>${details.map(([k, v]) => `<span class="st-crown-pop-row"><span>${esc(k)}</span><span>${v}</span></span>`).join("")}</span></span>`;
}

let bound = false;
/** Clicking a crown pins its popout open (a second click, Escape or a click elsewhere closes it). */
export function bindCrowns() {
  if (bound) return;
  bound = true;
  const closeAll = (except?: Element | null) => {
    for (const w of document.querySelectorAll(".st-crown-wrap.is-open")) {
      if (w === except) continue;
      w.classList.remove("is-open");
      w.querySelector(".st-crown")?.setAttribute("aria-expanded", "false");
    }
  };
  document.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".st-crown");
    const wrap = btn?.closest(".st-crown-wrap") ?? null;
    closeAll(wrap);
    if (!btn || !wrap) return;
    e.preventDefault();
    e.stopPropagation(); // a crown inside an expandable row must not toggle the row
    const open = wrap.classList.toggle("is-open");
    btn.setAttribute("aria-expanded", String(open));
  }, true);
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeAll());
}

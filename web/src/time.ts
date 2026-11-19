// One way to say when something happened, everywhere a row or a feed shows a time: "12s ago",
// "5m ago", "3h ago", "2d ago"; past 7 days the date itself ("19 Nov 2026"). Times ahead read
// "in 2m". The exact UTC time is in the tooltip, and one page-wide ticker keeps the words current.
// Steps inside a single rescue keep their clock times (their order is what matters there).

const WEEK_S = 7 * 86_400;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Nov 2026" (UTC). */
export function fullDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** "19 Nov 2026, 03:36:02 UTC": the tooltip. */
export function exactText(ms: number): string {
  return `${fullDate(ms)}, ${new Date(ms).toISOString().slice(11, 19)} UTC`;
}
/** "12s ago" · "5m ago" · "3h ago" · "2d ago" · "19 Nov 2026"; ahead: "in 40s" · "in 2m" · "in 3h" · "in 2d". */
export function agoText(ms: number, nowMs = Date.now()): string {
  const diff = Math.round((nowMs - ms) / 1000);
  const s = Math.abs(diff);
  if (s >= WEEK_S) return fullDate(ms);
  const n = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
  if (diff < 0) return `in ${n}`;
  return s < 5 ? "just now" : `${n} ago`;
}
/** The same as a <time> element, kept current by the ticker, the exact time on hover. */
export function ago(ms: number, nowMs = Date.now()): string {
  return `<time class="st-ago" datetime="${new Date(ms).toISOString()}" data-ago="${ms}" title="${exactText(ms)}">${agoText(ms, nowMs)}</time>`;
}

let ticking = false;
/** Refresh every [data-ago] on the page every 10 s (started once, by the app shell). */
export function startAgoTicker(): void {
  if (ticking || typeof document === "undefined") return;
  ticking = true;
  window.setInterval(() => {
    const now = Date.now();
    for (const el of document.querySelectorAll<HTMLElement>("[data-ago]")) {
      const t = agoText(Number(el.dataset.ago), now);
      if (el.textContent !== t) el.textContent = t;
    }
  }, 10_000);
}

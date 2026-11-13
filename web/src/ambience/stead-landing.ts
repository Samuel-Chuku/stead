// Landing-page motion: the homepage (#/) only, never the app pages. These are the scroll and pointer
// exceptions to "motion reports real events": the page's own health factor rail, the four steps played
// by scroll, sections powering on as they enter view, and the liquidation cards dealing in. All of it
// is decorative (aria-hidden or a re-run of a still layout), hard-edged (steps()), driven by native
// scroll and IntersectionObserver with no continuous loop, and absent or still under reduced motion.
import { rollNumbers } from "./stead-ambience.js";
import { CODE } from "../board/model";
import type { StewardId } from "../../../stewards/src/rescuelog";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ */
/* 1. The page has a health factor                                     */
/*    Scroll is the price falling. The rail's HF drops from 2.00; at   */
/*    the 1.15 trigger it flashes amber once, a steward tile drops in, */
/*    a RESCUED tag clips on and the HF snaps back to 1.40, then keeps */
/*    falling with further scroll. A second catch comes near the end.  */
/* ------------------------------------------------------------------ */
const TRIGGER = 1.15, RESTORED = 1.4, HF_LO = 0.9, HF_HI = 2.1;
const C1 = 0.4, C2 = 0.86; // scroll progress of the two catches
const HOLD = 0.14; // how long (in scroll) the first claim stays on before it is bought back
const CATCHERS: StewardId[] = ["swift", "deep"];

function hfAt(p: number): number {
  if (p < C1) return 2 - (2 - TRIGGER) * (p / C1);
  if (p < C2) return RESTORED - (RESTORED - TRIGGER) * ((p - C1) / (C2 - C1));
  return RESTORED - 0.12 * ((p - C2) / (1 - C2));
}
const level = (hf: number) => clamp((hf - HF_LO) / (HF_HI - HF_LO)) * 100;

export function mountPageHf(root: HTMLElement): () => void {
  if (reduced()) return () => {};
  const tile = (s: StewardId) => `<span class="st-tile st-tile--22" style="--sc: var(--st-steward-${s})">${CODE[s]}</span>`;
  const host = document.createElement("div");
  host.innerHTML = `
    <div class="st-pagehf" aria-hidden="true">
      <span class="st-num st-pagehf-num">2.00</span>
      <div class="st-pagehf-mid">
        <span class="st-pagehf-label">THIS PAGE · HF</span>
        <div class="st-pagehf-track">
          <span class="st-pagehf-fill"></span>
          <span class="st-pagehf-mark st-pagehf-mark--trigger" style="bottom:${level(TRIGGER).toFixed(1)}%"></span>
          <span class="st-pagehf-mark st-pagehf-mark--trip" style="bottom:${level(1).toFixed(1)}%"></span>
        </div>
      </div>
      <div class="st-pagehf-catch">${CATCHERS.map((s, i) => `<div class="st-pagehf-claim" data-claim="${i}" hidden>${tile(s)}<span class="st-pagehf-tag st-cut">RESCUED</span></div>`).join("")}</div>
    </div>
    <div class="st-pagebar" aria-hidden="true"><span class="st-pagebar-fill"></span></div>`;
  root.append(...host.children);
  const rail = root.querySelector<HTMLElement>(".st-pagehf")!;
  const bar = root.querySelector<HTMLElement>(".st-pagebar")!;
  const num = rail.querySelector<HTMLElement>(".st-pagehf-num")!;
  const fill = rail.querySelector<HTMLElement>(".st-pagehf-fill")!;
  const barFill = bar.querySelector<HTMLElement>(".st-pagebar-fill")!;
  const claims = [...rail.querySelectorAll<HTMLElement>("[data-claim]")];

  let lastP = -1, flashUntil = 0, flashTimer = 0, raf = 0;
  const progress = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    return max > 0 ? clamp(scrollY / max) : 0;
  };
  const paint = (hf: number, exposed: boolean) => {
    num.textContent = hf.toFixed(2);
    num.classList.toggle("is-below", exposed);
    fill.style.height = `${level(hf).toFixed(1)}%`;
    barFill.style.width = `${level(hf).toFixed(1)}%`;
    fill.classList.toggle("is-below", exposed);
    barFill.classList.toggle("is-below", exposed);
  };
  const render = (p: number, fromScroll: boolean) => {
    // a forward crossing of a catch point is the event: one amber flash at the trigger, then the catch
    if (fromScroll && lastP >= 0) {
      const crossed = [C1, C2].findIndex((c) => lastP < c && p >= c);
      if (crossed >= 0) {
        flashUntil = performance.now() + 380;
        clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => {
          flashUntil = 0;
          const el = claims[crossed];
          el.classList.remove("is-drop");
          void el.offsetWidth;
          el.classList.add("is-drop");
          render(progress(), false);
        }, 380);
      }
    }
    lastP = p;
    if (performance.now() < flashUntil) { paint(TRIGGER, true); return; }
    paint(hfAt(p), false);
    claims[0].hidden = !(p >= C1 && p < C1 + HOLD);
    claims[1].hidden = !(p >= C2);
  };
  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(progress(), true); });
  };
  addEventListener("scroll", onScroll, { passive: true });
  const ro = new ResizeObserver(() => render(progress(), false));
  ro.observe(document.body);
  render(progress(), false);
  return () => {
    removeEventListener("scroll", onScroll);
    ro.disconnect();
    cancelAnimationFrame(raf);
    clearTimeout(flashTimer);
    rail.remove();
    bar.remove();
  };
}

/* ------------------------------------------------------------------ */
/* 2. "One rescue, four steps" played by scroll                        */
/*    A tall wrapper with a sticky panel. Native scroll only: progress */
/*    through the wrapper picks the active step and a position within  */
/*    it; the page draws the stage from a recorded rescue. On phones,  */
/*    short screens and under reduced motion it is the plain list.     */
/* ------------------------------------------------------------------ */
export type StoryDraw = (step: number, within: number, items: HTMLElement[]) => void;

export function mountStory(wrap: HTMLElement, draw: StoryDraw, onMode: (scrolly: boolean) => void): () => void {
  const panel = wrap.querySelector<HTMLElement>("[data-story-panel]")!;
  const items = [...wrap.querySelectorAll<HTMLElement>(".st-step-site")];
  const mq = matchMedia("(min-width: 900px) and (min-height: 700px) and (max-height: 1400px) and (prefers-reduced-motion: no-preference)");
  let raf = 0, on = false, lastKey = "";
  const measure = () => {
    if (!on) return;
    const top = parseFloat(getComputedStyle(panel).top) || 0;
    const run = wrap.offsetHeight - panel.offsetHeight;
    const q = run > 0 ? clamp((top - wrap.getBoundingClientRect().top) / run) : 0;
    const step = Math.min(3, Math.floor(q * 4));
    const within = clamp(q * 4 - step);
    const key = `${step}:${within.toFixed(3)}`;
    if (key === lastKey) return;
    lastKey = key;
    items.forEach((li, i) => {
      li.classList.toggle("is-active", i === step);
      li.classList.toggle("is-past", i < step);
    });
    draw(step, within, items);
  };
  const onScroll = () => {
    if (on && !raf) raf = requestAnimationFrame(() => { raf = 0; measure(); });
  };
  const setMode = () => {
    on = mq.matches;
    wrap.classList.toggle("is-scrolly", on);
    lastKey = "";
    if (!on) items.forEach((li) => li.classList.remove("is-active", "is-past"));
    onMode(on);
    measure();
  };
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  mq.addEventListener("change", setMode);
  setMode();
  return () => {
    removeEventListener("scroll", onScroll);
    removeEventListener("resize", onScroll);
    mq.removeEventListener("change", setMode);
    cancelAnimationFrame(raf);
  };
}

/* ------------------------------------------------------------------ */
/* 3. Sections power on as they enter view                             */
/*    Each [data-panel] flickers on (the same hard-edged st-power as   */
/*    the app's once-a-session power-on, which the homepage no longer  */
/*    calls, so nothing flickers twice), its first label types in and  */
/*    its set-once numbers roll. Once per section per page view.       */
/* ------------------------------------------------------------------ */
const SKIP_LABEL = "[data-mini], [data-story-stage]";

function typeLabel(el: HTMLElement, delay: number) {
  const text = el.textContent ?? "";
  if (!text || el.children.length) return; // only plain text labels
  el.style.minHeight = `${el.offsetHeight}px`;
  el.textContent = "";
  let i = 0;
  const tick = () => {
    i += 1;
    el.textContent = text.slice(0, i);
    if (i < text.length) timers.push(window.setTimeout(tick, 18));
    else el.style.minHeight = "";
  };
  timers.push(window.setTimeout(tick, delay));
}
let timers: number[] = [];

export function powerOnView(root: HTMLElement): () => void {
  try { sessionStorage.setItem("st-powered", "1"); } catch { /* storage blocked: the app pages flicker once, harmless */ }
  if (reduced()) { rollNumbers(root, { instant: true }); return () => {}; }
  const done = new WeakSet<Element>();
  const waiting = new Map<Element, MutationObserver>();
  const fire = (p: HTMLElement, order: number) => {
    done.add(p);
    const d = order * 70;
    p.style.animation = `st-power 420ms steps(1, end) ${d}ms both`;
    p.addEventListener("animationend", () => { p.style.animation = ""; }, { once: true });
    const label = [...p.querySelectorAll<HTMLElement>(".st-label")].find((l) => !l.closest(SKIP_LABEL));
    if (label) typeLabel(label, d + 140);
    timers.push(window.setTimeout(() => rollNumbers(p, { selector: "[data-roll]:not([data-roll-view]):not([data-roll-deal])" }), d + 200));
  };
  const io = new IntersectionObserver((entries) => {
    let order = 0;
    for (const e of entries) {
      const p = e.target as HTMLElement;
      if (!e.isIntersecting || done.has(p)) continue;
      if (!p.childElementCount) {
        // a slot still loading (the chart): power it on when its content arrives, if still in view
        if (!waiting.has(p)) {
          const mo = new MutationObserver(() => {
            if (!p.childElementCount) return;
            mo.disconnect(); waiting.delete(p);
            const r = p.getBoundingClientRect();
            if (r.top < innerHeight && r.bottom > 0 && !done.has(p)) fire(p, 0);
          });
          mo.observe(p, { childList: true });
          waiting.set(p, mo);
        }
        continue;
      }
      io.unobserve(p);
      fire(p, order++);
    }
  }, { threshold: 0.12 });
  root.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => io.observe(p));
  return () => {
    io.disconnect();
    waiting.forEach((mo) => mo.disconnect());
    timers.forEach(clearTimeout);
    timers = [];
  };
}

/* ------------------------------------------------------------------ */
/* 4. Liquidation cards deal in                                        */
/*    When the carousel enters view, and after each step, the cards    */
/*    that came into the track deal in: the liquidator's bar fills,    */
/*    then the premium bar to its real width, then the kept figure     */
/*    rolls. A pointer over a card re-runs its bars.                   */
/* ------------------------------------------------------------------ */
export function mountDeal(box: HTMLElement, track: HTMLElement): () => void {
  if (reduced()) { rollNumbers(track, { instant: true }); return () => {}; }
  const cards = [...track.querySelectorAll<HTMLElement>(".st-mn-card")];
  const seen = new Set<HTMLElement>(); // in the track's view
  const dealt = new Set<HTMLElement>();
  let inView = false;
  const local: number[] = [];
  const deal = (list: HTMLElement[]) => {
    list.forEach((c, i) => {
      dealt.add(c);
      c.style.setProperty("--d", `${i * 110}ms`);
      c.classList.remove("is-deal");
      void c.offsetWidth;
      c.classList.add("is-deal");
      local.push(window.setTimeout(() => rollNumbers(c, { selector: "[data-roll-deal]" }), i * 110 + 760));
    });
  };
  const inTrack = new IntersectionObserver((entries) => {
    const fresh: HTMLElement[] = [];
    track.classList.add("is-armed");
    for (const e of entries) {
      const c = e.target as HTMLElement;
      if (e.isIntersecting) { seen.add(c); if (inView && !dealt.has(c)) fresh.push(c); }
      else { seen.delete(c); dealt.delete(c); }
    }
    if (fresh.length) deal(fresh.sort((a, b) => cards.indexOf(a) - cards.indexOf(b)));
  }, { root: track, threshold: 0.6 });
  const onPage = new IntersectionObserver(([e]) => {
    inView = e.isIntersecting;
    if (inView) deal(cards.filter((c) => seen.has(c) && !dealt.has(c)));
    else dealt.clear();
  }, { threshold: 0.3 });
  cards.forEach((c) => inTrack.observe(c));
  onPage.observe(box);
  // the pointer re-runs a card's bars (not its figure)
  const onEnter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const c = (e.target as HTMLElement).closest<HTMLElement>(".st-mn-card");
    if (!c || c.getAnimations({ subtree: true }).some((a) => a.playState === "running")) return;
    c.style.setProperty("--d", "0ms");
    c.classList.remove("is-deal");
    void c.offsetWidth;
    c.classList.add("is-deal");
  };
  cards.forEach((c) => c.addEventListener("pointerenter", onEnter));
  return () => {
    inTrack.disconnect();
    onPage.disconnect();
    local.forEach(clearTimeout);
    cards.forEach((c) => c.removeEventListener("pointerenter", onEnter));
  };
}

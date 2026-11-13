// The homepage (site.md): the product's own components are the imagery. Every figure on it is read
// from the contracts (stats.json) or from a recorded rescue's event log; nothing is invented.
import type { CostPath } from "../../../stewards/src/costpath";
import type { RescueEvent, RescueLog, StewardId } from "../../../stewards/src/rescuelog";
import type { SiteStats } from "../../../stewards/src/sitestats";
import { boardAt, CODE, consequence, RISK, RISK_WORD, RULE, STEWARD_ORDER } from "../board/model";
import { logo } from "../icons";
import { chartRunOf, costChart, wireCostChart } from "../rescue/costchart";
import { loadRecords } from "../lists/pages";
import type { PanelFeed } from "../../../stewards/src/panel";
import type { Records } from "../../../stewards/src/records";
import { mountGlyphMark, mountMarketField, rollOnView } from "../ambience/stead-ambience.js";
import { mountDeal, mountPageHf, mountStory, powerOnView } from "../ambience/stead-landing";
import { FAQ } from "../how/page";
import type { Liquidation } from "../../../stewards/src/panel";
import { icon } from "../icons";

const REPO_URL = "https://github.com/Samuel-Chuku/stead";
let LOOP_FROM = -3; // seconds before the first bid (set from the log), so the replay opens on the bidding
const LOOP_TO = 54; // a few seconds after the close, then the loop restarts
const tile = (s: StewardId, size: number) => `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s]}</span>`;
const num = (n: string) => `<span class="st-num">${n}</span>`;
/** A figure that rolls in when it first scrolls into view (only for values that are set once). */
const numRoll = (n: string) => `<span class="st-num" data-roll data-roll-view>${n}</span>`;
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const usdK = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n).toLocaleString("en-US")}`);
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const feedUrl = () => (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");

export function mountHome(root: HTMLElement, replayUrl: string): () => void {
  let raf = 0;
  let stopped = false;
  root.innerHTML = skeleton();
  const ambience = mountAmbience(root);
  const story = mountStorySection(root);
  void (async () => {
    const [log, path, stats] = await Promise.all([
      getJson<RescueLog>(replayUrl),
      getJson<CostPath>(replayUrl.replace(/\.json$/, "-path.json")),
      getJson<SiteStats>("/stats.json"),
    ]);
    if (stopped) return;
    // live totals from the contracts' records (through the feed), else the snapshot
    const rec = await loadRecords().then((r) => r, () => null);
    if (stopped) return;
    if (rec) fillLive(root, rec.rec, rec.live);
    else fillTotals(root, stats);
    rollOnView(root.querySelector("[data-totals]") ?? root);
    void getJson<PanelFeed>(`${feedUrl()}/mainnet.json`).then((m) => m ?? getJson<PanelFeed>("/mainnet.json")).then((m) => !stopped && fillMainnet(root, m));
    if (log) {
      const firstBid = log.events.find((e) => e.kind === "BIDDING" || e.kind === "BID");
      LOOP_FROM = firstBid ? Math.max(-3, firstBid.t - 2) : -3;
      const mini = root.querySelector<HTMLElement>("[data-mini]")!;
      mini.innerHTML = miniBoard(log);
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const t0 = performance.now();
      const frame = (now: number) => {
        if (stopped) return;
        const span = LOOP_TO - LOOP_FROM;
        const t = reduced ? 46 : LOOP_FROM + (((now - t0) / 1000) % span);
        updateMini(mini, log, t);
        if (!reduced) raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      story.setLog(log);
      if (path) {
        const slot = root.querySelector<HTMLElement>("[data-chart]")!;
        const run = chartRunOf(log, path);
        slot.innerHTML = costChart(run, { caption: `<p class="st-site-caption">From <a class="st-textlink" href="?rescue=${log.rescueId}#/rescues">rescue ${log.rescueId}</a>. More runs, on other real falls: <a class="st-textlink" href="#/how">How it works</a>.</p>` });
        wireCostChart(slot, run);
        rollOnView(slot);
      }
    }
  })();
  root.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-scroll]");
    if (!b) return;
    e.preventDefault();
    document.getElementById(b.dataset.scroll!)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  // one answer open at a time
  const onToggle = (e: Event) => {
    const d = e.target as HTMLDetailsElement;
    if (!d.matches?.("details.st-faq-item") || !d.open) return;
    for (const o of root.querySelectorAll<HTMLDetailsElement>("details.st-faq-item[open]")) if (o !== d) o.open = false;
  };
  root.addEventListener("toggle", onToggle, true);
  // the mainnet feed moves on: bring in new liquidations while the visitor is at the top of the cards
  let newest = "";
  const refresh = setInterval(() => {
    if (document.hidden) return;
    void getJson<PanelFeed>(`${feedUrl()}/mainnet.json`).then((m) => {
      const top = m?.liquidations.reduce((a, l) => (l.block > a ? l.block : a), 0);
      const track = root.querySelector<HTMLElement>("[data-mn-track]");
      if (stopped || !m || !top || String(top) === newest || (track && track.scrollLeft > 2)) return;
      newest = String(top);
      fillMainnet(root, m);
    });
  }, 120_000);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    clearInterval(refresh);
    root.removeEventListener("toggle", onToggle, true);
    ambience();
    story.stop();
    stopDeal();
    root.onclick = null;
  };
}

/** The homepage's ambience: the simulated market field behind the hero (its catches counted in the
 *  hero panel), the glyph mark in the footer, each section powering on as it enters view, and the
 *  page's own health factor rail. Every piece is still or absent under reduced motion. Returns the cleanup. */
function mountAmbience(root: HTMLElement): () => void {
  const phone = matchMedia("(max-width: 620px)").matches;
  const caught = root.querySelector<HTMLElement>("[data-caught]")!;
  let n = 0;
  const field = mountMarketField(root.querySelector<HTMLCanvasElement>("[data-field]")!, {
    ...(phone ? { cell: 12 } : {}),
    onRescue: () => {
      caught.textContent = String(++n);
      caught.classList.remove("st-tick");
      void caught.offsetWidth; // restart the tick
      caught.classList.add("st-tick");
    },
  });
  const mark = mountGlyphMark(root.querySelector<HTMLCanvasElement>("[data-mark]")!);
  const rail = mountPageHf(root);
  let view = () => {};
  let raf = requestAnimationFrame(() => (raf = requestAnimationFrame(() => (view = powerOnView(root)))));
  return () => {
    cancelAnimationFrame(raf);
    view();
    field();
    mark();
    rail();
  };
}

/** "One rescue, four steps" played by scroll on wide screens: the stage replays the recorded rescue,
 *  each step a stretch of its real event log (trigger, bids, top-up and claim, buy-back). Elsewhere
 *  the steps are the plain list. Returns setLog (once the log arrives) and stop. */
function mountStorySection(root: HTMLElement) {
  const wrap = root.querySelector<HTMLElement>("[data-story]")!;
  const stage = wrap.querySelector<HTMLElement>("[data-story-stage]")!;
  let log: RescueLog | null = null;
  let spans: [number, number, number][] = []; // [from t, to t, share of the step it takes]
  let last: [number, number] = [0, 0];
  let items: HTMLElement[] = [];
  const draw = (step: number, within: number, lis: HTMLElement[]) => {
    last = [step, within];
    items = lis;
    if (!log) {
      lis.forEach((li, i) => li.classList.toggle("is-exposed", i === step && step < 2));
      return;
    }
    const [a, b, share] = spans[step];
    const k = Math.min(1, within / share);
    const t = step === 0 ? (within < 0.35 ? a : b) : a + (b - a) * k;
    updateMini(stage, log, t);
    const below = boardAt(log, t).below;
    lis.forEach((li, i) => li.classList.toggle("is-exposed", i === step && below));
    const claim = log.events.find((e) => e.kind === "CLAIM_MINTED" && e.t <= t);
    const closed = log.events.some((e) => (e.kind === "BOUGHT_BACK" || e.kind === "SETTLED") && e.t <= t);
    const tag = stage.querySelector<HTMLElement>("[data-story-tag]")!;
    const done = stage.querySelector<HTMLElement>("[data-story-done]")!;
    tag.hidden = !claim || closed;
    done.hidden = !closed;
  };
  const stop = mountStory(wrap, draw, (on) => {
    stage.hidden = !on;
    if (!on) wrap.querySelectorAll<HTMLElement>(".st-step-site").forEach((li, i) => li.classList.toggle("is-exposed", i === 0));
  });
  const setLog = (l: RescueLog) => {
    const tOf = (...k: RescueEvent["kind"][]) => l.events.find((e) => k.includes(e.kind))?.t;
    const close = tOf("AUCTION_CLOSE") ?? l.params.auctionS;
    const claimT = tOf("CLAIM_MINTED") ?? close + 60;
    const endT = tOf("BOUGHT_BACK", "SETTLED") ?? claimT + 60;
    spans = [[-1, 0.5, 1], [0, close + 0.5, 0.9], [close + 0.5, claimT + 0.5, 0.7], [claimT + 0.5, endT + 0.5, 0.6]];
    const c = l.events.find((e) => e.kind === "CLAIM_MINTED") as Extract<RescueEvent, { kind: "CLAIM_MINTED" }> | undefined;
    stage.innerHTML = `${miniBoard(l)}
      <div class="st-story-claim">
        ${c ? `<div class="st-tag st-cut st-cut--l st-story-tag" data-story-tag hidden><div class="st-tag-top">${tile(c.holder, 22)}<span class="st-tag-title">CLAIM ${escHtml(c.claim)} · ${c.holder}</span></div><div class="st-tag-lines">Premium ${escHtml(c.premium)} ${escHtml(c.asset)}. Withdrawals are locked until the borrower buys it back.</div></div>` : `<div data-story-tag hidden></div>`}
        <p class="st-story-done" data-story-done hidden>Bought back. The claim is closed and the position is free again.</p>
      </div>`;
    log = l;
    if (items.length) draw(last[0], last[1], items);
  };
  return { setLog, stop };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function skeleton(): string {
  return `
  <div class="st-site">
    <header class="st-panel st-site-nav" data-panel>
      <a class="st-brand" href="#/" aria-label="Stead, home">${logo(26)}</a>
      <nav class="st-site-links" aria-label="Site">
        <a class="st-site-link" href="#/how">How it works</a>
        <a class="st-site-link" href="#/try">Protect a position</a>
        <a class="st-site-link" href="#/rescues">Rescues</a>
        <a class="st-site-link" href="#/mainnet">On mainnet</a>
        <a class="st-site-link" href="${REPO_URL}" target="_blank" rel="noopener">Code</a>
      </nav>
      <a class="st-push st-push--small st-cut" href="#/live"><span class="cut-label"><span class="st-lamp st-lamp-live" aria-hidden="true"></span>OPEN THE APP</span></a>
    </header>

    <div class="st-panel st-hero st-field-host" data-panel>
      <canvas class="st-field" aria-hidden="true" data-field></canvas>
      <section class="st-hero-main" aria-labelledby="hero-h">
        <div class="st-label">LIQUIDATION RESCUE MARKET · BUILT ON NEAR</div>
        <h1 class="st-hero-h" id="hero-h">Liquidation is not the only way out.</h1>
        <p class="st-hero-lead">Protect your Aave position with Stead. If it nears liquidation, agent stewards compete to top it up, for a premium always smaller than the liquidation penalty, and you buy the rescue back. A NEAR contract signs only what the rules allow, and every reading it acts on is proven, not reported.</p>
        <div class="st-hero-actions">
          <a class="st-push st-cut" href="#/try"><span class="cut-label"><span class="st-lamp" aria-hidden="true"></span>PROTECT AN AAVE POSITION</span></a>
          <a class="st-secondary st-cut st-secondary--link" href="?demo=#/live"><span class="cut-label">Watch a real rescue in 5 minutes, no wallet</span></a>
        </div>
        <p class="st-hero-trust"><span class="st-live-dot" aria-hidden="true"></span><span data-live-line>Live on NEAR testnet and Ethereum Sepolia, with Aave V3's real contracts.</span></p>
      </section>
      <section class="st-panel st-hero-mini" aria-label="A recorded rescue auction, replayed">
        <div class="st-hero-mini-board" data-mini><p class="st-empty">Loading the recorded auction…</p></div>
        <div class="st-field-count">
          <div class="st-field-count-text"><div class="st-label">SIMULATED MARKET · EACH MARK IS A POSITION</div><p class="st-field-count-sub">Caught in this field since you arrived</p></div>
          <span class="st-num st-field-count-num" data-caught>0</span>
        </div>
      </section>
    </div>

    <section class="st-site-totals" aria-labelledby="totals-h" data-panel>
      <h2 class="st-visually-hidden" id="totals-h">So far</h2>
      <dl class="st-kpis st-kpis--site" data-totals>
        <div><dt>RESCUES</dt><dd>${num("—")}</dd></div>
        <div><dt>BORROWERS WORSE OFF THAN LIQUIDATION</dt><dd>${num("—")}</dd></div>
        <div><dt>MEDIAN WINNING PREMIUM</dt><dd>${num("—")}</dd></div>
        <div><dt>MEDIAN TRIGGER TO CLAIM</dt><dd>${num("—")}</dd></div>
      </dl>
      <p class="st-site-caption" data-totals-caption>Reading the contracts…</p>
    </section>

    <section class="st-panel st-site-sect st-site-mainnet" aria-labelledby="mn-h" data-mainnet data-panel hidden>
      <div class="st-site-mn-num"><div class="st-label">ETHEREUM MAINNET · LAST 24 HOURS</div><div class="st-num st-site-big" data-mn-kept>—</div><p data-mn-kept-sub>that borrowers would have kept with Stead</p></div>
      <div class="st-site-mn-text"><h2 class="st-site-h2" id="mn-h">Liquidations are happening now</h2><p data-mn-text>Real Aave V3 liquidations on Ethereum, read from public RPCs, beside what a Stead rescue of the same position would have cost.</p><a class="st-secondary st-cut st-secondary--link" href="#/mainnet"><span class="cut-label">See each liquidation</span></a></div>
      <div class="st-mn-carousel" data-mn-carousel hidden>
        <div class="st-mn-car-head">
          <div class="st-label">POSITIONS STEAD COULD HAVE SAVED · LATEST FIRST</div>
          <div class="st-mn-car-nav">
            <span class="st-mn-car-pos" data-mn-pos aria-live="polite"></span>
            <button class="st-icon-btn st-mn-arrow st-mn-arrow--prev" type="button" data-mn-step="-1" aria-label="Previous liquidations" disabled></button>
            <button class="st-icon-btn st-mn-arrow" type="button" data-mn-step="1" aria-label="Next liquidations"></button>
          </div>
        </div>
        <div class="st-mn-track" data-mn-track tabindex="0" role="region" aria-label="Real Aave liquidations on Ethereum, each beside a Stead rescue"></div>
        <p class="st-site-caption">Each card is a real Aave V3 liquidation on Ethereum. The premium is what the lowest steward would have bid at Stead's 1.15 trigger, priced from the same position just before it was liquidated. Read-only: no Stead transaction.</p>
      </div>
    </section>

    <section class="st-site-ways" aria-labelledby="ways-h" data-panel>
      <h2 class="st-site-h2" id="ways-h">Three ways to see it work</h2>
      <div class="st-site-ways-grid">
        <a class="st-panel st-way" href="#/try"><div class="st-label">YOUR NEAR WALLET · ABOUT 15 MIN</div><h3 class="st-proof-t">Protect an Aave position</h3><p class="st-proof-b">Open a protected position with your own NEAR account, push it under the trigger, try to break it, and buy the rescue back. Test funds are sponsored; a Sepolia wallet is optional.</p><span class="st-way-go">Start</span></a>
        <a class="st-panel st-way" href="?demo=#/live"><div class="st-label">NO WALLET · ABOUT 5 MIN</div><h3 class="st-proof-t">Start a demo rescue</h3><p class="st-proof-b">A demo borrower falls under the trigger on Aave Sepolia; watch the real auction, every transaction it sends, and the contract refusing what a locked position forbids.</p><span class="st-way-go">Start</span></a>
        <a class="st-panel st-way" href="#/rescues"><div class="st-label">ONE CLICK</div><h3 class="st-proof-t">Read any rescue's story</h3><p class="st-proof-b">Every rescue so far, from the proven trigger to the last payout, each step linked to its NEAR or Sepolia transaction.</p><span class="st-way-go">Open</span></a>
      </div>
    </section>

    <section class="st-story" id="how" aria-labelledby="how-h" data-story>
      <div class="st-panel st-site-sect st-story-panel" data-story-panel data-panel>
        <div class="st-site-head"><h2 class="st-site-h2" id="how-h">One rescue, four steps</h2><span class="st-site-aside" data-how-aside>about 2 to 3 minutes from trigger to claim</span></div>
        <div class="st-story-body">
          <ol class="st-steps">
            ${[
              ["Trigger", "A proven reading shows the loan's health below 1.15. The position is exposed, and an auction opens for the top-up that brings it back to 1.50."],
              ["Auction", "For 45 seconds, stewards bid the premium down. The lowest bid wins, and no bid can exceed a cap set below Aave's liquidation penalty."],
              ["Top-up", "The winner supplies the collateral into the position. Once a proven reading shows it arrived, the steward receives a claim for exactly what it supplied plus its premium."],
              ["Buy back or settle", "The borrower buys the claim back by paying into the position, and the contract pays the steward exactly what is owed. If the window ends first, the claim settles from the position."],
            ]
              .map(([t, b], i) => `<li class="st-step-site${i === 0 ? " is-exposed" : ""}"><span class="st-step-num">${numRoll(String(i + 1).padStart(2, "0"))}</span><h3 class="st-step-site-t">${t}</h3><p class="st-step-site-b">${b}</p></li>`)
              .join("")}
          </ol>
          <div class="st-story-stage" data-story-stage aria-hidden="true" hidden><p class="st-empty">Loading the recorded rescue…</p></div>
        </div>
      </div>
    </section>

    <div data-chart data-panel></div>

    <section class="st-panel st-site-sect" id="stewards" aria-labelledby="stewards-h" data-panel>
      <div class="st-site-head">
        <div><h2 class="st-site-h2" id="stewards-h">Stewards</h2><p class="st-site-sub">Agents that bid to rescue positions with their own capital. Anyone can register one; these five are example strategies, each with its own appetite for risk.</p></div>
        <a class="st-secondary st-cut st-secondary--link" href="${REPO_URL}/blob/main/stewards/README.md" target="_blank" rel="noopener"><span class="cut-label">Run a steward</span></a>
      </div>
      <div class="st-steward-grid">
        ${STEWARD_ORDER.map(
          (s) => `<div class="st-steward-card" style="--sc: var(--st-steward-${s})">
            <div class="st-steward-card-top">${tile(s, 40)}<span class="st-risk st-risk--site" role="img" aria-label="Risk appetite: ${RISK_WORD[RISK[s]]}">${[1, 2, 3, 4, 5].map((i) => `<span class="st-pip${i <= RISK[s] ? " st-pip--on" : ""}" style="--i:${i - 1}"></span>`).join("")}</span></div>
            <h3 class="st-steward-name">${s}</h3>
            <p class="st-steward-rule">${RULE[s]}</p>
          </div>`,
        ).join("")}
      </div>
    </section>

    <section class="st-site-proofs" id="proof" aria-labelledby="proof-h" data-panel>
      <h2 class="st-visually-hidden" id="proof-h">Why you can check it</h2>
      <div class="st-panel st-proof-card"><div class="st-label">PROVEN READINGS</div><h3 class="st-proof-t">Checked in an enclave</h3><p class="st-proof-b">Every health factor, top-up and payment the contract acts on is read by a proof program running in an OutLayer enclave, from several RPCs that must agree. No auction opens on a reported number.</p></div>
      <div class="st-panel st-proof-card"><div class="st-label">SIGNED BY NEAR</div><h3 class="st-proof-t">Only allowed actions</h3><p class="st-proof-b">The contract holds each position through NEAR chain signatures and signs only what its rules allow: supply, repay, the top-up and exact payouts to registered addresses. While a claim is open, withdrawals are locked.</p></div>
      <div class="st-panel st-proof-card"><div class="st-label">SIGNED AI</div><h3 class="st-proof-t">Tuning you can audit</h3><p class="st-proof-b">A steward can let a model on NEAR AI Cloud adjust its risk settings within fixed bounds. A suggestion is applied only if the enclave's signature over that exact answer checks out, and each one links to its verification.</p></div>
    </section>

    <section class="st-panel st-site-sect st-site-faq" aria-labelledby="faq-h" data-panel>
      <div class="st-site-faq-head">
        <div class="st-label">QUESTIONS</div>
        <h2 class="st-site-h2" id="faq-h">What people ask</h2>
        <p class="st-site-caption">Short answers. The full walk-through, with diagrams and recorded runs, is on <a class="st-textlink" href="#/how">How it works</a>.</p>
      </div>
      <div class="st-faq">${FAQ.map(([q, a]) => `<details class="st-faq-item"><summary>${q}<span class="st-item-caret" aria-hidden="true"></span></summary><p>${a}</p></details>`).join("")}</div>
    </section>

    <footer class="st-panel st-site-foot" data-panel>
      <div class="st-site-foot-main">
      <a class="st-brand-plain" href="#/" aria-label="Stead, home">${logo(22)}</a>
      <p class="st-site-foot-tag">Held between the limits, never left to the liquidator.</p>
      <nav class="st-site-foot-links" aria-label="Pages"><a class="st-textlink" href="#/how">How it works</a><a class="st-textlink" href="#/try">Protect a position</a><a class="st-textlink" href="#/live">Live auctions</a><a class="st-textlink" href="#/rescues">Rescues</a><a class="st-textlink" href="#/proofs">Proofs</a><a class="st-textlink" href="#/mainnet">On mainnet</a></nav>
      <p class="st-site-foot-line">Testnet build for NEAR HACKATHON 2026. Unaudited.</p>
      <span class="st-mono st-site-foot-id">steadfi.testnet</span>
      <div class="st-seg st-seg--foot" role="group" aria-label="Theme">
        <button type="button" data-theme-set="light" aria-pressed="${document.documentElement.getAttribute("data-theme") !== "dark"}">LIGHT</button>
        <button type="button" data-theme-set="dark" aria-pressed="${document.documentElement.getAttribute("data-theme") === "dark"}">DARK</button>
      </div>
      </div>
      <div class="st-site-foot-mark"><canvas class="st-mark" aria-hidden="true" data-mark></canvas></div>
    </footer>
  </div>`;
}

/** The live band: the contracts' own records, read through the feed. "Worse off" is computed from
 *  each rescue's numbers (premiums against its cap), not asserted. */
function fillLive(root: HTMLElement, r: Records, live: boolean) {
  const real = r.rescues.filter((x) => x.chain !== "local fork");
  const done = real.filter((x) => x.state === "bought_back" || x.state === "settled");
  const worse = done.filter((x) => x.premiumUsd > (x.topUpUsd * x.capBps) / 10_000 + 0.01).length;
  const lows = done.map((x) => Math.min(...x.winners.map((w) => w.bps))).filter(Number.isFinite).sort((a, b) => a - b);
  const median = lows.length ? lows[Math.floor(lows.length / 2)] : null;
  const last = real.reduce((m, x) => Math.max(m, x.openedAtMs), 0);
  const positions = r.positions.filter((p) => p.chain !== "local fork").length;
  const cells = [
    ["RESCUES ON SEPOLIA", numRoll(String(done.length)), `${done.filter((x) => x.state === "bought_back").length} bought back, ${done.filter((x) => x.state === "settled").length} settled`],
    ["BORROWERS WORSE OFF THAN LIQUIDATION", numRoll(String(worse)), "every premium checked against its cap"],
    ["MEDIAN WINNING PREMIUM", median === null ? num("—") : `${numRoll(String(median))}<span class="st-unit">bps</span>`, "the lowest winning bid of each rescue"],
    ["LAST RESCUE", last ? numRoll(ago(last).replace(" ago", "")) : num("—"), last ? `ago · ${positions} positions protected` : ""],
  ];
  root.querySelector<HTMLElement>("[data-totals]")!.innerHTML = cells.map(([dt, dd, sub]) => `<div><dt>${dt}</dt><dd>${dd}</dd><dd class="st-kpi-sub">${sub}</dd></div>`).join("");
  root.querySelector<HTMLElement>("[data-totals-caption]")!.innerHTML = `${live ? "Read from the contracts" : "Snapshot of the contracts"} at ${new Date(r.generated).toISOString().slice(0, 16).replace("T", " ")} UTC · <a class="st-textlink" href="#/rescues">every rescue, every transaction</a>`;
  root.querySelector<HTMLElement>("[data-live-line]")!.textContent = `Live on NEAR testnet and Ethereum Sepolia, with Aave V3's real contracts. Last rescue ${ago(last)}.`;
}
function fillMainnet(root: HTMLElement, m: PanelFeed | null) {
  const sect = root.querySelector<HTMLElement>("[data-mainnet]");
  if (!sect || !m || !m.summary.compared24h) return;
  const s = m.summary;
  sect.hidden = false;
  const kept = sect.querySelector<HTMLElement>("[data-mn-kept]")!;
  kept.textContent = usdK(s.saved24hUsd);
  kept.setAttribute("data-roll", "");
  kept.setAttribute("data-roll-view", "");
  sect.querySelector("[data-mn-kept-sub]")!.textContent = `that borrowers would have kept with Stead, on ${s.compared24h} of ${s.liquidations24h} real liquidations`;
  rollOnView(sect);
  fillSaved(sect, m.liquidations);
  sect.querySelector("[data-mn-text]")!.textContent = `In the 24 hours to ${new Date(m.blockTime).toISOString().slice(11, 16)} UTC, Aave liquidators took ${usdK(s.bonusPaid24hUsd)} in bonuses on Ethereum. On the same positions, Stead's stewards would have charged ${usdK(s.steadPremium24hUsd)} in premiums. ${s.nearTrigger} positions sit near the trigger right now. Read-only, from public RPCs: no Stead transaction.`;
}

// ───────────── positions Stead could have saved: real mainnet liquidations, stepped with arrows ─────────────

let stopDeal = () => {};
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const SAVED_MAX = 12;

function savedCard(l: Liquidation, i: number, n: number): string {
  const s = l.stead!;
  // the premium's bar is drawn against the liquidator's bonus (always the larger: the cap keeps it so)
  const share = Math.max(2, Math.min(100, (s.premiumUsd / l.bonusPaidUsd) * 100));
  const steward = STEWARD_ORDER.includes(s.steward as StewardId) ? (s.steward as StewardId) : null;
  return `
  <article class="st-mn-card" aria-roledescription="slide" aria-label="${i + 1} of ${n}">
    <div class="st-mn-card-top"><span class="st-chip st-chip--liquidated">LIQUIDATED</span><span class="st-mn-when">${l.at.slice(11, 16)} UTC · ${ago(Date.parse(l.at))}</span></div>
    <div><h3 class="st-mn-pair">${escHtml(l.collateral.symbol)} / ${escHtml(l.debt.symbol)}</h3><p class="st-mn-debt">${usdK(s.debtUsd)} of debt just before</p></div>
    <div class="st-mn-cmp">
      <div class="st-mn-row"><span class="st-label">LIQUIDATOR TOOK</span>${num(usdK(l.bonusPaidUsd))}</div>
      <div class="st-cbar" aria-hidden="true"><span class="st-cbar-low" style="width:100%"></span></div>
      <div class="st-mn-row"><span class="st-label">STEAD PREMIUM</span>${num(usdK(s.premiumUsd))}</div>
      <div class="st-cbar" aria-hidden="true"><span class="st-cbar-premium" style="width:${share.toFixed(1)}%"></span></div>
    </div>
    <div class="st-mn-kept"><span class="st-num" data-roll data-roll-deal>${usdK(s.savedUsd)}</span><span>the borrower would have kept</span></div>
    <div class="st-mn-card-foot">${steward ? `${tile(steward, 22)}<span>${steward} at ${s.bps} bps</span>` : `<span>lowest bid ${s.bps} bps</span>`}<a class="st-textlink st-extlink" href="https://etherscan.io/tx/${l.tx}" target="_blank" rel="noopener">Etherscan${icon("external", 13)}</a></div>
  </article>`;
}

/** The latest liquidations that have a Stead estimate, newest first, as cards stepped with arrows. */
function fillSaved(sect: HTMLElement, all: Liquidation[]) {
  const box = sect.querySelector<HTMLElement>("[data-mn-carousel]")!;
  const list = all.filter((l) => l.stead && l.stead.savedUsd > 0 && l.bonusPaidUsd > 0).sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, SAVED_MAX);
  if (!list.length) return;
  const track = box.querySelector<HTMLElement>("[data-mn-track]")!;
  track.innerHTML = list.map((l, i) => savedCard(l, i, list.length)).join("");
  box.hidden = false;
  stopDeal();
  stopDeal = mountDeal(box, track);
  const pos = box.querySelector<HTMLElement>("[data-mn-pos]")!;
  const [prev, next] = box.querySelectorAll<HTMLButtonElement>("[data-mn-step]");
  const step = () => {
    const card = track.firstElementChild as HTMLElement;
    return card.offsetWidth + parseFloat(getComputedStyle(track).columnGap || "0");
  };
  const sync = () => {
    const w = step();
    const first = Math.round(track.scrollLeft / w);
    const shown = Math.max(1, Math.round((track.clientWidth + 1) / w));
    const last = Math.min(list.length, first + shown);
    pos.textContent = shown > 1 ? `${first + 1}–${last} of ${list.length}` : `${first + 1} of ${list.length}`;
    prev.disabled = track.scrollLeft <= 2;
    next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
  };
  let pending = 0;
  track.onscroll = () => {
    if (!pending) pending = requestAnimationFrame(() => ((pending = 0), sync()));
  };
  const go = (dir: number) => {
    const w = step();
    const shown = Math.max(1, Math.round((track.clientWidth + 1) / w));
    track.scrollBy({ left: dir * shown * w, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  new ResizeObserver(() => sync()).observe(track);
  prev.onclick = () => go(-1);
  next.onclick = () => go(1);
  track.onkeydown = (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      go(e.key === "ArrowRight" ? 1 : -1);
    }
  };
  sync();
}

function fillTotals(root: HTMLElement, s: SiteStats | null) {
  const dl = root.querySelector<HTMLElement>("[data-totals]")!;
  const cap = root.querySelector<HTMLElement>("[data-totals-caption]")!;
  if (!s) {
    cap.textContent = "The totals could not be read. They come from the contracts' own records.";
    return;
  }
  const cells = [
    ["RESCUES", numRoll(String(s.rescues)), `${s.boughtBack} bought back, ${s.settled} settled`],
    ["BORROWERS WORSE OFF THAN LIQUIDATION", numRoll(String(s.worseOff)), "premium within the cap every time"],
    ["MEDIAN WINNING PREMIUM", s.medianPremiumBps === null ? num("—") : `${numRoll(String(s.medianPremiumBps))}<span class="st-unit">bps</span>`, "the lowest bid of each rescue"],
    ["MEDIAN TRIGGER TO CLAIM", s.medianTriggerToClaimS === null ? num("—") : numRoll(fmtDur(s.medianTriggerToClaimS)), "auction, top-up and proof"],
  ];
  dl.innerHTML = cells.map(([dt, dd, sub]) => `<div><dt>${dt}</dt><dd>${dd}</dd><dd class="st-kpi-sub">${sub}</dd></div>`).join("");
  const day = new Date(s.generatedAt).toISOString().slice(0, 10);
  cap.textContent = `Finished rescues on Sepolia, read from ${s.contracts.join(" and ")} on ${day}. Runs on our local fork (${s.forkRescues}) are not counted.`;
  if (s.medianTriggerToClaimS !== null) root.querySelector<HTMLElement>("[data-how-aside]")!.textContent = `median ${fmtDur(s.medianTriggerToClaimS)} from trigger to claim on Sepolia`;
}

// ───────────── live mini board (a replay of the latest recorded auction, on loop) ─────────────

function miniBoard(log: RescueLog): string {
  const bidders = STEWARD_ORDER.filter((s) => log.events.some((e) => e.kind === "BID" && e.steward === s)).slice(0, 4);
  return `
    <div class="st-mini-top">
      <span class="st-mini-state"><span class="st-dot st-dot--replay" aria-hidden="true"></span>REPLAY · POSITION ${log.positionId}</span>
      <span class="st-mini-clock" role="timer" aria-label="Time left in the auction" data-mclock>00:45</span>
    </div>
    <div class="st-hfbar">
      <div class="st-hfbar-track"><span class="st-hfbar-fill" data-mfill></span><span class="st-hfbar-mark st-hfbar-mark--trigger"></span><span class="st-hfbar-mark st-hfbar-mark--trip"></span></div>
      <div class="st-hfbar-read"><span class="st-hfbar-num" data-mhf>—</span><span class="st-hfbar-cons" data-mcons></span></div>
    </div>
    <div class="st-mini-ladder" style="--n:${bidders.length}" role="list" aria-label="Bids, lowest premium first" data-mladder>
      ${bidders.map((_, i) => `<div class="st-mini-ph" style="--rank:${i}" aria-hidden="true">watching</div>`).join("")}
      ${bidders
        .map(
          (s) => `<div class="st-mini-row" role="listitem" data-mrow="${s}" style="--sc: var(--st-steward-${s}); --flash-c: var(--st-steward-${s})">
            ${tile(s, 26)}<span class="st-mini-name">${s}</span><span class="st-mini-bar"><span class="st-mini-fill" data-mbar></span></span><span class="st-mini-bps" data-mbps></span>
          </div>`,
        )
        .join("")}
    </div>
    <p class="st-mini-cap">Lowest premium wins. <span class="st-quiet">Replay of <a class="st-textlink" href="#/live">rescue ${log.rescueId}</a>, recorded on Sepolia.</span></p>`;
}

function updateMini(root: HTMLElement, log: RescueLog, t: number) {
  const b = boardAt(log, t);
  root.querySelector("[data-mclock]")!.textContent = `00:${String(b.clock).padStart(2, "0")}`;
  const fill = root.querySelector<HTMLElement>("[data-mfill]")!;
  const hfEl = root.querySelector<HTMLElement>("[data-mhf]")!;
  if (b.hf === null) {
    fill.style.width = "0%";
    hfEl.textContent = "—";
    root.querySelector("[data-mcons]")!.textContent = "Watching the position";
  } else {
    fill.style.width = `${Math.max(0, Math.min(100, ((b.hf - 0.9) / 0.8) * 100))}%`;
    fill.classList.toggle("is-below", b.below);
    hfEl.textContent = b.hf.toFixed(2);
    hfEl.classList.toggle("is-below", b.below);
    root.querySelector("[data-mcons]")!.textContent = `${log.market.collateral} can fall ${consequence(b.hf)}% before liquidation`;
  }
  const ranked = b.rows.filter((r) => r.rank !== null);
  root.querySelector("[data-mladder]")!.classList.toggle("has-bids", ranked.length > 0);
  for (const r of b.rows) {
    const el = root.querySelector<HTMLElement>(`[data-mrow="${r.steward}"]`);
    if (!el) continue;
    el.style.setProperty("--rank", String(r.rank ?? ranked.length));
    el.classList.toggle("is-in", r.bps !== null);
    el.classList.toggle("is-first", r.rank === 0);
    el.querySelector<HTMLElement>("[data-mbar]")!.style.width = r.bps !== null ? `${Math.min(100, r.bps / 3)}%` : "0%";
    el.querySelector("[data-mbps]")!.innerHTML = r.bps !== null ? `${num(String(r.bps))}<span class="st-unit">bps</span>` : "";
  }
}

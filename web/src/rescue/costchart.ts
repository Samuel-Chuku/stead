// The cost chart: one recorded rescue's position run along a real price fall, from the trigger on.
// Two panels share the time axis: the collateral's price against the trigger (why both lines fall),
// and the health factor with and without the rescue, over Aave's liquidation zone. The gap between
// the two lines is what the top-up bought. Before the trigger the two are the same position, so the
// chart starts at hour 0.
import type { ChartRun, CostPath } from "../../../stewards/src/costpath";
import type { RescueEvent, RescueLog } from "../../../stewards/src/rescuelog";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const usd = (n: number, d = 2) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (n: string) => `<span class="st-num">${n}</span>`;
const f = (n: number) => n.toFixed(1);
const pct = (r: number) => `${r >= 1 ? "+" : "−"}${Math.abs((r - 1) * 100).toFixed(1)}%`;
const hr = (h: number) => (h === 0 ? "0" : `+${h}h`);

/** A rescue page's own run (no year-wide count: that comes with the "How it works" runs). */
export function chartRunOf(log: RescueLog, path: CostPath): ChartRun {
  const of = <K extends RescueEvent["kind"]>(k: K) => log.events.filter((e) => e.kind === k) as Extract<RescueEvent, { kind: K }>[];
  const claims = of("CLAIM_MINTED");
  const premium = claims.reduce((s, c) => s + Number(c.premium), 0);
  const after = (of("READING") as any[]).find((e) => e.hf >= log.params.triggerHf);
  const t0 = path.hours.indexOf(0);
  return {
    key: `${log.contract.replace(/\.steadfi\.testnet$|\.testnet$/, "")}:${log.rescueId}`,
    rescueId: log.rescueId,
    positionId: log.positionId,
    collateral: log.market.collateral,
    sym: log.market.collateral.replace(/^W(BTC|ETH)$/, "$1"),
    pair: `${log.market.collateral}/${log.market.debt}`,
    about: "",
    stewards: [...new Set(claims.map((c) => c.holder))],
    claims: claims.length,
    rule: "fastest",
    triggerHf: path.without[t0] ?? log.params.triggerHf,
    hfAfter: after?.hf ?? path.with[t0],
    debtUsd: log.atOpen?.debtUsd ?? 0,
    priceUsd: log.atOpen?.priceUsd ?? 0,
    premium: premium.toFixed(8).replace(/\.?0+$/, ""),
    premiumUsd: premium * (log.atOpen?.priceUsd ?? 0),
    capBps: (of("AUCTION_OPEN")[0] as any)?.capBps ?? 0,
    path,
    year: null,
  };
}

/** The hours from the trigger on, with each line's value. */
function rows(p: CostPath) {
  return p.hours.map((h, j) => ({ h, r: p.ratio[j], w: p.with[j], wo: p.without[j] })).filter((x) => x.h >= 0);
}

export function dateOf(ms: number, withHour = false) {
  const d = new Date(ms);
  const day = `${d.getUTCDate()} ${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
  return withHour ? `${day}, ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC` : day;
}

// geometry (viewBox 760 × 380): the price strip on top, the health panel below
const X0 = 52, X1 = 744;
const P0 = 26, P1 = 96; // price strip
const H0 = 130, H1 = 344; // health panel

export function costChart(run: ChartRun, opts: { title?: boolean; caption?: string } = {}): string {
  const p = run.path;
  const R = rows(p);
  const hMax = R[R.length - 1].h;
  const x = (h: number) => X0 + (h / hMax) * (X1 - X0);
  // price strip: 0 % at the top line, down to the fall's lowest point
  const rLow = Math.min(...R.map((d) => d.r)), rHigh = Math.max(1, ...R.map((d) => d.r));
  const yp = (r: number) => P0 + ((rHigh - r) / (rHigh - rLow || 1)) * (P1 - P0);
  // health panel
  const yMax = Math.max(1.6, Math.ceil(Math.max(...R.map((d) => d.w)) * 10) / 10);
  const yMin = 0.9;
  const y = (v: number) => H1 - ((v - yMin) / (yMax - yMin)) * (H1 - H0);
  const liqH = p.liqHour;
  const live = R.filter((d) => d.wo !== null);
  const withPts = R.map((d) => `${f(x(d.h))},${f(y(d.w))}`);
  const withoutPts = live.map((d) => `${f(x(d.h))},${f(y(d.wo!))}`);
  // the gap the rescue bought, while the unrescued position still exists
  const gap = [...live.map((d) => `${f(x(d.h))},${f(y(d.w))}`), ...[...live].reverse().map((d) => `${f(x(d.h))},${f(y(d.wo!))}`)].join(" ");
  const pricePts = R.map((d) => `${f(x(d.h))},${f(yp(d.r))}`);
  const priceArea = `${f(x(0))},${f(yp(1))} ${pricePts.join(" ")} ${f(x(hMax))},${f(yp(1))}`;
  const low = R.reduce((a, d) => (d.w < a.w ? d : a), R[0]);
  const liqX = x(liqH), liqY = y(p.hfAtLiq);
  const ticks = R.filter((d) => d.h % 4 === 0).map((d) => d.h);
  const lowR = R.reduce((a, d) => (d.r < a.r ? d : a), R[0]);
  const fall = run.rule === "deepest" ? "deepest" : "fastest";
  const when = dateOf(p.startMs);
  const liqLabel = `LIQUIDATED AT +${liqH}H · −${usd(p.penaltyUsd.low, 0)} TO −${usd(p.penaltyUsd.high, 0)}`;
  const liqW = 8 + liqLabel.length * 6.6;
  // right of the zone's own label, as close to the liquidation point as fits
  const liqBoxX = Math.max(X0 + 200, Math.min(X1 - liqW, liqX - liqW / 2));
  const aria = `Position ${run.positionId} along ${run.sym}'s real hourly prices from ${dateOf(p.startMs, true)}. The price falls up to ${pct(lowR.r)}. Without Stead the health factor starts at ${run.triggerHf.toFixed(2)} and Aave liquidates at +${liqH} hours, costing ${usd(p.penaltyUsd.low, 0)} to ${usd(p.penaltyUsd.high, 0)}. With the rescue it starts at ${run.hfAfter.toFixed(2)} and its lowest point is ${p.lowestWith.toFixed(2)}; the premium was ${usd(run.premiumUsd)}.`;
  const max = p.penaltyUsd.high;
  const yr = run.year;
  const stewards = run.claims > 1 ? `${run.claims} claims pooled from ${run.stewards.join(", ")}` : `one claim, ${run.stewards[0] ?? "a steward"}`;

  return `
  <section class="st-panel st-chart-panel" aria-labelledby="chart-h-${run.rescueId}">
    <div class="st-chart-main">
      <div class="st-chart-head">
        <div>
          <div class="st-label">THE SAME POSITION, WITH AND WITHOUT THE RESCUE</div>
          <h2 class="st-chart-title" id="chart-h-${run.rescueId}">${opts.title === false ? "" : `On ${run.sym}'s ${fall} fall of 2026 (${esc(when)}), rescue ${run.rescueId} would have kept position ${run.positionId} out of liquidation`}</h2>
        </div>
        <div class="st-legend" aria-hidden="true"><span><i class="st-leg-with"></i>With Stead</span><span><i class="st-leg-without"></i>Without</span><span><i class="st-leg-gap"></i>What the top-up bought</span></div>
      </div>
      <div class="st-chart-box">
        <svg class="st-chart" viewBox="0 0 760 380" role="img" aria-label="${esc(aria)}">
          <text class="st-chart-axis-title" x="${X0}" y="14">${esc(run.sym)} PRICE AGAINST THE TRIGGER HOUR</text>
          <line class="st-grid" x1="${X0}" x2="${X1}" y1="${f(yp(1))}" y2="${f(yp(1))}"/>
          <text class="st-axis-t" x="${X0 - 6}" y="${f(yp(1) + 4)}" text-anchor="end">0%</text>
          <polygon class="st-price-area" points="${priceArea}"/>
          <polyline class="st-price-line" points="${pricePts.join(" ")}"/>
          <circle class="st-marker st-marker--quiet" cx="${f(x(lowR.h))}" cy="${f(yp(lowR.r))}" r="3"/>
          <text class="st-axis-t st-price-low" x="${f(Math.max(X0 + 24, Math.min(X1 - 24, x(lowR.h))))}" y="${f(yp(lowR.r) + 16)}" text-anchor="middle">${pct(lowR.r)}</text>

          <text class="st-chart-axis-title" x="${X0}" y="${H0 - 12}">HEALTH FACTOR</text>
          <rect class="st-zone-liq" x="${X0}" y="${f(y(1))}" width="${X1 - X0}" height="${f(H1 - y(1))}"/>
          <text class="st-zone-label" x="${X0 + 8}" y="${f(H1 - 8)}">AAVE LIQUIDATES BELOW 1.00</text>
          ${[yMax, 1.5, run.triggerHf, 1.0].filter((v, i, a) => a.indexOf(v) === i && v <= yMax).map((v) => `<line class="st-grid${v === 1 ? " st-grid--dash st-grid--trip" : Math.abs(v - run.triggerHf) < 1e-9 ? " st-grid--dash" : ""}" x1="${X0}" x2="${X1}" y1="${f(y(v))}" y2="${f(y(v))}"/><text class="st-axis-t${v === 1 ? " st-axis-trip" : ""}" x="${X0 - 6}" y="${f(y(v) + 4)}" text-anchor="end">${v.toFixed(2)}</text>`).join("")}
          <text class="st-axis-t" x="${X1}" y="${f(y(run.triggerHf) - 5)}" text-anchor="end">trigger</text>
          <polygon class="st-gap" points="${gap}"/>
          <line class="st-band-line" x1="${f(x(liqH))}" x2="${f(x(liqH))}" y1="${P0}" y2="${H1}" stroke-dasharray="3 3"/>
          <polyline class="st-line-without" points="${withoutPts.join(" ")}"/>
          <polyline class="st-line-with" points="${withPts.join(" ")}"/>
          <circle class="st-marker" cx="${f(x(0))}" cy="${f(y(run.hfAfter))}" r="4"/>
          <circle class="st-marker st-marker--trip" cx="${f(x(0))}" cy="${f(y(run.triggerHf))}" r="4"/>
          <g class="st-callout st-callout--with">
            <rect x="${f(x(0) + 10)}" y="${f(y(run.hfAfter) - 34)}" width="${f(8 + (`RESCUED · HF ${run.hfAfter.toFixed(2)} · PREMIUM ${run.premium} ${run.collateral}`).length * 6.6)}" height="24"/>
            <text x="${f(x(0) + 18)}" y="${f(y(run.hfAfter) - 18)}">RESCUED · HF ${run.hfAfter.toFixed(2)} · PREMIUM ${esc(run.premium)} ${esc(run.collateral)}</text>
          </g>
          <circle class="st-marker" cx="${f(x(low.h))}" cy="${f(y(low.w))}" r="3.5"/>
          <text class="st-axis-t st-low-label" x="${f(Math.max(X0 + 30, Math.min(X1 - 30, x(low.h))))}" y="${f(y(low.w) + 18)}" text-anchor="middle">lowest ${low.w.toFixed(2)}</text>
          <circle class="st-marker st-marker--trip" cx="${f(liqX)}" cy="${f(liqY)}" r="4"/>
          <g class="st-callout st-callout--trip">
            <rect x="${f(liqBoxX)}" y="${f(y(1) + 4)}" width="${f(liqW)}" height="22"/>
            <text x="${f(liqBoxX + 8)}" y="${f(y(1) + 19)}">${esc(liqLabel)}</text>
          </g>
          ${ticks.map((h) => `<text class="st-axis-t" x="${f(x(h))}" y="366" text-anchor="middle">${h === 0 ? "trigger" : hr(h)}</text>`).join("")}
          <line class="st-cross" x1="0" x2="0" y1="${P0}" y2="${H1}" visibility="hidden"/>
          <rect class="st-hit" x="${X0}" y="${P0}" width="${X1 - X0}" height="${H1 - P0}"/>
        </svg>
        <div class="st-tip" role="status" hidden></div>
      </div>
      <p class="st-chart-note">Both lines are position ${run.positionId} on the same real ${esc(run.sym)} prices (${esc(p.source)}, from ${esc(dateOf(p.startMs, true))}). <strong>Without Stead</strong> it starts at the trigger, HF ${run.triggerHf.toFixed(2)}, and Aave liquidates it ${liqH} hours later. <strong>With Stead</strong> the proven top-up lifts it to ${run.hfAfter.toFixed(2)} at hour 0, and the same fall only takes it to ${p.lowestWith.toFixed(2)}. The rescue itself is real (${esc(stewards)}); Sepolia's test price for ${esc(run.collateral)} is fixed at ${usd(run.priceUsd, 0)}, so the fall is replayed from the real market.</p>
      ${yr ? `<p class="st-chart-year"><strong>Not a lucky window:</strong> ${esc(run.sym)} fell far enough to liquidate this position within 24 hours from ${yr.windows} different starting hours of 2026. The rescued position stayed above 1.00 in ${yr.held === yr.windows ? `all ${yr.windows}` : `${yr.held} of ${yr.windows}`}; its lowest point across all of them was ${yr.worstWith.toFixed(2)}.</p>` : ""}
      <details class="st-values">
        <summary>Show the hourly values</summary>
        <div class="st-table-wrap"><table class="st-proofs st-values-table"><thead><tr><th>HOUR</th><th>${esc(run.sym)} PRICE</th><th>WITH STEAD</th><th>WITHOUT</th><th>DIFFERENCE</th></tr></thead><tbody>
          ${R.map((d) => `<tr${d.h === liqH ? ' class="is-liq"' : ""}><td>${d.h === 0 ? "0 (trigger)" : hr(d.h)}</td><td>${pct(d.r)}</td><td>${d.w.toFixed(3)}</td><td>${d.wo === null ? "liquidated" : d.wo < 1 ? `${d.wo.toFixed(3)} · liquidated` : d.wo.toFixed(3)}</td><td>${d.wo === null ? "—" : `+${(d.w - d.wo).toFixed(3)}`}</td></tr>`).join("")}
        </tbody></table></div>
      </details>
      ${opts.caption ?? ""}
    </div>
    <div class="st-chart-summary">
      <div class="st-label">BORROWER SAVED</div>
      <div class="st-saved">${num(`$${Math.round(p.savedUsd.low)}–${Math.round(p.savedUsd.high)}`)}</div>
      <p class="st-saved-line">Aave's liquidation bonus on this debt is ${usd(p.penaltyUsd.low, 0)}–${usd(p.penaltyUsd.high, 0)} (half or all of it closed). The rescue's premium was ${usd(run.premiumUsd)}.</p>
      <div class="st-bars">
        <div class="st-bar-label">Liquidation penalty</div>
        <div class="st-cbar"><span class="st-cbar-low" style="width:${f((p.penaltyUsd.low / max) * 100)}%"></span><span class="st-cbar-range" style="left:${f((p.penaltyUsd.low / max) * 100)}%; width:${f(((p.penaltyUsd.high - p.penaltyUsd.low) / max) * 100)}%"></span></div>
        <div class="st-bar-label">Rescue premium</div>
        <div class="st-cbar"><span class="st-cbar-premium" style="width:${f(Math.max(0.6, (run.premiumUsd / max) * 100))}%"></span></div>
      </div>
      <dl class="st-sum-rows">
        <div><dt>DEBT AT THE TRIGGER</dt><dd>${usd(run.debtUsd, 0)}</dd></div>
        <div><dt>PREMIUM</dt><dd>${esc(run.premium)} ${esc(run.collateral)}</dd></div>
        <div><dt>PREMIUM CAP</dt><dd>${run.capBps.toLocaleString("en-US")} bps</dd></div>
        <div><dt>LOWEST HF WITH STEAD</dt><dd>${p.lowestWith.toFixed(2)}</dd></div>
        ${yr ? `<div><dt>2026 FALLS SURVIVED</dt><dd>${yr.held} of ${yr.windows}</dd></div>` : ""}
      </dl>
    </div>
  </section>`;
}

export function wireCostChart(root: HTMLElement, run: ChartRun) {
  const svg = root.querySelector<SVGSVGElement>(".st-chart");
  const tip = root.querySelector<HTMLElement>(".st-tip");
  const cross = root.querySelector<SVGLineElement>(".st-cross");
  const hit = root.querySelector<SVGRectElement>(".st-hit");
  if (!svg || !tip || !cross || !hit) return;
  const R = rows(run.path);
  const hMax = R[R.length - 1].h;
  const show = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * 760;
    const h = Math.max(0, Math.min(hMax, Math.round(((vx - X0) / (X1 - X0)) * hMax)));
    const d = R.find((r) => r.h === h)!;
    const hx = X0 + (h / hMax) * (X1 - X0);
    cross.setAttribute("x1", String(hx));
    cross.setAttribute("x2", String(hx));
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b>${h === 0 ? "trigger" : hr(h)}</b> · ${esc(run.sym)} ${pct(d.r)} · with Stead ${d.w.toFixed(2)} · without ${d.wo === null ? "liquidated" : d.wo.toFixed(2)}`;
    const left = (hx / 760) * box.width;
    tip.style.left = `${Math.min(box.width - tip.offsetWidth, Math.max(0, left - tip.offsetWidth / 2))}px`;
  };
  hit.addEventListener("pointermove", (e) => show(e.clientX));
  hit.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}

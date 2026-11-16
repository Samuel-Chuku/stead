// The pooled rescue section (components.md §15, option B "fill the gap"). Built once; update()
// moves blocks, toggles states and fills text. Motion is CSS reacting to classes set from events.
import type { RescueLog, StewardId } from "../../../stewards/src/rescuelog";
import { CODE, STEWARD_ORDER, fmtAmt, type Board, type SettleStep } from "./model";

const tile = (s: StewardId, size: number) => `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s]}</span>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (hf: number) => Math.max(0, Math.min(100, ((hf - 0.9) / 0.8) * 100));

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/** The settlement's steps as a strip: done in ink, the current one outlined, the rest quiet.
 *  Shared by the pooled section and the single claim's slot. */
export function settleStrip(st: { steps: SettleStep[] }, t: number, label = "Settlement steps"): string {
  return `<ol class="st-settle" aria-label="${label}">${st.steps
    .map((x) => `<li class="st-settle-step${x.state === "done" && x.t !== null && t - x.t >= 0 && t - x.t < 1.2 ? " is-fresh" : ""}" data-state="${x.state}"><span class="st-settle-mark" aria-hidden="true"></span><span class="st-settle-label">${x.label}</span><span class="st-settle-detail">${esc(x.detail)}</span></li>`)
    .join("")}</ol>`;
}
export const settleKey = (st: { steps: SettleStep[] } | null) => (st ? st.steps.map((x) => `${x.key}:${x.state}:${x.detail}`).join("|") : "");

export function poolMarkup(log: RescueLog): string {
  return `
  <section class="st-panel st-board-panel st-pool" aria-label="Pooled rescue" data-pool>
    <div class="st-panel-head">
      <div class="st-label">POOLED RESCUE · POSITION ${log.positionId} · FILL THE GAP</div>
      <h2 class="st-panel-title" data-ptitle></h2>
      <div class="st-panel-sub" data-psub></div>
    </div>
    <div class="st-pool-cards">
      ${STEWARD_ORDER.map((s) => `<div class="st-pool-card" data-pcard="${s}">${tile(s, 30)}<div class="st-pool-card-body"><span class="st-pool-card-name">${s}</span><span class="st-pool-card-status" data-pstatus></span></div></div>`).join("")}
    </div>
    <div class="st-pool-stage">
      <div class="st-pool-rail" aria-hidden="true"><span style="bottom:100%">100%</span><span style="bottom:50%">50%</span><span style="bottom:0%">0</span></div>
      <div class="st-pool-col" role="img" data-pcol>
        <div class="st-pool-hatch" aria-hidden="true"></div>
        ${STEWARD_ORDER.map((s) => `<div class="st-pool-block" data-pblock="${s}" style="--sc: var(--st-steward-${s})"><span class="st-pool-block-name" data-pbname></span><span class="st-pool-block-amt" data-pbamt></span></div>`).join("")}
        <div class="st-pool-lid" aria-hidden="true"></div>
        <div class="st-pool-stamp" aria-hidden="true">FUNDED</div>
      </div>
      <div class="st-pool-pipe" aria-hidden="true"><span class="st-pool-pipe-flow" data-ppipe></span></div>
      <div class="st-pool-tank">
        <div class="st-gauge st-gauge--tank" role="img" aria-label="Position health factor" data-ptank>
          <div class="st-gauge-fill" data-ptankfill></div>
          <div class="st-gauge-mark st-gauge-mark--target" style="bottom: 75%"></div>
          <div class="st-gauge-mark st-gauge-mark--trigger" style="bottom: 31.25%"></div>
          <div class="st-gauge-mark st-gauge-mark--trip" style="bottom: 12.5%"></div>
        </div>
        <div class="st-pool-tank-read">
          <div class="st-label">POSITION ${log.positionId}</div>
          <div class="st-hf st-hf--tank" data-ptankhf>—</div>
          <div class="st-pool-tank-sub">health factor · target ${log.params.targetHf.toFixed(2)}</div>
        </div>
      </div>
    </div>
    <div class="st-pool-counter"><span data-pcount></span><span class="st-quiet" data-pnote></span></div>
    <div class="st-pool-settle" data-psettle></div>
    <div class="st-pool-tags" data-ptags></div>
    <p class="st-note">Each block is that steward's share of the gap, filled from the lowest premium up. Each claim is held by its own steward and paid back exactly, from the same buy-back.</p>
  </section>`;
}

export function updatePool(root: HTMLElement, log: RescueLog, b: Board, state: { fell: Map<string, number>; tagKey: string; settleKey: string }) {
  const p = b.pool;
  const sect = root.querySelector<HTMLElement>("[data-pool]");
  if (!p || !sect) return;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => sect.querySelector<T>(sel)!;
  const n = p.blocks.length;
  const committedPct = Math.round((p.committed / p.gap) * 100);
  const title = !p.blocks.length && b.phase !== "auction" && b.phase !== "before"
    ? `No offer covered ${p.gapText}`
    : b.phase === "before"
      ? `Who fills ${p.gapText}?`
      : !p.final
        ? `Who fills ${p.gapText}?`
        : p.claimsOpen && b.settlement
          ? `Settling ${n} claims at the oracle price`
          : p.claimsOpen && b.window
            ? b.window.left > 0 ? `${n} claims open · buy-back window ${clock(b.window.left)}` : `${n} claims open · buy-back window closed`
          : p.closedText
            ? `${n} claims ${p.closedText}`
            : p.confirmed
              ? `Top-up proven in the position`
              : p.draining
                ? `${n} stewards supplying ${p.gapText}`
                : `Funded by ${n} stewards`;
  q("[data-ptitle]").textContent = title;
  const st = b.settlement;
  const sub = p.claimsOpen && st
    ? st.steps.find((x) => x.state === "active")?.key === "legs"
      ? `Debt repaid · the position pays each claim its supplied units and premium, one transfer each`
      : `The window closed before a buy-back was proven: ${st.settler ?? "a steward"} repays the debt on Aave, then each claim is paid`
    : p.claimsOpen && b.window
      ? b.window.paidIn
        ? b.window.proven ? `The borrower paid ${b.window.paidIn} into the position; proven` : `The borrower paid ${b.window.paidIn} into the position · waiting for its proof`
        : b.window.left > 0 ? `The borrower can buy every claim back before the window closes` : `No buy-back proven in time · the claims will be settled`
      : null;
  q("[data-psub]").textContent = sub ?? (!p.final ? (n ? `If the auction closed now: ${n} steward${n > 1 ? "s" : ""}, lowest premium first` : "Stewards offer an amount and a premium; the lowest premiums fill the gap") : "Filled from the lowest premium up; the last offer trimmed to fit");

  // the settlement's steps, from its start (kept up after it ends)
  const strip = st ?? b.buyback;
  const sk = (st ? "s" : "b") + settleKey(strip);
  if (sk !== state.settleKey) {
    state.settleKey = sk;
    q("[data-psettle]").innerHTML = strip ? settleStrip(strip, b.t, st ? "Settlement steps" : "Buy-back steps") : "";
  }

  for (const c of p.cards) {
    const el = q(`[data-pcard="${c.steward}"]`);
    el.dataset.state = c.state;
    const st = el.querySelector<HTMLElement>("[data-pstatus]")!;
    st.textContent = c.status;
    st.classList.toggle("is-blink", c.state === "bidding");
  }

  const col = q("[data-pcol]");
  col.classList.toggle("is-funded", p.funded && p.final);
  col.classList.toggle("is-draining", p.draining);
  col.classList.toggle("is-drained", p.sentT !== null && b.t - p.sentT > 6); // jumped past the drain: no replayed motion
  col.setAttribute("aria-label", `${p.committed.toFixed(2)} of ${p.gapText} committed by ${n} steward${n === 1 ? "" : "s"}`);
  for (const s of STEWARD_ORDER) {
    const el = q(`[data-pblock="${s}"]`);
    const blk = p.blocks.find((x) => x.steward === s);
    if (!blk) {
      el.hidden = true;
      state.fell.delete(s);
      continue;
    }
    el.hidden = false;
    el.style.setProperty("--bottom", String(blk.bottom));
    el.style.setProperty("--share", String(blk.share));
    el.classList.toggle("is-small", blk.share < 16);
    el.querySelector("[data-pbname]")!.textContent = `${s} ${Math.round(blk.share)}%`;
    el.querySelector("[data-pbamt]")!.textContent = blk.amountText;
    // a block falls in once, when its steward's offer first enters the coalition
    if (state.fell.get(s) === undefined) {
      state.fell.set(s, blk.since);
      el.classList.remove("is-falling");
      if (b.t - blk.since < 1.2) { // only while watching it happen, not after a jump
        void el.offsetWidth;
        el.classList.add("is-falling");
      }
    }
  }

  const pipe = q("[data-ppipe]");
  // members' colours in share order, scaled to one 40px period (the st-flow-x step) so the flow loops cleanly
  const stops: string[] = [];
  let x = 0;
  p.blocks.forEach((blk, i) => {
    const w = i === p.blocks.length - 1 ? 40 - x : Math.max(4, Math.round((blk.share / 100) * 40));
    stops.push(`var(--st-steward-${blk.steward}) ${x}px ${x + w}px`);
    x += w;
  });
  pipe.style.setProperty("--stripes", stops.length ? `repeating-linear-gradient(90deg, ${stops.join(", ")})` : "none");
  pipe.classList.toggle("is-flowing", p.flowing);
  pipe.classList.toggle("is-done", p.confirmed);

  const fill = q("[data-ptankfill]");
  const hfEl = q("[data-ptankhf]");
  if (b.hf !== null) {
    fill.style.height = pct(b.hf) + "%";
    fill.classList.toggle("is-below", b.below);
    hfEl.textContent = b.hf.toFixed(2);
    hfEl.classList.toggle("is-below", b.below);
    q("[data-ptank]").setAttribute("aria-label", `Position health factor ${b.hf.toFixed(2)}`);
  }

  q("[data-pcount]").textContent = `${fmtAmt(p.committed)} of ${p.gapText} ${p.final ? "committed" : "offered"} · ${committedPct}%`;
  const bpsList = p.blocks.map((x) => x.bps);
  q("[data-pnote]").textContent = bpsList.length ? `premiums ${[...new Set(bpsList)].join(", ")} bps, each paid on its own share` : "";

  // lockout tags: amber while the claims are open; each shows its own exact payout as it lands
  const key = p.tags.map((t) => `${t.claim}:${t.buyback ?? ""}:${t.paid ?? ""}:${t.settledLines.length}`).join("|") + `|${p.claimsOpen}|${p.closedText}|${!!st}`;
  if (key !== state.tagKey) {
    const wasCount = (state.tagKey.match(/:/g) ?? []).length / 2;
    state.tagKey = key;
    q("[data-ptags]").innerHTML = p.tags
      .map((t, i) => {
        const lines = [
          `Owed ${t.owed} ${t.asset} + ${t.premium} ${t.asset} premium`,
          p.claimsOpen ? (st ? `Settling at the oracle price` : `Locked on position ${log.positionId} until buy-back`) : `Claim ${p.closedText}`,
          t.buyback ? (t.paid ? `Paid exactly ${t.paid}` : `Buy-back committed: ${t.buyback} owed`) : "",
          ...t.settledLines,
        ].filter(Boolean);
        const drop = wasCount === 0 && p.tags.length > 0 ? ` style="animation-delay:${i * 200}ms"` : "";
        return `<div class="st-tag st-cut st-cut--l st-pool-tag${p.claimsOpen ? "" : " is-closed"}${wasCount === 0 ? "" : " no-drop"}"${drop}>
          <div class="st-tag-top">${tile(t.holder, 22)}<span class="st-tag-title">CLAIM · ${Math.round(t.share)}%</span></div>
          <div class="st-tag-lines">${lines.map(esc).join("<br>")}</div>
          <div class="st-tag-id">${esc(t.claim)} · ${t.holder}</div>
        </div>`;
      })
      .join("");
  }
}

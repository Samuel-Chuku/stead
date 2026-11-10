// The rescue page: one recorded rescue, everything on it read from its event log (the chains) and,
// for the cost chart, the same position run along a real price path (labelled as such).
import type { CostPath } from "../../../stewards/src/costpath";
import type { Evidence, RescueEvent, RescueLog, StewardId } from "../../../stewards/src/rescuelog";
import { CODE, fmtAmt } from "../board/model";
import { icon } from "../icons";
import { crown } from "../crown";

type Ev<K extends RescueEvent["kind"]> = Extract<RescueEvent, { kind: K }>;
export type ProofKind = "readings" | "auction" | "topup" | "claim" | "payouts";
export type ProofRow = { t: number; step: string; kind: ProofKind; ev: Evidence };
/** Every step of a recorded rescue that carries a record on a chain, newest first. */
export function proofRows(log: RescueLog): ProofRow[] {
  const KIND: Partial<Record<RescueEvent["kind"], ProofKind>> = {
    TRIGGER: "readings", READING: "readings", BID: "auction", AUCTION_CLOSE: "auction", TOPUP_SENT: "topup", TOPUP_CONFIRMED: "topup",
    CLAIM_MINTED: "claim", PAYMENT_IN: "claim", ESCROW_PROVEN: "claim", BUYBACK: "claim", BOUGHT_BACK: "claim", PAYOUT: "payouts",
  };
  const trigger = all(log, "TRIGGER")[0];
  const win = all(log, "AUCTION_CLOSE")[0]?.winners[0];
  const pay = all(log, "PAYMENT_IN")[0];
  const rows: ProofRow[] = [];
  for (const e of log.events) {
    if (!("evidence" in e)) continue;
    const ev = (e as any).evidence as Evidence;
    const label: Record<string, string> = {
      TRIGGER: `Health ${trigger.hf.toFixed(3)}, below ${log.params.triggerHf.toFixed(2)}: auction opens`,
      AUCTION_CLOSE: `Auction closed${win ? `: ${win.steward} wins at ${win.bps} bps` : ""}`,
      TOPUP_CONFIRMED: "Top-up proven in the position",
      CLAIM_MINTED: e.kind === "CLAIM_MINTED" ? `Claim ${e.claim} minted to ${e.holder}` : "",
      PAYMENT_IN: `Borrower pays ${pay?.amount ?? ""} ${pay?.asset ?? ""} into the position`,
      ESCROW_PROVEN: "Payment proven in the position",
      BUYBACK: e.kind === "BUYBACK" ? `Buy-back committed: ${e.amount} ${e.asset}` : "",
      BOUGHT_BACK: "Claim closed, withdrawals unlocked",
    };
    let step = label[e.kind];
    if (e.kind === "BID") step = `${e.steward} bids ${e.bps} bps`;
    if (e.kind === "TOPUP_SENT") step = `${e.steward} supplies ${e.amount} ${e.asset}`;
    if (e.kind === "READING") step = `Health ${e.hf.toFixed(3)}`;
    if (e.kind === "PAYOUT") step = e.purpose === "buyback" ? `${e.amount} ${e.asset} paid to the claim owner` : `${e.amount} ${e.asset} refunded to the borrower`;
    const kind = KIND[e.kind];
    if (!step || !kind) continue;
    if (rows.some((r) => r.ev.tx === ev.tx && r.step === step)) continue;
    rows.push({ t: e.t, step, kind, ev });
    const transfer = (e as any).transfer as Evidence | undefined;
    if (transfer) rows.push({ t: e.t, step: `${step}: the transfer`, kind, ev: transfer });
  }
  rows.sort((a, b) => b.t - a.t); // newest first
  return rows;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const usd = (n: number, d = 2) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const clock = (log: RescueLog, t: number) => new Date(log.openedAtMs + t * 1000).toISOString().slice(11, 19);
const shortId = (s: string) => (s.length > 14 ? `${s.slice(0, s.startsWith("0x") ? 6 : 4)}…${s.slice(-4)}` : s);
const tile = (s: StewardId, size: number) => `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s]}</span>`;
/** A number in Big Shoulders with its unit in Chakra Petch (no word is ever set in Big Shoulders). */
const num = (n: string, unit = "") => `<span class="st-num">${n}</span>${unit ? `<span class="st-unit">${unit}</span>` : ""}`;

export async function mountRescue(root: HTMLElement, replayUrl: string) {
  root.innerHTML = `<section class="st-panel st-page"><div class="st-label">RESCUES</div><p class="st-empty">Loading the recorded rescue…</p></section>`;
  let log: RescueLog;
  let path: CostPath | null = null;
  try {
    const r = await fetch(replayUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    log = await r.json();
    // the cost chart's price path exists only for some recordings: without one, the page has no chart
    const p = await fetch(replayUrl.replace(/\.json$/, "-path.json"));
    if (p.ok && (p.headers.get("content-type") ?? "").includes("json")) path = await p.json().catch(() => null);
  } catch (e) {
    root.innerHTML = `<section class="st-error" role="alert"><h2>Rescue not loaded</h2><p>The recorded rescue could not be read (${esc(String((e as Error).message))}). Reload the page to try again.</p></section>`;
    return () => {};
  }
  root.innerHTML = render(log, path);
  if (path) wireChart(root, path);
  wireProofs(root);
  return () => {};
}

function all<K extends RescueEvent["kind"]>(log: RescueLog, k: K) {
  return log.events.filter((e) => e.kind === k) as Ev<K>[];
}

export function render(log: RescueLog, path: CostPath | null): string {
  const m = log.market;
  const open = all(log, "AUCTION_OPEN")[0];
  const trigger = all(log, "TRIGGER")[0];
  const close = all(log, "AUCTION_CLOSE")[0];
  const sent = all(log, "TOPUP_SENT")[0];
  const proven = all(log, "TOPUP_CONFIRMED")[0];
  const claim = all(log, "CLAIM_MINTED")[0];
  const pay = all(log, "PAYMENT_IN")[0];
  const buyback = all(log, "BUYBACK")[0];
  const bought = all(log, "BOUGHT_BACK")[0];
  const payouts = all(log, "PAYOUT");
  const toOwner = payouts.find((p) => p.purpose === "buyback");
  const refund = payouts.find((p) => p.purpose === "refund");
  const after = log.events.find((e) => e.kind === "READING" && e.hf >= log.params.triggerHf) as Ev<"READING"> | undefined;
  const win = close?.winners[0];
  // a pooled rescue: several stewards share the top-up, each with its own claim and payout
  const winners = close?.winners ?? [];
  const pooled = winners.length > 1;
  const claims = all(log, "CLAIM_MINTED");
  const toOwners = payouts.filter((p) => p.purpose === "buyback");
  const sum = (xs: { amount: string }[]) => xs.reduce((a, x) => a + Number(x.amount), 0);
  const bpsLo = Math.min(...winners.map((w) => w.bps)), bpsHi = Math.max(...winners.map((w) => w.bps));
  const bpsRange = bpsLo === bpsHi ? `${bpsLo}` : `${bpsLo}–${bpsHi}`;
  const price = log.atOpen?.priceUsd ?? 0;
  const premiumUsd = claims.reduce((a, c) => a + Number(c.premium) * price, 0);
  const bids = all(log, "BID");
  const outcome = log.outcome === "bought back" ? "BOUGHT BACK" : log.outcome === "settled" ? "SETTLED" : log.outcome === "liquidated" ? "LIQUIDATED" : "OPEN";

  // ---------- header + KPIs ----------
  const kpis = `
    <dl class="st-kpis">
      <div><dt>TOP-UP</dt><dd>${num(fmtAmt(open.topUp.amount), m.collateral)}</dd><dd class="st-kpi-sub">${usd(open.topUp.usd)} at the trigger</dd></div>
      <div><dt>${pooled ? "WINNING PREMIUMS" : "WINNING PREMIUM"}</dt><dd>${num(win ? bpsRange : "—", "bps")}</dd><dd class="st-kpi-sub">${pooled ? `${winners.length} stewards, ${usd(premiumUsd)} in all` : win ? `${win.steward}, ${usd(premiumUsd)}` : ""}</dd></div>
      <div><dt>PREMIUM CAP</dt><dd>${num(open.capBps.toLocaleString("en-US"), "bps")}</dd><dd class="st-kpi-sub">below Aave's liquidation penalty</dd></div>
      <div><dt>BACK ABOVE TRIGGER</dt><dd>${num(after ? fmtDur(after.t) : "—")}</dd><dd class="st-kpi-sub">trigger to proven top-up</dd></div>
      <div><dt>HEALTH FACTOR</dt><dd>${num(trigger.hf.toFixed(2))}<span class="st-unit st-unit--mid">to</span>${num(after ? after.hf.toFixed(2) : "—")}</dd><dd class="st-kpi-sub">proven readings</dd></div>
    </dl>`;

  // ---------- timeline ----------
  const steps: { title: string; t?: number; body: string; state: "done" | "pending" }[] = [
    { title: "Trigger", t: trigger.t, body: `HF ${trigger.hf.toFixed(3)}, ${trigger.evidence.rpcs} RPCs agree`, state: "done" },
    { title: "Auction", t: open.t, body: `${bids.length} bids in ${open.durationS} s`, state: "done" },
    { title: "Won", t: close?.t, body: pooled ? `${winners.length} stewards, ${bpsRange} bps` : win ? `${win.steward} at ${win.bps} bps` : "no cover", state: close ? "done" : "pending" },
    { title: "Top-up", t: proven?.t ?? sent?.t, body: proven ? `${fmtAmt(open.topUp.amount)} ${m.collateral}, proven` : sent ? `${sent.amount} ${sent.asset} sent` : "waiting", state: proven ? "done" : "pending" },
    { title: pooled ? "Claims" : "Claim", t: claim?.t, body: pooled ? `${claims.length} claims, one per steward` : claim ? `${claim.claim} to ${claim.holder}` : "", state: claim ? "done" : "pending" },
    { title: "Buy-back", t: bought?.t, body: pooled && toOwners.length ? `${fmtAmt(sum(toOwners))} ${toOwners[0].asset} to ${toOwners.length} owners` : toOwner ? `${toOwner.amount} ${toOwner.asset} to the owner` : buyback ? "committed" : "window open", state: bought ? "done" : "pending" },
    { title: "Settle", body: bought ? "Not needed: bought back" : "If the window ends", state: "pending" },
  ];
  const timeline = `
    <ol class="st-timeline" aria-label="Rescue timeline">
      ${steps.map((s) => `<li class="st-step st-step--${s.state}"><span class="st-step-dot" aria-hidden="true"></span><span class="st-step-title">${s.title}</span><span class="st-step-time">${s.t !== undefined ? clock(log, s.t) + " UTC" : "—"}</span><span class="st-step-body">${esc(s.body)}</span></li>`).join("")}
    </ol>`;

  // ---------- auction results ----------
  const ranked = [...bids].sort((a, b) => a.bps - b.bps || a.t - b.t);
  const results = `
    <section class="st-panel st-sect" aria-labelledby="res-h">
      <div class="st-sect-head"><div><div class="st-label">AUCTION RESULTS</div><h2 class="st-panel-title" id="res-h">${bids.length} stewards bid · lowest premium won</h2></div><a class="st-textlink" href="#/live">Watch the replay</a></div>
      <div class="st-results">
        ${ranked
          .map((b, i) => {
            const history = bids.filter((x) => x.steward === b.steward).map((x) => x.bps).join(", ");
            const won = close?.winners.find((w) => w.steward === b.steward);
            const claimOf = claims.find((c) => c.holder === b.steward);
            return `<div class="st-result${won ? " is-won" : ""}"><span class="st-result-rank">${i + 1}</span>${tile(b.steward, 28)}<span class="st-result-name">${b.steward}${won ? crown(b.steward, [["Premium", `${b.bps} bps`], ["Share", `${fmtAmt(won.amount)} ${m.collateral}`], ...(claimOf ? ([["Claim", esc(claimOf.claim)]] as [string, string][]) : [])]) : ""}</span><span class="st-result-hist">${history} bps</span><span class="st-result-final">${num(String(b.bps), "bps")}</span></div>`;
          })
          .join("")}
      </div>
      <p class="st-note">Pool did not bid: it joins coalitions when a single steward can't cover the top-up. Each bid is the steward's own signed NEAR transaction (see Proofs).</p>
    </section>`;

  // ---------- claim + buy-back ----------
  // pooled: one small lockout tag per claim, each paid exactly what it was owed
  const ownerPaid = (c: Ev<"CLAIM_MINTED">) => toOwners.find((p) => p.claim === c.claim) ?? null;
  const pooledTags = `<div class="st-claim-grid">${claims
    .map((c) => {
      const paid = ownerPaid(c);
      const share = winners.find((w) => w.steward === c.holder);
      const pct = share ? Math.round((Number(share.amount) / Number(open.topUp.amount)) * 100) : null;
      return `<div class="st-tag st-cut st-cut--l${bought ? " is-closed" : ""}">
        <div class="st-tag-top">${tile(c.holder, 22)}<span class="st-tag-title">CLAIM${pct !== null ? ` · ${pct}%` : ""}</span></div>
        <div class="st-tag-lines">Owed ${fmtAmt(c.owed)} + ${fmtAmt(c.premium)} ${c.asset} premium<br>${c.holder}.steadfi.testnet · token ${esc(c.claim)}${paid ? `<br>Paid ${fmtAmt(paid.amount)} ${paid.asset}` : ""}</div>
      </div>`;
    })
    .join("")}</div>`;
  const buybacks = all(log, "BUYBACK");
  const buyTotal = buybacks.length ? `${fmtAmt(sum(buybacks))} ${buybacks[0].asset}` : "";
  const claimBlock = claim && pooled
    ? `
    <section class="st-panel st-sect st-claim-sect" aria-labelledby="claim-h">
      <div class="st-label">CLAIMS · ${claims.length} STEWARDS</div>
      <h2 class="st-panel-title" id="claim-h">One claim per steward, filled from the lowest premium up</h2>
      ${pooledTags}
      <div class="st-buyback">
        <span class="st-chip st-chip--${bought ? "rescued" : "open"}">${outcome}</span>
        <p class="st-buyback-text">${
          bought && toOwners.length
            ? `The borrower paid ${pay ? fmtAmt(pay.amount) + " " + pay.asset : "the buy-back"} into the position. Once the payment was proven, the contract paid each of the ${toOwners.length} claim owners exactly what its claim was owed, ${fmtAmt(sum(toOwners))} ${toOwners[0].asset} in all${refund ? `, and refunded ${fmtAmt(refund.amount)} ${refund.asset} to the borrower` : ""}. The claims are burned and withdrawals are unlocked.`
            : "The borrower can buy the claims back until the window ends; after that they settle."
        }</p>
        <button type="button" class="st-push st-cut" aria-disabled="true" disabled><span class="st-lamp" aria-hidden="true"></span>BUY BACK FOR ${esc(buyTotal)}</button>
        <span class="st-disabled-reason">${bought ? `Bought back at ${clock(log, bought.t)} UTC · claims closed` : "Replay: buy-back opens from a borrower's own position"}</span>
      </div>
    </section>`
    : claim
    ? `
    <section class="st-panel st-sect st-claim-sect" aria-labelledby="claim-h">
      <div class="st-label">CLAIM</div>
      <div class="st-claim-row">
        <div class="st-tag st-tag--xl st-cut st-cut--xl${bought ? " is-closed" : ""}">
          <div class="st-tag-kicker">LOCKOUT TAG · NFT</div>
          <h2 class="st-tag-big" id="claim-h">Claim <span class="st-mono-big">${esc(claim.claim)}</span></h2>
          <dl class="st-tag-rows">
            <div><dt>HOLDER</dt><dd>${tile(claim.holder, 22)} ${claim.holder}.steadfi.testnet</dd></div>
            <div><dt>OWED</dt><dd>${claim.owed} + ${claim.premium} ${claim.asset}</dd></div>
            <div><dt>LOCKED</dt><dd>Withdrawals on position ${log.positionId}${bought ? " (released)" : ""}</dd></div>
            <div><dt>WINDOW</dt><dd>${fmtDur(claim.windowEndsT - claim.t)} from ${clock(log, claim.t)} UTC${bought ? ` · closed ${clock(log, bought.t)}` : ""}</dd></div>
          </dl>
          <div class="st-tag-id">STEAD-${log.rescueId}-P${log.positionId} · token ${esc(claim.claim)}</div>
        </div>
        <div class="st-buyback">
          <span class="st-chip st-chip--${bought ? "rescued" : "open"}">${outcome}</span>
          <p class="st-buyback-text">${
            bought && toOwner
              ? `The borrower paid ${pay ? pay.amount + " " + pay.asset : "the buy-back"} into the position. Once the payment was proven, the contract paid the claim owner exactly ${toOwner.amount} ${toOwner.asset}${refund ? ` and refunded ${refund.amount} ${refund.asset} to the borrower` : ""}. The claim is burned and withdrawals are unlocked.`
              : "The borrower can buy the claim back until the window ends; after that it settles."
          }</p>
          <button type="button" class="st-push st-cut" aria-disabled="true" disabled><span class="st-lamp" aria-hidden="true"></span>BUY BACK FOR ${esc(buyback?.amount ?? toOwner?.amount ?? "")} ${esc(m.debt)}</button>
          <span class="st-disabled-reason">${bought ? `Bought back at ${clock(log, bought.t)} UTC · claim closed` : "Replay: buy-back opens from a borrower's own position"}</span>
        </div>
      </div>
    </section>`
    : "";

  // ---------- proofs ----------
  // Newest first, 7 per page; filterable by kind and by chain (wired in wireProofs).
  const rows = proofRows(log);
  const kinds: { id: "all" | ProofKind; label: string }[] = [
    { id: "all", label: "ALL" }, { id: "readings", label: "READINGS" }, { id: "auction", label: "AUCTION" },
    { id: "topup", label: "TOP-UP" }, { id: "claim", label: "CLAIM & BUY-BACK" }, { id: "payouts", label: "PAYOUTS" },
  ];
  const chainOf = (ev: Evidence) => (ev.chain === "sepolia" || ev.chain === "ethereum" ? "evm" : "near");
  const count = (k: string) => (k === "all" ? rows.length : rows.filter((r) => r.kind === k).length);
  const proofs = `
    <section class="st-panel st-sect" aria-labelledby="proofs-h" data-proofs>
      <div class="st-sect-head">
        <div><div class="st-label">PROOFS</div><h2 class="st-panel-title" id="proofs-h">Every step, linked to its record</h2></div>
        <p class="st-proof-count" data-proof-count aria-live="polite"></p>
      </div>
      <div class="st-list-tools st-proof-tools">
        <label class="st-select"><span class="st-select-label">Show</span><select data-kind-select>
          ${kinds.filter((k) => count(k.id) > 0).map((k) => `<option value="${k.id}">${k.id === "all" ? "Every record" : k.label.charAt(0) + k.label.slice(1).toLowerCase()} (${count(k.id)})</option>`).join("")}
        </select></label>
        <label class="st-select"><span class="st-select-label">Chain</span><select data-chain-select>
          <option value="all">Both chains</option><option value="near">NEAR</option><option value="evm">${log.evmChain === "sepolia" ? "Sepolia" : "Ethereum"}</option>
        </select></label>
      </div>
      <div class="st-table-wrap">
        <table class="st-proofs">
          <thead><tr><th>TIME (UTC)</th><th>STEP</th><th>EVIDENCE</th><th>WHERE</th><th>TRUST</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr data-kind="${r.kind}" data-chain="${chainOf(r.ev)}"><td class="st-mono">${clock(log, r.t)}</td><td class="st-proof-step">${esc(r.step)}</td><td class="st-mono">${esc(shortId(r.ev.tx))}${r.ev.block ? ` · block ${r.ev.block.toLocaleString("en-US")}` : ""}</td><td><a class="st-textlink st-extlink" href="${r.ev.url}" target="_blank" rel="noopener" aria-label="${r.ev.chain === "sepolia" ? "Etherscan" : "NearBlocks"}: ${esc(r.step)} (opens in a new tab)">${r.ev.chain === "sepolia" ? "Etherscan" : "NearBlocks"}${icon("external", 14)}</a></td><td>${chip(r.ev)}</td></tr>`,
              )
              .join("")}
            <tr class="st-proof-empty" data-proof-empty hidden><td colspan="5">No record of this kind on this chain for this rescue.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="st-pager">
        <button type="button" class="st-secondary st-cut" data-page="prev">Previous</button>
        <span class="st-pager-pos" data-page-pos></span>
        <button type="button" class="st-secondary st-cut" data-page="next">Next</button>
      </div>
    </section>`;

  return `
  <div class="st-rescue">
    <section class="st-panel st-sect st-rescue-head" aria-labelledby="rescue-title">
      <div class="st-sect-head">
        <div>
          <div class="st-label">RESCUE · POSITION ${log.positionId} · SEPOLIA MARKET ${m.id} · ${m.collateral}/${m.debt}</div>
          <h1 class="st-rescue-title" id="rescue-title">Rescue ${num(`#${log.rescueId}`)}</h1>
          <p class="st-rescue-sub">${esc(log.borrower)} · ${esc(log.label)} · contract <span class="st-mono">${esc(log.contract)}</span></p>
        </div>
        <span class="st-chip st-chip--rescued">${outcome}</span>
      </div>
      ${kpis}
      ${timeline}
    </section>
    ${path ? chart(log, path, premiumUsd, claim, open.capBps) : ""}
    ${results}
    ${claimBlock}
    ${proofs}
  </div>`;
}

function chip(ev: Evidence): string {
  if (ev.mark === "proven") return `<span class="st-evidence st-evidence--proven"><span class="st-evidence-mark" aria-hidden="true"></span>${ev.rpcs ? `PROVEN · ${ev.rpcs} RPC` : "ON CHAIN"}</span>`;
  if (ev.mark === "reported") return `<span class="st-evidence st-evidence--reported"><span class="st-evidence-mark" aria-hidden="true"></span>REPORTED</span>`;
  return `<span class="st-evidence st-evidence--unverified">FORK · UNVERIFIED</span>`;
}

function fmtDur(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m}:${String(r).padStart(2, "0")}` : `${r} s`;
}

// ───────────────────────────── cost chart (§24) ─────────────────────────────

const X0 = 48, X1 = 752, Y0 = 12, Y1 = 266;

function chart(log: RescueLog, p: CostPath, premiumUsd: number, claim: Ev<"CLAIM_MINTED"> | undefined, capBps: number): string {
  const hMin = p.hours[0], hMax = p.hours[p.hours.length - 1];
  const yMax = Math.max(1.6, Math.ceil(Math.max(...p.with) * 10) / 10);
  const yMin = 0.9;
  const x = (h: number) => X0 + ((h - hMin) / (hMax - hMin)) * (X1 - X0);
  const y = (v: number) => Y1 - ((v - yMin) / (yMax - yMin)) * (Y1 - Y0);
  const f = (n: number) => n.toFixed(1);

  const withPts: string[] = [];
  p.hours.forEach((h, j) => {
    if (h === 0) withPts.push(`${f(x(0))},${f(y(p.without[j]!))}`); // the step up at the rescue
    withPts.push(`${f(x(h))},${f(y(p.with[j]))}`);
  });
  const withoutPts = p.hours.map((h, j) => (p.without[j] === null ? null : `${f(x(h))},${f(y(p.without[j]!))}`)).filter(Boolean);
  const liqX = x(p.liqHour), liqY = y(p.hfAtLiq);
  const resX = x(0), resY = y(p.with[p.hours.indexOf(0)]);
  const ticks = p.hours.filter((h) => h % 6 === 0);
  const grid = [
    { v: 1.6, cls: "st-grid", label: "1.60" },
    { v: 1.5, cls: "st-grid", label: "1.50" },
    { v: log.params.triggerHf, cls: "st-grid st-grid--dash", label: "trig" },
    { v: 1.0, cls: "st-grid st-grid--dash st-grid--trip", label: "trip" },
  ].filter((g) => g.v <= yMax);
  const date = new Date(p.startMs);
  const when = `${date.getUTCDate()} ${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${date.getUTCFullYear()}, ${String(date.getUTCHours()).padStart(2, "0")}:00 UTC`;
  const asset = log.market.collateral.replace(/^W/, "");
  const lo = Math.round(p.savedUsd.low), hi = Math.round(p.savedUsd.high);
  const aria = `Health factor of position ${log.positionId} along ${asset}'s real hourly prices from ${when}. Without Stead it falls below 1.00 at ${p.liqHour} hours and is liquidated, costing ${usd(p.penaltyUsd.low, 0)} to ${usd(p.penaltyUsd.high, 0)}. With the rescue it steps to ${p.with[p.hours.indexOf(0)].toFixed(2)} and its lowest point is ${p.lowestWith.toFixed(2)}; the premium was ${usd(premiumUsd)}.`;
  const max = p.penaltyUsd.high;
  const rescuedLabel = claim ? `RESCUED · ${claim.premium} ${claim.asset}` : "RESCUED";
  const liqLabel = `LIQUIDATED · −${usd(p.penaltyUsd.low, 0)} TO −${usd(p.penaltyUsd.high, 0)}`;

  return `
  <section class="st-panel st-chart-panel" aria-labelledby="chart-h">
    <div class="st-chart-main">
      <div class="st-chart-head">
        <div>
          <div class="st-label">HEALTH FACTOR, WITH AND WITHOUT STEAD</div>
          <h2 class="st-chart-title" id="chart-h">On ${asset}'s real fall of ${esc(when.split(",")[0])}, rescue ${log.rescueId} would have kept position ${log.positionId} out of liquidation</h2>
        </div>
        <div class="st-legend" aria-hidden="true"><span><i class="st-leg-with"></i>With Stead</span><span><i class="st-leg-without"></i>Without</span></div>
      </div>
      <div class="st-chart-box">
        <svg class="st-chart" viewBox="0 0 760 300" role="img" aria-label="${esc(aria)}">
          ${grid.map((g) => `<line class="${g.cls}" x1="${X0}" x2="${X1}" y1="${f(y(g.v))}" y2="${f(y(g.v))}"/><text class="st-axis-t${g.label === "trip" ? " st-axis-trip" : ""}" x="${X0 - 6}" y="${f(y(g.v) + 4)}" text-anchor="end">${g.label}</text>`).join("")}
          ${ticks.map((h) => `<text class="st-axis-t" x="${f(x(h))}" y="290" text-anchor="middle">${h === 0 ? "0" : (h > 0 ? "+" : "−") + Math.abs(h) + "h"}</text>`).join("")}
          <rect class="st-band" x="${f(resX - 13)}" y="${Y0}" width="26" height="${Y1 - Y0}"/>
          <line class="st-band-line" x1="${f(resX)}" x2="${f(resX)}" y1="${Y0}" y2="${Y1}"/>
          <rect class="st-band st-band--trip" x="${f(liqX - 13)}" y="${Y0}" width="26" height="${Y1 - Y0}"/>
          <line class="st-band-line st-band-line--trip" x1="${f(liqX)}" x2="${f(liqX)}" y1="${Y0}" y2="${Y1}"/>
          <polyline class="st-line-without" points="${withoutPts.join(" ")}"/>
          <polyline class="st-line-with" points="${withPts.join(" ")}"/>
          <g class="st-callout st-callout--with">
            <rect x="${f(Math.max(X0, resX - 200))}" y="${f(resY - 44)}" width="194" height="30" rx="0"/>
            <text x="${f(Math.max(X0, resX - 200) + 10)}" y="${f(resY - 24)}">${esc(rescuedLabel)}</text>
          </g>
          <g class="st-callout st-callout--trip">
            <rect x="${f(Math.min(X1 - 236, liqX + 10))}" y="${f(Math.min(Y1 - 34, liqY + 12))}" width="236" height="30" rx="0"/>
            <text x="${f(Math.min(X1 - 236, liqX + 10) + 10)}" y="${f(Math.min(Y1 - 34, liqY + 12) + 20)}">${esc(liqLabel)}</text>
          </g>
          <circle class="st-marker" cx="${f(resX)}" cy="${f(resY)}" r="4"/>
          <circle class="st-marker st-marker--trip" cx="${f(liqX)}" cy="${f(liqY)}" r="4"/>
          <line class="st-cross" x1="0" x2="0" y1="${Y0}" y2="${Y1}" visibility="hidden"/>
          <rect class="st-hit" x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}"/>
        </svg>
        <div class="st-tip" role="status" hidden></div>
      </div>
      <p class="st-chart-note">Sepolia's test price for ${esc(log.market.collateral)} is fixed at ${usd(log.atOpen?.priceUsd ?? 0, 0)}, so the real rescue never faced a falling market. This chart runs position ${log.positionId}, exactly as it stood at the trigger (HF ${(p.without[p.hours.indexOf(0)] ?? 0).toFixed(2)}, ${usd(log.atOpen?.debtUsd ?? 0)} of debt) and after the proven top-up, along ${esc(p.source)}, starting ${esc(when)}: the fastest 2026 fall that would have liquidated it within 24 hours.</p>
      <details class="st-values">
        <summary>Show the hourly values</summary>
        <div class="st-table-wrap"><table class="st-proofs st-values-table"><thead><tr><th>HOUR</th><th>PRICE / START</th><th>WITH STEAD</th><th>WITHOUT</th></tr></thead><tbody>
          ${p.hours.map((h, j) => `<tr><td>${h > 0 ? "+" : ""}${h}h</td><td>${p.ratio[j].toFixed(4)}</td><td>${p.with[j].toFixed(3)}</td><td>${p.without[j] === null ? "liquidated" : p.without[j]!.toFixed(3)}</td></tr>`).join("")}
        </tbody></table></div>
      </details>
    </div>
    <div class="st-chart-summary">
      <div class="st-label">BORROWER SAVED</div>
      <div class="st-saved">${num(`$${lo}–${hi}`)}</div>
      <p class="st-saved-line">Aave's liquidation bonus on this debt is ${usd(p.penaltyUsd.low, 0)}–${usd(p.penaltyUsd.high, 0)}. The winning premium was ${usd(premiumUsd)}.</p>
      <div class="st-bars">
        <div class="st-bar-label">Liquidation penalty</div>
        <div class="st-cbar"><span class="st-cbar-low" style="width:${f((p.penaltyUsd.low / max) * 100)}%"></span><span class="st-cbar-range" style="left:${f((p.penaltyUsd.low / max) * 100)}%; width:${f(((p.penaltyUsd.high - p.penaltyUsd.low) / max) * 100)}%"></span></div>
        <div class="st-bar-label">Rescue premium</div>
        <div class="st-cbar"><span class="st-cbar-premium" style="width:${f(Math.max(0.6, (premiumUsd / max) * 100))}%"></span></div>
      </div>
      <dl class="st-sum-rows">
        <div><dt>PREMIUM CAP</dt><dd>${capBps.toLocaleString("en-US")} bps</dd></div>
        <div><dt>LOWEST HF AFTER RESCUE</dt><dd>${p.lowestWith.toFixed(2)}</dd></div>
        <div><dt>GUARANTEE</dt><dd>never worse than liquidation</dd></div>
      </dl>
    </div>
  </section>`;
}

export function wireChart(root: HTMLElement, p: CostPath) {
  const svg = root.querySelector<SVGSVGElement>(".st-chart");
  const tip = root.querySelector<HTMLElement>(".st-tip");
  const cross = root.querySelector<SVGLineElement>(".st-cross");
  const hit = root.querySelector<SVGRectElement>(".st-hit");
  if (!svg || !tip || !cross || !hit) return;
  const hMin = p.hours[0], hMax = p.hours[p.hours.length - 1];
  const show = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const vx = ((clientX - box.left) / box.width) * 760;
    const h = Math.round(hMin + ((vx - X0) / (X1 - X0)) * (hMax - hMin));
    const j = p.hours.indexOf(Math.max(hMin, Math.min(hMax, h)));
    const hx = X0 + ((p.hours[j] - hMin) / (hMax - hMin)) * (X1 - X0);
    cross.setAttribute("x1", String(hx));
    cross.setAttribute("x2", String(hx));
    cross.setAttribute("visibility", "visible");
    const wo = p.without[j];
    tip.hidden = false;
    tip.innerHTML = `<b>${p.hours[j] > 0 ? "+" : ""}${p.hours[j]}h</b> · with Stead ${p.with[j].toFixed(2)} · without ${wo === null ? "liquidated" : wo.toFixed(2)}`;
    const left = (hx / 760) * box.width;
    tip.style.left = `${Math.min(box.width - tip.offsetWidth, Math.max(0, left - tip.offsetWidth / 2))}px`;
  };
  hit.addEventListener("pointermove", (e) => show(e.clientX));
  hit.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
  });
}

/** Proofs a page: ten on a desktop, six on a phone. */
const pageSize = () => (matchMedia("(max-width: 620px)").matches ? 6 : 10);
function wireProofs(root: HTMLElement) {
  const sect = root.querySelector<HTMLElement>("[data-proofs]");
  if (!sect) return;
  const rows = [...sect.querySelectorAll<HTMLTableRowElement>("tbody tr[data-kind]")];
  let kind = "all";
  let chain = "all";
  let page = 0;
  const draw = () => {
    const match = rows.filter((r) => (kind === "all" || r.dataset.kind === kind) && (chain === "all" || r.dataset.chain === chain));
    const PAGE = pageSize();
    const pages = Math.max(1, Math.ceil(match.length / PAGE));
    page = Math.min(page, pages - 1);
    const shown = new Set(match.slice(page * PAGE, page * PAGE + PAGE));
    for (const r of rows) r.hidden = !shown.has(r);
    sect.querySelector<HTMLElement>("[data-proof-empty]")!.hidden = match.length > 0;
    const from = match.length ? page * PAGE + 1 : 0;
    const to = Math.min(match.length, page * PAGE + PAGE);
    sect.querySelector("[data-proof-count]")!.textContent = `${match.length} record${match.length === 1 ? "" : "s"} · newest first`;
    sect.querySelector("[data-page-pos]")!.textContent = match.length ? `${from}–${to} of ${match.length}` : "0 of 0";
    const prev = sect.querySelector<HTMLButtonElement>('[data-page="prev"]')!;
    const next = sect.querySelector<HTMLButtonElement>('[data-page="next"]')!;
    prev.disabled = page === 0;
    next.disabled = page >= pages - 1;
    sect.querySelector<HTMLElement>(".st-pager")!.hidden = pages <= 1;
  };
  sect.querySelector<HTMLSelectElement>("[data-kind-select]")?.addEventListener("change", (e) => {
    kind = (e.target as HTMLSelectElement).value;
    page = 0;
    draw();
  });
  sect.querySelector<HTMLSelectElement>("[data-chain-select]")?.addEventListener("change", (e) => {
    chain = (e.target as HTMLSelectElement).value;
    page = 0;
    draw();
  });
  sect.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-page]");
    if (!b) return;
    page += b.dataset.page === "next" ? 1 : -1;
    draw();
  });
  draw();
}

/** The cost chart section for a rescue (the homepage shows the latest real one). */
export function costChartSection(log: RescueLog, p: CostPath): string {
  const claim = all(log, "CLAIM_MINTED")[0];
  const open = all(log, "AUCTION_OPEN")[0];
  const premiumUsd = claim ? Number(claim.premium) * (log.atOpen?.priceUsd ?? 0) : 0;
  return chart(log, p, premiumUsd, claim, open.capBps);
}

/** The Proofs page: every record behind every published recording, newest first, one table with
 *  the same filters and paging as a rescue page, plus the rescue each record belongs to. */
export async function mountProofs(root: HTMLElement, replays: { id: string; url: string }[]) {
  root.innerHTML = `<section class="st-panel st-page"><div class="st-label">PROOFS</div><p class="st-empty">Loading the recorded rescues…</p></section>`;
  let logs: RescueLog[];
  try {
    logs = await Promise.all(replays.map(async (r) => {
      const x = await fetch(r.url);
      if (!x.ok) throw new Error(`HTTP ${x.status}`);
      return x.json();
    }));
  } catch (e) {
    root.innerHTML = `<section class="st-error" role="alert"><h2>Proofs not loaded</h2><p>The recorded rescues could not be read (${esc(String((e as Error).message))}). Reload the page to try again.</p></section>`;
    return () => {};
  }
  const rows = logs
    .flatMap((log, i) => proofRows(log).map((r) => ({ ...r, log, page: replays[i].id, at: log.openedAtMs + r.t * 1000 })))
    .sort((a, b) => b.at - a.at);
  const kinds: { id: "all" | ProofKind; label: string }[] = [
    { id: "all", label: "ALL" }, { id: "readings", label: "READINGS" }, { id: "auction", label: "AUCTION" },
    { id: "topup", label: "TOP-UP" }, { id: "claim", label: "CLAIM & BUY-BACK" }, { id: "payouts", label: "PAYOUTS" },
  ];
  const count = (k: string) => (k === "all" ? rows.length : rows.filter((r) => r.kind === k).length);
  const chainOf = (ev: Evidence) => (ev.chain === "sepolia" || ev.chain === "ethereum" ? "evm" : "near");
  root.innerHTML = `
    <section class="st-panel st-sect" aria-labelledby="proofs-h" data-proofs>
      <div class="st-sect-head">
        <div><div class="st-label">PROOFS</div><h1 class="st-page-title" id="proofs-h">Every step, linked to its record</h1>
        <p class="st-list-sub">Each verified reading, bid, top-up, claim and payment behind the ${logs.length} recorded rescues, newest first. A PROVEN reading is an OutLayer proof that several Sepolia RPCs agreed on the block.</p></div>
        <p class="st-proof-count" data-proof-count aria-live="polite"></p>
      </div>
      <div class="st-list-tools st-proof-tools">
        <label class="st-select"><span class="st-select-label">Show</span><select data-kind-select>
          ${kinds.filter((k) => count(k.id) > 0).map((k) => `<option value="${k.id}">${k.id === "all" ? "Every record" : k.label.charAt(0) + k.label.slice(1).toLowerCase()} (${count(k.id)})</option>`).join("")}
        </select></label>
        <label class="st-select"><span class="st-select-label">Chain</span><select data-chain-select>
          <option value="all">Both chains</option><option value="near">NEAR</option><option value="evm">Sepolia</option>
        </select></label>
      </div>
      <div class="st-table-wrap">
        <table class="st-proofs st-proofs--multi">
          <thead><tr><th>TIME (UTC)</th><th>RESCUE</th><th>STEP</th><th>EVIDENCE</th><th>WHERE</th><th>TRUST</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `<tr data-kind="${r.kind}" data-chain="${chainOf(r.ev)}"><td class="st-mono">${new Date(r.at).toISOString().slice(5, 19).replace("T", " ")}</td><td><a class="st-textlink" href="?rescue=${r.page}#/rescues">#${r.log.rescueId}</a></td><td class="st-proof-step">${esc(r.step)}</td><td class="st-mono">${esc(shortId(r.ev.tx))}${r.ev.block ? ` · block ${r.ev.block.toLocaleString("en-US")}` : ""}</td><td><a class="st-textlink st-extlink" href="${r.ev.url}" target="_blank" rel="noopener" aria-label="${r.ev.chain === "sepolia" ? "Etherscan" : "NearBlocks"}: ${esc(r.step)} (opens in a new tab)">${r.ev.chain === "sepolia" ? "Etherscan" : "NearBlocks"}${icon("external", 14)}</a></td><td>${chip(r.ev)}</td></tr>`,
              )
              .join("")}
            <tr class="st-proof-empty" data-proof-empty hidden><td colspan="6">No record of this kind on this chain.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="st-pager">
        <button type="button" class="st-secondary st-cut" data-page="prev">Previous</button>
        <span class="st-pager-pos" data-page-pos></span>
        <button type="button" class="st-secondary st-cut" data-page="next">Next</button>
      </div>
    </section>`;
  wireProofs(root);
  return () => {};
}

// A rescue told step by step, from the trigger to the end: each step says what happened in plain
// words, with its numbers and a labelled link to the real transaction (NearBlocks or Etherscan).
// Readings between the steps fold into one line each, so the story stays readable.
import type { Evidence, RescueEvent, RescueLog } from "../../../stewards/src/rescuelog";
import { CODE, fmtAmt } from "../board/model";
import { icon } from "../icons";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
type Ev<K extends RescueEvent["kind"]> = Extract<RescueEvent, { kind: K }>;
const STEWARDS = ["patient", "hedged", "pool", "deep", "swift"];
const tile = (s: string) => (STEWARDS.includes(s) ? `<span class="st-tile st-tile--22" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s as keyof typeof CODE]}</span>` : "");
const clock = (log: RescueLog, t: number) => new Date(log.openedAtMs + t * 1000).toISOString().slice(11, 19);
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A labelled button to the transaction: where it is and what it proves. */
export function txLink(ev: Evidence | undefined, label: string): string {
  if (!ev) return "";
  const where = ev.chain.startsWith("near") ? "NearBlocks" : ev.chain === "sepolia" ? "Etherscan (Sepolia)" : "Etherscan";
  if (!ev.url) return `<span class="st-txlink is-local">${esc(label)} · local fork, not public</span>`;
  const mark = ev.mark === "proven" ? (ev.rpcs ? ` · proven, ${ev.rpcs} RPCs agree` : "") : ev.mark === "reported" ? " · reported" : " · unverified";
  return `<a class="st-txlink" href="${ev.url}" target="_blank" rel="noopener"><span>${esc(label)}</span><span class="st-txlink-where">${where}${ev.block ? ` · block ${ev.block.toLocaleString("en-US")}` : ""}${mark}</span>${icon("external", 13)}</a>`;
}

type Step = { t: number; tone: "exposure" | "acting" | "safe" | "plain"; title: string; titleHtml?: string; body: string; links: string };

export function storySteps(log: RescueLog): Step[] {
  const all = <K extends RescueEvent["kind"]>(k: K) => log.events.filter((e) => e.kind === k) as Ev<K>[];
  // settlement events share one shape in the log
  const ends = (k: "SETTLE_START" | "SETTLED" | "LIQUIDATED") => log.events.filter((e) => e.kind === k) as { t: number; evidence: Evidence }[];
  const C = log.market.collateral;
  const steps: Step[] = [];
  const trigger = all("TRIGGER")[0];
  const open = all("AUCTION_OPEN")[0];
  if (trigger)
    steps.push({ t: trigger.t, tone: "exposure", title: `Health fell to ${trigger.hf.toFixed(3)}, below the 1.15 trigger`, body: `A reading of position ${log.positionId} on Aave showed it close to liquidation. ${trigger.evidence.mark === "proven" ? `It is a proof, not a report: an OutLayer program read Aave's storage on Sepolia, and ${trigger.evidence.rpcs ?? "several"} independent RPCs agreed on the block.` : "On the local fork the keeper reports readings; nothing there is public."}`, links: txLink(trigger.evidence, "The reading that opened the auction") });
  if (open)
    steps.push({ t: open.t, tone: "acting", title: `Auction opened: ${fmtAmt(open.topUp.amount)} ${open.topUp.asset} needed`, body: `To bring health back to 1.50 the position needs ${fmtAmt(open.topUp.amount)} ${open.topUp.asset} (${usd(open.topUp.usd)}). Stewards have ${open.durationS} s to bid a premium; no premium may exceed ${open.capBps.toLocaleString("en-US")} bps, which keeps the borrower's cost under what an Aave liquidation would take.`, links: txLink(open.evidence, "Auction opened") });
  const bids = all("BID");
  if (bids.length)
    steps.push({
      t: bids[0].t,
      tone: "plain",
      title: `${new Set(bids.map((b) => b.steward)).size} stewards bid`,
      body: `Each bid is the steward's own signed NEAR transaction. Lowest premium wins${bids.length > new Set(bids.map((b) => b.steward)).size ? "; some re-bid lower when outbid" : ""}.`,
      links: bids.map((b) => `<div class="st-story-sub">${tile(b.steward)}<span>${esc(b.steward)} bids <strong>${b.bps} bps</strong> for ${fmtAmt(b.amount)} ${C} · ${clock(log, b.t)}</span>${txLink(b.evidence, "Bid")}</div>`).join(""),
    });
  const close = all("AUCTION_CLOSE")[0];
  if (close)
    steps.push({ t: close.t, tone: close.winners.length ? "acting" : "exposure", title: close.winners.length ? `Auction closed: ${close.winners.map((w) => `${w.steward} at ${w.bps} bps`).join(", ")}` : "Auction closed with no bid covering the top-up", body: close.winners.length > 1 ? `The top-up is shared from the lowest premium up: ${close.winners.map((w) => `${w.steward} supplies ${fmtAmt(w.amount)} ${C}`).join(", ")}.` : close.winners.length ? `${close.winners[0].steward} supplies the whole top-up.` : "The position goes back to waiting for the next auction.", links: txLink(close.evidence, "Auction closed") });
  for (const s of all("TOPUP_SENT")) steps.push({ t: s.t, tone: "safe", title: `${s.steward} supplied ${fmtAmt(s.amount)} ${s.asset} on Aave`, body: `The steward sends its own ${s.asset} into Aave on the position's behalf, from its own wallet.`, links: txLink(s.evidence, "Top-up") });
  const proven = all("TOPUP_CONFIRMED")[0];
  if (proven) steps.push({ t: proven.t, tone: "safe", title: "Top-up proven: the position is safe again", body: "A new proven reading shows the collateral increase. Only that proof lets the contract mint the claims: no steward is trusted to say it paid.", links: txLink(proven.evidence, "Proof of the top-up") });
  for (const x of all("TOPUP_EXPIRED")) steps.push({ t: x.t, tone: "exposure", title: "Top-up missed its deadline", body: `The winner did not top up in time; its bond (${x.slashed} NEAR) goes to the borrower and the position can be auctioned again.`, links: txLink(x.evidence, "Expiry") });
  const claims = all("CLAIM_MINTED");
  if (claims.length)
    steps.push({ t: claims[0].t, tone: "acting", title: claims.length > 1 ? `${claims.length} claims minted` : `Claim ${claims[0].claim} minted to ${claims[0].holder}`, body: `Each winner holds a claim (an NFT), owed back exactly the units it supplied plus its premium, in ${C}, not dollars. The borrower can buy it back within the window; withdrawals stay locked until then.`, links: claims.map((c) => `<div class="st-story-sub">${tile(c.holder)}<span>Claim <span class="st-mono">${esc(c.claim)}</span> · ${esc(c.holder)} is owed ${fmtAmt(c.owed)} + ${fmtAmt(c.premium)} ${c.asset}</span>${txLink(c.evidence, "Claim minted")}</div>`).join("") });
  const pay = all("PAYMENT_IN")[0];
  if (pay) steps.push({ t: pay.t, tone: "safe", title: `Borrower paid ${fmtAmt(pay.amount)} ${pay.asset} into the position`, body: "The buy-back goes into the position, not to the stewards. The contract decides who gets what, so a payment can never be lost to a race.", links: txLink(pay.evidence, "Buy-back payment") });
  const esc_ = all("ESCROW_PROVEN")[0];
  if (esc_) steps.push({ t: esc_.t, tone: "safe", title: "Payment proven", body: "A proven reading of the position's balance commits the buy-back.", links: txLink(esc_.evidence, "Proof of the payment") });
  const bought = all("BOUGHT_BACK")[0];
  if (bought) steps.push({ t: bought.t, tone: "safe", title: "Bought back: claims closed, position unlocked", body: "The claims are burned. Payouts follow, each exactly the owed amount.", links: txLink(bought.evidence, "Buy-back committed") });
  const holderOf = new Map(claims.map((c) => [c.claim, c.holder]));
  for (const p of all("PAYOUT")) {
    const holder = p.claim ? holderOf.get(p.claim) : undefined;
    const titleHtml =
      p.purpose === "buyback"
        ? `${fmtAmt(p.amount)} ${esc(p.asset)} paid back to ${holder ? `${tile(holder)} ${esc(holder)}` : "the claim owner"} <small>(owner of claim ${esc(p.claim ?? "")})</small>`
        : p.purpose === "refund"
          ? `${fmtAmt(p.amount)} ${esc(p.asset)} refunded to the borrower <small>(paid more than owed)</small>`
          : `${fmtAmt(p.amount)} ${esc(p.asset)} reimbursed to a steward <small>(at par)</small>`;
    steps.push({ t: p.t, tone: "plain", title: "", titleHtml, body: "Signed by the contract through NEAR's chain signatures; the transfer lands on Sepolia.", links: txLink(p.evidence, "Payout signed") + txLink((p as any).transfer, "Transfer") });
  }
  for (const s of ends("SETTLE_START")) steps.push({ t: s.t, tone: "exposure", title: "Settlement started", body: "The buy-back window ended (or the borrower's own health fell below 1.10). A claim owner closes the claim at the oracle price: it repays debt and withdraws the collateral it is owed, principal first, premiums last.", links: txLink(s.evidence, "Settlement started") });
  for (const s of ends("SETTLED")) steps.push({ t: s.t, tone: "safe", title: "Settled", body: "Every claim was paid from the position at the oracle price; the borrower kept the rest.", links: txLink(s.evidence, "Settled") });
  for (const s of ends("LIQUIDATED")) steps.push({ t: s.t, tone: "exposure", title: "Aave liquidated the position anyway", body: "The claims shrink to the units supplied: the premium is forfeited, so the borrower never pays both.", links: txLink(s.evidence, "Liquidation proven") });
  return steps.sort((a, b) => a.t - b.t);
}

export function story(log: RescueLog): string {
  const steps = storySteps(log);
  const readings = log.events.filter((e) => e.kind === "READING") as Ev<"READING">[];
  const last = steps[steps.length - 1];
  return `
  <details class="st-panel st-sect st-story">
    <summary class="st-story-summary"><div><div class="st-label">WHAT HAPPENED</div><h2 class="st-panel-title">Step by step, every step on chain</h2>
      <p class="st-story-gist">${steps.length} steps, ${clock(log, 0)} to ${clock(log, last?.t ?? 0)} UTC, each linked to its transaction. Open to read them.</p></div>
      <span class="st-story-toggle" aria-hidden="true"></span></summary>
    <ol class="st-story-list">
      ${steps
        .map(
          (s) => `<li class="st-story-step st-story-step--${s.tone}">
        <span class="st-story-dot" aria-hidden="true"></span>
        <div class="st-story-time">${clock(log, s.t)} UTC<span>+${Math.round(s.t)} s</span></div>
        <div class="st-story-main"><h3>${s.titleHtml ?? esc(s.title)}</h3><p>${s.body}</p></div>
        <div class="st-story-links">${s.links}</div>
      </li>`,
        )
        .join("")}
    </ol>
    ${readings.length ? `<details class="st-story-more"><summary>${readings.length} health readings along the way</summary><div class="st-story-links">${readings.map((r) => `<div class="st-story-sub"><span>${clock(log, r.t)} · health ${r.hf.toFixed(3)}</span>${txLink(r.evidence, "Reading")}</div>`).join("")}</div></details>` : ""}
  </details>`;
}

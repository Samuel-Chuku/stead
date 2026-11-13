// "How it works": the system in two diagrams, a rescue in plain steps, what is proven and by whom,
// a worked example of the cost, recorded rescues run along real price falls, and the questions people
// ask. Every number here is either a contract parameter or a recorded run (README › Recorded runs).
import type { ChartRun } from "../../../stewards/src/costpath";
import { costChart, dateOf, wireCostChart } from "../rescue/costchart";

// links in the answers open in a new tab, so the page stays where the reader was
const out = (href: string, text: string) => `<a class="st-textlink" href="${href}" target="_blank" rel="noopener">${text}</a>`;

const box = (x: number, y: number, w: number, h: number, title: string, sub: string, tone = "") => `
  <g class="st-dg-node ${tone}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="0"/>
  <text x="${x + w / 2}" y="${y + h / 2 - 6}" class="st-dg-title">${title}</text>
  <text x="${x + w / 2}" y="${y + h / 2 + 14}" class="st-dg-sub">${sub}</text></g>`;
const arrow = (x1: number, y1: number, x2: number, y2: number, label: string, lx?: number, ly?: number) => `
  <line class="st-dg-edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#st-dg-arrow)"/>
  ${label ? `<text class="st-dg-label" x="${lx ?? (x1 + x2) / 2}" y="${ly ?? (y1 + y2) / 2 - 6}">${label}</text>` : ""}`;

/** Who talks to whom: NEAR holds the rules and the keys (via MPC); Ethereum holds the money. */
const systemDiagram = `
<svg class="st-dg" viewBox="0 0 960 430" role="img" aria-labelledby="dg1-t dg1-d">
  <title id="dg1-t">How Stead is built</title>
  <desc id="dg1-d">The borrower's NEAR account and the stewards call the Stead contract on NEAR. The contract asks NEAR's MPC network to sign Ethereum transactions for the position, which lives on Aave. The keeper asks OutLayer, a program in a secure enclave, to prove the position's health from Ethereum storage; the proof goes back to the contract.</desc>
  <defs><marker id="st-dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="st-dg-head"/></marker></defs>
  <text class="st-dg-zone" x="20" y="28">NEAR</text>
  <rect class="st-dg-band" x="10" y="38" width="560" height="372"/>
  <text class="st-dg-zone" x="600" y="28">ETHEREUM (SEPOLIA TODAY)</text>
  <rect class="st-dg-band" x="590" y="38" width="360" height="372"/>
  ${box(30, 60, 170, 70, "Borrower", "a NEAR account")}
  ${box(30, 300, 170, 70, "Stewards", "bots that bid and top up")}
  ${box(250, 170, 190, 90, "Stead contract", "auction · claims · rules", "is-core")}
  ${box(250, 320, 190, 70, "MPC network", "NEAR chain signatures")}
  ${box(250, 60, 190, 70, "OutLayer (TEE)", "the keeper asks; it proves")}
  ${box(640, 170, 270, 90, "The position on Aave", "an address only the contract signs for", "is-money")}
  ${box(640, 320, 270, 70, "Steward wallets", "their own LINK, sent as top-ups")}
  ${box(640, 60, 270, 70, "Aave storage + 3 RPCs", "the block the proof reads")}
  ${arrow(200, 95, 250, 190, "asks", 230, 130)}
  ${arrow(200, 330, 250, 245, "bids", 236, 300)}
  ${arrow(345, 260, 345, 320, "sign this", 385, 295)}
  ${arrow(440, 355, 640, 225, "signed transaction", 545, 275)}
  ${arrow(345, 130, 345, 170, "proven health", 410, 155)}
  ${arrow(640, 95, 440, 95, "reads", 540, 88)}
  ${arrow(775, 320, 775, 260, "top-up", 815, 295)}
</svg>`;

/** A rescue's life, left to right. */
const lifeDiagram = `
<svg class="st-dg" viewBox="0 0 960 250" role="img" aria-labelledby="dg2-t dg2-d">
  <title id="dg2-t">A rescue from the trigger to the end</title>
  <desc id="dg2-d">Health falls below 1.15; a 45-second auction picks the lowest premium; the winner tops up and a proof mints its claim; the borrower buys the claim back, or a claim owner settles at the oracle price.</desc>
  <defs><marker id="st-dg-arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="st-dg-head"/></marker></defs>
  ${box(10, 40, 150, 76, "Health < 1.15", "proven reading", "is-risk")}
  ${box(200, 40, 150, 76, "Auction, 45 s", "lowest premium wins")}
  ${box(390, 40, 150, 76, "Top-up", "steward supplies on Aave")}
  ${box(580, 40, 150, 76, "Claim NFT", "owed the same units back")}
  ${box(790, 0, 160, 76, "Bought back", "within the window", "is-safe")}
  ${box(790, 110, 160, 76, "Settled", "at the oracle price")}
  <line class="st-dg-edge" x1="160" y1="78" x2="200" y2="78" marker-end="url(#st-dg-arrow2)"/>
  <line class="st-dg-edge" x1="350" y1="78" x2="390" y2="78" marker-end="url(#st-dg-arrow2)"/>
  <line class="st-dg-edge" x1="540" y1="78" x2="580" y2="78" marker-end="url(#st-dg-arrow2)"/>
  <line class="st-dg-edge" x1="730" y1="70" x2="790" y2="40" marker-end="url(#st-dg-arrow2)"/>
  <line class="st-dg-edge" x1="730" y1="90" x2="790" y2="148" marker-end="url(#st-dg-arrow2)"/>
  <text class="st-dg-label" x="480" y="160">Health back to 1.50 the moment the top-up is proven.</text>
  <text class="st-dg-label" x="480" y="182">The borrower's cost: the premium, capped below what Aave's liquidation would take.</text>
  <text class="st-dg-label" x="480" y="230">If Aave liquidates anyway, the premium is forfeited: the borrower never pays both.</text>
</svg>`;

const STEPS: [string, string][] = [
  ["Watch", "The keeper asks OutLayer for a proven reading of each position: a program in a secure enclave reads Aave's storage on Ethereum, and at least three independent RPCs must agree on the block. When the proven health factor falls below 1.15, the contract opens an auction."],
  ["Bid", "For 45 seconds, stewards bid a premium in basis points for an amount of collateral. The lowest premium wins. When no single steward can cover the top-up, several share it, filled from the lowest premium up. Every premium is capped below Aave's liquidation penalty."],
  ["Top up", "Each winner supplies its own collateral to Aave on the position's behalf. Only a new proven reading showing the collateral increase mints its claim: an NFT owed back exactly the units it supplied plus its premium."],
  ["Buy back", "Within the window (24 hours; 5 minutes on the demo contract), the borrower pays what is owed into the position. Once the payment is proven, the contract pays each claim owner exactly what it is owed and refunds any excess."],
  ["Or settle", "If the window ends, or the borrower's own health falls below 1.10, a claim owner settles at the oracle price: it repays part of the debt and withdraws the collateral it is owed. A stalled settler is taken over after 3 minutes."],
  ["Locked meanwhile", "From the auction until the last claim closes, the borrower may only repay or add collateral. The contract refuses every other request; the position's address has no key anyone holds."],
];

export const FAQ: [string, string][] = [
  ["Who holds the keys to my position?", "Nobody. The position is an Ethereum address derived by NEAR's MPC network for the Stead contract. Only the contract can have a transaction signed for it, and only from a fixed list: Aave supply, borrow, repay and withdraw, approvals to the Aave pool, sending borrowed debt to your own payout address, and the payouts the contract itself queues."],
  ["Why would a steward rescue my position?", "For the premium: a few percent of the top-up at most, because the contract caps every premium below Aave's liquidation penalty. The steward's collateral comes back to it in the same units it supplied, so it is not betting on the price; the premium pays for its capital and for the risk that the price falls too fast for a rescue to help."],
  ["Can the borrower walk away with the steward's top-up?", `No. From the moment the auction opens until the last claim closes, the contract will only sign a repay or a supply for the position. A borrow or a withdrawal is refused on chain: ${out("?demo=#/live", "try it on the demo")}, every refusal is a real NEAR transaction.`],
  ["What does a rescue cost me, compared with a liquidation?", `Only the premium. In the ${out("?rescue=steadfi:7#/rescues", "recorded settlement on our fork")}, the borrower paid 0.6233 LINK ($12.96 at the trigger) against $90 that an Aave liquidation would have taken from the same position. On Ethereum mainnet today, the ${out("#/mainnet", "On mainnet")} page shows the same comparison for every real liquidation of the last 24 hours.`],
  ["What if nobody bids, or the winner never tops up?", "No bid: the position goes back to waiting and a new auction opens on the next proven reading below 1.15. A winner that misses its top-up deadline loses its bond to the borrower, and the position can be auctioned again."],
  ["What if the price keeps falling after the rescue?", "If the borrower's own health, net of what the claims are owed, falls below 1.10, a claim owner may settle early instead of waiting for the window. If Aave liquidates the position anyway, every claim shrinks to the units supplied: the premium is forfeited, so the borrower never pays both a premium and Aave's penalty."],
  ["How do you know the health factor is real?", "On Sepolia every decision that moves money waits for a proof: an OutLayer program, running in a secure enclave with a pinned hash, reads Aave's storage at a block that at least three independent RPCs agree on. No steward and no bot is trusted to say 'health is low', 'the top-up landed' or 'the payment arrived'."],
  ["Is it live on mainnet?", `The rescues run on testnets (NEAR testnet and Ethereum Sepolia), with real Aave V3 contracts. The ${out("#/mainnet", "On mainnet")} page applies Stead's formulas to real Aave positions on Ethereum, read-only. Two small capped rescues on Ethereum mainnet are planned, each recorded with every transaction.`],
];

export function mountHow(root: HTMLElement): () => void {
  root.innerHTML = `
  <div class="st-how">
    <section class="st-panel st-sect st-list">
      <header class="st-list-head">
        <div class="st-label">HOW IT WORKS</div>
        <h1 class="st-page-title">A rescue market for positions about to be liquidated</h1>
        <p class="st-list-sub">When an Aave position nears liquidation, stewards compete to top up its collateral, and the lowest premium wins. The rescue becomes a claim the borrower buys back. A NEAR contract runs the auction, holds the claims and signs the position's Ethereum transactions through NEAR's chain signatures. <strong>A borrower is never worse off than after an Aave liquidation.</strong></p>
      </header>
      <div class="st-how-cta"><a class="st-push st-cut" href="#/try"><span class="st-lamp" aria-hidden="true"></span>PROTECT AN AAVE POSITION</a><a class="st-secondary st-cut st-secondary--link" href="?demo=#/live">Start a demo rescue</a><a class="st-secondary st-cut st-secondary--link" href="#/rescues">See every rescue</a></div>
    </section>

    <section class="st-panel st-sect">
      <div class="st-label">THE PIECES</div>
      <h2 class="st-panel-title">NEAR holds the rules and the keys; Ethereum holds the money</h2>
      ${systemDiagram}
    </section>

    <section class="st-panel st-sect">
      <div class="st-label">A RESCUE</div>
      <h2 class="st-panel-title">From the trigger to the end</h2>
      ${lifeDiagram}
      <ol class="st-how-steps">${STEPS.map(([t, b], i) => `<li><span class="st-own-num" aria-hidden="true">${i + 1}</span><div><h3>${t}</h3><p>${b}</p></div></li>`).join("")}</ol>
    </section>

    <section class="st-panel st-sect">
      <div class="st-label">THE PROMISE, IN NUMBERS</div>
      <h2 class="st-panel-title">Why the borrower is never worse off</h2>
      <div class="st-how-cols">
        <div><h3>Aave liquidation</h3><p>A liquidator repays up to half the debt and takes that value in collateral plus a bonus (5–10 % depending on the asset). That bonus is the borrower's loss.</p></div>
        <div><h3>Stead rescue</h3><p>The total premium, valued at the trigger price, must stay below that bonus on half the debt, counted across every open claim. The steward is owed back the same units it supplied, so the borrower's cost is the premium and nothing else.</p></div>
        <div><h3>If it goes wrong anyway</h3><p>An Aave liquidation proven while claims are open forfeits every premium. Settlement happens at the oracle price, principal first and premiums last.</p></div>
      </div>
    </section>

    <section class="st-panel st-sect st-how-runs" data-runs>
      <div class="st-sect-head">
        <div>
          <div class="st-label">IN A REAL CRASH</div>
          <h2 class="st-panel-title">Recorded rescues, run along real 2026 price falls</h2>
          <p class="st-list-sub">Sepolia's test prices never move, so each recorded rescue's position (its health at the trigger, its proven health after the top-up, its debt and premium) is replayed on a real hourly fall of its collateral, picked by a fixed rule. Pick a run.</p>
        </div>
        <label class="st-select"><span class="st-select-label">Run</span><select data-run-select disabled><option>Loading…</option></select></label>
      </div>
      <div data-run-chart><p class="st-empty">Loading the runs…</p></div>
    </section>

    <section class="st-panel st-sect">
      <div class="st-label">QUESTIONS</div>
      <h2 class="st-panel-title">What people ask</h2>
      <div class="st-faq">${FAQ.map(([q, a]) => `<details class="st-faq-item"><summary>${q}<span class="st-item-caret" aria-hidden="true"></span></summary><p>${a}</p></details>`).join("")}</div>
    </section>
  </div>`;
  // one answer open at a time
  const onToggle = (e: Event) => {
    const d = e.target as HTMLDetailsElement;
    if (!d.matches?.("details.st-faq-item") || !d.open) return;
    for (const o of root.querySelectorAll<HTMLDetailsElement>("details.st-faq-item[open]")) if (o !== d) o.open = false;
  };
  root.addEventListener("toggle", onToggle, true);
  void mountRuns(root);
  return () => root.removeEventListener("toggle", onToggle, true);
}

const runLabel = (r: ChartRun) => `Rescue ${r.rescueId} · ${r.about} · ${r.sym}'s ${r.rule} fall, ${dateOf(r.path.startMs)}`;

/** The run picker: one chart, redrawn for the chosen run. */
async function mountRuns(root: HTMLElement) {
  const slot = root.querySelector<HTMLElement>("[data-run-chart]");
  const select = root.querySelector<HTMLSelectElement>("[data-run-select]");
  if (!slot || !select) return;
  let runs: ChartRun[];
  try {
    const r = await fetch("/replays/chart-runs.json");
    if (!r.ok) throw new Error(String(r.status));
    runs = await r.json();
  } catch {
    slot.innerHTML = `<p class="st-empty">The runs could not be loaded. Reload the page to try again.</p>`;
    return;
  }
  select.innerHTML = runs.map((r, i) => `<option value="${i}">${runLabel(r)}</option>`).join("");
  select.disabled = false;
  const draw = () => {
    const run = runs[Number(select.value)] ?? runs[0];
    const page = `?rescue=${run.key}#/rescues`;
    slot.innerHTML = costChart(run, {
      caption: `<p class="st-site-caption">The rescue itself: ${out(page, `rescue ${run.rescueId}'s page`)}, with every transaction.</p>`,
    });
    wireCostChart(slot, run);
  };
  select.addEventListener("change", draw);
  draw();
}

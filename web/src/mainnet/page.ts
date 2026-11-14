// The On mainnet page: Stead's real rescues on Ethereum mainnet, read from its contract on NEAR
// mainnet (chainlist.ts), then real Aave V3 positions on Ethereum and the real liquidations of the
// last 24 hours, each with what Stead's contract and stewards would have done at the 1.15 trigger
// (the contract's formulas and the stewards' real strategies applied to public reads:
// stewards/scripts/mainnet-panel.ts).
import type { Liquidation, PanelFeed, PanelPosition, TriggerEvent } from "../../../stewards/src/panel";
import { crown } from "../crown";
import { list, wire, type Item } from "../lists/pages";
import { icon } from "../icons";
import { loadRuns, runsHtml, wireRuns } from "./runs";
import { chainSectionHtml, mountChainRuns } from "./chainlist";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (n: number, dp = 0) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const usdBig = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `$${Math.round(n / 1e3)}k` : usd(n));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const addr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const etherscan = (path: string, label: string) => `<a class="st-textlink st-extlink" href="https://etherscan.io/${path}" target="_blank" rel="noopener">${label}${icon("external", 13)}</a>`;
const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16) + " UTC";
const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";

const feedUrl = () =>
  (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");
async function loadPanel(): Promise<{ feed: PanelFeed; live: boolean }> {
  try {
    const r = await fetch(`${feedUrl()}/mainnet.json`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (r.ok) return { feed: await r.json(), live: true };
  } catch {
    /* fall back to the snapshot */
  }
  const r = await fetch("/mainnet.json");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { feed: await r.json(), live: false };
}

/** A real liquidation, and what Stead would have charged the same position at its trigger. */
function liquidationItem(l: Liquidation): Item {
  const s = l.stead;
  return {
    chain: "Ethereum",
    group: s ? "real" : "fork", // the dropdown: liquidations Stead could have rescued, or all
    cells: [
      `<span class="st-item-main">${hhmm(l.at)}</span><span class="st-item-sub st-mono">${addr(l.user)}</span>`,
      `<span class="st-item-main">${usd(l.debt.usd)} ${esc(l.debt.symbol)}</span><span class="st-item-sub">repaid, ${esc(l.collateral.symbol)} seized</span>`,
      `<span class="st-item-main">${usd(l.bonusPaidUsd)}</span><span class="st-item-sub">liquidation bonus paid</span>`,
      s ? `<span class="st-item-main">${usd(s.savedUsd)} kept</span><span class="st-item-sub">with Stead: ${usd(s.premiumUsd)} premium</span>` : `<span class="st-item-sub st-item-note">${esc(l.steadNote ?? "no estimate")}</span>`,
    ],
    details: [
      ["Liquidated", `${when(l.at)} · block ${l.block.toLocaleString("en-US")} · ${etherscan(`tx/${l.tx}`, "Etherscan")}`],
      ["Borrower", `<span class="st-mono">${esc(l.user)}</span>`],
      ["Repaid", `${usd(l.debt.usd, 2)} of ${esc(l.debt.symbol)}`],
      ["Seized", `${usd(l.collateral.usd, 2)} of ${esc(l.collateral.symbol)}`],
      ["Bonus paid", `${usd(l.bonusPaidUsd, 2)} (collateral seized minus debt repaid, at the ${l.priceAt === "block" ? "block's" : "latest"} oracle price; Aave's protocol fee comes on top)`],
      ...(s
        ? ([
            ["Stead at the trigger", `top-up ${usd(s.topupUsd)} to bring health back to 1.50`],
            ["Winning bid", `${esc(s.steward)} ${crown(s.steward, [["Premium", `${s.bps} bps`], ["Cost", usd(s.premiumUsd, 2)]], 13)} at ${s.bps} bps, ${usd(s.premiumUsd, 2)} (cap ${usd(s.capUsd, 2)})`],
            ["Borrower would keep", `<strong>${usd(s.savedUsd, 2)}</strong>`],
          ] as [string, string][])
        : ([["Stead", esc(l.steadNote ?? "no estimate")]] as [string, string][])),
    ],
  };
}

/** A real position that crossed 1.15: where Stead's auction would have opened. */
function triggerItem(t: TriggerEvent): Item {
  const w = t.stead.winner;
  return {
    chain: "Ethereum",
    cells: [
      `<span class="st-item-main">seen ${hhmm(t.at)}</span><span class="st-item-sub st-mono">${addr(t.address)}</span>`,
      `<span class="st-item-main">${t.hfBefore.toFixed(3)} to <span class="st-item-hf-below">${t.hf.toFixed(3)}</span></span><span class="st-item-sub">health factor</span>`,
      `<span class="st-item-main">${usdBig(t.debtUsd)}</span><span class="st-item-sub">debt</span>`,
      w ? `<span class="st-item-main">${esc(w.steward)} at ${w.bps} bps</span><span class="st-item-sub">${usd(w.premiumUsd)} to top up ${usd(t.stead.topupUsd)}</span>` : `<span class="st-item-sub st-item-note">no steward would bid</span>`,
    ],
    details: [
      ["Seen below 1.15", `${when(t.at)} · block ${t.block.toLocaleString("en-US")} (the first reading below the trigger; the feed reads every 5 minutes)`],
      ["Position", `<span class="st-mono">${esc(t.address)}</span> · ${etherscan(`address/${t.address}`, "Etherscan")}`],
      ["Collateral", usd(t.collateralUsd, 2)],
      ["Stead's auction", `top-up ${usd(t.stead.topupUsd)} to bring health back to 1.50 · premium cap ${usd(t.stead.capUsd, 2)}`],
      ...(w ? ([["Winning bid", `${esc(w.steward)} ${crown(w.steward, [["Premium", `${w.bps} bps`], ["Cost", usd(w.premiumUsd, 2)]], 13)} at ${w.bps} bps, ${usd(w.premiumUsd, 2)}`]] as [string, string][]) : []),
    ],
  };
}

/** A real position near the trigger, and Stead's auction if it crossed 1.15 now. */
function positionItem(p: PanelPosition): Item {
  const t = p.atTrigger;
  const won = t?.winner;
  return {
    chain: "Ethereum",
    cells: [
      `<span class="st-item-main st-mono">${addr(p.address)}</span><span class="st-item-sub">${esc(p.collateral.map((c) => c.symbol).slice(0, 2).join(", "))}${p.collateral.length > 2 ? ` +${p.collateral.length - 2}` : ""}</span>`,
      `<span class="st-num st-item-big${p.hf < 1.15 ? " is-below" : ""}">${p.hf.toFixed(3)}</span>`,
      `<span class="st-item-main">${usdBig(p.debtUsd)}</span><span class="st-item-sub">debt</span>`,
      `<span class="st-item-main">${pct(p.dropToLiquidation)}</span><span class="st-item-sub">fall to liquidation</span>`,
    ],
    details: [
      ["Position", `<span class="st-mono">${esc(p.address)}</span> · ${etherscan(`address/${p.address}`, "Etherscan")}`],
      ["Health factor", `${p.hf.toFixed(4)} · Aave liquidates below 1.00, after a ${pct(p.dropToLiquidation)} fall`],
      ["Collateral", p.collateral.map((c) => `${esc(c.symbol)} ${usdBig(c.usd)}`).join(", ")],
      ["Debt", usd(p.debtUsd, 2)],
      ...(t
        ? ([
            ["At the trigger", `top-up ${usd(t.topupUsd)} · premium cap ${t.capBps} bps · Aave's liquidation would cost ${usd(t.liquidationCostUsd, 2)}`],
            ["Stewards", t.bids.map((b) => `${esc(b.steward)}${won && won.steward === b.steward ? ` ${crown(b.steward, [["Premium", `${b.bps} bps`], ["Cost", usd(won.premiumUsd, 2)]], 13)}` : ""}: <span class="st-quiet">${b.bps !== null ? `${b.bps} bps` : esc(b.why)}</span>`).join("<br>")],
            ...(won ? ([["Borrower would keep", `<strong>${usd(won.savedUsd, 2)}</strong> against the liquidation`]] as [string, string][]) : []),
          ] as [string, string][])
        : []),
    ],
  };
}

function render(f: PanelFeed, live: boolean, runs: string) {
  const s = f.summary;
  const dayAgo = Date.parse(f.blockTime) - 86_400_000;
  const recent = f.liquidations.filter((l) => Date.parse(l.at) > dayAgo);
  const crossed = f.triggers.filter((t) => Date.parse(t.at) > dayAgo);
  // the feed lists the latest 50; the summary counts every one of the day
  const cut = recent.length < s.liquidations24h ? `<p class="st-list-note">The latest ${recent.length} of the day's ${s.liquidations24h} liquidations.</p>` : "";
  return `
  <section class="st-panel st-sect st-list">
    <header class="st-list-head">
      <div class="st-label">ETHEREUM MAINNET</div>
      <h1 class="st-page-title">Aave on mainnet, with Stead</h1>
      <p class="st-list-sub">Stead runs on Ethereum mainnet with real funds: below the totals, every rescue its contract has run, read straight from the contract. Then real Aave V3 positions and real liquidations on Ethereum, read from public RPCs, each with what Stead's contract and stewards would have done at the 1.15 trigger.</p>
      <p class="st-list-src">${live ? `<span class="st-live-dot" aria-hidden="true"></span>` : ""}${live ? "Read" : "Snapshot read"} at block ${f.block.toLocaleString("en-US")}, ${when(f.blockTime)} · ${f.coverage.borrowers.toLocaleString("en-US")} borrowers followed</p>
    </header>
    <dl class="st-kpis">
      <div><dt>LIQUIDATED, 24 H</dt><dd><span class="st-num">${s.liquidations24h}</span></dd><dd class="st-kpi-sub">${usdBig(s.bonusPaid24hUsd)} in liquidation bonuses</dd></div>
      <div><dt>WITH STEAD</dt><dd><span class="st-num">${usdBig(s.steadPremium24hUsd)}</span></dd><dd class="st-kpi-sub">in premiums, on ${s.compared24h} of them</dd></div>
      <div><dt>BORROWERS KEEP</dt><dd><span class="st-num">${usdBig(s.saved24hUsd)}</span></dd><dd class="st-kpi-sub">that went to liquidators</dd></div>
      <div><dt>NEAR THE TRIGGER</dt><dd><span class="st-num">${s.nearTrigger}</span></dd><dd class="st-kpi-sub">${usdBig(s.debtNearTriggerUsd)} of debt, ${s.belowTrigger} below 1.15</dd></div>
    </dl>
  </section>
  ${chainSectionHtml()}
  ${runs}
  <section class="st-panel st-sect st-list" data-list>
    <div class="st-sect-head"><div><div class="st-label">LIQUIDATIONS · LAST 24 HOURS</div><h2 class="st-panel-title">What borrowers paid, and what Stead would have charged</h2></div></div>
    <div class="st-list-tools"><label class="st-select"><span class="st-select-label">Show</span><select data-chain-select>
      <option value="real">Stead could rescue (${recent.filter((l) => l.stead).length})</option><option value="all">All liquidations (${recent.length})</option>
    </select></label></div>
    ${list("st-items--mainnet", ["TIME · BORROWER", "REPAID", "PAID TO LIQUIDATOR", "WITH STEAD"], recent.map(liquidationItem), "No liquidation in the last 24 hours that Stead could have rescued.")}
    ${cut}
  </section>
  ${crossed.length ? `<section class="st-panel st-sect st-list" data-list>
    <div class="st-sect-head"><div><div class="st-label">CROSSED 1.15 · LAST 24 HOURS</div><h2 class="st-panel-title">Where Stead's auction would have opened</h2></div></div>
    ${list("st-items--mainnet", ["SEEN · POSITION", "HEALTH", "DEBT", "WINNING BID"], crossed.map(triggerItem), "No position crossed the trigger.")}
  </section>` : ""}
  <section class="st-panel st-sect st-list" data-list>
    <div class="st-sect-head"><div><div class="st-label">CLOSEST TO THE TRIGGER</div><h2 class="st-panel-title">Positions Stead's stewards would be watching</h2></div></div>
    ${list("st-items--mainnet", ["POSITION", "HEALTH", "DEBT", "LEFT BEFORE AAVE LIQUIDATES"], f.positions.map(positionItem), "No position near the trigger.")}
  </section>`;
}

export function mountMainnet(root: HTMLElement): () => void {
  let gone = false;
  const stop = new AbortController();
  root.innerHTML = `<section class="st-panel st-page" aria-busy="true"><div class="st-label">MAINNET</div><p class="st-empty">Reading Ethereum mainnet…</p></section>`;
  Promise.all([loadPanel(), loadRuns()]).then(
    ([{ feed, live }, runs]) => {
      if (gone) return;
      root.innerHTML = render(feed, live, runsHtml(runs));
      wire(root, stop.signal);
      wireRuns(root, stop.signal);
      mountChainRuns(root, stop.signal, runs?.runs ?? null);
    },
    (e) => {
      if (!gone) root.innerHTML = `<section class="st-error" role="alert"><h2>Mainnet panel not loaded</h2><p>Neither the live feed nor the site's snapshot answered (${esc(String((e as Error).message))}). Reload the page to try again.</p></section>`;
    },
  );
  return () => {
    gone = true;
    stop.abort();
  };
}

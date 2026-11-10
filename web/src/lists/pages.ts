// The list pages: Overview, Positions, Rescues, Claims, Stewards. Every row is the contracts' own
// record (stewards/src/records.ts), read live through the feed (re-read every 2 minutes), else the
// snapshot shipped with the site, and the page says which it shows and when it was read.
import type { ClaimRow, PositionRow, Records, RescueRow, StewardRow } from "../../../stewards/src/records";
import type { StewardId } from "../../../stewards/src/rescuelog";
import { CODE, RISK, RISK_WORD, STEWARD_ORDER } from "../board/model";

export type ListRoute = "overview" | "positions" | "rescues" | "claims" | "stewards";
/** Rescues with a published recording (their own page with timeline, chart and proofs). */
export type Recorded = { id: string; contract: string; rescueId: number };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (n: number | null) => (n === null ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const amt = (v: string) => {
  const n = Number(v);
  return n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 4 }) : v;
};
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const shortC = (c: string) => (c.startsWith("sepolia-demo") ? "sepolia-demo" : c.split(".")[0]);
const isSteward = (s: string): s is StewardId => (STEWARD_ORDER as string[]).includes(s);
const tile = (s: string, size = 22) => (isSteward(s) ? `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s]}</span>` : "");
const STATE: Record<string, [string, string]> = {
  auction: ["AUCTION", "open"],
  top_up_pending: ["TOP-UP", "open"],
  open: ["CLAIM OPEN", "open"],
  settling: ["SETTLING", "open"],
  bought_back: ["BOUGHT BACK", "rescued"],
  settled: ["SETTLED", "rescued"],
  failed: ["FAILED", "liquidated"],
};
const stateChip = (s: string) => {
  const [t, k] = STATE[s] ?? [s.toUpperCase(), "rescued"];
  return `<span class="st-chip st-chip--${k}">${t}</span>`;
};
const forkChip = `<span class="st-evidence st-evidence--unverified">FORK · UNVERIFIED</span>`;

// ── data ──

const feedUrl = () =>
  (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");
let cache: { rec: Records; live: boolean; at: number } | null = null;
export async function loadRecords(): Promise<{ rec: Records; live: boolean }> {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  try {
    const r = await fetch(`${feedUrl()}/records.json`, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    if (r.ok) {
      cache = { rec: await r.json(), live: true, at: Date.now() };
      return cache;
    }
  } catch {
    /* fall back to the snapshot */
  }
  const r = await fetch("/records.json");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  cache = { rec: await r.json(), live: false, at: Date.now() };
  return cache;
}

/** Rows shown by the chain filter: the real chains by default; local fork runs only when asked. */
export function byChain<T extends { chain: string }>(rows: T[], chain: "real" | "fork" | "all"): T[] {
  return chain === "all" ? rows : rows.filter((r) => (chain === "fork" ? r.chain === "local fork" : r.chain !== "local fork"));
}

// ── page parts ──

function head(label: string, title: string, sub: string, live: boolean, generated: string) {
  return `<div class="st-sect-head">
      <div><div class="st-label">${label}</div><h1 class="st-page-title">${title}</h1><p class="st-list-sub">${sub}</p></div>
      <p class="st-list-src">${live ? `<span class="st-live-dot" aria-hidden="true"></span>Read from the contracts at ${when(Date.parse(generated))}` : `Snapshot of the contracts from ${when(Date.parse(generated))}`}</p>
    </div>`;
}
const chainFilter = (counts: Record<"real" | "fork" | "all", number>) => `
    <div class="st-filter-group" role="group" aria-label="Chain">
      <button type="button" class="st-filter" data-chain="real" aria-pressed="true">SEPOLIA <span class="st-seg-count">${counts.real}</span></button>
      ${counts.fork ? `<button type="button" class="st-filter" data-chain="fork" aria-pressed="false">LOCAL FORK <span class="st-seg-count">${counts.fork}</span></button>` : ""}
      <button type="button" class="st-filter" data-chain="all" aria-pressed="false">ALL <span class="st-seg-count">${counts.all}</span></button>
    </div>`;
const counts = (rows: { chain: string }[]) => ({ real: byChain(rows, "real").length, fork: byChain(rows, "fork").length, all: rows.length });
const table = (cols: string[], body: string, empty: string) => `
    <div class="st-table-wrap"><table class="st-list-table">
      <thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${body}<tr class="st-proof-empty" data-list-empty hidden><td colspan="${cols.length}">${empty}</td></tr></tbody>
    </table></div>`;

function hfCell(p: PositionRow) {
  if (p.hf === null) return `<span class="st-quiet">${p.status === "no reading" ? "no reading yet" : "no debt"}</span>`;
  const mark = p.chain === "local fork" ? forkChip : p.hfSource === "verified" ? `<span class="st-evidence st-evidence--proven"><span class="st-evidence-mark" aria-hidden="true"></span>PROVEN</span>` : `<span class="st-evidence st-evidence--reported"><span class="st-evidence-mark" aria-hidden="true"></span>REPORTED · ${esc((p.hfSource ?? "").split(".")[0])}</span>`;
  return `<span class="st-num st-list-hf${p.hf < 1.15 ? " is-below" : ""}">${p.hf.toFixed(3)}</span> ${mark}${p.hfBlock ? `<span class="st-list-meta">block ${p.hfBlock.toLocaleString("en-US")}</span>` : ""}`;
}
const POS_STATUS: Record<PositionRow["status"], string> = {
  "in rescue": `<span class="st-chip st-chip--open">IN RESCUE</span>`,
  "below trigger": `<span class="st-chip st-chip--open">BELOW TRIGGER</span>`,
  protected: `<span class="st-chip st-chip--rescued">PROTECTED</span>`,
  "no reading": `<span class="st-chip st-chip--rescued">NO READING</span>`,
  empty: `<span class="st-chip st-chip--rescued">EMPTY</span>`,
};

function positionsPage(rec: Records, live: boolean) {
  const rows = rec.positions
    .map(
      (p) => `<tr data-chain="${p.chain === "local fork" ? "fork" : "real"}">
        <td><span class="st-num">#${p.id}</span><span class="st-list-meta">${shortC(p.contract)}</span></td>
        <td class="st-mono">${esc(p.owner)}</td>
        <td>${esc(p.pair)}<span class="st-list-meta">${esc(p.chain)}</span></td>
        <td>${hfCell(p)}</td>
        <td>${usd(p.collateralUsd)}</td><td>${usd(p.debtUsd)}</td>
        <td>${POS_STATUS[p.status]}${p.openRescues.length ? `<span class="st-list-meta">rescue ${p.openRescues.join(", ")}</span>` : ""}</td>
      </tr>`,
    )
    .join("");
  return `<section class="st-panel st-sect st-list" data-list>
    ${head("POSITIONS", "Protected positions", "Every position registered with a Stead contract. The health factor is the contract's last reading: proven by OutLayer on Sepolia, reported on the local fork. An auction opens when a proven reading falls below 1.15.", live, rec.generated)}
    <div class="st-filters">${chainFilter(counts(rec.positions))}</div>
    ${table(["POSITION", "BORROWER", "MARKET", "HEALTH FACTOR", "COLLATERAL", "DEBT", "STATUS"], rows, "No position on this chain.")}
  </section>`;
}

function rescuesPage(rec: Records, live: boolean, recorded: Recorded[], latest = false) {
  const pageOf = (r: RescueRow) => recorded.find((x) => x.contract === r.contract && x.rescueId === r.id);
  const rows = rec.rescues
    .map((r) => {
      const page = pageOf(r);
      const open = ["auction", "top_up_pending", "open", "settling"].includes(r.state);
      return `<tr data-chain="${r.chain === "local fork" ? "fork" : "real"}">
        <td><span class="st-num">#${r.id}</span><span class="st-list-meta">${shortC(r.contract)}</span></td>
        <td>#${r.positionId}<span class="st-list-meta">${esc(r.pair)} · ${esc(r.chain)}</span></td>
        <td class="st-mono">${when(r.openedAtMs)}</td>
        <td>${amt(r.topUp)} ${esc(r.asset)}<span class="st-list-meta">${usd(r.topUpUsd)} at the trigger</span></td>
        <td>${r.winners.length ? r.winners.map((w) => `<span class="st-list-win">${tile(w.steward)}${esc(w.steward)} <span class="st-quiet">${w.bps} bps</span></span>`).join("") : `<span class="st-quiet">${r.state === "auction" ? "bidding" : r.bids ? "no winner" : "no bids"}</span>`}<span class="st-list-meta">${r.bids} bid${r.bids === 1 ? "" : "s"} · cap ${r.capBps.toLocaleString("en-US")} bps</span></td>
        <td>${stateChip(r.state)}${r.chain === "local fork" ? ` ${forkChip}` : ""}</td>
        <td>${page ? `<a class="st-textlink" href="?rescue=${page.id}#/rescues">Rescue page</a>` : open ? `<a class="st-textlink" href="#/live">Watch live</a>` : `<span class="st-quiet">—</span>`}</td>
      </tr>`;
    })
    .join("");
  return `<section class="st-panel st-sect st-list" data-list>
    ${latest ? `<div class="st-sect-head"><div><div class="st-label">LATEST RESCUES</div><h2 class="st-panel-title">On Sepolia, newest first</h2></div><a class="st-textlink" href="#/rescues">Every rescue</a></div>` : head("RESCUES", "Every rescue", "Each auction a Stead contract opened, newest first, with its top-up, its winners and their premiums. Recorded rescues have their own page: timeline, cost chart and every proof.", live, rec.generated)}
    ${latest ? "" : `<div class="st-filters">${chainFilter(counts(rec.rescues))}</div>`}
    ${table(["RESCUE", "POSITION", "OPENED", "TOP-UP", "WINNERS", "STATE", ""], rows, "No rescue on this chain.")}
  </section>`;
}

function claimsPage(rec: Records, live: boolean) {
  const chainOfClaim = (c: ClaimRow) => rec.rescues.find((r) => r.contract === c.contract && r.id === c.rescueId)?.chain ?? "Sepolia";
  const rows = rec.claims
    .map((c) => {
      const chain = chainOfClaim(c);
      const st = c.status === "open" ? (c.expiresAtMs > Date.now() ? `<span class="st-chip st-chip--open">OPEN</span><span class="st-list-meta">buy-back until ${when(c.expiresAtMs)}</span>` : `<span class="st-chip st-chip--open">WINDOW ENDED</span><span class="st-list-meta">settlement due</span>`) : stateChip(c.status);
      return `<tr data-chain="${chain === "local fork" ? "fork" : "real"}">
        <td class="st-mono">${esc(c.token)}<span class="st-list-meta">${shortC(c.contract)}</span></td>
        <td><span class="st-list-win">${tile(c.owner)}${esc(c.owner)}</span></td>
        <td>${amt(c.owed)} ${esc(c.asset)}<span class="st-list-meta">${amt(c.share)} supplied + ${amt(c.premium)} premium</span></td>
        <td>${c.bps} bps</td>
        <td>#${c.rescueId}<span class="st-list-meta">position ${c.positionId}</span></td>
        <td>${st}</td>
      </tr>`;
    })
    .join("");
  const withChain = rec.claims.map((c) => ({ chain: chainOfClaim(c) }));
  return `<section class="st-panel st-sect st-list" data-list>
    ${head("CLAIMS", "Claims", "Each rescue mints its stewards a claim (NEP-171), owed in units of the asset they supplied, never in dollars. The borrower buys it back within the window, or it settles at the oracle price.", live, rec.generated)}
    <div class="st-filters">${chainFilter(counts(withChain))}</div>
    ${table(["CLAIM", "HOLDER", "OWED", "PREMIUM", "RESCUE", "STATUS"], rows, "No claim on this chain.")}
  </section>`;
}

const STRATEGY: Record<StewardId, string> = {
  patient: "Bids late and prices thin margins higher.",
  hedged: "Hedges the asset it supplies on a perpetuals venue while its claim is open.",
  pool: "Joins coalitions with partial amounts when one steward can't cover the top-up.",
  deep: "Bids only on comfortable margins, at a low premium, for the full amount.",
  swift: "Bids first, at a fixed spread.",
};
function stewardsPage(rec: Records, live: boolean) {
  const card = (s: StewardRow) => {
    const id = isSteward(s.name) ? s.name : null;
    return `<article class="st-panel st-list-steward">
      <div class="st-list-steward-head">${tile(s.name, 40)}<div><h2 class="st-list-steward-name">${esc(s.name)}</h2><span class="st-mono st-list-meta">${esc(s.account)}</span>${id ? `<span class="st-list-meta">Risk appetite: ${RISK_WORD[RISK[id]]}</span>` : ""}</div></div>
      ${id ? `<p class="st-list-steward-body">${STRATEGY[id]}</p>` : ""}
      <dl class="st-list-kv">
        <div><dt>BIDS</dt><dd class="st-num">${s.bids}</dd></div>
        <div><dt>WON</dt><dd class="st-num">${s.wins}</dd></div>
        <div><dt>OPEN</dt><dd class="st-num">${s.claimsOpen}</dd></div>
        <div><dt>EARNED</dt><dd class="st-num">${usd(s.premiumUsd)}</dd></div>
      </dl>
      <p class="st-list-meta">${s.lastWinAtMs ? `Last win ${when(s.lastWinAtMs)}` : "No win yet"} · on ${s.contracts.map(shortC).join(", ")}</p>
    </article>`;
  };
  return `<section class="st-panel st-sect st-list">
    ${head("STEWARDS", "Stewards", "Anyone can register a steward and bid; these five are example strategies running 24/7. Premiums are each rescue's premium at its trigger price, across the testnet contracts and the local fork.", live, rec.generated)}
    <div class="st-list-stewards">${rec.stewards.map(card).join("")}</div>
  </section>`;
}

function overviewPage(rec: Records, live: boolean, recorded: Recorded[]) {
  const real = byChain(rec.rescues, "real");
  const done = real.filter((r) => r.state === "bought_back" || r.state === "settled");
  const open = real.filter((r) => ["auction", "top_up_pending", "open", "settling"].includes(r.state));
  const pos = byChain(rec.positions, "real");
  const realRescue = new Set(real.map((r) => r.key));
  const claimsOpen = rec.claims.filter((c) => c.status === "open" && realRescue.has(`${c.contract}#${c.rescueId}`)).length;
  const premiums = done.reduce((a, r) => a + r.premiumUsd, 0);
  const topups = done.reduce((a, r) => a + r.topUpUsd, 0);
  return `<section class="st-panel st-sect st-list">
    ${head("OVERVIEW", "Overview", "Totals across the testnet contracts on Sepolia, from their own records. Local fork runs are listed on each page but not counted here.", live, rec.generated)}
    <dl class="st-kpis">
      <div><dt>POSITIONS</dt><dd><span class="st-num">${pos.length}</span></dd><dd class="st-kpi-sub">${pos.filter((p) => p.status === "in rescue").length} in a rescue now</dd></div>
      <div><dt>RESCUES</dt><dd><span class="st-num">${done.length}</span></dd><dd class="st-kpi-sub">${done.filter((r) => r.state === "bought_back").length} bought back · ${done.filter((r) => r.state === "settled").length} settled</dd></div>
      <div><dt>OPEN NOW</dt><dd><span class="st-num">${open.length}</span></dd><dd class="st-kpi-sub">${claimsOpen} claim${claimsOpen === 1 ? "" : "s"} open</dd></div>
      <div><dt>COLLATERAL TOPPED UP</dt><dd><span class="st-num">${usd(topups)}</span></dd><dd class="st-kpi-sub">at each trigger price</dd></div>
      <div><dt>PREMIUMS PAID</dt><dd><span class="st-num">${usd(premiums)}</span></dd><dd class="st-kpi-sub">${topups ? ((premiums / topups) * 100).toFixed(2) : "0"} % of the top-ups</dd></div>
    </dl>
  </section>
  ${rescuesPage({ ...rec, rescues: real.slice(0, 6) }, live, recorded, true)}`;
}

/** Filters: rows carry data-chain; the SEPOLIA button shows real chains (the default). */
function wire(root: HTMLElement) {
  for (const sect of root.querySelectorAll<HTMLElement>("[data-list]")) {
    const rows = [...sect.querySelectorAll<HTMLTableRowElement>("tbody tr[data-chain]")];
    // phones show each row as a card: every cell carries its column's name
    const cols = [...sect.querySelectorAll("thead th")].map((th) => th.textContent ?? "");
    for (const r of rows) [...r.cells].forEach((td, i) => cols[i] && (td.dataset.label = cols[i]));
    const draw = (chain: string) => {
      let shown = 0;
      for (const r of rows) shown += (r.hidden = !(chain === "all" || r.dataset.chain === chain)) ? 0 : 1;
      const empty = sect.querySelector<HTMLElement>("[data-list-empty]");
      if (empty) empty.hidden = shown > 0;
    };
    sect.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-chain]");
      if (!b) return;
      for (const x of sect.querySelectorAll<HTMLButtonElement>("button[data-chain]")) x.setAttribute("aria-pressed", String(x === b));
      draw(b.dataset.chain!);
    });
    draw(sect.querySelector("button[data-chain]") ? "real" : "all");
  }
}

export function mountList(root: HTMLElement, route: ListRoute, recorded: Recorded[]): () => void {
  let gone = false;
  root.innerHTML = `<section class="st-panel st-page" aria-busy="true"><div class="st-label">${route.toUpperCase()}</div><p class="st-empty">Reading the contracts…</p></section>`;
  loadRecords().then(
    ({ rec, live }) => {
      if (gone) return;
      root.innerHTML =
        route === "positions" ? positionsPage(rec, live) : route === "rescues" ? rescuesPage(rec, live, recorded) : route === "claims" ? claimsPage(rec, live) : route === "stewards" ? stewardsPage(rec, live) : overviewPage(rec, live, recorded);
      wire(root);
    },
    (e) => {
      if (!gone) root.innerHTML = `<section class="st-error" role="alert"><h2>Records not loaded</h2><p>Neither the live feed nor the site's snapshot answered (${esc(String((e as Error).message))}). Reload the page to try again.</p></section>`;
    },
  );
  return () => {
    gone = true;
  };
}

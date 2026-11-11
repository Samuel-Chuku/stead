// The list pages: Overview, Positions, Rescues, Claims, Stewards. Every row is the contracts' own
// record (stewards/src/records.ts), read live through the feed (re-read every 2 minutes), else the
// snapshot shipped with the site, and the page says which it shows and when it was read.
// Calm by design: each item is one line with a few essentials and opens for the rest; ten items a
// page; one dropdown for the chain.
import type { ClaimRow, PositionRow, Records, RescueRow, StewardRow } from "../../../stewards/src/records";
import type { StewardId } from "../../../stewards/src/rescuelog";
import { CODE, RISK, RISK_WORD, STEWARD_ORDER } from "../board/model";
import { crown } from "../crown";
import { icon } from "../icons";

export type ListRoute = "overview" | "positions" | "rescues" | "claims" | "stewards";
/** Rescues with a published recording (their own page with timeline, chart and proofs). */
export type Recorded = { id: string; contract: string; rescueId: number };
/** Items a page: ten on a desktop, six on a phone. */
export const PAGE_SIZE = 10;
export const PAGE_SIZE_PHONE = 6;
export const pageSize = () => (typeof matchMedia === "function" && matchMedia("(max-width: 620px)").matches ? PAGE_SIZE_PHONE : PAGE_SIZE);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (n: number | null) => (n === null ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
/** Amounts for reading: two decimals from 1 up, else up to 6 significant decimals. Exact values sit in the details. */
const amt = (v: string) => {
  const n = Number(v);
  return n >= 1 ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(Number(n.toPrecision(4)));
};
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const shortC = (c: string) => (c.startsWith("sepolia-demo") ? "sepolia-demo" : c.split(".")[0]);
const isSteward = (s: string): s is StewardId => (STEWARD_ORDER as string[]).includes(s);
const tile = (s: string, size = 22) => (isSteward(s) ? `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s]}</span>` : "");

/** A state as a dot and a word (amber only while money is exposed). */
const STATE: Record<string, [string, "open" | "done" | "bad" | "quiet"]> = {
  auction: ["Auction", "open"],
  top_up_pending: ["Top-up", "open"],
  open: ["Claim open", "open"],
  settling: ["Settling", "open"],
  bought_back: ["Bought back", "done"],
  settled: ["Settled", "done"],
  failed: ["Failed", "bad"],
  "in rescue": ["In rescue", "open"],
  "below trigger": ["Below trigger", "open"],
  protected: ["Protected", "done"],
  "no reading": ["No reading yet", "quiet"],
  empty: ["Empty", "quiet"],
  "window ended": ["Window ended", "open"],
};
export const state = (s: string) => {
  const [t, k] = STATE[s] ?? [s, "quiet"];
  return `<span class="st-state st-state--${k}"><span class="st-state-dot" aria-hidden="true"></span>${t}</span>`;
};

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
/** One page of rows (0-based), and how many pages there are. */
export function pageOf<T>(rows: T[], page: number, size = PAGE_SIZE): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: rows.slice(p * size, p * size + size), page: p, pages };
}

// ── page parts ──

export function head(label: string, title: string, sub: string, live: boolean, generated: string) {
  return `<header class="st-list-head">
      <div class="st-label">${label}</div>
      <h1 class="st-page-title">${title}</h1>
      <p class="st-list-sub">${sub}</p>
      <p class="st-list-src">${live ? `<span class="st-live-dot" aria-hidden="true"></span>Read from the contracts at ${when(Date.parse(generated))}` : `Snapshot of the contracts from ${when(Date.parse(generated))}`}</p>
    </header>`;
}
const chainSelect = (c: Record<"real" | "fork" | "all", number>) =>
  c.fork
    ? `<label class="st-select"><span class="st-select-label">Chain</span><select data-chain-select>
        <option value="real">Sepolia (${c.real})</option><option value="fork">Local fork, unverified (${c.fork})</option><option value="all">All (${c.all})</option>
      </select></label>`
    : "";
const counts = (rows: { chain: string }[]) => ({ real: byChain(rows, "real").length, fork: byChain(rows, "fork").length, all: rows.length });
/** One item: a summary line of cells that opens to a details list. */
/** `group` is what the page's dropdown filters on ("real" / "fork" by default, from the chain). */
/** `href`: clicking the row opens this page (the caret still opens the details). */
export type Item = { chain: string; group?: string; cells: string[]; details: [string, string][]; href?: string };
const itemHtml = (it: Item) => `
    <li data-chain="${it.group ?? (it.chain === "local fork" ? "fork" : "real")}"${it.href ? ` data-href="${it.href}"` : ""}><details class="st-item">
      <summary>${it.cells.map((c) => `<span class="st-item-cell">${c}</span>`).join("")}<span class="st-item-caret" aria-hidden="true"></span></summary>
      <dl class="st-item-details">${it.details.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
    </details></li>`;
export const list = (cls: string, cols: string[], items: Item[], empty: string, paged = true) => `
    <div class="st-items-head ${cls}" aria-hidden="true">${cols.map((c) => `<span>${c}</span>`).join("")}<span></span></div>
    <ul class="st-items ${cls}" data-items>${items.map(itemHtml).join("")}</ul>
    <p class="st-empty" data-items-empty hidden>${empty}</p>
    ${paged ? `<div class="st-pager" data-pager><button type="button" class="st-secondary st-cut" data-page="prev">Previous</button><span class="st-pager-pos" data-page-pos></span><button type="button" class="st-secondary st-cut" data-page="next">Next</button></div>` : ""}`;

// ── positions ──

function hfShort(p: PositionRow) {
  if (p.hf === null) return `<span class="st-quiet">—</span>`;
  return `<span class="st-num st-item-big${p.hf < 1.15 ? " is-below" : ""}">${p.hf.toFixed(2)}</span>`;
}
const markOf = (p: PositionRow) => (p.chain === "local fork" ? "reported, local fork (unverified)" : p.hfSource === "verified" ? "proven (OutLayer)" : `reported by ${esc(p.hfSource ?? "")}`);
const positionItem = (p: PositionRow): Item => ({
  chain: p.chain,
  cells: [`<span class="st-num">#${p.id}</span>`, `<span class="st-item-main">${esc(p.pair)}</span><span class="st-item-sub">${esc(p.owner)}</span>`, hfShort(p), state(p.status)],
  details: [
    ["Health factor", p.hf === null ? (p.status === "no reading" ? "no reading yet" : "no debt at the last reading") : `${p.hf.toFixed(4)}, ${markOf(p)}`],
    ["Last reading", p.hfBlock ? `block ${p.hfBlock.toLocaleString("en-US")}${p.hfAtMs ? `, ${when(p.hfAtMs)}` : ""}` : "—"],
    ["Collateral", usd(p.collateralUsd)],
    ["Debt", usd(p.debtUsd)],
    ["Chain", esc(p.chain)],
    ["Contract", `<span class="st-mono">${esc(p.contract)}</span>`],
    ...(p.openRescues.length ? ([["Open rescue", p.openRescues.map((r) => `#${r}`).join(", ") + ` · <a class="st-textlink" href="#/live">Watch live</a>`]] as [string, string][]) : []),
  ],
});
function positionsPage(rec: Records, live: boolean) {
  return `<section class="st-panel st-sect st-list" data-list>
    ${head("POSITIONS", "Protected positions", "Every position registered with a Stead contract and its last health reading. An auction opens when a proven reading falls below 1.15.", live, rec.generated)}
    <div class="st-list-tools">${chainSelect(counts(rec.positions))}</div>
    ${list("st-items--positions", ["POSITION", "MARKET", "HEALTH", "STATUS"], rec.positions.map(positionItem), "No position on this chain.")}
  </section>`;
}

// ── rescues ──

/** The two lowest premiums as tiles, then "+N more": the rest is one click away. */
export function winnersShort(winners: RescueRow["winners"], range: string): string {
  const byBps = [...winners].sort((a, b) => a.bps - b.bps);
  const more = byBps.length - 2;
  return `<span class="st-item-tiles">${byBps.slice(0, 2).map((w) => `<span title="${esc(w.steward)}, ${w.bps} bps">${tile(w.steward)}</span>`).join("")}${more > 0 ? `<span class="st-item-more">+${more} more</span>` : ""}</span><span class="st-item-sub">${range}</span>`;
}
const pageHref = (contract: string, id: number) => `?rescue=${contract === "steadfi.testnet" ? "steadfi" : contract.split(".")[0]}:${id}#/rescues`;
const ext = (url: string | undefined, label: string) => (url ? `<a class="st-textlink st-extlink" href="${url}" target="_blank" rel="noopener">${label}${icon("external", 12)}</a>` : "");
function rescueItem(r: RescueRow, recorded: Recorded[]): Item {
  const page = r.recorded || recorded.some((x) => x.contract === r.contract && x.rescueId === r.id) ? pageHref(r.contract, r.id) : null;
  const open = ["auction", "top_up_pending", "open", "settling"].includes(r.state);
  const bps = r.winners.map((w) => w.bps);
  const range = bps.length ? (Math.min(...bps) === Math.max(...bps) ? `${bps[0]} bps` : `${Math.min(...bps)}–${Math.max(...bps)} bps`) : r.state === "auction" ? "bidding" : "no winner";
  return {
    chain: r.chain,
    href: page ?? undefined,
    cells: [
      `<span class="st-num">#${r.id}</span><span class="st-item-sub">${day(r.openedAtMs)}</span>`,
      `<span class="st-item-main">${amt(r.topUp)} ${esc(r.asset)}</span><span class="st-item-sub">${usd(r.topUpUsd)}</span>`,
      winnersShort(r.winners, range),
      state(r.state),
    ],
    details: [
      ["Opened", when(r.openedAtMs)],
      ["Position", `#${r.positionId} · ${esc(r.pair)} on ${esc(r.chain)}${r.chain === "local fork" ? " (unverified)" : ""}`],
      ["Top-up", `${r.topUp} ${esc(r.asset)}, ${usd(r.topUpUsd)} at the trigger price`],
      ["Bids", `${r.bids} · premium cap ${r.capBps.toLocaleString("en-US")} bps (below Aave's liquidation penalty)`],
      ["Winners", r.winners.length ? [...r.winners].sort((a, b) => a.bps - b.bps).map((w) => `<span class="st-item-winner">${tile(w.steward)} ${esc(w.steward)} ${crown(w.steward, [["Premium", `${w.bps} bps`], ["Share", `${amt(w.share)} ${esc(r.asset)}`]], 13)}</span>`).join("") : "—"],
      ["Premiums", usd(r.premiumUsd)],
      ["Contract", `<span class="st-mono">${esc(r.contract)}</span>`],
      ...(page ? ([["The whole story", `<a class="st-textlink" href="${page}">Open rescue #${r.id}</a>: every step from the trigger to the end, each linked to its transaction`]] as [string, string][]) : open ? ([["Live", `<a class="st-textlink" href="#/live">Watch it on the live board</a>`]] as [string, string][]) : ([["The whole story", "being recorded from the chains; it appears a few minutes after the rescue ends"]] as [string, string][])),
      ...(r.triggerUrl ? ([["Trigger", ext(r.triggerUrl, "The reading that opened the auction, on NearBlocks")]] as [string, string][]) : []),
    ],
  };
}
function rescuesPage(rec: Records, live: boolean, recorded: Recorded[]) {
  return `<section class="st-panel st-sect st-list" data-list>
    ${head("RESCUES", "Every rescue", "Each auction a Stead contract opened, newest first. Open one for its winners, premiums and links; recorded rescues have their own page.", live, rec.generated)}
    <div class="st-list-tools">${chainSelect(counts(rec.rescues))}</div>
    ${list("st-items--rescues", ["RESCUE", "TOP-UP", "WINNERS", "STATE"], rec.rescues.map((r) => rescueItem(r, recorded)), "No rescue on this chain.")}
  </section>`;
}

// ── claims ──

function claimsPage(rec: Records, live: boolean) {
  const chainOf = (c: ClaimRow) => rec.rescues.find((r) => r.contract === c.contract && r.id === c.rescueId)?.chain ?? "Sepolia";
  const items = rec.claims.map((c): Item => {
    const st = c.status === "open" ? (c.expiresAtMs > Date.now() ? "open" : "window ended") : c.status;
    return {
      chain: chainOf(c),
      cells: [
        `<span class="st-item-main st-mono">${esc(c.token)}</span><span class="st-item-sub">rescue #${c.rescueId}</span>`,
        `<span class="st-item-who">${tile(c.owner)}${esc(c.owner)}</span>`,
        `<span class="st-item-main">${amt(c.owed)} ${esc(c.asset)}</span><span class="st-item-sub">${c.bps} bps</span>`,
        state(st),
      ],
      details: [
        ["Owed", `${c.owed} ${esc(c.asset)}: ${c.share} supplied + ${c.premium} premium`],
        ["Premium", `${c.bps} bps`],
        ["Buy-back window", c.status === "open" ? `until ${when(c.expiresAtMs)}` : `ended ${when(c.expiresAtMs)}`],
        ["Rescue", `<a class="st-textlink" href="${pageHref(c.contract, c.rescueId)}">Rescue #${c.rescueId}</a> on position ${c.positionId}`],
        ...(c.topupUrl || c.mintUrl || c.paidUrl
          ? ([["On chain", [ext(c.topupUrl, "Top-up on Etherscan"), ext(c.mintUrl, "Minted on NearBlocks"), ext(c.paidUrl, "Payout signed on NearBlocks"), ext(c.paidTransferUrl, "Payout transfer on Etherscan")].filter(Boolean).join("<br>")]] as [string, string][])
          : []),
        ["Contract", `<span class="st-mono">${esc(c.contract)}</span>`],
      ],
    };
  });
  return `<section class="st-panel st-sect st-list" data-list>
    ${head("CLAIMS", "Claims", "Each winning steward gets a claim (NEP-171), owed in units of the asset it supplied. The borrower buys it back within the window, or it settles at the oracle price.", live, rec.generated)}
    <div class="st-list-tools">${chainSelect(counts(items))}</div>
    ${list("st-items--claims", ["CLAIM", "HOLDER", "OWED", "STATUS"], items, "No claim on this chain.")}
  </section>`;
}

// ── stewards ──

const STRATEGY: Record<StewardId, string> = {
  patient: "Bids late and prices thin margins higher.",
  hedged: "Hedges the asset it supplies on a perpetuals venue while its claim is open.",
  pool: "Joins coalitions with partial amounts when one steward can't cover the top-up.",
  deep: "Bids only on comfortable margins, at a low premium, for the full amount.",
  swift: "Bids first, at a fixed spread.",
};
function stewardsPage(rec: Records, live: boolean) {
  const items = rec.stewards.map((s: StewardRow): Item => {
    const id = isSteward(s.name) ? s.name : null;
    return {
      chain: "Sepolia",
      cells: [
        `<span class="st-item-who">${tile(s.name, 28)}<span><span class="st-item-main">${esc(s.name)}</span><span class="st-item-sub">${id ? `risk appetite ${RISK_WORD[RISK[id]]}` : "registered steward"}</span></span></span>`,
        `<span class="st-item-main">${s.wins} won</span><span class="st-item-sub">of ${s.bids} bids</span>`,
        `<span class="st-item-main">${usd(s.premiumUsd)}</span><span class="st-item-sub">premiums earned</span>`,
      ],
      details: [
        ...(id ? ([["Strategy", STRATEGY[id]]] as [string, string][]) : []),
        ["Claims", `${s.claimsOpen} open, ${s.claimsTotal} in all`],
        ["Last win", s.lastWinAtMs ? when(s.lastWinAtMs) : "none yet"],
        ["Account", `<span class="st-mono">${esc(s.account)}</span>`],
        ["Contracts", s.contracts.map((c) => `<span class="st-mono">${esc(c)}</span>`).join(", ")],
      ],
    };
  });
  return `<section class="st-panel st-sect st-list" data-list>
    ${head("STEWARDS", "Stewards", "Anyone can register a steward and bid. These five are example strategies running around the clock; open one for its strategy and record.", live, rec.generated)}
    ${list("st-items--stewards", ["STEWARD", "WON", "EARNED"], items, "No steward registered.", false)}
  </section>`;
}

// ── overview ──

function overviewPage(rec: Records, live: boolean, recorded: Recorded[]) {
  const real = byChain(rec.rescues, "real");
  const done = real.filter((r) => r.state === "bought_back" || r.state === "settled");
  const open = real.filter((r) => ["auction", "top_up_pending", "open", "settling"].includes(r.state));
  const pos = byChain(rec.positions, "real");
  const premiums = done.reduce((a, r) => a + r.premiumUsd, 0);
  const topups = done.reduce((a, r) => a + r.topUpUsd, 0);
  return `<section class="st-panel st-sect st-list">
    ${head("OVERVIEW", "Overview", "The testnet contracts on Sepolia, from their own records.", live, rec.generated)}
    <dl class="st-kpis">
      <div><dt>POSITIONS</dt><dd><span class="st-num">${pos.length}</span></dd><dd class="st-kpi-sub">${open.length ? `${open.length} in a rescue now` : "all above the trigger"}</dd></div>
      <div><dt>RESCUES</dt><dd><span class="st-num">${done.length}</span></dd><dd class="st-kpi-sub">${done.filter((r) => r.state === "bought_back").length} bought back, ${done.filter((r) => r.state === "settled").length} settled</dd></div>
      <div><dt>TOPPED UP</dt><dd><span class="st-num">${usd(Math.round(topups)).replace(/\.00$/, "")}</span></dd><dd class="st-kpi-sub">collateral, at trigger prices</dd></div>
      <div><dt>PREMIUMS</dt><dd><span class="st-num">${topups ? ((premiums / topups) * 100).toFixed(2) : "0"}%</span></dd><dd class="st-kpi-sub">of the top-ups, ${usd(premiums)}</dd></div>
    </dl>
  </section>
  <section class="st-panel st-sect st-list" data-list>
    <div class="st-sect-head"><div><div class="st-label">LATEST RESCUES</div><h2 class="st-panel-title">On Sepolia, newest first</h2></div><a class="st-textlink" href="#/rescues">Every rescue</a></div>
    ${list("st-items--rescues", ["RESCUE", "TOP-UP", "WINNERS", "STATE"], real.slice(0, 5).map((r) => rescueItem(r, recorded)), "No rescue yet.", false)}
  </section>`;
}

/** The chain dropdown and the pager: ten visible items at a time. */
export function wire(root: HTMLElement, signal: AbortSignal) {
  // a row with a page opens it; its caret opens the details; opening one item closes the others
  root.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const summary = t.closest("summary");
    const li = summary?.closest<HTMLLIElement>("li[data-href]");
    if (!summary || !li || t.closest("a, button")) return;
    // the caret's end of the row (the last 56 px) opens the details instead
    if ((e as MouseEvent).clientX > summary.getBoundingClientRect().right - 56) return;
    e.preventDefault();
    location.href = li.dataset.href!;
  }, { signal });
  root.addEventListener("toggle", (e) => {
    const d = e.target as HTMLDetailsElement;
    if (!d.matches?.("details.st-item") || !d.open) return;
    for (const o of root.querySelectorAll<HTMLDetailsElement>("details.st-item[open]")) if (o !== d) o.open = false;
  }, { capture: true, signal });
  for (const sect of root.querySelectorAll<HTMLElement>("[data-list]")) {
    const items = [...sect.querySelectorAll<HTMLLIElement>("[data-items] > li")];
    const select = sect.querySelector<HTMLSelectElement>("[data-chain-select]");
    const pager = sect.querySelector<HTMLElement>("[data-pager]");
    let page = 0;
    const draw = () => {
      const chain = select?.value ?? "all";
      const match = items.filter((li) => chain === "all" || li.dataset.chain === chain);
      const size = pageSize();
      const p = pager ? pageOf(match, page, size) : { rows: match, page: 0, pages: 1 };
      page = p.page;
      const shown = new Set(p.rows);
      for (const li of items) li.hidden = !shown.has(li);
      sect.querySelector<HTMLElement>("[data-items-empty]")!.hidden = match.length > 0;
      if (pager) {
        pager.hidden = p.pages <= 1;
        sect.querySelector("[data-page-pos]")!.textContent = `${page * size + 1}–${page * size + p.rows.length} of ${match.length}`;
        sect.querySelector<HTMLButtonElement>('[data-page="prev"]')!.disabled = page === 0;
        sect.querySelector<HTMLButtonElement>('[data-page="next"]')!.disabled = page >= p.pages - 1;
      }
    };
    select?.addEventListener("change", () => {
      page = 0;
      draw();
    });
    pager?.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-page]");
      if (!b) return;
      page += b.dataset.page === "next" ? 1 : -1;
      draw();
      sect.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    // crossing the phone width changes the page size: start again from the first page
    matchMedia("(max-width: 620px)").addEventListener("change", () => {
      page = 0;
      draw();
    }, { signal });
    draw();
  }
}

export function mountList(root: HTMLElement, route: ListRoute, recorded: Recorded[]): () => void {
  let gone = false;
  const stop = new AbortController();
  root.innerHTML = `<section class="st-panel st-page" aria-busy="true"><div class="st-label">${route.toUpperCase()}</div><p class="st-empty">Reading the contracts…</p></section>`;
  loadRecords().then(
    ({ rec, live }) => {
      if (gone) return;
      root.innerHTML =
        route === "positions" ? positionsPage(rec, live) : route === "rescues" ? rescuesPage(rec, live, recorded) : route === "claims" ? claimsPage(rec, live) : route === "stewards" ? stewardsPage(rec, live) : overviewPage(rec, live, recorded);
      wire(root, stop.signal);
    },
    (e) => {
      if (!gone) root.innerHTML = `<section class="st-error" role="alert"><h2>Records not loaded</h2><p>Neither the live feed nor the site's snapshot answered (${esc(String((e as Error).message))}). Reload the page to try again.</p></section>`;
    },
  );
  return () => {
    gone = true;
    stop.abort();
  };
}

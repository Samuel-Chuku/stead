// "Live on mainnet": the rescues with real funds. The list is read straight from the contract
// (chainlist.ts); when the site also has the evidence harness's checked trails
// (stewards/scripts/evidence.ts writes /mainnet-runs.json from evidence/mainnet/, real runs only),
// each recorded run follows the list, every transaction re-checked on chain.
import type { WebRuns } from "../../../stewards/src/trailcheck";
import type { Move, RescueView, StewardView } from "../../../stewards/src/stewardview";
import { icon } from "../icons";
import { CODE } from "../board/model";

type Run = WebRuns["runs"][number];
type Entry = Run["entries"][number];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const when = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const hms = (iso: string) => new Date(iso).toISOString().slice(11, 19);
// the trails write arrows; the site uses words (no emoji-prone glyphs)
const plainStep = (s: string) => s.replace(/^\d+[a-z]?:\s*/, "").replace(/\s*→\s*/g, ", ");
const plainWhat = (s: string) => s.replace(/\s*→\s*/g, " to ");
const chainName: Record<string, string> = { ethereum: "Ethereum", "near-mainnet": "NEAR", "near-testnet": "NEAR testnet", sepolia: "Sepolia", "ethereum-copy": "local copy" };
const ext = (href: string, label: string) => `<a class="st-textlink st-extlink" href="${href}" target="_blank" rel="noopener">${label}${icon("external", 13)}</a>`;

export async function loadRuns(): Promise<WebRuns | null> {
  try {
    // development only: `?runs=<file>.json` reads another file from the dev server (a local preview)
    const dev = (import.meta as any).env?.DEV ? new URLSearchParams(location.search).get("runs") : null;
    const r = await fetch(dev && /^[\w.-]+\.json$/.test(dev) ? `/${dev}` : "/mainnet-runs.json", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    const j = (await r.json()) as WebRuns;
    return j.runs?.length ? j : null;
  } catch {
    return null;
  }
}

function entryRow(e: Entry, showAll: boolean): string {
  const mark = e.confirmed ? `<span class="st-evidence st-evidence--proven"><span class="st-evidence-mark" aria-hidden="true"></span>${e.ok ? "ON CHAIN" : "REFUSED, AS RECORDED"}</span>` : `<span class="st-evidence st-evidence--unverified">NOT CONFIRMED</span>`;
  const link = e.link ? ext(e.link, chainName[e.chain] ?? e.chain) : `<span class="st-quiet">${esc(chainName[e.chain] ?? e.chain)}</span>`;
  return `<tr${e.key || showAll ? "" : ' class="is-minor" hidden'}><td class="st-mono">${hms(e.at)}</td><td>${esc(e.actor)}</td><td>${esc(plainWhat(e.what))}</td><td>${link}</td><td>${mark}</td></tr>`;
}

function runSection(r: Run, i: number): string {
  // the trail is in chain order and steps interleave (a keeper's reading lands mid-step): group by
  // step, in the order the steps are numbered, each step's entries by time
  const by = new Map<string, Entry[]>();
  for (const e of r.entries) by.set(e.step, [...(by.get(e.step) ?? []), e]);
  const steps = [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([step, entries]) => ({ step, entries: entries.sort((x, y) => x.at.localeCompare(y.at)) }));
  const all = r.confirmed === r.total;
  const state = r.state.checked ? (r.state.matches ? "matches the recording" : "differs from the recording") : "not compared";
  return `
  <section class="st-panel st-sect st-mn-runs" data-run="${i}">
    <div class="st-sect-head">
      <div>
        <div class="st-label">${esc(r.label.toUpperCase())}</div>
        <h2 class="st-panel-title">${esc(r.title)}</h2>
        <p class="st-list-src">${when(r.started)}${r.finished ? ` to ${when(r.finished)}` : ""} · contract ${ext(r.contractLink, `<span class="st-mono">${esc(r.contract)}</span>`)}</p>
      </div>
      <span class="st-chip${all ? " st-chip--rescued" : ""}">${r.confirmed}/${r.total} CONFIRMED</span>
    </div>
    <dl class="st-kpis">
      <div><dt>TRANSACTIONS</dt><dd><span class="st-num">${r.total}</span></dd><dd class="st-kpi-sub">${r.confirmed} re-checked on chain${all ? ", all" : ""}</dd></div>
      <div><dt>KEY STEPS</dt><dd><span class="st-num">${r.entries.filter((e) => e.key).length}</span></dd><dd class="st-kpi-sub">the rest is the keeper's bookkeeping</dd></div>
      <div><dt>CONTRACT STATE</dt><dd class="st-kpi-word">${state}</dd><dd class="st-kpi-sub">positions, rescues, claims read again</dd></div>
    </dl>
    ${movesRow(r, i)}
    ${r.outcome ? `<ul class="st-mn-outcome">${r.outcome.split("\n").filter(Boolean).map((l) => `<li>${esc(plainWhat(l))}</li>`).join("")}</ul>` : ""}
    <div class="st-faq st-mn-steps">
      ${steps
        .map(
          (s) => {
            const keys = s.entries.filter((e) => e.key).length;
            const showAll = keys === 0; // only bookkeeping in this step: show it
            const n = s.entries.length;
            return `<details class="st-faq-item"><summary><span>${esc(plainStep(s.step))}</span><span class="st-mn-count">${n} transaction${n === 1 ? "" : "s"}${keys && keys < n ? `, ${keys} key` : ""}</span><span class="st-item-caret" aria-hidden="true"></span></summary>
        <div class="st-table-wrap"><table class="st-proofs st-values-table st-mn-table"><thead><tr><th>TIME</th><th>WHO</th><th>WHAT</th><th>WHERE</th><th>CHECK</th></tr></thead><tbody>${s.entries.map((e) => entryRow(e, showAll)).join("")}</tbody></table></div>
        ${!showAll && keys < n ? `<button class="st-secondary st-cut" type="button" data-minor>Show all ${n}</button>` : ""}
      </details>`;
          },
        )
        .join("")}
    </div>
  </section>`;
}

// ── the steward's view: one winning steward's own moves, in order ──

const tile = (s: string, size = 22) => (s in CODE ? `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s as keyof typeof CODE]}</span>` : "");
const possessive = (s: string) => `${s}'s`;
const amt = (v: string) => (/\.\d{7,}$/.test(v) ? Number(v).toFixed(6).replace(/0+$/, "") : v);
// the trail keeps full precision; a sentence reads 6 decimals, and starts with a capital
const sentence = (t: string) => t.replace(/\b\d+\.\d{7,}\b/g, amt).replace(/^./, (c) => c.toUpperCase());
const shortTx = (tx: string) => (tx.length > 16 ? `${tx.slice(0, 6)}…${tx.slice(-4)}` : tx);
/** A duration: the numbers in the number face, the units as words. */
function dur(sec: number): string {
  const n = (v: number) => `<span class="st-sv-n">${v}</span>`;
  const u = (w: string) => `<span class="st-sv-u">${w}</span>`;
  if (sec < 60) return `${n(sec)}${u("s")}`;
  const m = Math.floor(sec / 60), r = sec % 60;
  return `${n(m)}${u("min")}${r ? `${n(r)}${u("s")}` : ""}`;
}
const capitalWord: Record<NonNullable<StewardView["capital"]>, string> = { own: "Own WETH", intents: "NEAR Intents · 1Click", "intents-fallback": "Own WETH, after NEAR Intents" };
const outcomeWord: Record<StewardView["outcome"], string> = { "bought back": "Bought back, paid out", settled: "Settled at the oracle price", open: "Claim open" };

function movesRow(r: Run, i: number): string {
  const rescues = r.rescues ?? [];
  if (!rescues.length) return "";
  return `<div class="st-sv-launch">${rescues
    .map(
      (x, j) => `<div class="st-sv-launch-row"><span class="st-label">RESCUE ${esc(x.rescue)}${x.position ? ` · ${esc(x.position.toUpperCase())}` : ""} · ${x.pooled ? `POOLED, ${x.stewards.length} STEWARDS` : "ONE STEWARD"}</span>
      <span class="st-sv-launch-btns">${x.stewards.map((v, k) => `<button type="button" class="st-secondary st-cut st-sv-open" data-sv="${i}.${j}.${k}" aria-haspopup="dialog">${tile(v.steward)}<span>${esc(possessive(v.steward))} moves</span></button>`).join("")}</span></div>`,
    )
    .join("")}</div>`;
}

function evidence(m: Move): string {
  if (!m.tx) return `<span class="st-sv-off">${esc(m.note ?? "off chain")}</span>`;
  if (m.kind === "reported") return `<span class="st-evidence st-evidence--reported"><span class="st-evidence-mark" aria-hidden="true"></span>REPORTED · KEEPER</span>`;
  if (!m.confirmed) return `<span class="st-evidence st-evidence--unverified">NOT CONFIRMED</span>`;
  return `<span class="st-evidence st-evidence--proven"><span class="st-evidence-mark" aria-hidden="true"></span>${m.ok === false ? "REFUSED, AS RECORDED" : "ON CHAIN"}</span>`;
}
function where(m: Move): string {
  if (!m.tx && m.link) return ext(m.link, "Etherscan"); // a step the contract records without a transaction: where to see it
  if (!m.tx || !m.chain) return "";
  const hash = `<span class="st-mono">${esc(shortTx(m.tx))}</span>`;
  const name = chainName[m.chain] ?? m.chain;
  return m.link ? ext(m.link, `${esc(name)} ${hash}`) : `<span class="st-sv-where">${esc(name)} ${hash}</span>`;
}
function actorTag(m: Move, steward: string): string {
  if (m.actor === "borrower") return `<span class="st-sv-by st-sv-by--other">by the borrower</span>`;
  if (m.actor === steward) return `<span class="st-sv-by">${tile(steward)}<span>${esc(steward)}</span></span>`;
  const who = m.actor === "contract" ? "the contract" : m.actor.replace(/^keeper \(temporary reporter\)$/, "keeper, temporary reporter");
  return `<span class="st-sv-by st-sv-by--other">by ${esc(who)}</span>`;
}
function moveItem(m: Move, steward: string): string {
  const fig = m.figure ? `<span class="st-sv-fig"><span class="st-sv-n">${esc(amt(m.figure.value))}</span><span class="st-sv-u">${esc(m.figure.unit)}</span></span>` : "";
  return `<li class="st-sv-move${m.ok === false ? " is-refused" : ""}${m.tx ? "" : " is-off"}">
    <span class="st-sv-dot" aria-hidden="true"></span>
    <div class="st-sv-time">${m.at ? `${hms(m.at)} UTC` : m.after ? `<span class="st-sv-after">after ${hms(m.after)}</span>` : ""}</div>
    <div class="st-sv-body">
      <div class="st-sv-head"><h4>${esc(m.title)}</h4>${fig}</div>
      <p>${esc(sentence(m.detail))}</p>
      <div class="st-sv-meta">${actorTag(m, steward)}${where(m)}${evidence(m)}</div>
    </div>
  </li>`;
}
/** The gap between two timed moves, on the line between them. */
function gap(a: Move | undefined, b: Move): string {
  if (!a?.at || !b.at || (a.tx && a.tx === b.tx)) return ""; // the claim is minted in the check's own transaction
  const s = Math.max(0, Math.round((Date.parse(b.at) - Date.parse(a.at)) / 1000));
  return `<li class="st-sv-gap" aria-label="${s} seconds later"><span aria-hidden="true">+${dur(s)}</span></li>`;
}

/** A whole rescue's steps as one timeline (the steward's view's styling): each step's actor, its
 *  time or the time it follows, its figure and where to see it. */
export function flowSeq(moves: Move[]): string {
  let html = "";
  let prev: Move | undefined;
  for (const m of moves) {
    html += gap(prev, m) + moveItem(m, m.actor in CODE ? m.actor : "");
    if (m.at) prev = m;
  }
  return `<ol class="st-sv-seq">${html}</ol>`;
}

export function stewardPanel(v: StewardView, x: RescueView): string {
  const timed = v.moves.filter((m) => m.at);
  const span = timed.length > 1 ? Math.round((Date.parse(timed[timed.length - 1].at!) - Date.parse(timed[0].at!)) / 1000) : 0;
  const claim = v.moves.find((m) => m.kind === "claim");
  const toClaim = claim?.at && v.moves[0].at ? Math.round((Date.parse(claim.at) - Date.parse(v.moves[0].at!)) / 1000) : undefined;
  // the sequence: timed moves in order; the Intents leg grouped under its own heading
  let html = "";
  let prev: Move | undefined;
  let k = 0;
  while (k < v.moves.length) {
    const m = v.moves[k];
    if (m.intents && m.kind !== "wrap") {
      const leg: Move[] = [];
      while (k < v.moves.length && v.moves[k].intents && v.moves[k].kind !== "wrap") leg.push(v.moves[k++]);
      let inner = "";
      for (const l of leg) {
        inner += gap(prev, l) + moveItem(l, v.steward);
        if (l.at) prev = l;
      }
      html += `<li class="st-sv-leg"><div class="st-sv-leg-head"><span class="st-label">CAPITAL · NEAR INTENTS · 1CLICK</span>${v.intentsSeconds !== undefined ? `<span class="st-sv-leg-time">USDC on NEAR to ETH on Ethereum in ${dur(v.intentsSeconds)}</span>` : ""}</div><ol class="st-sv-seq st-sv-seq--leg">${inner}</ol></li>`;
      continue;
    }
    html += gap(prev, m) + moveItem(m, v.steward);
    if (m.at) prev = m;
    k++;
  }
  return `
    <dl class="st-kpis st-sv-kpis">
      <div><dt>PREMIUM</dt><dd><span class="st-num">${v.premiumBps}</span> <span class="st-sv-u">bps</span></dd><dd class="st-kpi-sub">${x.pooled ? "its own bid, pooled" : "lowest bid"}</dd></div>
      ${v.share ? `<div><dt>TOPPED UP</dt><dd><span class="st-num">${esc(amt(v.share.amount))}</span> <span class="st-sv-u">${esc(v.share.asset)}</span></dd><dd class="st-kpi-sub">to ${esc(x.position ?? "the position")}</dd></div>` : ""}
      ${v.capital ? `<div><dt>CAPITAL</dt><dd class="st-kpi-word">${capitalWord[v.capital]}</dd><dd class="st-kpi-sub">${v.intentsSeconds !== undefined ? `delivered in ${v.intentsSeconds} s` : v.capital === "own" ? "already in its wallet" : "no delivery in time"}</dd></div>` : ""}
      ${toClaim !== undefined ? `<div><dt>BID TO CLAIM</dt><dd class="st-sv-kpi-dur">${dur(toClaim)}</dd><dd class="st-kpi-sub">${esc(outcomeWord[v.outcome])}${span ? `, ${Math.round(span / 60)} min in all` : ""}</dd></div>` : ""}
    </dl>
    <ol class="st-sv-seq">${html}</ol>`;
}

let current: WebRuns | null = null;

const RUN_NOTE = "Read from the run's recorded transactions, each re-checked on chain. Times are when each transaction was sent (NEAR) or its block's time (Ethereum); the NEAR Intents delivery is when it was seen.";
/** The steward's view dialog (empty; `showSteward` fills it). `note` is the line under the moves;
 *  `o.id` names a second dialog of the same look on one page (its title is `#<id>-title`). */
export function dialogHtml(note = RUN_NOTE, o: { id?: string; close?: string } = {}): string {
  const id = o.id ?? "st-sv";
  return `<dialog class="st-sv-dialog" data-dlg="${id}" aria-labelledby="${id}-title">
    <div class="st-sv-top">
      <div><div class="st-label" data-sv-label></div><h2 class="st-panel-title st-sv-title" id="${id}-title"></h2></div>
      <button type="button" class="st-icon-btn" data-sv-close aria-label="${esc(o.close ?? "Close the steward's view")}">${icon("close", 16)}</button>
    </div>
    <div class="st-sv-tabs" role="tablist" aria-label="Winning stewards" hidden></div>
    <div class="st-sv-panel" role="tabpanel" id="${id}-panel" tabindex="-1"></div>
    <p class="st-list-note st-sv-note">${esc(note)}</p>
  </dialog>`;
}

/** The recorded runs, when the site has them (none: the contract's list stands alone). */
export function runsHtml(data: WebRuns | null): string {
  current = data;
  if (!data) return "";
  return data.runs.map(runSection).join("") + (data.runs.some((r) => r.rescues?.length) ? dialogHtml() : "");
}

export function showSteward(dlg: HTMLDialogElement, x: RescueView, k: number, focusTab = false) {
  const v = x.stewards[k];
  dlg.querySelector("[data-sv-label]")!.textContent = `STEWARD'S VIEW · RESCUE ${x.rescue}${x.pooled ? " · POOLED" : ""}`;
  dlg.querySelector(".st-sv-title")!.innerHTML = `${tile(v.steward, 32)}<span>${esc(possessive(v.steward))} moves</span>`;
  const tabs = dlg.querySelector<HTMLElement>(".st-sv-tabs")!;
  tabs.hidden = !x.pooled;
  tabs.innerHTML = x.pooled
    ? x.stewards.map((s, i) => `<button type="button" role="tab" id="st-sv-tab-${i}" aria-controls="st-sv-panel" aria-selected="${i === k}" tabindex="${i === k ? 0 : -1}" data-sv-tab="${i}">${tile(s.steward)}<span>${esc(s.steward)}</span><span class="st-sv-tab-sub">${s.premiumBps} bps</span></button>`).join("")
    : "";
  const panel = dlg.querySelector<HTMLElement>(".st-sv-panel")!;
  if (x.pooled) panel.setAttribute("aria-labelledby", `st-sv-tab-${k}`);
  else panel.removeAttribute("aria-labelledby");
  panel.innerHTML = stewardPanel(v, x);
  panel.scrollTop = 0;
  dlg.scrollTop = 0;
  if (focusTab) tabs.querySelector<HTMLButtonElement>(`[data-sv-tab="${k}"]`)?.focus();
}

/** One step open at a time; "show all" reveals the keeper's bookkeeping in that step. */
export function wireRuns(root: HTMLElement, signal: AbortSignal) {
  root.addEventListener(
    "toggle",
    (e) => {
      const d = e.target as HTMLDetailsElement;
      if (!d.matches?.(".st-mn-steps details") || !d.open) return;
      for (const o of d.closest(".st-mn-steps")!.querySelectorAll<HTMLDetailsElement>("details[open]")) if (o !== d) o.open = false;
    },
    { capture: true, signal },
  );
  // the steward's view: a modal dialog (the page behind is inert, Escape closes it), focus back on
  // the button that opened it
  const dlg = root.querySelector<HTMLDialogElement>('.st-sv-dialog[data-dlg="st-sv"]');
  if (dlg) {
    let open: RescueView | undefined;
    let opener: HTMLElement | null = null;
    root.addEventListener(
      "click",
      (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-sv]");
        if (!b || !current) return;
        const [i, j, k] = b.dataset.sv!.split(".").map(Number);
        open = current.runs[i]?.rescues?.[j];
        if (!open) return;
        opener = b;
        showSteward(dlg, open, k);
        dlg.showModal();
        dlg.querySelector<HTMLElement>(open.pooled ? `[data-sv-tab="${k}"]` : "[data-sv-close]")?.focus();
      },
      { signal },
    );
    dlg.addEventListener(
      "click",
      (e) => {
        const t = e.target as HTMLElement;
        if (t === dlg || t.closest("[data-sv-close]")) return dlg.close(); // the backdrop, or ×
        const tab = t.closest<HTMLButtonElement>("[data-sv-tab]");
        if (tab && open) showSteward(dlg, open, Number(tab.dataset.svTab), true);
      },
      { signal },
    );
    dlg.addEventListener(
      "keydown",
      (e) => {
        const tab = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-sv-tab]");
        if (!tab || !open || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const n = open.stewards.length, at = Number(tab.dataset.svTab);
        const k = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (at + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
        showSteward(dlg, open, k, true);
      },
      { signal },
    );
    dlg.addEventListener("close", () => opener?.focus(), { signal });
    signal.addEventListener("abort", () => dlg.open && dlg.close());
  }
  root.addEventListener(
    "click",
    (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-minor]");
      if (!b) return;
      const rows = b.closest("details")!.querySelectorAll<HTMLTableRowElement>("tr.is-minor");
      const show = b.textContent!.startsWith("Show all");
      for (const r of rows) r.hidden = !show;
      b.textContent = show ? "Key steps only" : `Show all ${b.closest("details")!.querySelectorAll("tbody tr").length}`;
    },
    { signal },
  );
}

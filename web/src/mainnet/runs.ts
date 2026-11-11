// "Live on mainnet": the capped rescues with real funds, read from the evidence harness's checked
// trails (stewards/scripts/evidence.ts writes /mainnet-runs.json from evidence/mainnet/, real runs
// only). Before the runs, the panel says what is planned and what is already checked.
import type { WebRuns } from "../../../stewards/src/trailcheck";
import { icon } from "../icons";

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

// the read-only preflight on Ethereum mainnet: OutLayer ran the pinned proof program on a real Aave position
const PREFLIGHT_TX = "7GCYZhCDkTPrzp7xSJ2syonU24wrqGD9MMSWbc6oZiXK";

export async function loadRuns(): Promise<WebRuns | null> {
  try {
    const r = await fetch("/mainnet-runs.json", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    const j = (await r.json()) as WebRuns;
    return j.runs?.length ? j : null;
  } catch {
    return null;
  }
}

function planned(): string {
  return `
  <section class="st-panel st-sect st-mn-runs">
    <div class="st-sect-head">
      <div>
        <div class="st-label">REAL RESCUES · ETHEREUM MAINNET</div>
        <h2 class="st-panel-title">Two small rescues with real funds, recorded transaction by transaction</h2>
      </div>
      <span class="st-chip">PLANNED</span>
    </div>
    <div class="st-mn-plan">
      <div><h3>Run 1 · one steward, bought back</h3><p>A WETH/USDC position falls under 1.15. The stewards bid, the lowest premium tops it up alone, and the borrower buys the claim back. The contract pays the steward exactly what it is owed.</p></div>
      <div><h3>Run 2 · pooled, settled</h3><p>No steward may cover the whole top-up, so two share it, each with its own claim. Nobody buys it back, so a claim owner settles at the oracle price and each owner is paid exactly.</p></div>
      <div><h3>Limits</h3><p>At most $150 of collateral per position and one allow-listed borrower, both owner settings bounded in the code. Every decision rests on a verified reading. Both positions are closed to zero at the end.</p></div>
    </div>
    <p class="st-chart-year"><strong>Already checked on mainnet, read-only:</strong> OutLayer ran Stead's pinned proof program on a real Aave position on Ethereum. Six independent RPCs agreed, and the collateral, debt, liquidation threshold and balances it proved equal Aave's own figures at that block. ${ext(`https://testnet.nearblocks.io/txns/${PREFLIGHT_TX}`, "The OutLayer run")}</p>
    <p class="st-list-note">This panel fills from the runs' evidence: every transaction is re-checked on chain and the contract's state is compared with the recording.</p>
  </section>`;
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

export function runsHtml(data: WebRuns | null): string {
  return data ? data.runs.map(runSection).join("") : planned();
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

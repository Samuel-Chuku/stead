// "Real rescues on Ethereum mainnet": every rescue Stead's contract on NEAR mainnet has run, read
// straight from the contract (get_rescues, then get_claim for each winner's claim) and the Ethereum
// blocks its proofs name. A row opens the rescue's full flow, the same timeline as the position
// dashboard's protections. The public NEAR RPCs are rate-limited: pages are read one after another,
// gently, and a finished rescue is kept (in memory and in this browser) and never read again.
import { NETS, rescueFlow, OUTCOME_WORD, units, type ClaimView, type RescueView } from "../own/net";
import { CODE } from "../board/model";
import { icon } from "../icons";
import { chainRuns, claimIdsOf, proofBlocks, readFrom, trailRescueIds, type ChainRow } from "./chainruns";
import { dialogHtml, flowSeq } from "./runs";

const net = NETS.mainnet;
const C = net.collateral;
type Story = { rescue: RescueView; claims: ClaimView[] };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((ok, no) => {
    const t = setTimeout(ok, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), no(new Error("aborted"))), { once: true });
  });
const ext = (href: string, label: string) => `<a class="st-textlink st-extlink" href="${href}" target="_blank" rel="noopener">${label}${icon("external", 13)}</a>`;
const contractLink = () => ext(`https://nearblocks.io/address/${net.contract}`, `<span class="st-mono">${net.contract}</span>`);
const dayText = (ms: number) => `${new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${new Date(ms).toISOString().slice(11, 16)} UTC`;
const tile = (acct: string, size = 22) => {
  const id = acct.split(".")[0];
  return id in CODE ? `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${id})" aria-hidden="true">${CODE[id as keyof typeof CODE]}</span>` : "";
};
const glyph = (d: string, size: number, cls = "") => `<svg aria-hidden="true" class="${cls}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const weth = (v: bigint | string) => units(v, C.decimals, 6);

// ── reads (kept across page visits; finished rescues also in this browser) ──
const CACHE_KEY = "stead.mainnet.rescues.v1";
const held = new Map<number, Story>();
const blockMsCache = new Map<number, number>();
try {
  const j = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as { stories?: Story[]; blocks?: [number, number][] } | null;
  for (const s of j?.stories ?? []) if (s?.rescue && Number.isInteger(s.rescue.id)) held.set(s.rescue.id, s);
  for (const [n, ms] of j?.blocks ?? []) blockMsCache.set(n, ms);
} catch {
  /* no storage: read everything */
}
function save() {
  try {
    const done = [...held.values()].filter((s) => ["bought_back", "settled", "failed"].includes(s.rescue.state));
    localStorage.setItem(CACHE_KEY, JSON.stringify({ stories: done, blocks: [...blockMsCache] }));
  } catch {
    /* the cache is a convenience */
  }
}

async function rpc(urls: string[], body: object, signal: AbortSignal): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of urls) {
      if (signal.aborted) throw new Error("aborted");
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }), signal: typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000) });
        if (r.status === 429 || r.status >= 500) throw new Error(`RPC ${r.status}`);
        return await r.json();
      } catch (e) {
        last = e;
      }
    }
    await sleep(1000 * (attempt + 1), signal);
  }
  throw new Error(`no RPC answered (${(last as Error)?.message ?? "no answer"})`);
}
async function view<T>(method: string, args: object, signal: AbortSignal): Promise<T> {
  const j = await rpc(net.nearRpcs, { method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: net.contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } }, signal);
  if (!j.result) throw new Error(j.error?.cause?.name ?? "NEAR view failed");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}

/** Every rescue, 50 a page from the first one not yet known to be finished, then the claims the
 *  winners were minted (only those not held), one read at a time. */
async function readRescues(signal: AbortSignal): Promise<void> {
  let from = readFrom(new Map([...held].map(([k, v]) => [k, v.rescue])));
  for (let pages = 0; pages < 100; pages++) {
    const page = await view<RescueView[]>("get_rescues", { from, limit: 50 }, signal);
    for (const r of page) {
      const was = held.get(r.id);
      held.set(r.id, { rescue: r, claims: was && was.rescue.state === r.state ? was.claims : [] });
    }
    if (page.length < 50) break;
    from = page[page.length - 1].id + 1;
    await sleep(1500, signal);
  }
  for (const s of [...held.values()].sort((a, b) => b.rescue.id - a.rescue.id)) {
    const ids = claimIdsOf(s.rescue);
    if (!ids.length || ids.every((id) => s.claims.some((c) => c.token_id === id))) continue;
    const claims: ClaimView[] = [];
    for (const id of ids) {
      await sleep(1500, signal);
      const c = await view<ClaimView | null>("get_claim", { token_id: id }, signal).catch(() => null);
      if (c) claims.push(c);
    }
    s.claims = claims;
  }
  save();
}
/** The times of the Ethereum blocks the proofs name (a proven top-up, a proven buy-back payment). */
async function readBlocks(signal: AbortSignal): Promise<boolean> {
  let got = false;
  for (const s of held.values()) {
    if (!s.rescue.members.length) continue;
    for (const n of proofBlocks(s.rescue, s.claims)) {
      if (blockMsCache.has(n)) continue;
      const j = await rpc(net.evmRpcs, { method: "eth_getBlockByNumber", params: [`0x${n.toString(16)}`, false] }, signal).catch(() => null);
      const ts = j?.result?.timestamp;
      if (ts) {
        blockMsCache.set(n, Number(BigInt(ts)) * 1000);
        got = true;
      }
    }
  }
  if (got) save();
  return got;
}

// ── drawing ──
const flowOpts = () => ({ debt: net.debt, evmTx: net.evmTx, evmBlock: net.evmBlock, evmAddress: net.evmAddress, blockMs: (n: number) => blockMsCache.get(n) ?? null });

function rowHtml(x: ChainRow): string {
  const who = x.winners.length
    ? x.winners.map((w) => `<span class="st-dash-prow-w">${tile(w.steward)}<span>${esc(w.name)}</span><span class="st-dash-prow-bps"><b class="st-num">${w.bps}</b> bps</span></span>`).join("")
    : `<span class="st-dash-prow-none">${x.outcome === "running" ? esc(x.stage) : `${x.bids} bid${x.bids === 1 ? "" : "s"}, ${x.covered ? "no top-up proven" : "short of the top-up"}`}</span>`;
  const chip = x.outcome === "running" ? x.stage : OUTCOME_WORD[x.outcome];
  return `<li><button type="button" class="st-dash-prow st-mn-prow" data-flow="${x.id}" aria-haspopup="dialog" aria-label="Rescue ${x.id}${x.positionId !== null ? ` on position ${x.positionId}` : ""}: ${esc(chip)}. Open its full flow">
      <span class="st-dash-prow-id"><span>RESCUE</span><b class="st-num">${x.id}</b></span>
      <span class="st-dash-prow-id st-mn-prow-pos"><span>POSITION</span><b class="st-num">${x.positionId ?? "?"}</b></span>
      <span class="st-dash-pchip is-${x.outcome}">${esc(chip)}</span>
      <span class="st-dash-prow-who">${who}</span>
      <span class="st-dash-prow-amt">${x.winners.length ? `<b>${weth(x.topupUnits)}</b> ${C.symbol}` : ""}</span>
      <span class="st-dash-prow-date">${dayText(x.openedMs)}</span>
      ${glyph("M6 3.5 10.5 8 6 12.5", 14, "st-dash-prow-go")}
    </button></li>`;
}

const head = (title: string, sub: string, chip = "") => `
    <div class="st-sect-head">
      <div>
        <div class="st-label">REAL RESCUES · ETHEREUM MAINNET · AAVE V3 ${C.symbol}/${net.debt.symbol}</div>
        <h2 class="st-panel-title">${title}</h2>
        <p class="st-list-src">${sub}</p>
      </div>
      ${chip}
    </div>`;

const NOTE = "Read from Stead's contract on NEAR mainnet: every figure is the contract's own record. Real funds, inside the contract's size cap. A row opens the rescue's full flow.";

/** The section's frame: filled once the contract is read. */
export function chainSectionHtml(): string {
  return `<section class="st-panel st-sect st-mn-runs st-mn-chain" data-chain-runs aria-busy="true">
    ${head("Stead's rescues with real funds", `Reading the rescues from contract ${contractLink()} on NEAR mainnet…`)}
  </section>${dialogHtml("Read from Stead's contract on NEAR mainnet. Times are the contract's own, or the time of the Ethereum block a proof read; a step with no time of its own reads after the last recorded time before it.", { id: "st-mn-flow", close: "Close the rescue's flow" })}`;
}

function listHtml(showFailed: boolean): string {
  const v = chainRuns([...held.values()].map((s) => s.rescue));
  const topped = v.real.reduce((t, x) => t + BigInt(x.topupUnits), 0n);
  const bps = [...new Set(v.real.flatMap((x) => x.winners.map((w) => w.bps)))].sort((a, b) => a - b);
  const winners = [...new Set(v.real.flatMap((x) => x.winners.map((w) => w.name)))];
  const posWords = v.positions.length === 1 ? `${v.positions[0]}` : `${v.positions.slice(0, -1).join(", ")} and ${v.positions.at(-1)}`;
  const sub = [esc(v.tally), `contract ${contractLink()} on NEAR mainnet`].filter(Boolean).join(" · ");
  const kpis = v.real.length
    ? `<dl class="st-kpis st-mn-chain-kpis">
      <div><dt>POSITIONS</dt><dd><span class="st-num">${v.positions.length}</span></dd><dd class="st-kpi-sub">rescued: ${v.positions.length === 1 ? "position" : "positions"} ${posWords}</dd></div>
      <div><dt>TOPPED UP</dt><dd><span class="st-num">${weth(topped)}</span> <span class="st-sv-u">${C.symbol}</span></dd><dd class="st-kpi-sub">supplied to Aave by the winning stewards</dd></div>
      <div><dt>WINNING PREMIUM</dt><dd><span class="st-num">${bps.length > 1 ? `${bps[0]}–${bps.at(-1)}` : bps[0]}</span> <span class="st-sv-u">bps</span></dd><dd class="st-kpi-sub">${winners.length ? `won by ${esc(winners.join(", "))}, the lowest bid` : ""}</dd></div>
    </dl>`
    : "";
  const shown = showFailed ? [...v.real, ...v.failed].sort((a, b) => b.id - a.id) : v.real;
  const rows = shown.length ? `<ol class="st-dash-prows st-mn-prows">${shown.map(rowHtml).join("")}</ol>` : `<p class="st-dash-prot-note">No rescue has reached a top-up yet. Stewards act when a protected position's health factor falls under 1.15.</p>`;
  const toggle = v.failed.length
    ? `<button type="button" class="st-dash-jmore" data-flow-failed aria-expanded="${showFailed}">${showFailed ? `Hide the ${v.failed.length} without a proven top-up` : `${v.failed.length} more: bids, no top-up proven`}${glyph(showFailed ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4", 14)}</button>`
    : "";
  const quiet = v.noBids ? `<span class="st-mn-chain-quiet">${v.noBids} rescue${v.noBids === 1 ? "" : "s"} with no bid not listed</span>` : "";
  return `${head(esc(v.headline), sub, `<span class="st-chip st-chip--rescued">LIVE ON MAINNET</span>`)}
    ${kpis}
    ${rows}
    ${toggle || quiet ? `<div class="st-dash-prot-foot st-mn-chain-foot">${quiet}${toggle}</div>` : ""}
    <p class="st-list-note">${esc(NOTE)}</p>`;
}

type FlowMovesFn = (typeof import("../own/dashlogic"))["flowMoves"];
function flowBody(id: number, flowMoves: FlowMovesFn, trail: { run: number; rescue: number } | undefined): string {
  const x = held.get(id);
  if (!x) return `<p class="st-dash-prot-note">Rescue ${id} is not in the contract's list.</p>`;
  const r = x.rescue;
  const row = chainRuns([r]);
  const one = row.real[0] ?? row.failed[0];
  const owed = x.claims.reduce((t, c) => t + BigInt(c.owed_units), 0n);
  const flow = rescueFlow(r, x.claims, { coll: C, evmName: net.evmName, ...flowOpts() });
  const win = one ? one.winners.map((w) => `<span class="st-dash-prot-w">${tile(w.steward)}<span>${esc(w.name)}</span></span>`).join("") : "";
  const bps = one ? one.winners.map((w) => `${w.bps} bps`).join(", ") : "";
  const outcome = one?.outcome ?? "no_bids";
  return `<dl class="st-kpis st-sv-kpis st-dash-prot-kpis">
      <div><dt>OUTCOME</dt><dd class="st-kpi-word"><span class="st-dash-pchip is-${outcome}">${esc(outcome === "running" ? `${OUTCOME_WORD.running} · ${one!.stage}` : OUTCOME_WORD[outcome])}</span></dd><dd class="st-kpi-sub">opened ${dayText(one?.openedMs ?? 0)}</dd></div>
      <div><dt>${one && one.winners.length > 1 ? "WINNERS" : "WINNER"}</dt><dd class="st-dash-prot-win">${win || `<span class="st-kpi-word">none</span>`}</dd><dd class="st-kpi-sub">${bps ? `${bps} · ` : ""}cap ${r.cap_bps} bps · ${r.bids.length} bid${r.bids.length === 1 ? "" : "s"}</dd></div>
      <div><dt>TOPPED UP</dt><dd>${one?.winners.length ? `<span class="st-num">${weth(one.topupUnits)}</span> <span class="st-sv-u">${C.symbol}</span>` : `<span class="st-kpi-word">nothing</span>`}</dd><dd class="st-kpi-sub">${weth(r.topup_units)} ${C.symbol} needed</dd></div>
      ${owed > 0n ? `<div><dt>CLAIM OWED</dt><dd><span class="st-num">${weth(owed)}</span> <span class="st-sv-u">${C.symbol}</span></dd><dd class="st-kpi-sub">${x.claims.map((c) => esc(c.token_id)).join(", ")}</dd></div>` : ""}
    </dl>
    ${trail ? `<p class="st-mn-flow-trail"><button type="button" class="st-secondary st-cut" data-flow-trail="${trail.run}.${trail.rescue}.0">The recorded run: every transaction re-checked</button></p>` : ""}
    ${flowSeq(flowMoves(flow))}`;
}

/** Reads the contract, fills the section, wires the rows to the flow dialog. `trails` is the
 *  checked trails' runs when the site has them (a row recorded there links to its run). */
export function mountChainRuns(root: HTMLElement, signal: AbortSignal, trails: { rescues?: { rescue: string }[] }[] | null) {
  const sect = root.querySelector<HTMLElement>("[data-chain-runs]");
  const dlg = root.querySelector<HTMLDialogElement>('.st-sv-dialog[data-dlg="st-mn-flow"]');
  if (!sect || !dlg) return;
  const trailIds = trailRescueIds(trails);
  let showFailed = false;
  let openId: number | null = null;
  let opener: HTMLElement | null = null;
  let flowMoves: FlowMovesFn | null = null;
  const logic = import("../own/dashlogic").then((m) => (flowMoves = m.flowMoves));

  const draw = () => {
    if (signal.aborted) return;
    sect.removeAttribute("aria-busy");
    const focused = (document.activeElement as HTMLElement | null)?.closest?.("[data-flow],[data-flow-failed]") as HTMLElement | null;
    const key = focused?.dataset.flow ?? (focused?.hasAttribute("data-flow-failed") ? "failed" : null);
    sect.innerHTML = listHtml(showFailed);
    if (key) sect.querySelector<HTMLElement>(key === "failed" ? "[data-flow-failed]" : `[data-flow="${key}"]`)?.focus();
    if (openId !== null && dlg.open) fillDialog(openId);
  };
  const fillDialog = (id: number) => {
    const x = held.get(id);
    const one = x ? (chainRuns([x.rescue]).real[0] ?? chainRuns([x.rescue]).failed[0]) : undefined;
    dlg.querySelector("[data-sv-label]")!.textContent = `RESCUE ${id}${one && one.positionId !== null ? ` · POSITION ${one.positionId}` : ""} · ETHEREUM MAINNET`;
    dlg.querySelector("#st-mn-flow-title")!.textContent = `Rescue ${id}${one ? `: ${one.outcome === "running" ? one.stage : OUTCOME_WORD[one.outcome].toLowerCase()}` : ""}`;
    const panel = dlg.querySelector<HTMLElement>(".st-sv-panel")!;
    const top = panel.scrollTop;
    panel.innerHTML = flowMoves ? flowBody(id, flowMoves, trails ? trailIds.get(id) : undefined) : `<p class="st-dash-prot-note">Drawing the flow…</p>`;
    panel.scrollTop = top;
  };

  sect.addEventListener(
    "click",
    (e) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-flow-failed]")) {
        showFailed = !showFailed;
        return draw();
      }
      const b = t.closest<HTMLElement>("[data-flow]");
      if (!b) return;
      openId = Number(b.dataset.flow);
      opener = b;
      fillDialog(openId);
      dlg.scrollTop = 0;
      dlg.showModal();
      dlg.querySelector<HTMLElement>("[data-sv-close]")?.focus();
      if (!flowMoves) void logic.then(() => openId !== null && dlg.open && fillDialog(openId));
    },
    { signal },
  );
  dlg.addEventListener(
    "click",
    (e) => {
      const t = e.target as HTMLElement;
      if (t === dlg || t.closest("[data-sv-close]")) return dlg.close();
      const tr = t.closest<HTMLElement>("[data-flow-trail]");
      if (tr) {
        dlg.close();
        root.querySelector<HTMLButtonElement>(`[data-sv="${tr.dataset.flowTrail}"]`)?.click();
      }
    },
    { signal },
  );
  dlg.addEventListener(
    "close",
    () => {
      openId = null;
      opener?.focus();
    },
    { signal },
  );
  signal.addEventListener("abort", () => dlg.open && dlg.close());

  // what this browser already holds draws at once; then the contract, then the proofs' block times
  if ([...held.values()].some((s) => s.rescue.members.length)) draw();
  readRescues(signal).then(
    async () => {
      draw();
      if (await readBlocks(signal).catch(() => false)) draw();
    },
    (e) => {
      if (signal.aborted) return;
      if (held.size) return draw(); // keep what is held; the next visit reads again
      sect.removeAttribute("aria-busy");
      sect.innerHTML = `${head("Stead's rescues with real funds", `Contract ${contractLink()} on NEAR mainnet`)}
        <p class="st-dash-prot-note" role="alert">The rescues were not read: no NEAR mainnet RPC answered (${esc(String((e as Error).message))}). Reload the page to try again, or see the contract's transactions on NearBlocks.</p>`;
    },
  );
}

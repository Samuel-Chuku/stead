// The Positions page's protections: inside an expanded position, every rescue that position has had
// (newest first, the ones with no bids folded away), and a row opens that rescue's full flow in a
// read-only dialog, the same timeline as the dashboard's protections, its steps linked to their
// transactions when the rescue was recorded. The flow is read from the contract on demand.
import type { PositionRow, RescueRow } from "../../../stewards/src/records";
import { NETS, OUTCOME_WORD, rescueFlow, type ClaimView, type Outcome, type RescueView, type Token } from "../own/net";
import { attachRecorded, loadRecording, replayLink } from "../own/flowlinks";
import { dialogHtml, flowSeq } from "../mainnet/runs";
import { CODE, fmtAmt } from "../board/model";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const STAGE: Record<string, string> = { auction: "stewards bidding", top_up_pending: "topping up", open: "claim open", settling: "settling" };

export type PosProtection = { id: number; contract: string; outcome: Outcome; chip: string; winners: RescueRow["winners"]; topUp: string; asset: string; openedAtMs: number; bids: number };
/** How a listed rescue ended, or the stage it is in. */
export function rowOutcome(r: Pick<RescueRow, "state" | "bids" | "winners">): Outcome {
  if (r.state === "bought_back" || r.state === "settled") return r.state;
  if (r.state === "failed") return r.bids === 0 && r.winners.length === 0 ? "no_bids" : "failed";
  return "running";
}
/** Every rescue on this position (same contract, same position id), newest first; no-bid ones apart. */
export function positionProtections(rescues: RescueRow[], p: Pick<PositionRow, "contract" | "id">): { rows: PosProtection[]; noBids: PosProtection[] } {
  const all = rescues
    .filter((r) => r.contract === p.contract && r.positionId === p.id)
    .sort((a, b) => b.id - a.id)
    .map((r): PosProtection => {
      const outcome = rowOutcome(r);
      const filled = r.winners.reduce((t, w) => t + Number(w.share), 0);
      return { id: r.id, contract: r.contract, outcome, chip: outcome === "running" ? (STAGE[r.state] ?? r.state) : OUTCOME_WORD[outcome], winners: r.winners, topUp: r.winners.length ? String(filled) : "0", asset: r.asset, openedAtMs: r.openedAtMs, bids: r.bids };
    });
  return { rows: all.filter((x) => x.outcome !== "no_bids"), noBids: all.filter((x) => x.outcome === "no_bids") };
}

const tile = (s: string) => (s in CODE ? `<span class="st-tile st-tile--22" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s as keyof typeof CODE]}</span>` : "");
const dayText = (ms: number) => `${new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · ${new Date(ms).toISOString().slice(11, 16)} UTC`;
const go = `<svg aria-hidden="true" class="st-dash-prow-go" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`;

function rowHtml(x: PosProtection): string {
  const who = x.winners.length
    ? [...x.winners].sort((a, b) => a.bps - b.bps).map((w) => `<span class="st-dash-prow-w">${tile(w.steward)}<span>${esc(w.steward)}</span><span class="st-dash-prow-bps"><b class="st-num">${w.bps}</b> bps</span></span>`).join("")
    : `<span class="st-dash-prow-none">${x.outcome === "running" ? esc(x.chip) : x.bids ? `${x.bids} bid${x.bids === 1 ? "" : "s"}, no top-up proven` : "no steward bid"}</span>`;
  return `<li><button type="button" class="st-dash-prow" data-pflow="${esc(x.contract)}#${x.id}" aria-haspopup="dialog" aria-label="Rescue ${x.id}: ${esc(x.chip)}. Open its full flow">
      <span class="st-dash-prow-id"><span>RESCUE</span><b class="st-num">${x.id}</b></span>
      <span class="st-dash-pchip is-${x.outcome}">${esc(x.chip)}</span>
      <span class="st-dash-prow-who">${who}</span>
      <span class="st-dash-prow-amt">${x.winners.length ? `<b>${fmtAmt(x.topUp)}</b> ${esc(x.asset)}` : ""}</span>
      <span class="st-dash-prow-date">${dayText(x.openedAtMs)}</span>
      ${go}
    </button></li>`;
}

/** The protections block inside an expanded position. */
export function protectionsHtml(rescues: RescueRow[], p: PositionRow): string {
  const { rows, noBids } = positionProtections(rescues, p);
  if (!rows.length && !noBids.length) return `<div class="st-pos-prot"><div class="st-label">PROTECTIONS</div><p class="st-dash-prot-note">No rescue on this position yet. Stewards act when its health factor falls under 1.15.</p></div>`;
  return `<div class="st-pos-prot"><div class="st-label">PROTECTIONS · ${rows.length} WITH BIDS</div>
    ${rows.length ? `<ol class="st-dash-prows">${rows.map(rowHtml).join("")}</ol>` : `<p class="st-dash-prot-note">Every rescue so far ended with no bids.</p>`}
    ${noBids.length ? `<button type="button" class="st-dash-jmore" data-pflow-nobids aria-expanded="false">${noBids.length} without bids</button><ol class="st-dash-prows" data-pflow-hidden hidden>${noBids.map(rowHtml).join("")}</ol>` : ""}
  </div>`;
}

export const posFlowDialogHtml = () =>
  dialogHtml("Read from the contract on NEAR. Times are the contract's own; a step with no time of its own reads after the last recorded time before it. Recorded rescues link every step to its transaction.", { id: "st-pos-flow", close: "Close the rescue's flow" });

// ── reading one rescue (read-only views over the public NEAR RPCs) ──
async function nearView<T>(rpcs: string[], contract: string, method: string, args: object, signal: AbortSignal): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of rpcs) {
      if (signal.aborted) throw new Error("aborted");
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) } }), signal: AbortSignal.timeout(6000) });
        if (r.status === 429 || r.status >= 500) throw new Error(`RPC ${r.status}`);
        const j = await r.json();
        if (!j.result) throw new Error(j.error?.cause?.name ?? "view failed");
        return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
      } catch (e) {
        last = e;
      }
    }
    await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
  }
  throw new Error(`no RPC answered (${(last as Error)?.message ?? "no answer"})`);
}
type Story = { rescue: RescueView; claims: ClaimView[] };
const stories = new Map<string, Promise<Story>>();
function readStory(contract: string, id: number, signal: AbortSignal): Promise<Story> {
  const k = `${contract}#${id}`;
  if (!stories.has(k)) {
    const rpcs = contract.endsWith(".near") ? NETS.mainnet.nearRpcs : NETS.testnet.nearRpcs;
    const p = (async () => {
      const page = await nearView<RescueView[]>(rpcs, contract, "get_rescues", { from: id, limit: 1 }, signal);
      const rescue = page.find((r) => r.id === id);
      if (!rescue) throw new Error(`rescue ${id} not found`);
      const claims: ClaimView[] = [];
      for (const m of rescue.members) {
        if (!m.claim_id) continue;
        const c = await nearView<ClaimView | null>(rpcs, contract, "get_claim", { token_id: m.claim_id }, signal).catch(() => null);
        if (c) claims.push(c);
      }
      return { rescue, claims };
    })();
    p.catch(() => stories.delete(k)); // a failed read is tried again next time
    stories.set(k, p);
  }
  return stories.get(k)!;
}

function tokensFor(r: RescueRow): { coll: Token; debt?: Token } {
  if (r.contract.endsWith(".near")) return { coll: NETS.mainnet.collateral, debt: NETS.mainnet.debt };
  const T = NETS.testnet;
  const debtSym = r.pair.split("/")[1];
  const DEC: Record<string, number> = { WBTC: 8, USDC: 6, USDT: 6 }; // Aave's Sepolia tokens; the rest are 18
  return { coll: T.collateral.symbol === r.asset ? T.collateral : { address: "0x0", symbol: r.asset, decimals: DEC[r.asset] ?? 18 }, debt: T.debt.symbol === debtSym ? T.debt : undefined };
}

/** The dialog's body for one rescue: its summary and the full flow. */
function flowBody(row: RescueRow, x: Story, flowMoves: (typeof import("../own/dashlogic"))["flowMoves"], rec: Awaited<ReturnType<typeof loadRecording>>): string {
  const { coll, debt } = tokensFor(row);
  const mainnet = row.contract.endsWith(".near");
  const N = mainnet ? NETS.mainnet : NETS.testnet;
  // the local fork's Ethereum is a copy: no explorer has its transactions
  const evm = row.chain === "local fork" ? {} : { evmTx: N.evmTx, evmBlock: N.evmBlock, evmAddress: N.evmAddress };
  const flow = attachRecorded(rescueFlow(x.rescue, x.claims, { coll, debt, evmName: row.chain === "local fork" ? "the local fork" : N.evmName, ...evm }), rec, row.contract);
  const outcome = rowOutcome(row);
  const owed = x.claims.reduce((t, c) => t + BigInt(c.owed_units), 0n);
  const u = (v: bigint | string) => fmtAmt(String(Number(BigInt(v)) / 10 ** coll.decimals));
  const win = row.winners.map((w) => `<span class="st-dash-prot-w">${tile(w.steward)}<span>${esc(w.steward)}</span></span>`).join("");
  const bps = row.winners.map((w) => `${w.bps} bps`).join(", ");
  return `<dl class="st-kpis st-sv-kpis st-dash-prot-kpis">
      <div><dt>OUTCOME</dt><dd class="st-kpi-word"><span class="st-dash-pchip is-${outcome}">${esc(outcome === "running" ? `${OUTCOME_WORD.running} · ${STAGE[row.state] ?? row.state}` : OUTCOME_WORD[outcome])}</span></dd><dd class="st-kpi-sub">opened ${dayText(row.openedAtMs)}</dd></div>
      <div><dt>${row.winners.length > 1 ? "WINNERS" : "WINNER"}</dt><dd class="st-dash-prot-win">${win || `<span class="st-kpi-word">none</span>`}</dd><dd class="st-kpi-sub">${bps ? `${bps} · ` : ""}cap ${row.capBps} bps · ${row.bids} bid${row.bids === 1 ? "" : "s"}</dd></div>
      <div><dt>TOPPED UP</dt><dd>${row.winners.length ? `<span class="st-num">${u(x.rescue.members.reduce((t, m) => t + BigInt(m.share_units), 0n))}</span> <span class="st-sv-u">${esc(coll.symbol)}</span>` : `<span class="st-kpi-word">nothing</span>`}</dd><dd class="st-kpi-sub">${u(x.rescue.topup_units)} ${esc(coll.symbol)} needed</dd></div>
      ${owed > 0n ? `<div><dt>CLAIM OWED</dt><dd><span class="st-num">${u(owed)}</span> <span class="st-sv-u">${esc(coll.symbol)}</span></dd><dd class="st-kpi-sub">${x.claims.map((c) => esc(c.token_id)).join(", ")}</dd></div>` : ""}
    </dl>
    ${replayLink(row.contract, x.rescue.id, rec)}
    ${flowSeq(flowMoves(flow, mainnet ? "ethereum" : "sepolia"))}`;
}

/** Wires the protections rows: the no-bids toggle, and a row opening its flow in the dialog. */
export function wireProtections(root: HTMLElement, rescues: RescueRow[], signal: AbortSignal) {
  const dlg = root.querySelector<HTMLDialogElement>('.st-sv-dialog[data-dlg="st-pos-flow"]');
  if (!dlg) return;
  let opener: HTMLElement | null = null;
  let openKey: string | null = null;
  const panel = dlg.querySelector<HTMLElement>(".st-sv-panel")!;
  root.addEventListener(
    "click",
    (e) => {
      const t = e.target as HTMLElement;
      const tog = t.closest<HTMLButtonElement>("[data-pflow-nobids]");
      if (tog) {
        const list = tog.nextElementSibling as HTMLElement;
        list.hidden = !list.hidden;
        tog.setAttribute("aria-expanded", String(!list.hidden));
        const n = list.children.length;
        tog.textContent = list.hidden ? `${n} without bids` : `Hide the ${n} without bids`;
        return;
      }
      const b = t.closest<HTMLElement>("[data-pflow]");
      if (!b || dlg.contains(b)) return;
      const key = b.dataset.pflow!;
      const [contract, idText] = [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)];
      const id = Number(idText);
      const row = rescues.find((r) => r.contract === contract && r.id === id);
      if (!row) return;
      opener = b;
      openKey = key;
      const outcome = rowOutcome(row);
      dlg.querySelector("[data-sv-label]")!.textContent = `RESCUE ${id} · POSITION ${row.positionId} · ${row.contract.endsWith(".near") ? "ETHEREUM MAINNET" : row.chain === "local fork" ? "LOCAL FORK, UNVERIFIED" : "SEPOLIA TESTNET"}`;
      dlg.querySelector("#st-pos-flow-title")!.textContent = `Rescue ${id}: ${outcome === "running" ? (STAGE[row.state] ?? row.state) : OUTCOME_WORD[outcome].toLowerCase()}`;
      panel.innerHTML = `<p class="st-dash-prot-note">Reading rescue ${id} from ${esc(contract)}…</p>`;
      dlg.scrollTop = 0;
      dlg.showModal();
      dlg.querySelector<HTMLElement>("[data-sv-close]")?.focus();
      Promise.all([readStory(contract, id, signal), loadRecording(contract, id), import("../own/dashlogic")]).then(
        ([story, rec, logic]) => {
          if (openKey !== key || !dlg.open) return;
          panel.innerHTML = flowBody(row, story, logic.flowMoves, rec);
        },
        (err) => {
          if (openKey !== key || !dlg.open) return;
          panel.innerHTML = `<p class="st-dash-prot-note" role="alert">Rescue ${id} was not read: ${esc(String((err as Error).message))}. The public NEAR RPCs rate-limit; close this and open the row again in a minute.</p>`;
        },
      );
    },
    { signal },
  );
  dlg.addEventListener(
    "click",
    (e) => {
      const t = e.target as HTMLElement;
      if (t === dlg || t.closest("[data-sv-close]")) dlg.close();
    },
    { signal },
  );
  dlg.addEventListener("close", () => ((openKey = null), opener?.focus()), { signal });
  signal.addEventListener("abort", () => dlg.open && dlg.close());
}

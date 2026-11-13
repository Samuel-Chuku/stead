// Re-checks a live run's evidence trail (src/record.ts) on chain, read-only:
//  - every Ethereum tx: it exists, succeeded or failed as recorded, and was sent from / to the
//    recorded addresses;
//  - every NEAR tx: it exists, succeeded or failed as recorded, and its signer, contract and
//    method (or key deletion) match the record;
//  - the contract's state: the positions, rescues and claims read live now, compared with the
//    snapshot taken at the end of the run.
// RPCs are tried in order, each twice. No RPC URL is ever printed or written (some carry a key).
import type { TrailChain, TrailEntry, TrailFile } from "./record.js";
import { rescueViews, type RescueView } from "./stewardview.js";

export type Rpcs = Record<TrailChain, string[]>;

export interface CheckedEntry extends TrailEntry {
  link: string; // explorer link ("" for a local copy)
  confirmed: boolean; // the chain agrees with the record
  status: string; // plain words: "✓ block 123", "✓ refused, as recorded", "✗ sender differs", …
}
export interface CheckedTrail {
  file: string;
  title: string;
  label: string;
  contract: string;
  contractLink: string;
  started: string;
  finished?: string;
  outcome?: string;
  addresses: Record<string, string>;
  entries: CheckedEntry[];
  confirmed: number;
  total: number;
  state: { checked: boolean; matches: boolean; differences: string[]; note: string };
}

export function explorerLink(chain: TrailChain, tx: string): string {
  switch (chain) {
    case "ethereum": return `https://etherscan.io/tx/${tx}`;
    case "sepolia": return `https://sepolia.etherscan.io/tx/${tx}`;
    case "near-mainnet": return `https://nearblocks.io/txns/${tx}`;
    case "near-testnet": return `https://testnet.nearblocks.io/txns/${tx}`;
    default: return "";
  }
}
export const accountLink = (net: "mainnet" | "testnet", id: string) => `https://${net === "mainnet" ? "" : "testnet."}nearblocks.io/address/${id}`;

type Fetch = (url: string, body: unknown) => Promise<any>;
const post: Fetch = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return r.json();
};

/** Ask each RPC in turn (the list twice) until one gives an answer `accept` likes. The error never names a URL. */
export async function rpcAny(urls: string[], method: string, params: unknown, accept: (r: any) => boolean = (r) => r?.result != null, fetcher: Fetch = post): Promise<any> {
  let last: any;
  for (const u of [...urls, ...urls]) {
    try {
      const r = await fetcher(u, { jsonrpc: "2.0", id: 1, method, params });
      if (accept(r)) return r;
      last = r;
    } catch {
      /* next RPC */
    }
  }
  return last ?? { error: { message: `no RPC answered (${urls.length} tried)` } };
}

const same = (a?: string | null, b?: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** One Ethereum entry against its receipt and transaction. */
export function checkEvm(e: TrailEntry, receipt: any, tx: any): { confirmed: boolean; status: string } {
  if (!receipt || !tx) return { confirmed: false, status: "✗ not found" };
  if (e.from && !same(tx.from, e.from)) return { confirmed: false, status: "✗ sender differs from the record" };
  if (e.to && !same(tx.to, e.to)) return { confirmed: false, status: "✗ target differs from the record" };
  const ok = receipt.status === "0x1";
  const block = parseInt(receipt.blockNumber, 16);
  if (ok !== e.ok) return { confirmed: false, status: ok ? "✗ succeeded, recorded as failed" : "✗ reverted, recorded as succeeded" };
  return { confirmed: true, status: ok ? `✓ block ${block}` : `✓ reverted, as recorded (block ${block})` };
}

/** The method of a NEAR transaction's first function call, or the kind of its first other action. */
function nearAction(t: any): string | undefined {
  const a = t?.actions?.[0];
  if (!a) return undefined;
  if (typeof a === "string") return a;
  if (a.FunctionCall) return a.FunctionCall.method_name;
  return Object.keys(a)[0];
}

/** One NEAR entry against the `tx` RPC answer. */
export function checkNear(e: TrailEntry, r: any): { confirmed: boolean; status: string } {
  const res = r?.result;
  if (!res?.transaction) return { confirmed: false, status: `✗ not found${r?.error?.cause?.name ? ` (${r.error.cause.name})` : ""}` };
  const t = res.transaction;
  if (e.signer && t.signer_id !== e.signer) return { confirmed: false, status: "✗ signer differs from the record" };
  if (e.receiver && t.receiver_id !== e.receiver) return { confirmed: false, status: "✗ receiver differs from the record" };
  if (e.method && nearAction(t) !== e.method) return { confirmed: false, status: `✗ ${nearAction(t)} on chain, ${e.method} in the record` };
  const st = res.status ?? {};
  const ok = "SuccessValue" in st || "SuccessReceiptId" in st;
  const failed = "Failure" in st;
  if (!ok && !failed) return { confirmed: false, status: "✗ still pending" };
  if (ok !== e.ok) return { confirmed: false, status: ok ? "✗ succeeded, recorded as refused" : "✗ refused, recorded as succeeded" };
  return { confirmed: true, status: ok ? "✓" : "✓ refused, as recorded" };
}

const stable = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Differences between the snapshot and a live read, as "rescue 3: state", one per changed field. */
export function compareState(kind: string, snap: Record<string, unknown>, live: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [id, s] of Object.entries(snap)) {
    const l = live[id];
    if (l === undefined) {
      out.push(`${kind} ${id}: not readable now`);
      continue;
    }
    if (s && l && typeof s === "object" && typeof l === "object") {
      const keys = new Set([...Object.keys(s as object), ...Object.keys(l as object)]);
      for (const k of keys) if (stable((s as any)[k]) !== stable((l as any)[k])) out.push(`${kind} ${id}: ${k}`);
    } else if (stable(s) !== stable(l)) out.push(`${kind} ${id}`);
  }
  return out;
}

async function nearView(urls: string[], contract: string, method: string, args: object, fetcher?: Fetch): Promise<unknown> {
  const r = await rpcAny(urls, "query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }, (x) => Array.isArray(x?.result?.result), fetcher);
  if (!Array.isArray(r?.result?.result)) return undefined;
  return JSON.parse(Buffer.from(r.result.result).toString());
}

const READINGS = ["health"];
const omit = (m: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(m).map(([id, v]) => [id, v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k))) : v]));

/** Check a whole trail. Entries are checked one after another (public RPCs rate-limit bursts). */
export async function checkTrail(path: string, f: TrailFile, rpcs: Rpcs, fetcher?: Fetch): Promise<CheckedTrail> {
  const entries: CheckedEntry[] = [];
  for (const e of f.entries) {
    let c: { confirmed: boolean; status: string };
    const urls = rpcs[e.chain] ?? [];
    if (!urls.length) c = { confirmed: false, status: "✗ no RPC for this chain" };
    else if (e.chain.startsWith("near")) {
      const r = await rpcAny(urls, "tx", { tx_hash: e.tx, sender_account_id: e.signer ?? e.actor, wait_until: "NONE" }, (x) => x?.result?.transaction != null, fetcher);
      c = checkNear(e, r);
    } else {
      const rc = await rpcAny(urls, "eth_getTransactionReceipt", [e.tx], undefined, fetcher);
      const tx = await rpcAny(urls, "eth_getTransactionByHash", [e.tx], undefined, fetcher);
      c = checkEvm(e, rc?.result, tx?.result);
    }
    entries.push({ ...e, link: explorerLink(e.chain, e.tx), ...c });
  }
  const state = { checked: false, matches: false, differences: [] as string[], note: "no snapshot in the trail" };
  if (f.state) {
    const urls = rpcs[f.nearNetwork === "mainnet" ? "near-mainnet" : "near-testnet"];
    const live = async (method: string, arg: string, ids: string[]) =>
      Object.fromEntries((await Promise.all(ids.map(async (id) => [id, await nearView(urls, f.contract, method, { [arg]: /^\d+$/.test(id) ? Number(id) : id }, fetcher)] as const))).filter(([, v]) => v !== undefined));
    const diffs = [
      // a position's latest health reading is left out: anyone may request a new reading at any time
      ...compareState("position", omit(f.state.positions, READINGS), omit(await live("get_position", "position_id", Object.keys(f.state.positions)), READINGS)),
      ...compareState("rescue", f.state.rescues, await live("get_rescue", "rescue_id", Object.keys(f.state.rescues))),
      ...compareState("claim", f.state.claims, await live("get_claim", "token_id", Object.keys(f.state.claims))),
    ];
    Object.assign(state, {
      checked: true,
      matches: diffs.length === 0,
      differences: diffs,
      note: diffs.length === 0 ? `the contract's positions, rescues and claims read now match the snapshot taken at ${f.state.read_at} (positions' latest health readings aside)` : `differs from the snapshot taken at ${f.state.read_at}`,
    });
  }
  return {
    file: path,
    title: f.title,
    label: f.label,
    contract: f.contract,
    contractLink: f.nearNetwork === "mainnet" || f.nearNetwork === "testnet" ? accountLink(f.nearNetwork, f.contract) : "",
    started: f.started,
    finished: f.finished,
    outcome: f.outcome,
    addresses: f.addresses,
    entries,
    confirmed: entries.filter((e) => e.confirmed).length,
    total: entries.length,
    state,
  };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function row(e: CheckedEntry): string {
  const tx = e.link ? `[\`${e.tx.slice(0, 10)}…\`](${e.link})` : `\`${e.tx.slice(0, 10)}…\``;
  const chain = e.chain.startsWith("near") ? "NEAR" : "Ethereum";
  return `| ${e.at.slice(11, 19)} | ${cell(e.actor)} | ${cell(e.what)} | ${chain} ${tx} | ${e.status} |`;
}
/** Entries grouped by step, steps in the order they happened, each step a small table. */
function bySteps(entries: CheckedEntry[]): string[] {
  const head = "| Time (UTC) | Who | What | Transaction | On chain |\n|---|---|---|---|---|";
  const steps: string[] = [];
  for (const e of entries) if (!steps.includes(e.step)) steps.push(e.step);
  return steps.flatMap((s) => [`**Step ${s}**`, "", head, ...entries.filter((e) => e.step === s).map(row), ""]);
}

/** A run as markdown: the key steps first, the full trail folded below. */
export function renderTrail(c: CheckedTrail): string {
  const key = c.entries.filter((e) => e.key);
  const lines = [
    `### ${c.title}`,
    "",
    `**${c.label}** · contract [\`${c.contract}\`](${c.contractLink}) · ${c.started.slice(0, 16).replace("T", " ")} → ${(c.finished ?? "unfinished").slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**${c.confirmed} of ${c.total} recorded transactions confirmed on chain.** Contract state: ${c.state.checked ? (c.state.matches ? "✓ " : "✗ ") : ""}${c.state.note}${c.state.differences.length ? ` (${c.state.differences.join(", ")})` : ""}.`,
    "",
  ];
  if (c.outcome) lines.push("```", c.outcome, "```", "");
  if (Object.keys(c.addresses).length) lines.push(`Addresses: ${Object.entries(c.addresses).map(([n, a]) => `${n} \`${a}\``).join(" · ")}`, "");
  lines.push(`Key steps (${key.length}):`, "", ...bySteps(key), `<details><summary>Full trail: all ${c.total} transactions, in order, including the keeper's readings and confirmations</summary>`, "", ...bySteps(c.entries), "</details>", "");
  return lines.join("\n");
}

/** What the site's "Live on mainnet" panel reads: each checked run, without the snapshot or the
 *  chain-check internals. Only real runs (evidence/mainnet/) are ever published. */
export interface WebRuns {
  generated: string;
  runs: {
    title: string;
    label: string;
    contract: string;
    contractLink: string;
    started: string;
    finished?: string;
    outcome?: string;
    confirmed: number;
    total: number;
    state: { checked: boolean; matches: boolean; note: string };
    entries: Pick<CheckedEntry, "chain" | "tx" | "at" | "step" | "what" | "actor" | "ok" | "key" | "link" | "confirmed" | "status">[];
    /** Each rescue in the run, with every winning steward's own moves (the "steward's view"). */
    rescues: RescueView[];
  }[];
}
export function webRuns(checked: CheckedTrail[], generated = new Date().toISOString()): WebRuns {
  return {
    generated,
    runs: checked.map((c) => ({
      title: c.title,
      label: c.label,
      contract: c.contract,
      contractLink: c.contractLink,
      started: c.started,
      finished: c.finished,
      outcome: c.outcome,
      confirmed: c.confirmed,
      total: c.total,
      state: { checked: c.state.checked, matches: c.state.matches, note: c.state.note },
      entries: c.entries.map(({ chain, tx, at, step, what, actor, ok, key, link, confirmed, status }) => ({ chain, tx, at, step, what, actor, ok, key, link, confirmed, status })),
      rescues: rescueViews(c.entries),
    })),
  };
}

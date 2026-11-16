// Explorer links for a rescue's flow, from the board's recording of that rescue (web/public/replays):
// each recorded event carries the transaction that made it ({chain, tx, url}). A flow step built from
// the contract's records gets the matching transactions: a bid its steward's bid, the close its
// close_auction call, a top-up the steward's supply on Ethereum, a proof the verified read, a claim
// the NEAR transaction that minted it, a buy-back the borrower's transfer and its proof, a payout the
// contract's pay call and the Ethereum transfer. Pure: the page fetches the recording.
import type { FlowStep } from "./net";

export type TxLink = { href: string; label: "NearBlocks" | "Etherscan"; ref: string };
type Evidence = { chain?: string; tx?: string; url?: string };
export type RecEvent = {
  kind: string;
  t?: number;
  steward?: string | null;
  bps?: number;
  claim?: string | null;
  purpose?: string;
  evidence?: Evidence;
  transfer?: Evidence;
  /** the contract's record of an EVM step (a settlement's repay) */
  near?: Evidence;
  /** a settlement leg's index in the contract's settlement */
  leg?: number;
  from?: string | null;
  to?: string | null;
  amount?: string;
  asset?: string;
};
export type Recording = { contract: string; rescueId: number; openedAtMs?: number; events: RecEvent[] };

/** The live feed, where every finished rescue is recorded from the chains (no site rebuild). */
export const feedBase = (): string | null =>
  typeof location === "undefined" ? null : ((import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz"));
export type RecordingEntry = { contract: string; rescueId: number; outcome: string; openedAtMs: number; winners: number };
let indexAt = 0;
let indexP: Promise<RecordingEntry[]> | null = null;
/** Every recording the feed holds (re-read after a minute); empty when the feed can't be reached. */
export function feedRecordings(fetcher: typeof fetch = fetch): Promise<RecordingEntry[]> {
  const base = feedBase();
  if (!base) return Promise.resolve([]);
  if (!indexP || Date.now() - indexAt > 60_000) {
    indexAt = Date.now();
    indexP = fetcher(`${base}/recordings.json`, { signal: AbortSignal.timeout(8000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (Array.isArray(j?.recordings) ? (j.recordings as RecordingEntry[]) : []))
      .catch(() => {
        indexAt = 0; // tried again next time
        return [];
      });
  }
  return indexP;
}
/** Where a recording is read: the feed's copy, else the file the site ships (kept as the fallback). */
export function recordingUrls(contract: string, id: number): string[] {
  const base = feedBase();
  const file = recordingFile(contract, id);
  return [...(base ? [`${base}/rescue/${contract}/${id}.json`] : []), ...(file ? [`/replays/${file}`] : [])];
}

/** The live board's replay of a recorded rescue (mainnet, the Sepolia demo and the main testnet
 *  contract), or null for a contract the board doesn't replay. */
export function replayHref(contract: string, id: number): string | null {
  if (contract.endsWith(".near")) return `?replay=mainnet-${id}#/live`;
  if (contract === "steadfi.testnet") return `?replay=steadfi:${id}#/live`;
  if (contract === "sepolia-demo.steadfi.testnet") return `?replay=sepolia-demo:${id}#/live`;
  return null;
}
/** The flow's way to the replay, once the rescue's recording is in hand. */
export function replayLink(contract: string, id: number, rec: Recording | null): string {
  const href = rec ? replayHref(contract, id) : null;
  return href ? `<p class="st-flow-replay"><a class="st-secondary st-cut st-secondary--link" href="${href}"><span class="cut-label">Replay rescue ${id} on the board</span></a><span class="st-flow-replay-note">every event, each linked to its transaction</span></p>` : "";
}

/** The recordings the site ships: which contract and rescue each one is. */
export const RECORDINGS: { contract: string; rescueId: number; file: string }[] = [
  { contract: "app.usestead.near", rescueId: 82, file: "mainnet-rescue-82.json" },
  { contract: "app.usestead.near", rescueId: 81, file: "mainnet-rescue-81.json" },
  { contract: "app.usestead.near", rescueId: 78, file: "mainnet-rescue-78.json" },
  { contract: "sepolia-demo.steadfi.testnet", rescueId: 8, file: "sepolia-demo-rescue-8.json" },
  { contract: "sepolia-demo.steadfi.testnet", rescueId: 10, file: "sepolia-demo-rescue-10.json" },
  { contract: "sepolia-demo.steadfi.testnet", rescueId: 11, file: "sepolia-demo-rescue-11.json" },
];
export const recordingFile = (contract: string, id: number) => RECORDINGS.find((r) => r.contract === contract && r.rescueId === id)?.file ?? null;

const HOSTS: Record<string, TxLink["label"]> = { "nearblocks.io": "NearBlocks", "testnet.nearblocks.io": "NearBlocks", "etherscan.io": "Etherscan", "sepolia.etherscan.io": "Etherscan" };
/** An evidence link, only to the two explorers (a local-copy event has none). */
export function txLink(e: Evidence | undefined): TxLink | null {
  if (!e?.url || !e.tx) return null;
  let host: string;
  try {
    const u = new URL(e.url);
    if (u.protocol !== "https:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  const label = HOSTS[host];
  return label ? { href: e.url, label, ref: e.tx } : null;
}

const short = (s: string | null | undefined) => (s ?? "").split(".")[0];
/** Decimal strings to 18-place integers and back (sums of recorded amounts, never through a float). */
const dec = (v: string) => {
  const [w, fr = ""] = v.split(".");
  return BigInt(w || "0") * 10n ** 18n + BigInt((fr + "0".repeat(18)).slice(0, 18) || "0");
};
const undec = (v: bigint) => {
  const r = (v + 5n * 10n ** 11n) / 10n ** 12n; // rounded to 6 places
  const fr = (r % 10n ** 6n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${r / 10n ** 6n}${fr ? `.${fr}` : ""}`;
};

/** The flow with each step's recorded transactions (`txs`), when `rec` is this rescue's recording.
 *  A recording of another contract or rescue changes nothing. */
export function attachRecorded(flow: FlowStep[], rec: Recording | null, contract: string): FlowStep[] {
  if (!rec || rec.contract !== contract || !flow.length || rec.rescueId !== flow[0].rescueId) return flow;
  const ev = rec.events;
  const of = (kind: string, pick: (e: RecEvent) => boolean = () => true) => ev.filter((e) => e.kind === kind && pick(e));
  const links = (...es: (Evidence | undefined)[]) => es.map(txLink).filter((x): x is TxLink => !!x);
  // each steward's bids in the order it sent them: the nth bid on the contract is its nth recorded bid
  const bidSeen = new Map<string, number>();
  const timeOf = (e: RecEvent | undefined) => (rec.openedAtMs && e?.t !== undefined ? Math.round(rec.openedAtMs + e.t * 1000) : null);
  const out: FlowStep[] = [];
  for (let f of flow) {
    let txs: TxLink[] = [];
    const parts = f.key.split(":");
    switch (f.kind) {
      case "open":
        txs = links(of("AUCTION_OPEN")[0]?.evidence);
        break;
      case "bid": {
        // the contract keeps a steward's latest bid only: match its premium (the last such bid),
        // else the steward's bids in the order it sent them
        const s = short(parts[2]);
        const n = bidSeen.get(s) ?? 0;
        bidSeen.set(s, n + 1);
        const mine = of("BID", (e) => short(e.steward) === s);
        const same = mine.filter((e) => f.figure && String(e.bps) === f.figure.value);
        txs = links((same.at(-1) ?? mine[n])?.evidence);
        break;
      }
      case "close":
        txs = links(of("AUCTION_CLOSE")[0]?.evidence);
        break;
      case "topup":
        txs = links(of("TOPUP_SENT", (e) => short(e.steward) === short(parts[2]))[0]?.evidence);
        break;
      case "proven": {
        const own = of("TOPUP_CONFIRMED", (e) => short(e.steward) === short(parts[2]));
        txs = links((own[0] ?? of("TOPUP_CONFIRMED", (e) => !e.steward)[0])?.evidence);
        break;
      }
      case "claim":
        txs = links(of("CLAIM_MINTED", (e) => e.claim === parts.slice(1).join(":"))[0]?.evidence);
        break;
      case "escrow":
        txs = links(of("PAYMENT_IN")[0]?.evidence, of("ESCROW_PROVEN")[0]?.evidence);
        break;
      case "payout": {
        const p = of("PAYOUT", (e) => e.claim === parts.slice(1).join(":"))[0];
        txs = links(p?.evidence, p?.transfer);
        break;
      }
      case "bought":
        txs = links(of("BOUGHT_BACK")[0]?.evidence);
        break;
      case "settle": {
        txs = links(of("SETTLE_START")[0]?.evidence);
        // the contract keeps the settler it ended with: the one who started it was the stalled one
        const by = of("SETTLE_TAKEOVER")[0];
        if (by?.from) f = { ...f, actor: short(by.from), html: f.html.replace(/ by <strong>[^<]*<\/strong>$/, ` by <strong>${short(by.from)}</strong>`) };
        break;
      }
      case "repay": {
        const r = of("SETTLE_REPAY")[0];
        txs = links(r?.evidence, r?.near);
        break;
      }
      case "leg": {
        const i = Number(parts[2]);
        const indexed = ev.some((e) => e.kind === "SETTLE_LEG" && e.leg !== undefined);
        const e = indexed ? of("SETTLE_LEG", (x) => x.leg === i)[0] : of("SETTLE_LEG")[i];
        txs = links(e?.evidence);
        // a takeover's fee leg carries the stalled claim but pays the steward that took over
        if (e?.purpose === "fee" && e.steward) {
          const by = of("SETTLE_TAKEOVER")[0];
          const amt = f.figure ? `${f.figure.value} ${f.figure.unit}` : "The fee";
          f = { ...f, title: `${f.figure?.unit ?? "Collateral"} paid to ${e.steward}`, text: `${amt} withdrawn from Aave and sent to ${e.steward}'s payout: the takeover fee${by?.from ? `, from ${short(by.from)}'s premium` : ""}.`, html: `${amt} withdrawn from Aave and paid to <strong>${e.steward}</strong>'s payout (the takeover fee)` };
        }
        break;
      }
      case "settled": {
        txs = links(of("SETTLED")[0]?.evidence);
        // what each steward was paid, from the legs as they landed (a fee leg pays the taker, not
        // the claim's owner)
        const legs = of("SETTLE_LEG", (e) => e.purpose !== "batch" && !!e.steward && !!e.amount);
        if (legs.length) {
          const paid = new Map<string, bigint>();
          for (const e of legs) paid.set(e.steward!, (paid.get(e.steward!) ?? 0n) + dec(e.amount!));
          const asset = legs[0].asset ?? "";
          const parts = [...paid].map(([w, v]) => `${w} paid ${undec(v)} ${asset}`);
          f = { ...f, text: `Every leg landed: ${parts.map((p) => `${p} in all`).join(", ")}. The claim is closed.`, html: `Settled: ${[...paid].map(([w, v]) => `<strong>${w}</strong> paid ${undec(v)} ${asset}`).join(", ")}` };
        }
        break;
      }
    }
    // one link per transaction (a claim is minted in the proof's own transaction: both keep it)
    const seen = new Set<string>();
    txs = txs.filter((t) => !seen.has(t.href) && (seen.add(t.href), true));
    // a step the contract keeps no time for takes its transaction's recorded time (never earlier
    // than the step before it)
    const prevAt = out.length ? out[out.length - 1].atMs : -Infinity;
    const recAt = f.exactMs === null && txs.length ? timeOf(ev.find((e) => e.evidence?.url === txs[0].href || e.near?.url === txs[0].href)) : null;
    if (recAt !== null && recAt >= prevAt) f = { ...f, exactMs: recAt, atMs: recAt, afterMs: recAt };
    out.push(txs.length ? { ...f, txs } : f);
    // the settlement taken over: its own step, after the start
    if (f.kind === "settle")
      for (const t of of("SETTLE_TAKEOVER")) {
        const at = timeOf(t) ?? f.atMs + 1;
        const link = links(t.evidence);
        out.push({ key: `takeover:${f.rescueId}:${short(t.to)}`, kind: "takeover", rescueId: f.rescueId, order: f.order, atMs: at, exactMs: timeOf(t), afterMs: at, actor: short(t.to) || "contract", title: "Settlement taken over", text: `${short(t.from) || "The settler"} had not repaid within its time: ${short(t.to) || "another steward"} takes over the settlement and repays instead.`, html: `Settlement taken over by <strong>${short(t.to)}</strong> from <strong>${short(t.from)}</strong>`, ...(link.length ? { txs: link } : {}) });
      }
  }
  return out;
}

const cache = new Map<string, Promise<Recording | null>>();
/** The recording of a rescue, when the site publishes one (fetched once, then kept). */
export function loadRecording(contract: string, id: number, fetcher: typeof fetch = fetch): Promise<Recording | null> {
  const k = `${contract}#${id}`;
  if (!cache.has(k)) {
    const valid = (j: any) => (j && j.contract === contract && j.rescueId === id && Array.isArray(j.events) && j.events.length ? (j as Recording) : null);
    const p = (async () => {
      for (const url of recordingUrls(contract, id)) {
        const got = await fetcher(url, { signal: AbortSignal.timeout(10_000) })
          .then((r) => (r.ok ? r.json() : null))
          .then(valid)
          .catch(() => null);
        if (got) return got;
      }
      return null;
    })();
    // not recorded yet: asked again after a minute (it appears a few minutes after the rescue ends)
    void p.then((r) => r || setTimeout(() => cache.delete(k), 60_000));
    cache.set(k, p);
  }
  return cache.get(k)!;
}
const held = new Map<string, Recording | null>();
/** The recording if it has already arrived (else null, and it starts loading; `then` runs when it lands). */
export function recordingNow(contract: string, id: number, then?: () => void): Recording | null {
  const k = `${contract}#${id}`;
  if (held.has(k)) return held.get(k)!;
  void loadRecording(contract, id).then((r) => {
    const first = !held.has(k);
    held.set(k, r);
    if (first && r) then?.();
  });
  return null;
}

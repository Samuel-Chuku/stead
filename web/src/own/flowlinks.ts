// Explorer links for a rescue's flow, from the board's recording of that rescue (web/public/replays):
// each recorded event carries the transaction that made it ({chain, tx, url}). A flow step built from
// the contract's records gets the matching transactions: a bid its steward's bid, the close its
// close_auction call, a top-up the steward's supply on Ethereum, a proof the verified read, a claim
// the NEAR transaction that minted it, a buy-back the borrower's transfer and its proof, a payout the
// contract's pay call and the Ethereum transfer. Pure: the page fetches the recording.
import type { FlowStep } from "./net";

export type TxLink = { href: string; label: "NearBlocks" | "Etherscan"; ref: string };
type Evidence = { chain?: string; tx?: string; url?: string };
export type RecEvent = { kind: string; steward?: string | null; bps?: number; claim?: string | null; purpose?: string; evidence?: Evidence; transfer?: Evidence };
export type Recording = { contract: string; rescueId: number; events: RecEvent[] };

/** The published recordings: which contract and rescue each one is. */
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

/** The flow with each step's recorded transactions (`txs`), when `rec` is this rescue's recording.
 *  A recording of another contract or rescue changes nothing. */
export function attachRecorded(flow: FlowStep[], rec: Recording | null, contract: string): FlowStep[] {
  if (!rec || rec.contract !== contract || !flow.length || rec.rescueId !== flow[0].rescueId) return flow;
  const ev = rec.events;
  const of = (kind: string, pick: (e: RecEvent) => boolean = () => true) => ev.filter((e) => e.kind === kind && pick(e));
  const links = (...es: (Evidence | undefined)[]) => es.map(txLink).filter((x): x is TxLink => !!x);
  // each steward's bids in the order it sent them: the nth bid on the contract is its nth recorded bid
  const bidSeen = new Map<string, number>();
  return flow.map((f) => {
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
      case "settle":
        txs = links(of("SETTLE_START")[0]?.evidence);
        break;
      case "repay":
        txs = links(of("SETTLE_REPAY")[0]?.evidence);
        break;
      case "leg":
        txs = links(of("SETTLE_LEG")[Number(parts[2])]?.evidence);
        break;
      case "settled":
        txs = links(of("SETTLED")[0]?.evidence);
        break;
    }
    // one link per transaction (a claim is minted in the proof's own transaction: both keep it)
    const seen = new Set<string>();
    txs = txs.filter((t) => !seen.has(t.href) && (seen.add(t.href), true));
    return txs.length ? { ...f, txs } : f;
  });
}

const cache = new Map<string, Promise<Recording | null>>();
/** The recording of a rescue, when the site publishes one (fetched once, then kept). */
export function loadRecording(contract: string, id: number, fetcher: typeof fetch = fetch): Promise<Recording | null> {
  const file = recordingFile(contract, id);
  if (!file) return Promise.resolve(null);
  if (!cache.has(file))
    cache.set(
      file,
      fetcher(`/replays/${file}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (j && j.contract === contract && j.rescueId === id && Array.isArray(j.events) ? (j as Recording) : null))
        .catch(() => null),
    );
  return cache.get(file)!;
}
const held = new Map<string, Recording | null>();
/** The recording if it has already arrived (else null, and it starts loading; `then` runs when it lands). */
export function recordingNow(contract: string, id: number, then?: () => void): Recording | null {
  const k = `${contract}#${id}`;
  if (held.has(k)) return held.get(k)!;
  if (!recordingFile(contract, id)) return null;
  void loadRecording(contract, id).then((r) => {
    const first = !held.has(k);
    held.set(k, r);
    if (first && r) then?.();
  });
  return null;
}

// The list pages on mainnet: Stead's contract on NEAR mainnet (app.usestead.near), read only, through
// the same records builder the testnet lists use (get_rescues, get_position, get_claim, get_roles,
// get_market), so every renderer is shared. Public NEAR RPCs rate-limit: one view at a time, gently,
// and the result is kept for a few minutes in memory.
import { buildRecords, fetchContract, linkRecords, type Records } from "../../../stewards/src/records";
import { NETS } from "../own/net";
import { view } from "../mainnet/chainlist";
import { feedRecordings, loadRecording } from "../own/flowlinks";
import { contractSnapshot } from "../own/snapshot";

export type ListNet = "testnet" | "mainnet";
export const NET_KEY = "stead.lists.net";
export const MAINNET_NOTE = "Real funds, capped at $150 per position; not open to the public (unaudited contract).";

/** The list pages' network: ?net= wins, then this tab's last choice, else testnet. */
export function listNet(search: string, stored: string | null): ListNet {
  const q = new URLSearchParams(search).get("net");
  if (q === "mainnet" || q === "testnet") return q;
  return stored === "mainnet" ? "mainnet" : "testnet";
}
export function readStoredNet(): string | null {
  try {
    return sessionStorage.getItem(NET_KEY);
  } catch {
    return null;
  }
}
/** Remember the choice for this tab and put it in the address (?net=mainnet; testnet is the default, so no parameter). */
export function chooseNet(n: ListNet) {
  try {
    sessionStorage.setItem(NET_KEY, n);
  } catch {
    /* private mode: the address still carries it */
  }
  const u = new URL(location.href);
  if (n === "mainnet") u.searchParams.set("net", "mainnet");
  else u.searchParams.delete("net");
  history.replaceState(null, "", u);
  for (const el of document.querySelectorAll<HTMLElement>('[data-status="network"]')) el.textContent = n === "mainnet" ? "Ethereum" : "Sepolia";
  dispatchEvent(new CustomEvent("stead:net", { detail: n })); // the sidebar's readings and stewards follow
}

/** Token symbols for the mainnet market, from the app's verified addresses (no extra chain read). */
export function symbolOf(address: string): string {
  const m = NETS.mainnet;
  for (const t of [m.collateral, m.debt]) if (t.address.toLowerCase() === address.toLowerCase()) return t.symbol;
  return address.slice(0, 8);
}

/** The mainnet recordings the site ships (the fallback when the live feed can't be reached); the
 *  feed records every mainnet rescue a few minutes after it ends. */
export const MAINNET_RECORDINGS = [82, 81, 78];

let cache: { rec: Records; at: number; keepMs: number } | null = null;
export async function loadMainnetRecords(signal: AbortSignal): Promise<Records> {
  if (cache && Date.now() - cache.at < cache.keepMs) return cache.rec;
  const contract = NETS.mainnet.contract;
  // the live feed's copy of the contract (one request); the chain itself only when the feed can't answer
  const snap = await contractSnapshot(contract);
  const gentle = async <T>(_c: string, method: string, args: object): Promise<T> => {
    await new Promise((r) => setTimeout(r, 350));
    return view<T>(method, args, signal);
  };
  const raw = snap?.raw ?? (await fetchContract(contract, gentle, async (a) => symbolOf(a)));
  const logs = new Map<string, { events: any[] }>();
  const fromFeed = (await feedRecordings()).filter((x) => x.contract === contract).map((x) => x.rescueId);
  await Promise.all(
    [...new Set([...fromFeed, ...MAINNET_RECORDINGS])].map((id) => loadRecording(contract, id).then((j) => j && logs.set(`${contract}#${id}`, j as any), () => {})),
  );
  const rec = linkRecords(buildRecords([raw]), logs);
  cache = { rec, at: Date.now(), keepMs: snap ? 20_000 : 5 * 60_000 };
  return rec;
}

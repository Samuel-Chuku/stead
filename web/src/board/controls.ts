// The board's control bar, as data: which recordings the Watch menu lists and in what groups, and
// the one network/market chip for the recording on screen. Pure (tested in stewards/tests).
import type { RescueLog } from "../../../stewards/src/rescuelog";

/** A recording the board can replay. `net` decides its group in the Watch menu. */
export type Recording = { id: string; label: string; url: string; net: "mainnet" | "testnet" };

/** Watch menu groups, real funds first; empty groups are dropped, each group keeps its order. */
export const GROUPS: { net: Recording["net"]; label: string }[] = [
  { net: "mainnet", label: "Ethereum mainnet (real funds)" },
  { net: "testnet", label: "Sepolia" },
];
export function replayGroups<T extends { net?: Recording["net"] }>(list: T[]): { label: string; items: T[] }[] {
  return GROUPS.map((g) => ({ label: g.label, items: list.filter((r) => (r.net ?? "testnet") === g.net) })).filter((g) => g.items.length > 0);
}

/** The single chip naming where the recording on screen ran. */
export function marketChip(log: Pick<RescueLog, "evmChain" | "market">): string {
  const m = log.market;
  if (log.evmChain === "ethereum") return `ETHEREUM MAINNET · ${m.collateral}/${m.debt}`;
  if (log.evmChain === "fork") return `LOCAL FORK · MARKET ${m.id} · ${m.collateral}/${m.debt}`;
  return `SEPOLIA · MARKET ${m.id} · ${m.collateral}/${m.debt}`;
}

/** The EVM chain's name in journal lines ("Sepolia block 123", "Ethereum block 123"). */
export const evmName = (evmChain: string) => (evmChain === "ethereum" ? "Ethereum" : evmChain === "fork" ? "Fork" : "Sepolia");

/** The flip clock's four digits (MMSS) for whole seconds left; 99:59 at most. */
export function clockDigits(sec: number): string {
  const t = Math.max(0, Math.min(5999, Math.floor(sec)));
  return String(Math.floor(t / 60)).padStart(2, "0") + String(t % 60).padStart(2, "0");
}

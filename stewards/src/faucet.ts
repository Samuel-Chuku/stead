// The sponsored test-funds faucet for visitors who try Stead with their own wallets. Pure rules
// (tested offline); the runner sends. Amounts are what one own-wallet rescue needs, measured on the
// demo runs, with a margin: ~13 Stead calls at ~0.0018 NEAR each; ~10 position transactions at
// ~0.000023 ETH each but 600k gas × 2 gwei (0.0012 ETH) up front per transaction; 60 LINK of collateral
// plus ~20 LINK for the buy-back; a little DAI for interest when closing.

export const FAUCET = {
  nearYocto: 40_000_000_000_000_000_000_000n, // 0.04 NEAR
  ethWei: 2_500_000_000_000_000n, // 0.0025 ETH: 0.0015 for the position's gas, the rest for the wallet's own transfers
  link: 80n * 10n ** 18n,
  dai: 5n * 10n ** 18n,
  /** Once per NEAR account, per Sepolia address and per visitor in this window. */
  perWalletMs: 24 * 3_600_000,
  /** Wallets served per UTC day, at most. */
  perDay: 40,
  /** The reserve keeps this much for the demo slots; the faucet never dips into it. */
  reserveFloorWei: 300_000_000_000_000_000n, // 0.3 ETH
  /** The sponsor account keeps this much (storage + fees). */
  sponsorFloorYocto: 500_000_000_000_000_000_000_000n, // 0.5 NEAR
} as const;

export interface FaucetState {
  /** key ("near:<account>", "evm:<address>", "ip:<visitor>") → last time served (ms). */
  served: Record<string, number>;
  day: string;
  today: number;
}
export const freshFaucet = (): FaucetState => ({ served: {}, day: "", today: 0 });

export const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const EVM_RE = /^0x[0-9a-fA-F]{40}$/;

export type FaucetVerdict = { ok: true; near: string; evm: string } | { ok: false; status: number; error: string; nextAt?: number };

/** Decide a request. On ok the caller sends, then calls `recordFaucet`. */
export function checkFaucet(st: FaucetState, now: number, body: string, origin: string | undefined, allowedOrigins: string[], visitor: string, funds: { reserveWei: bigint; sponsorYocto: bigint }): FaucetVerdict {
  if (!origin || !allowedOrigins.includes(origin)) return { ok: false, status: 403, error: "origin not allowed" };
  if (body.length > 1024) return { ok: false, status: 400, error: "body too large" };
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(body);
    if (!b || typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => k !== "near" && k !== "evm")) throw new Error();
  } catch {
    return { ok: false, status: 400, error: 'body must be {"near": "<account>.testnet", "evm": "0x…"}' };
  }
  const near = typeof b.near === "string" ? b.near.toLowerCase() : "";
  const evm = typeof b.evm === "string" ? b.evm.toLowerCase() : "";
  if (!near.endsWith(".testnet") || near.length > 64 || !NEAR_ACCOUNT_RE.test(near)) return { ok: false, status: 400, error: "a NEAR testnet account is needed (….testnet)" };
  if (!EVM_RE.test(evm)) return { ok: false, status: 400, error: "a Sepolia address is needed (0x…)" };
  for (const k of [`near:${near}`, `evm:${evm}`, `ip:${visitor}`]) {
    const t = st.served[k];
    if (t !== undefined && now - t < FAUCET.perWalletMs) return { ok: false, status: 429, error: "these wallets (or this visitor) already got test funds today", nextAt: t + FAUCET.perWalletMs };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  if (st.day === day && st.today >= FAUCET.perDay) return { ok: false, status: 429, error: "today's sponsored test funds are used up; bring your own testnet NEAR and Sepolia ETH, or try tomorrow", nextAt: Date.parse(day) + 86_400_000 };
  if (funds.reserveWei < FAUCET.reserveFloorWei + FAUCET.ethWei) return { ok: false, status: 503, error: "the sponsor's Sepolia ETH is being refilled" };
  if (funds.sponsorYocto < FAUCET.sponsorFloorYocto + FAUCET.nearYocto) return { ok: false, status: 503, error: "the sponsor's NEAR is being refilled" };
  return { ok: true, near, evm };
}

export function recordFaucet(st: FaucetState, now: number, near: string, evm: string, visitor: string) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (st.day !== day) {
    st.day = day;
    st.today = 0;
  }
  st.today += 1;
  for (const k of [`near:${near}`, `evm:${evm}`, `ip:${visitor}`]) st.served[k] = now;
  for (const [k, t] of Object.entries(st.served)) if (now - t >= FAUCET.perWalletMs) delete st.served[k];
}

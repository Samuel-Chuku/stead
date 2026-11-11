// Steward capital arriving through NEAR Intents.
// A real steward keeps its working capital on NEAR (USDC) and, when it wins a top-up larger than its
// EVM balance, asks NEAR Intents solvers to deliver the asset on the EVM chain. NEAR Intents has no
// testnet, so on testnets this module does two things:
//  1. asks the real NEAR Intents 1Click API for a DRY quote (no deposit, no funds move) for the same
//     asset on Ethereum mainnet: what the delivery would cost and how long it would take;
//  2. delivers the test tokens from Aave's public test-token faucet, labelled SIMULATED.
// A quote failure never blocks a rescue: it's logged and the faucet still delivers.
import { type Address } from "viem";
import { balance, faucet, type wallet } from "./fork.js";
import { log, fmt } from "./log.js";

export const INTENTS_LABEL = "[SIMULATED delivery: no NEAR Intents testnet exists; the faucet delivers the test tokens]";
export const ONECLICK_API = process.env.ONECLICK_API || "https://1click.chaindefuser.com/v0";
/** USDC on NEAR (the steward's working capital), as a 1Click asset id. */
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** The same assets on Ethereum mainnet (canonical token addresses), as 1Click asset ids. */
const ON_ETHEREUM: Record<string, { id: string; decimals: number }> = {
  LINK: { id: "nep141:eth-0x514910771af9ca656af840dff83e8264ecf986ca.omft.near", decimals: 18 },
  WBTC: { id: "nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near", decimals: 8 },
  // WETH has no direct 1Click liquidity: native ETH is delivered and the steward wraps it (1:1)
  WETH: { id: "nep141:eth.omft.near", decimals: 18 },
};

export interface IntentsQuote {
  amountIn: number; // USDC on NEAR
  amountInUsd: number;
  amountOutUsd: number;
  costBps: number; // (in − out) / out, fees included
  seconds: number;
}

/** A DRY 1Click quote: `units` of `symbol` on Ethereum, paid in USDC on NEAR. Nothing is deposited. */
export async function dryQuote(symbol: string, units: bigint, decimals: number, recipient: Address, fetchFn: typeof fetch = fetch): Promise<IntentsQuote> {
  const dest = ON_ETHEREUM[symbol];
  if (!dest) throw new Error(`no Ethereum asset for ${symbol}`);
  // the test token's decimals may differ from the mainnet token's
  const amount = dest.decimals === decimals ? units : (units * 10n ** BigInt(dest.decimals)) / 10n ** BigInt(decimals);
  const body = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: USDC_NEAR,
    depositType: "INTENTS",
    destinationAsset: dest.id,
    amount: amount.toString(),
    refundTo: process.env.STEWARD_INTENTS_ACCOUNT || "stead-steward.near",
    refundType: "INTENTS",
    recipient: recipient.toLowerCase(),
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
  const r = await fetchFn(`${ONECLICK_API}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as { quote?: { amountInFormatted: string; amountInUsd: string; amountOutUsd: string; timeEstimate: number }; message?: string };
  if (!r.ok || !j.quote) throw new Error(`1Click ${r.status}: ${j.message ?? "no quote"}`);
  const q = j.quote;
  const inUsd = Number(q.amountInUsd);
  const outUsd = Number(q.amountOutUsd);
  return { amountIn: Number(q.amountInFormatted), amountInUsd: inUsd, amountOutUsd: outUsd, costBps: outUsd > 0 ? ((inUsd - outUsd) / outUsd) * 10_000 : 0, seconds: q.timeEstimate };
}

/** Make sure `w` holds `units` of `token`; any shortfall is quoted on NEAR Intents (dry) and delivered by the faucet. */
export async function sourceCapital(who: string, w: ReturnType<typeof wallet>, token: Address, symbol: string, units: bigint, decimals = 18): Promise<bigint> {
  const have = await balance(token, w.address);
  if (have >= units) return 0n;
  const short = units - have;
  log(who, `capital: needs ${fmt(short, decimals)} more ${symbol} on the EVM side → NEAR Intents, USDC on NEAR → ${symbol}`);
  try {
    const q = await dryQuote(symbol, short, decimals, w.address);
    log(who, `capital: REAL NEAR Intents quote (dry, nothing deposited): ${q.amountIn.toFixed(2)} USDC on NEAR → ${fmt(short, decimals)} ${symbol} on Ethereum mainnet, cost ${q.costBps.toFixed(0)} bps incl. fees, ~${q.seconds} s`);
  } catch (e) {
    log(who, `capital: NEAR Intents quote unavailable (${(e as Error).message}); delivery continues`);
  }
  await faucet(w, token, w.address, short);
  log(who, `capital: ${fmt(short, decimals)} ${symbol} arrived ${INTENTS_LABEL}`);
  return short;
}

// ── the real path (Ethereum mainnet + NEAR mainnet only) ──
// 1Click, verified 2026-11-11 with a non-dry quote: an ORIGIN_CHAIN deposit of USDC on NEAR goes to a
// NEAR implicit account (64 hex, no memo); the swap starts when the transfer lands. Native ETH is
// delivered (no WETH liquidity) and the steward wraps it. If delivery isn't confirmed in time, the
// steward tops up from its own WETH: a slow solver never costs the bond.
export const USDC_NEAR_CONTRACT = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_STORAGE_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, the token's storage minimum
export const INTENTS_MAX_USDC = BigInt(Math.round(Number(process.env.INTENTS_MAX_USDC ?? 20) * 1e6));
export const INTENTS_MAX_COST_BPS = Number(process.env.INTENTS_MAX_COST_BPS ?? 400);

export interface LiveQuote {
  depositAddress: string;
  amountIn: bigint; // USDC, 6 dp: what we send (1Click refunds anything above what the swap used)
  minAmountIn: bigint;
  amountOutUsd: number;
  amountInUsd: number;
  costBps: number;
  seconds: number;
  deadline: string;
}
export interface Delivery {
  status: "SUCCESS" | "REFUNDED" | "FAILED" | "TIMEOUT";
  depositTx?: string; // NEAR ft_transfer
  deliveryTxs: string[]; // Ethereum, the solver's
  quote?: LiveQuote;
  note: string;
}
/** What the real path needs from the outside world (injected, so every rule is tested offline). */
export interface IntentsDeps {
  fetch: typeof fetch;
  nearView: <T>(contract: string, method: string, args: Record<string, unknown>) => Promise<T>;
  nearCall: (contract: string, method: string, args: Record<string, unknown>, deposit: bigint) => Promise<string>; // → tx hash
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export async function liveQuote(d: IntentsDeps, ethWei: bigint, recipient: Address, nearAccount: string): Promise<LiveQuote> {
  const body = {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: USDC_NEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: ON_ETHEREUM.WETH.id,
    amount: ethWei.toString(),
    refundTo: nearAccount,
    refundType: "ORIGIN_CHAIN",
    recipient: recipient.toLowerCase(),
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(d.now() + 30 * 60_000).toISOString(),
  };
  const r = await d.fetch(`${ONECLICK_API}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const j = (await r.json()) as { quote?: Record<string, string | number>; message?: string };
  if (!r.ok || !j.quote) throw new Error(`1Click ${r.status}: ${j.message ?? "no quote"}`);
  const q = j.quote;
  if (!/^[0-9a-f]{64}$/.test(String(q.depositAddress))) throw new Error(`unexpected deposit address ${String(q.depositAddress).slice(0, 20)}`);
  const inUsd = Number(q.amountInUsd), outUsd = Number(q.amountOutUsd);
  return { depositAddress: String(q.depositAddress), amountIn: BigInt(q.amountIn), minAmountIn: BigInt(q.minAmountIn ?? q.amountIn), amountInUsd: inUsd, amountOutUsd: outUsd, costBps: outUsd > 0 ? ((inUsd - outUsd) / outUsd) * 10_000 : 0, seconds: Number(q.timeEstimate), deadline: String(q.deadline) };
}

/** Pay the quote: register the deposit account on USDC if needed, then send exactly `amountIn`. */
export async function payQuote(d: IntentsDeps, q: LiveQuote): Promise<string> {
  if (q.amountIn > INTENTS_MAX_USDC) throw new Error(`quote asks ${Number(q.amountIn) / 1e6} USDC, above the ${Number(INTENTS_MAX_USDC) / 1e6} USDC cap: nothing sent`);
  if (q.costBps > INTENTS_MAX_COST_BPS) throw new Error(`quote costs ${q.costBps.toFixed(0)} bps, above the ${INTENTS_MAX_COST_BPS} bps cap: nothing sent`);
  const reg = await d.nearView<unknown>(USDC_NEAR_CONTRACT, "storage_balance_of", { account_id: q.depositAddress }).catch(() => null);
  if (!reg) await d.nearCall(USDC_NEAR_CONTRACT, "storage_deposit", { account_id: q.depositAddress, registration_only: true }, USDC_STORAGE_YOCTO);
  return d.nearCall(USDC_NEAR_CONTRACT, "ft_transfer", { receiver_id: q.depositAddress, amount: q.amountIn.toString(), memo: "stead steward capital" }, 1n);
}

/** Poll 1Click until the swap succeeds, is refunded or fails, or the budget runs out. */
export async function waitDelivery(d: IntentsDeps, depositAddress: string, depositTx: string, nearAccount: string, budgetMs: number): Promise<Delivery> {
  const until = d.now() + budgetMs;
  // optional, but it lets 1Click see the deposit sooner
  await d.fetch(`${ONECLICK_API}/deposit/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash: depositTx, depositAddress, nearSenderAccount: nearAccount }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
  let last = "PENDING_DEPOSIT";
  while (d.now() < until) {
    try {
      const r = await d.fetch(`${ONECLICK_API}/status?depositAddress=${depositAddress}`, { signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { status?: string; swapDetails?: { destinationChainTxHashes?: { hash: string }[] } };
      last = j.status ?? last;
      const txs = (j.swapDetails?.destinationChainTxHashes ?? []).map((t) => t.hash);
      if (last === "SUCCESS") return { status: "SUCCESS", depositTx, deliveryTxs: txs, note: "delivered" };
      if (last === "REFUNDED" || last === "FAILED") return { status: last, depositTx, deliveryTxs: txs, note: `1Click: ${last}` };
    } catch {
      /* a status read failing is not a swap failing: keep polling */
    }
    await d.sleep(3000);
  }
  return { status: "TIMEOUT", depositTx, deliveryTxs: [], note: `not delivered within ${Math.round(budgetMs / 1000)} s (last status ${last})` };
}

/** The whole real path for `ethWei` of ETH; never throws: the caller falls back on anything but SUCCESS. */
export async function deliverViaIntents(d: IntentsDeps, ethWei: bigint, recipient: Address, nearAccount: string, budgetMs: number): Promise<Delivery> {
  let q: LiveQuote | undefined;
  try {
    q = await liveQuote(d, ethWei, recipient, nearAccount);
    const tx = await payQuote(d, q);
    return { ...(await waitDelivery(d, q.depositAddress, tx, nearAccount, budgetMs)), quote: q };
  } catch (e) {
    return { status: "FAILED", deliveryTxs: [], quote: q, note: (e as Error).message };
  }
}

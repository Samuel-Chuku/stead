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

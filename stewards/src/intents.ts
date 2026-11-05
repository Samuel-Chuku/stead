// Steward capital arriving through NEAR Intents: SIMULATED.
// A real steward keeps its working capital on NEAR and, when it wins a top-up larger than its EVM
// balance, asks NEAR Intents solvers to deliver the asset on the EVM chain. There is no Intents
// deployment that delivers Aave's Sepolia test tokens, so this module stands in for the solver:
// it mints the shortfall from Aave's public test-token faucet and labels every line SIMULATED.
import { type Address } from "viem";
import { balance, faucet, type wallet } from "./fork.js";
import { log, fmt } from "./log.js";

export const INTENTS_LABEL = "[SIMULATED NEAR Intents: no solver delivers these test tokens; the faucet stands in]";

/** Make sure `w` holds `units` of `token`; any shortfall "arrives via Intents" (simulated). */
export async function sourceCapital(who: string, w: ReturnType<typeof wallet>, token: Address, symbol: string, units: bigint): Promise<bigint> {
  const have = await balance(token, w.address);
  if (have >= units) return 0n;
  const short = units - have;
  log(who, `capital: needs ${fmt(short)} more ${symbol} on the EVM side → intent "NEAR → ${symbol}" ${INTENTS_LABEL}`);
  await faucet(w, token, w.address, short);
  log(who, `capital: ${fmt(short)} ${symbol} arrived ${INTENTS_LABEL}`);
  return short;
}

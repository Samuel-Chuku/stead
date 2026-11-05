// Print the demo wallets' public addresses (never the keys).
import { privateKeyToAccount } from "viem/accounts";
import { env, STEWARDS } from "../src/config.js";

for (const k of ["BORROWER_EVM_KEY", ...STEWARDS.map((s) => `STEWARD_${s.toUpperCase()}_EVM_KEY`)]) {
  console.log(k.replace("_EVM_KEY", "").toLowerCase().padEnd(16), privateKeyToAccount(env(k) as `0x${string}`).address);
}

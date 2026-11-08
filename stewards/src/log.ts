// One-line, timestamped, labelled output. Every line in the local fork demo carries the trust label.
export const DEMO_LABEL = process.env.STEAD_EVM === "sepolia"
  ? "[Sepolia testnet: Aave readings verified on OutLayer (TEE); nonces and settlement repays still from the TEMPORARY reporter]"
  : process.env.STEAD_EVM === "ethereum"
    ? "[Ethereum MAINNET, real funds, capped: Aave readings verified on OutLayer (TEE); nonces and settlement repays still from the TEMPORARY reporter]"
    : "[unverified demo mode: local fork, TEMPORARY reporter]";

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;

export function log(who: string, msg: string) {
  console.log(`${stamp()} ${who.padEnd(8)} ${msg}`);
}

export const short = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const fmt = (units: bigint, dec = 18, dp = 4) => (Number(units) / 10 ** dec).toFixed(dp);

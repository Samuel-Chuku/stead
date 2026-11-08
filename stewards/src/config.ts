// Configuration from the repo's .env (gitignored) and the public fork address book.
// Secrets are read here and never printed.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_FILE = join(REPO, ".env");

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const fileEnv = existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, "utf8")) : {};
/** EVM side: "fork" (a local anvil copy), "sepolia" (testnet) or "ethereum" (mainnet, real funds). */
const EVM = process.env.STEAD_EVM === "sepolia" ? "sepolia" : process.env.STEAD_EVM === "ethereum" ? "ethereum" : "fork";
/** Which Aave deployment the EVM side talks to: Sepolia (default) or Ethereum (STEAD_AAVE=ethereum,
 *  always on Ethereum mainnet). */
export const AAVE_BOOK = process.env.STEAD_AAVE === "ethereum" || EVM === "ethereum" ? "ethereum" : "sepolia";
if (EVM === "sepolia" && AAVE_BOOK === "ethereum") throw new Error("STEAD_EVM=sepolia with the Ethereum address book: pick one chain");
const book = parseEnv(readFileSync(join(REPO, "fork", AAVE_BOOK === "ethereum" ? "addresses-ethereum.sh" : "addresses.sh"), "utf8"));

export function env(name: string, fallback?: string): string {
  const v = [process.env[name], fileEnv[name], fallback].find((x) => x !== undefined && x !== "");
  if (v === undefined || v === "") throw new Error(`missing ${name} in .env`);
  return v;
}

/** Append a value to .env (used once to create fork-only demo keys). Never logs the value. */
export function persistEnv(name: string, value: string) {
  appendFileSync(ENV_FILE, `\n${name}=${value}\n`);
  fileEnv[name] = value;
}
export function hasEnv(name: string) {
  return Boolean(process.env[name] || fileEnv[name]);
}

/** NEAR network: "testnet" (default) or "mainnet" (NEAR_NETWORK=mainnet). */
export const NEAR_NETWORK = (process.env.NEAR_NETWORK ?? fileEnv.NEAR_NETWORK) === "mainnet" ? "mainnet" : "testnet";
const NEAR_RPC_DEFAULT = NEAR_NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com";

export const cfg = {
  nearNetwork: NEAR_NETWORK,
  // mainnet reads its own .env names, so a testnet NEAR_RPC_URL in .env never applies to mainnet
  nearRpc: NEAR_NETWORK === "mainnet" ? env("MAINNET_NEAR_RPC_URL", NEAR_RPC_DEFAULT) : env("NEAR_RPC_URL", NEAR_RPC_DEFAULT),
  /** Transactions can go through another RPC than views (views are the high-volume part). */
  nearTxRpc: NEAR_NETWORK === "mainnet"
    ? env("MAINNET_NEAR_TX_RPC_URL", env("MAINNET_NEAR_RPC_URL", NEAR_RPC_DEFAULT))
    : env("NEAR_TX_RPC_URL", env("NEAR_RPC_URL", NEAR_RPC_DEFAULT)),
  contract: env("NEAR_CONTRACT_ID", "steadfi.testnet"),
  owner: env("NEAR_OWNER_ACCOUNT", "steadfi.testnet"),
  reporter: env("NEAR_REPORTER_ACCOUNT", "reporter.steadfi.testnet"),
  borrower: env("NEAR_BORROWER_ACCOUNT", "borrower.steadfi.testnet"),
  /** NEAR view RPCs tried in order after nearRpc (MAINNET_NEAR_RPC_FALLBACK / NEAR_RPC_FALLBACK). */
  nearFallback: (NEAR_NETWORK === "mainnet"
    ? process.env.MAINNET_NEAR_RPC_FALLBACK ?? fileEnv.MAINNET_NEAR_RPC_FALLBACK ?? "https://rpc.mainnet.fastnear.com,https://near.drpc.org,https://rpc.mainnet.near.org"
    : process.env.NEAR_RPC_FALLBACK ?? fileEnv.NEAR_RPC_FALLBACK ?? ""),
  credentialsDir: (NEAR_NETWORK === "mainnet" ? join(homedir(), ".near-credentials", "mainnet") : env("NEAR_CREDENTIALS_DIR", join(homedir(), ".near-credentials", "testnet"))).replace(/^~/, homedir()),
  /** EVM side: "fork" (local anvil copy, TEMPORARY reporter), "sepolia" (real testnet, readings
   *  verified on OutLayer) or "ethereum" (mainnet, real funds). Set STEAD_EVM. */
  evm: EVM as "fork" | "sepolia" | "ethereum",
  /** A real public chain (blocks arrive on their own; RPC answers can lag), not the local copy. */
  realChain: EVM !== "fork",
  forkRpc: EVM === "sepolia"
    ? env("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")
    : EVM === "ethereum"
      ? env("MAINNET_RPC_URL", "https://ethereum-rpc.publicnode.com")
      : env("FORK_RPC_URL", "http://127.0.0.1:8545"),
  chainId: EVM === "sepolia" ? 11155111 : EVM === "ethereum" ? 1 : Number(env("FORK_CHAIN_ID", "31337")),
  /** Real chains: more EVM RPCs tried in order when the first fails, one list per chain so a
   *  mainnet URL can never serve Sepolia (MAINNET_RPC_FALLBACK / SEPOLIA_RPC_FALLBACK, comma-separated).
   *  Ethereum mainnet defaults to public RPCs tested 2026-11-08. Reads and broadcasting an
   *  already-signed transaction are safe to retry elsewhere. */
  evmFallback: (EVM === "ethereum"
    ? process.env.MAINNET_RPC_FALLBACK ?? fileEnv.MAINNET_RPC_FALLBACK ?? "https://eth.drpc.org,https://ethereum-rpc.publicnode.com,https://eth-mainnet.public.blastapi.io,https://rpc.mevblocker.io"
    : EVM === "sepolia"
      ? process.env.SEPOLIA_RPC_FALLBACK ?? fileEnv.SEPOLIA_RPC_FALLBACK ?? ""
      : "")
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u && EVM !== "fork"),
  // Sepolia: market 2 (gas cap 670k, set from live measurements); market 1 is legacy (500k, too low for a first borrow)
  marketId: Number(env("STEAD_MARKET_ID", EVM === "sepolia" ? "2" : "0")),
  aave: {
    pool: book.AAVE_POOL as `0x${string}`,
    oracle: book.AAVE_ORACLE as `0x${string}`,
    /** Sepolia only: Aave's test-token faucet (undefined on Ethereum). */
    faucet: book.AAVE_FAUCET as `0x${string}` | undefined,
    link: book.LINK as `0x${string}`,
    aLink: book.A_LINK as `0x${string}`,
    dai: book.DAI as `0x${string}`,
  },
  forkAdmin: book.FORK_ADMIN as `0x${string}`,
};

// never mix networks: a mainnet run with a testnet RPC, key folder or contract (or the reverse) stops here
{
  const otherRpc = NEAR_NETWORK === "mainnet" ? /test/i : /mainnet/i; // "test.rpc.fastnear.com" has no "testnet"
  for (const [what, v] of [["NEAR RPC", cfg.nearRpc], ["NEAR tx RPC", cfg.nearTxRpc], ["NEAR key folder", cfg.credentialsDir]] as const) {
    if (otherRpc.test(v)) throw new Error(`NEAR_NETWORK=${NEAR_NETWORK} but the ${what} points at another network: set it for ${NEAR_NETWORK}`);
  }
  // accounts are judged by their suffix, not by words in the name (a testnet contract may be called "…-mainnet-dry.testnet")
  if ((NEAR_NETWORK === "mainnet") === cfg.contract.endsWith(".testnet")) throw new Error(`NEAR_NETWORK=${NEAR_NETWORK} but the contract is ${cfg.contract}`);
}

export const STEWARDS = ["patient", "swift", "deep", "pool", "hedged"] as const;
export type StewardName = (typeof STEWARDS)[number];
/** Each steward's NEAR account: `<name>.<STEWARD_ACCOUNT_PARENT>` (default `steadfi.testnet`). */
export const stewardAccount = (n: StewardName) => `${n}.${env("STEWARD_ACCOUNT_PARENT", "steadfi.testnet")}`;

/** NEAR full-access key from the legacy keychain, as `ed25519:...`. Never printed. */
export function nearKey(accountId: string): string {
  const f = join(cfg.credentialsDir, `${accountId}.json`);
  if (!existsSync(f)) throw new Error(`no NEAR credentials for ${accountId} in ${cfg.credentialsDir}`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  return j.private_key ?? j.secret_key;
}

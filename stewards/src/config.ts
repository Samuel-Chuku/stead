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
/** Which Aave deployment the EVM side talks to: Sepolia (default) or Ethereum (STEAD_AAVE=ethereum). */
export const AAVE_BOOK = process.env.STEAD_AAVE === "ethereum" ? "ethereum" : "sepolia";
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

export const cfg = {
  nearRpc: env("NEAR_RPC_URL", "https://test.rpc.fastnear.com"),
  /** Transactions can go through another RPC than views (views are the high-volume part). */
  nearTxRpc: env("NEAR_TX_RPC_URL", env("NEAR_RPC_URL", "https://test.rpc.fastnear.com")),
  contract: env("NEAR_CONTRACT_ID", "steadfi.testnet"),
  owner: env("NEAR_OWNER_ACCOUNT", "steadfi.testnet"),
  reporter: env("NEAR_REPORTER_ACCOUNT", "reporter.steadfi.testnet"),
  borrower: env("NEAR_BORROWER_ACCOUNT", "borrower.steadfi.testnet"),
  credentialsDir: env("NEAR_CREDENTIALS_DIR", join(homedir(), ".near-credentials", "testnet")).replace(/^~/, homedir()),
  /** EVM side: "fork" (local anvil fork, mock price, TEMPORARY reporter) or "sepolia" (real
   *  testnet, readings verified on OutLayer). Set STEAD_EVM=sepolia. */
  evm: (process.env.STEAD_EVM === "sepolia" ? "sepolia" : "fork") as "fork" | "sepolia",
  forkRpc: process.env.STEAD_EVM === "sepolia"
    ? env("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com")
    : env("FORK_RPC_URL", "http://127.0.0.1:8545"),
  chainId: process.env.STEAD_EVM === "sepolia" ? 11155111 : Number(env("FORK_CHAIN_ID", "31337")),
  // Sepolia: market 2 (gas cap 670k, set from live measurements); market 1 is legacy (500k, too low for a first borrow)
  marketId: Number(env("STEAD_MARKET_ID", process.env.STEAD_EVM === "sepolia" ? "2" : "0")),
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

export const STEWARDS = ["patient", "swift", "deep", "pool", "hedged"] as const;
export type StewardName = (typeof STEWARDS)[number];
export const stewardAccount = (n: StewardName) => `${n}.steadfi.testnet`;

/** NEAR full-access key from the legacy keychain, as `ed25519:...`. Never printed. */
export function nearKey(accountId: string): string {
  const f = join(cfg.credentialsDir, `${accountId}.json`);
  if (!existsSync(f)) throw new Error(`no NEAR credentials for ${accountId} in ${cfg.credentialsDir}`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  return j.private_key ?? j.secret_key;
}

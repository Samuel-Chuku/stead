// Create the demo runner's keys where it runs, once, and print only what others need: each demo
// borrower's NEAR public key (to create the account with) and the Sepolia addresses (to fund).
// Never prints or overwrites a private key; an existing key is kept.
//
//   npx tsx scripts/demo-keys.ts --near-dir <dir> --env <file> [--accounts demo.steadfi.testnet,demo-2.steadfi.testnet]
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const nearDir = arg("--near-dir");
const envFile = arg("--env");
if (!nearDir || !envFile) throw new Error("usage: --near-dir <dir> --env <file> [--accounts a,b]");
const accounts = (arg("--accounts") ?? "demo.steadfi.testnet,demo-2.steadfi.testnet").split(",");

mkdirSync(nearDir, { recursive: true, mode: 0o700 });
for (const a of accounts) {
  const f = join(nearDir, `${a}.json`);
  if (!existsSync(f)) {
    const k = KeyPair.fromRandom("ed25519");
    writeFileSync(f, JSON.stringify({ account_id: a, public_key: k.getPublicKey().toString(), private_key: k.toString() }), { mode: 0o600 });
  }
  console.log(`${a}  NEAR public key  ${JSON.parse(readFileSync(f, "utf8")).public_key}`);
}

const have = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
const names = [...accounts.map((_, i) => `DEMO_${i + 1}_EVM_KEY`), "DEMO_RESERVE_EVM_KEY"];
for (const n of names) {
  let key = have.match(new RegExp(`^${n}=(0x[0-9a-fA-F]{64})$`, "m"))?.[1];
  if (!key) {
    key = generatePrivateKey();
    appendFileSync(envFile, `${n}=${key}\n`, { mode: 0o600 });
  }
  console.log(`${n.replace("_EVM_KEY", "").padEnd(14)} Sepolia address  ${privateKeyToAccount(key as `0x${string}`).address}`);
}
chmodSync(envFile, 0o600);

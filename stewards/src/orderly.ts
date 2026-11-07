// Orderly Network perps client for the hedged steward. TESTNET ONLY: the base URL is fixed to
// Orderly's testnet, and nothing here can reach a mainnet venue.
//
// Account: an EVM wallet registers with a broker (EIP-712), then authorises an ed25519 trading
// key (EIP-712). Every private REST call is signed with that key. Keys live in the repo .env
// (ORDERLY_EVM_KEY, ORDERLY_KEY_SEED) and are never printed.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { env, hasEnv, persistEnv } from "./config.js";
import { generatePrivateKey } from "viem/accounts";

export const ORDERLY_API = "https://testnet-api.orderly.org";
export const ORDERLY_FAUCET = "https://testnet-operator-evm.orderly.org/v1/faucet/usdc";
export const BROKER_ID = process.env.ORDERLY_BROKER_ID ?? "demo";
const CHAIN_ID = 421614; // Arbitrum Sepolia: the chain the testnet account is registered on
const DOMAIN = { name: "Orderly", version: "1", chainId: CHAIN_ID, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" } as const;

/** The hedge market for a collateral symbol (the venue's perp on the same asset). */
export const PERP: Record<string, string> = { LINK: "PERP_LINK_USDC", WBTC: "PERP_BTC_USDC", WETH: "PERP_ETH_USDC", BTC: "PERP_BTC_USDC", ETH: "PERP_ETH_USDC" };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(b: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

const PKCS8_ED25519 = "302e020100300506032b657004220420";
function tradingKey() {
  const seed = Buffer.from(env("ORDERLY_KEY_SEED"), "hex");
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8_ED25519, "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x!, "base64url");
  return { priv, orderlyKey: `ed25519:${base58(pub)}` };
}

/** Create the venue keys in .env if missing (never printed). Returns the wallet address. */
export function ensureKeys(): string {
  if (!hasEnv("ORDERLY_EVM_KEY")) persistEnv("ORDERLY_EVM_KEY", generatePrivateKey());
  if (!hasEnv("ORDERLY_KEY_SEED")) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    persistEnv("ORDERLY_KEY_SEED", Buffer.from(der.subarray(der.length - 32)).toString("hex"));
  }
  return wallet().address;
}

const wallet = () => privateKeyToAccount(env("ORDERLY_EVM_KEY") as `0x${string}`);

async function publicGet<T = any>(path: string): Promise<T> {
  const r = await fetch(ORDERLY_API + path);
  const j: any = await r.json();
  if (!j.success) throw new Error(`orderly ${path}: ${j.message ?? r.status}`);
  return j.data;
}

/** The account id for our wallet and broker, or undefined if not registered yet. */
export async function accountId(): Promise<string | undefined> {
  const r = await fetch(`${ORDERLY_API}/v1/get_account?address=${wallet().address}&broker_id=${BROKER_ID}`);
  const j: any = await r.json();
  return j.success ? j.data.account_id : undefined;
}

/** Register the wallet with the broker and authorise the trading key (one-off, idempotent). */
export async function register(): Promise<string> {
  const w = wallet();
  let id = await accountId();
  if (!id) {
    const { registration_nonce } = await publicGet<{ registration_nonce: string }>("/v1/registration_nonce");
    const message = { brokerId: BROKER_ID, chainId: CHAIN_ID, timestamp: Date.now(), registrationNonce: registration_nonce };
    const signature = await w.signTypedData({
      domain: DOMAIN,
      types: { Registration: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "timestamp", type: "uint64" }, { name: "registrationNonce", type: "uint256" }] },
      primaryType: "Registration",
      message: { ...message, chainId: BigInt(CHAIN_ID), timestamp: BigInt(message.timestamp), registrationNonce: BigInt(registration_nonce) },
    });
    const r: any = await (await fetch(`${ORDERLY_API}/v1/register_account`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature, userAddress: w.address }) })).json();
    if (!r.success) throw new Error(`register_account: ${r.message}`);
    id = r.data.account_id as string;
  }
  const { orderlyKey } = tradingKey();
  const known: any = await (await fetch(`${ORDERLY_API}/v1/get_orderly_key?account_id=${id}&orderly_key=${encodeURIComponent(orderlyKey)}`)).json();
  if (!known.success) {
    const now = Date.now();
    const message = { brokerId: BROKER_ID, chainId: CHAIN_ID, orderlyKey, scope: "read,trading", timestamp: now, expiration: now + 300 * 86_400_000 };
    const signature = await w.signTypedData({
      domain: DOMAIN,
      types: { AddOrderlyKey: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "orderlyKey", type: "string" }, { name: "scope", type: "string" }, { name: "timestamp", type: "uint64" }, { name: "expiration", type: "uint64" }] },
      primaryType: "AddOrderlyKey",
      message: { ...message, chainId: BigInt(CHAIN_ID), timestamp: BigInt(message.timestamp), expiration: BigInt(message.expiration) },
    });
    const r: any = await (await fetch(`${ORDERLY_API}/v1/orderly_key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature, userAddress: w.address }) })).json();
    if (!r.success) throw new Error(`orderly_key: ${r.message}`);
  }
  return id;
}

/** Test USDC from the testnet faucet (1,000 per claim, 5 claims per account). */
export async function faucet(): Promise<string> {
  const r: any = await (await fetch(ORDERLY_FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_address: wallet().address, broker_id: BROKER_ID, chain_id: String(CHAIN_ID) }) })).json();
  if (!r.success) throw new Error(`faucet: ${r.message ?? JSON.stringify(r)}`);
  return JSON.stringify(r.data ?? r);
}

/** A signed private REST call: ed25519 over `timestamp + METHOD + path + body`. */
export async function privateCall<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: object): Promise<T> {
  const id = await accountId();
  if (!id) throw new Error("orderly account not registered (run the setup)");
  const { priv, orderlyKey } = tradingKey();
  const ts = Date.now().toString();
  const b = body ? JSON.stringify(body) : "";
  const sig = sign(null, Buffer.from(ts + method + path + b), priv).toString("base64url");
  const r = await fetch(ORDERLY_API + path, {
    method,
    headers: {
      "orderly-timestamp": ts,
      "orderly-account-id": id,
      "orderly-key": orderlyKey,
      "orderly-signature": sig,
      "content-type": method === "POST" ? "application/json" : "application/x-www-form-urlencoded",
    },
    body: b || undefined,
  });
  const j: any = await r.json();
  if (!j.success) throw new Error(`orderly ${method} ${path}: ${j.message ?? r.status}`);
  return j.data;
}

export interface Fill {
  orderId: number;
  qty: number; // base units, positive
}

/** Market order. `sell` opens/extends a short; a reduce-only buy closes it. */
export async function marketOrder(symbol: string, side: "SELL" | "BUY", qty: number, reduceOnly = false): Promise<Fill> {
  const d = await privateCall<{ order_id: number; order_quantity: number }>("POST", "/v1/order", { symbol, order_type: "MARKET", side, order_quantity: qty, reduce_only: reduceOnly });
  return { orderId: d.order_id, qty: d.order_quantity ?? qty };
}

/** Our open position in `symbol` (negative = short), in base units. */
export async function position(symbol: string): Promise<number> {
  const d = await privateCall<{ position_qty: number }>("GET", `/v1/position/${symbol}`);
  return d.position_qty ?? 0;
}

export async function holding(): Promise<{ token: string; holding: number }[]> {
  const d = await privateCall<{ holding: { token: string; holding: number }[] }>("GET", "/v1/client/holding");
  return d.holding;
}

export async function market(symbol: string) {
  const [info, fut] = await Promise.all([publicGet<any>(`/v1/public/info/${symbol}`), publicGet<any>(`/v1/public/futures/${symbol}`)]);
  return { baseTick: info.base_tick as number, baseMin: info.base_min as number, minNotional: info.min_notional as number, mark: fut.mark_price as number, estFunding: fut.est_funding_rate as number };
}

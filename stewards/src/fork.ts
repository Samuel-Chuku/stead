// EVM side: the local Sepolia fork (anvil, chain 31337) or Sepolia itself (STEAD_EVM=sepolia).
// Aave reads, steward/borrower wallets, and helpers (test-token faucet; fork-only gas funding and
// mock oracle price).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient, createWalletClient, createTestClient, http, parseAbi, defineChain, keccak256, encodeAbiParameters, toHex,
  type Hex, type Address, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cfg, REPO } from "./config.js";

export const fork = defineChain({
  id: cfg.chainId,
  name: cfg.evm === "sepolia" ? "sepolia" : "stead-fork",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.forkRpc] } },
});

export const pub: PublicClient = createPublicClient({ chain: fork, transport: http(cfg.forkRpc) }) as PublicClient;
export const test = createTestClient({ chain: fork, mode: "anvil", transport: http(cfg.forkRpc) });

export const poolAbi = parseAbi([
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function getReserveNormalizedVariableDebt(address asset) view returns (uint256)",
  "event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
  "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)",
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
]);
export const erc20Abi = parseAbi([
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const faucetAbi = parseAbi(["function mint(address token, address to, uint256 amount) returns (uint256)"]);
const mockAbi = parseAbi(["function setAnswer(int256)"]);

export const E18 = 10n ** 18n;
export const E8 = 10n ** 8n;
export const MAX = 2n ** 256n - 1n;
const U128_MAX = 2n ** 128n - 1n;

export function wallet(key: Hex): WalletClient & { address: Address } {
  const account = privateKeyToAccount(key);
  const w = createWalletClient({ account, chain: fork, transport: http(cfg.forkRpc) });
  return Object.assign(w, { address: account.address });
}

/** Send a contract write and wait for its receipt; returns the tx hash. */
export async function write(w: WalletClient, address: Address, abi: any, functionName: string, args: unknown[], onSent?: (hash: Hex) => void): Promise<Hex> {
  const hash = await w.writeContract({ address, abi, functionName, args, account: w.account!, chain: fork } as any);
  onSent?.(hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  return hash;
}

export async function accountData(user: Address) {
  const [c, d, , lt, , hf] = (await pub.readContract({ address: cfg.aave.pool, abi: poolAbi, functionName: "getUserAccountData", args: [user] })) as readonly bigint[];
  return { collateralBase: c, debtBase: d, ltBps: lt, hfWad: hf > U128_MAX ? U128_MAX : hf };
}

export async function price(asset: Address): Promise<bigint> {
  return (await pub.readContract({ address: cfg.aave.oracle, abi: oracleAbi, functionName: "getAssetPrice", args: [asset] })) as bigint;
}

export async function balance(token: Address, who: Address): Promise<bigint> {
  return (await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] })) as bigint;
}

// ── fork-only helpers (demo funding; nothing here exists on a real chain) ──

/** Gas funding for an address on the fork (on a real chain the position address needs ETH; here anvil sets it). */
export async function fundEth(who: Address, eth = 10n) {
  if (cfg.evm !== "fork") return; // real chain: funded by hand (testnet ETH)
  await test.setBalance({ address: who, value: eth * E18 });
}

/** Sepolia: mint test tokens from Aave's faucet (permissionless). A local copy of Ethereum: write
 *  the token balance directly (fork only). A real chain without a faucet: funded by hand. */
export async function faucet(w: WalletClient, token: Address, to: Address, units: bigint): Promise<void> {
  if (!cfg.aave.faucet) {
    if (cfg.evm !== "fork") throw new Error("no test-token faucet on this chain: fund the wallet by hand");
    return deal(token, to, (await balance(token, to)) + units);
  }
  const max = 10_000n * E18; // faucet per-call limit
  for (let left = units; left > 0n; left -= left > max ? max : left) {
    await write(w, cfg.aave.faucet, faucetAbi, "mint", [token, to, left > max ? max : left]);
  }
}

const balanceSlot = new Map<string, bigint>();
/** Fork only: set `to`'s balance of `token` by writing its storage. The balances mapping's slot is
 *  found once per token by probing (WETH 3, USDC 9, most ERC-20s 0–10). */
export async function deal(token: Address, to: Address, amount: bigint): Promise<void> {
  if (cfg.evm !== "fork") throw new Error("deal: fork only");
  const keyAt = (slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, slot]));
  const known = balanceSlot.get(token.toLowerCase());
  for (const slot of known !== undefined ? [known] : Array.from({ length: 21 }, (_, i) => BigInt(i))) {
    const key = keyAt(slot);
    const before = await pub.getStorageAt({ address: token, slot: key });
    await test.setStorageAt({ address: token, index: key, value: toHex(amount, { size: 32 }) });
    if ((await balance(token, to)) === amount) {
      balanceSlot.set(token.toLowerCase(), slot);
      return;
    }
    await test.setStorageAt({ address: token, index: key, value: before ?? toHex(0n, { size: 32 }) });
  }
  throw new Error(`deal: no balance slot found for ${token}`);
}

/** Ensure `who` holds at least `units` of `token` (mints the shortfall). */
export async function ensureTokens(w: WalletClient & { address: Address }, token: Address, units: bigint) {
  const have = await balance(token, w.address);
  if (have >= units) return;
  await faucet(w, token, w.address, units - have);
  // a load-balanced public RPC can answer from a node that hasn't seen the mint yet: wait until the
  // balance shows it, so the next transfer isn't simulated against the old balance
  for (let i = 0; i < 20 && (await balance(token, w.address)) < units; i++) await new Promise((r) => setTimeout(r, 1500));
}

const mockAddr = () => readFileSync(join(REPO, "fork", "state", "mock.addr"), "utf8").trim() as Address;

/** Set the mock LINK/USD answer (8 decimals). Returns the fork tx hash. */
export async function setLinkPrice(price8: bigint): Promise<Hex> {
  if (cfg.evm !== "fork") throw new Error("the mock price exists only on the local fork");
  const admin = createWalletClient({ account: cfg.forkAdmin, chain: fork, transport: http(cfg.forkRpc) });
  const hash = await admin.writeContract({ address: mockAddr(), abi: mockAbi, functionName: "setAnswer", args: [price8], account: cfg.forkAdmin, chain: fork });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

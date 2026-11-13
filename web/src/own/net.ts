// The "Protect a position" page on each network: one object per network holds every address, size,
// gas setting, link and sentence that differs, plus the pure arithmetic the page runs (no DOM, no
// wallet, no network: tested offline). Testnet is the default and works exactly as before; mainnet
// is real money on Ethereum, capped by the contract.

export type NetId = "testnet" | "mainnet";
export type Hex = `0x${string}`;
export type Token = { address: Hex; symbol: string; decimals: number };
/** The gas fields a contract-signed Ethereum transaction carries (the contract checks them against its market's caps). */
export type EvmGas = { gas_limit: string; max_fee_per_gas: string; max_priority_fee_per_gas: string };
/** The contract's market, as `get_market` returns it. */
export type MarketView = { chain_id: number; pool: string; collateral: string; debt: string; collateral_decimals: number; debt_decimals: number; lt_bps: number; liq_bonus_bps: number; gas_limit_cap: string; max_fee_cap: string };
export type LimitsView = { max_collateral_base: string; borrowers: string[] };
export type ParamsView = { trigger_hf_bps: number; target_hf_bps: number; auction_window_ns: string; topup_deadline_ns: string; buyback_window_ns: string };

export interface OwnNet {
  id: NetId;
  /** NEAR side */
  contract: string;
  market: number;
  nearName: string; // "NEAR testnet" / "NEAR mainnet"
  nearRpcs: string[];
  nearTx: (hash: string) => string;
  nearExplorer: string;
  /** Ethereum side */
  evmChainId: number;
  evmName: string; // "Sepolia" / "Ethereum"
  evmRpcs: string[];
  evmTx: (hash: string) => string;
  evmAddress: (a: string) => string;
  evmExplorer: string;
  pool: Hex;
  oracle: Hex;
  collateral: Token;
  debt: Token;
  /** The position's size and health targets. */
  collateralUnits: bigint;
  openHfBps: bigint; // opening borrows to this health
  pushHfBps: bigint; // "push under the trigger" takes it here
  /** How the push is made: borrow more (testnet) or withdraw a little collateral to the wallet (mainnet:
   *  one transaction, so it can't be split by the auction opening between a borrow and its transfer). */
  pushBy: "borrow" | "withdraw";
  /** Gas: fixed on testnet; on mainnet taken from the contract's market caps at run time. */
  evmGas: EvmGas;
  txUpfrontWei: bigint; // what the RPC wants available at the position before it sends one signed tx
  positionGasWei: bigint; // sent to a new position for its gas
  gasTopupWei: bigint; // sent when it runs low
  /** Small amounts for the "try to break it" requests the contract refuses during a rescue. */
  breakWithdrawUnits: bigint;
  breakBorrowUnits: bigint;
  /** What this network offers a visitor. */
  faucet: boolean; // free test funds
  sponsor: boolean; // the NEAR-only path (the sponsor holds the Ethereum side)
  liveFeed: boolean; // the live feed watches this contract (else the page reads the contract itself)
  readingBeforeSupply: boolean; // a size cap is set: the contract needs a price reading before a supply
  realFunds: boolean;
  /** The rescue story page's contract short name, when the feed records this contract's rescues. */
  storyContract: string | null;
  /** Default timing, replaced by the contract's own params once read. */
  auctionS: number;
}

const E18 = 10n ** 18n;

export const NETS: Record<NetId, OwnNet> = {
  testnet: {
    id: "testnet",
    contract: "sepolia-demo.steadfi.testnet",
    market: 1,
    nearName: "NEAR testnet",
    nearRpcs: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
    nearTx: (h) => `https://testnet.nearblocks.io/txns/${h}`,
    nearExplorer: "NearBlocks",
    evmChainId: 11155111,
    evmName: "Sepolia",
    evmRpcs: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.ethpandaops.io"],
    evmTx: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    evmAddress: (a) => `https://sepolia.etherscan.io/address/${a}#tokentxns`,
    evmExplorer: "Etherscan",
    pool: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
    oracle: "0x2da88497588bf89281816106C7259e31AF45a663",
    collateral: { address: "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5", symbol: "LINK", decimals: 18 },
    debt: { address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", symbol: "DAI", decimals: 18 },
    collateralUnits: 60n * E18,
    openHfBps: 11_400n,
    pushHfBps: 11_400n,
    pushBy: "borrow",
    evmGas: { gas_limit: "600000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "100000000" },
    txUpfrontWei: 600_000n * 2_000_000_000n,
    positionGasWei: 1_500_000_000_000_000n,
    gasTopupWei: 2_000_000_000_000_000n,
    breakWithdrawUnits: E18,
    breakBorrowUnits: E18,
    faucet: true,
    sponsor: true,
    liveFeed: true,
    readingBeforeSupply: false,
    realFunds: false,
    storyContract: "sepolia-demo",
    auctionS: 45,
  },
  mainnet: {
    id: "mainnet",
    contract: "app.usestead.near",
    market: 0,
    nearName: "NEAR mainnet",
    nearRpcs: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"],
    nearTx: (h) => `https://nearblocks.io/txns/${h}`,
    nearExplorer: "NearBlocks",
    evmChainId: 1,
    evmName: "Ethereum",
    evmRpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    evmTx: (h) => `https://etherscan.io/tx/${h}`,
    evmAddress: (a) => `https://etherscan.io/address/${a}#tokentxns`,
    evmExplorer: "Etherscan",
    // Aave V3 Ethereum core market (bgd-labs aave-address-book, AaveV3Ethereum); the oracle is also
    // what PoolAddressesProvider 0x2f39…4E9e returns from getPriceOracle()
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
    collateral: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    debt: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    collateralUnits: 4n * 10n ** 16n, // 0.04 WETH
    openHfBps: 12_000n,
    pushHfBps: 11_400n,
    pushBy: "withdraw",
    // replaced by the market's caps once read (gasFromMarket); these are the caps the market was set with
    evmGas: { gas_limit: "375332", max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "10000000" },
    txUpfrontWei: 375_332n * 1_000_000_000n,
    positionGasWei: 10n ** 15n, // 0.001 ETH: the up-front fee of one signed tx is 0.000375 ETH; real spend is far less
    gasTopupWei: 10n ** 15n,
    breakWithdrawUnits: 10n ** 15n, // 0.001 WETH
    breakBorrowUnits: 10n ** 6n, // 1 USDC
    faucet: false,
    sponsor: false,
    liveFeed: false,
    readingBeforeSupply: true,
    realFunds: true,
    storyContract: null,
    auctionS: 120,
  },
};

/** `?net=mainnet` (in the page address's query) selects mainnet; anything else is testnet. */
export function netFromSearch(search: string): NetId {
  return new URLSearchParams(search).get("net") === "mainnet" ? "mainnet" : "testnet";
}

/** The gas every contract-signed transaction carries, from the market's caps (the contract refuses
 *  anything above them). The priority fee stays the configured one, capped at the max fee. */
export function gasFromMarket(net: OwnNet, m: Pick<MarketView, "gas_limit_cap" | "max_fee_cap">): { evmGas: EvmGas; txUpfrontWei: bigint } {
  const limit = BigInt(m.gas_limit_cap);
  const fee = BigInt(m.max_fee_cap);
  const tip = BigInt(net.evmGas.max_priority_fee_per_gas);
  return {
    evmGas: { gas_limit: limit.toString(), max_fee_per_gas: fee.toString(), max_priority_fee_per_gas: (tip > fee ? fee : tip).toString() },
    txUpfrontWei: limit * fee,
  };
}

/** Does the contract's market point at the addresses this page expects? Returns the mismatches. */
export function marketMismatch(net: OwnNet, m: MarketView | null): string[] {
  if (!m) return [`market ${net.market} does not exist on ${net.contract}`];
  const out: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (m.chain_id !== net.evmChainId) out.push(`chain id ${m.chain_id}, expected ${net.evmChainId}`);
  if (!same(m.pool, net.pool)) out.push(`pool ${m.pool}`);
  if (!same(m.collateral, net.collateral.address)) out.push(`collateral ${m.collateral}`);
  if (!same(m.debt, net.debt.address)) out.push(`debt ${m.debt}`);
  if (m.collateral_decimals !== net.collateral.decimals || m.debt_decimals !== net.debt.decimals) out.push("token decimals");
  return out;
}

/** Whether a NEAR account may register a position: an empty allow-list lets anyone. */
export function allowed(limits: LimitsView | null, account: string | null): "yes" | "no" | "unknown" {
  if (!limits || !account) return "unknown";
  return !limits.borrowers.length || limits.borrowers.includes(account) ? "yes" : "no";
}

/** The size cap in whole dollars (Aave base units have 8 decimals); 0 = no cap. */
export const capUsd = (limits: LimitsView | null) => (limits ? Number(BigInt(limits.max_collateral_base) / 10n ** 8n) : 0);

/** Debt units to borrow so Aave's health factor becomes `hfBps` (collateral × liquidation threshold ÷ debt).
 *  Aave's values: collateral and debt in base units (8 dp), LT in bps, the debt token's price (8 dp). */
export function borrowUnits(collBase: bigint, debtBase: bigint, ltBps: bigint, hfBps: bigint, debtPrice: bigint, debtDecimals: number): bigint {
  const target = (collBase * ltBps) / hfBps;
  if (target <= debtBase || debtPrice <= 0n) return 0n;
  return ((target - debtBase) * 10n ** BigInt(debtDecimals)) / debtPrice;
}

/** Collateral units to withdraw so the health factor falls to `hfBps` (debt unchanged). */
export function withdrawUnits(collBase: bigint, debtBase: bigint, ltBps: bigint, hfBps: bigint, collPrice: bigint, collDecimals: number): bigint {
  if (debtBase === 0n || ltBps === 0n || collPrice <= 0n) return 0n;
  const keep = (debtBase * hfBps + ltBps - 1n) / ltBps; // round up: never below the target
  if (keep >= collBase) return 0n;
  return ((collBase - keep) * 10n ** BigInt(collDecimals)) / collPrice;
}

/** Debt units that repay `debtBase` with a small margin (interest keeps accruing; Aave's "max" refunds the rest). */
export function repayUnits(debtBase: bigint, debtPrice: bigint, debtDecimals: number): bigint {
  return (debtBase * 10n ** BigInt(debtDecimals) * 1002n) / 1000n / debtPrice;
}

/** USD value (8 dp base units) of token units at an oracle price (8 dp). */
export const valueBase = (units: bigint, price: bigint, decimals: number) => (units * price) / 10n ** BigInt(decimals);

/** What the visitor's own Ethereum wallet must hold for a mainnet run, and what it holds. */
export type Need = { what: string; need: bigint; have: bigint; decimals: number; symbol: string; note: string };
export function walletNeeds(net: OwnNet, have: { eth: bigint; coll: bigint; debt: bigint }, opts: { buyBackUnits: bigint; ownGasWei: bigint; repayMarginUnits: bigint }): Need[] {
  return [
    { what: "collateral", need: net.collateralUnits, have: have.coll, decimals: net.collateral.decimals, symbol: net.collateral.symbol, note: `sent to your position and supplied on Aave${opts.buyBackUnits > 0n ? `; about ${units(opts.buyBackUnits, net.collateral.decimals, 4)} more to buy the rescue back` : ""}` },
    { what: "gas", need: net.positionGasWei + opts.ownGasWei, have: have.eth, decimals: 18, symbol: "ETH", note: `the position's gas, plus your own transfers` },
    { what: "repay", need: opts.repayMarginUnits, have: have.debt, decimals: net.debt.decimals, symbol: net.debt.symbol, note: `margin for the final repay (the rest is the ${net.debt.symbol} you borrow)` },
  ];
}
export const isShort = (n: Need) => n.have < n.need;

// ── the rescue read straight from the contract (mainnet: no feed) ──
type Bid = { steward: string; premium_bps: number; amount_units: string; seq: number };
type Member = { steward: string; premium_bps: number; share_units: string; confirmed: boolean; evm_tx: string | null; claim_id: string | null };
export type RescueView = {
  id: number;
  state: string;
  opened_at: string;
  closes_at: string;
  topup_units: string;
  cap_bps: number;
  bids: Bid[];
  members: Member[];
  claims_opened_at: string;
  settlement: { started_at: string } | null;
};
export type ClaimView = { token_id: string; owner: string; owed_units: string; status: string; expires_at?: string };
/** One line of what happened, with its time when the contract records one (else the page uses when it first saw it). */
export type DirectLine = { key: string; atMs: number | null; html: string };

const nsToMs = (ns: string | undefined) => (ns && ns !== "0" ? Number(BigInt(ns) / 1_000_000n) : null);
const name = (account: string) => account.split(".")[0];
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const units = (v: bigint | string, dec: number, dp = 4) => (Number(BigInt(v)) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dp });

/** Plain event lines for a rescue, from the contract's own records: auction, bids, winners, top-ups, claims, ending. */
export function directLines(r: RescueView, claims: ClaimView[], coll: Token, evmName: string): DirectLine[] {
  const out: DirectLine[] = [];
  const u = (v: string) => units(v, coll.decimals, 6);
  out.push({ key: `open:${r.id}`, atMs: nsToMs(r.opened_at), html: `Auction open: ${u(r.topup_units)} ${coll.symbol} needed, premium cap ${r.cap_bps} bps` });
  for (const b of r.bids) out.push({ key: `bid:${r.id}:${b.steward}:${b.seq}`, atMs: null, html: `<strong>${escHtml(name(b.steward))}</strong> bids ${b.premium_bps} bps for ${u(b.amount_units)}` });
  if (r.state !== "auction") {
    const w = r.members.map((m) => `<strong>${escHtml(name(m.steward))}</strong> at ${m.premium_bps} bps`).join(", ");
    out.push({ key: `close:${r.id}`, atMs: nsToMs(r.closes_at), html: `Auction closed: ${w || "no winner"}` });
  }
  for (const m of r.members) {
    if (m.evm_tx) out.push({ key: `topup:${r.id}:${m.steward}`, atMs: null, html: `<strong>${escHtml(name(m.steward))}</strong> tops up ${u(m.share_units)} ${coll.symbol} on Aave` });
    if (m.confirmed) out.push({ key: `proven:${r.id}:${m.steward}`, atMs: null, html: `Top-up proven on ${evmName}` });
  }
  for (const c of claims) {
    out.push({ key: `claim:${c.token_id}`, atMs: nsToMs(r.claims_opened_at), html: `Claim ${escHtml(c.token_id)} minted to <strong>${escHtml(name(c.owner))}</strong>: owed ${u(c.owed_units)} ${coll.symbol}` });
  }
  if (r.settlement) out.push({ key: `settle:${r.id}`, atMs: nsToMs(r.settlement.started_at), html: `Settlement started at the oracle price` });
  if (r.state === "bought_back") out.push({ key: `bought:${r.id}`, atMs: null, html: `Bought back` });
  if (r.state === "settled") out.push({ key: `settled:${r.id}`, atMs: null, html: `Settled` });
  return out;
}

/** Bids lowest premium first (the order the contract awards them), each steward's latest only. */
export function ladder(r: RescueView): Bid[] {
  const latest = new Map<string, Bid>();
  for (const b of r.bids) if (!latest.has(b.steward) || latest.get(b.steward)!.seq < b.seq) latest.set(b.steward, b);
  return [...latest.values()].sort((a, b) => a.premium_bps - b.premium_bps || a.seq - b.seq);
}

/** When the auction closes and when the buy-back window ends (ms), from the contract's records. */
export function rescueClock(r: RescueView | null, claims: ClaimView[]): { closesAtMs: number | null; windowEndMs: number | null } {
  const ends = claims.filter((c) => c.status === "open" && c.expires_at).map((c) => nsToMs(c.expires_at)!);
  return { closesAtMs: r && r.state === "auction" ? nsToMs(r.closes_at) : null, windowEndMs: ends.length ? Math.min(...ends) : null };
}

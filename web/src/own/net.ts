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
  evmBlock: (n: number) => string;
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
    evmBlock: (n) => `https://sepolia.etherscan.io/block/${n}`,
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
    evmBlock: (n) => `https://etherscan.io/block/${n}`,
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
type Member = { steward: string; premium_bps: number; share_units: string; premium_units?: string; confirmed: boolean; evm_tx: string | null; claim_id: string | null };
/** One settlement leg: a withdrawal from Aave straight to a registered payout. `amount` is
 *  `{ exact }` or "max" (the rest of the collateral, to the borrower). */
export type SettleLeg = { to: string; amount: { exact: string } | string; claim_id: string | null; done: boolean };
export type SettlementView = {
  started_at: string;
  settler?: string;
  early?: boolean;
  repay_units?: string;
  repay_collateral_units?: string;
  repay_confirmed?: boolean;
  full_close?: boolean;
  legs?: SettleLeg[];
};
export type RescueView = {
  id: number;
  position_id?: number;
  state: string;
  opened_at: string;
  closes_at: string;
  topup_deadline?: string;
  topup_units: string;
  cap_bps: number;
  bids: Bid[];
  members: Member[];
  claims_opened_at: string;
  settlement: SettlementView | null;
};
export type ClaimView = {
  token_id: string;
  owner: string;
  owed_units: string;
  status: string;
  expires_at?: string;
  opened_at?: string;
  share_units?: string;
  premium_units?: string;
  premium_bps?: number;
  evm_topup_tx?: string | null;
  paid_by_tx?: string | null;
};

const nsToMs = (ns: string | undefined) => (ns && ns !== "0" ? Number(BigInt(ns) / 1_000_000n) : null);
const name = (account: string) => account.split(".")[0];
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const units = (v: bigint | string, dec: number, dp = 4) => (Number(BigInt(v)) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dp });

/** What an Ethereum record in the contract names: a transaction hash, or the block a proof read
 *  ("verified@<block>" for a proven top-up, "escrow@<block>" for a proven buy-back payment). */
export type EvmRef = { tx: string } | { block: number };
export function evmRef(s: string | null | undefined): EvmRef | null {
  if (!s) return null;
  const m = s.match(/^[a-z]+@(\d+)$/);
  if (m) return { block: Number(m[1]) };
  return /^0x[0-9a-fA-F]+$/.test(s) ? { tx: s } : null;
}

export type FlowKind = "open" | "bid" | "close" | "topup" | "proven" | "failed" | "claim" | "escrow" | "payout" | "bought" | "lapsed" | "settle" | "repay" | "leg" | "settled";
/** One step of a rescue, in the order the rescue runs. `exactMs` is a time the contract records for
 *  the step itself (or the time of the Ethereum block its proof read); a step with none sorts by its
 *  place in the flow, just after the step before it (`atMs`), and reads "after" `afterMs`, the last
 *  recorded time before it. Never the time a page first saw it. */
export type FlowStep = {
  key: string;
  kind: FlowKind;
  rescueId: number;
  order: number;
  atMs: number;
  exactMs: number | null;
  afterMs: number;
  /** a steward's short name, "contract" or "borrower" */
  actor: string;
  title: string;
  text: string;
  html: string;
  figure?: { value: string; unit: string };
  /** an explorer link for the step, and what it names (a tx hash, "block N", a payout address) */
  link?: { href: string; ref: string; kind: "tx" | "block" | "address" };
  /** the contract has queued it but not yet seen it land */
  pending?: boolean;
};
export type FlowOpts = {
  coll: Token;
  evmName: string;
  debt?: Token;
  evmTx?: (hash: string) => string;
  evmBlock?: (n: number) => string;
  evmAddress?: (a: string) => string;
  /** an Ethereum block number to its time (ms), when the page has read it */
  blockMs?: (n: number) => number | null;
};

/** Every step of a rescue from the contract's own records: the auction (each bid in order), the
 *  winners, each top-up and its proof, the claims, then the buy-back or the settlement (the
 *  settler's repay, each leg withdrawn from Aave to a payout, the end), or the failure. */
export function rescueFlow(r: RescueView, claims: ClaimView[], o: FlowOpts): FlowStep[] {
  const C = o.coll;
  const u = (v: string | bigint) => units(v, C.decimals, 6);
  const nm = (a: string) => `<strong>${escHtml(name(a))}</strong>`;
  const raw: Omit<FlowStep, "order" | "atMs" | "afterMs" | "rescueId">[] = [];
  const refLink = (ref: EvmRef | null): FlowStep["link"] => {
    if (!ref) return undefined;
    if ("block" in ref) return o.evmBlock ? { href: o.evmBlock(ref.block), ref: `block ${ref.block}`, kind: "block" } : undefined;
    return o.evmTx ? { href: o.evmTx(ref.tx), ref: ref.tx, kind: "tx" } : undefined;
  };
  const refMs = (ref: EvmRef | null) => (ref && "block" in ref && o.blockMs ? o.blockMs(ref.block) : null);
  const add = (s: Omit<FlowStep, "order" | "atMs" | "afterMs" | "rescueId">) => raw.push(s);

  add({ key: `open:${r.id}`, kind: "open", exactMs: nsToMs(r.opened_at), actor: "contract", title: "Auction opened", text: `The position fell under the trigger: ${u(r.topup_units)} ${C.symbol} needed, premium cap ${r.cap_bps} bps.`, html: `Auction open: ${u(r.topup_units)} ${C.symbol} needed, premium cap ${r.cap_bps} bps`, figure: { value: String(r.cap_bps), unit: "bps cap" } });
  for (const b of [...r.bids].sort((a, b) => a.seq - b.seq))
    add({ key: `bid:${r.id}:${b.steward}:${b.seq}`, kind: "bid", exactMs: null, actor: name(b.steward), title: `${name(b.steward)} bids`, text: `Bids ${b.premium_bps} bps to supply ${u(b.amount_units)} ${C.symbol}.`, html: `${nm(b.steward)} bids ${b.premium_bps} bps for ${u(b.amount_units)}`, figure: { value: String(b.premium_bps), unit: "bps" } });
  // a failed rescue keeps no members (a winner that never topped up is dropped), so its bids tell what happened
  const failedBids = r.state === "failed" && !r.members.length && r.bids.length > 0;
  const covered = bidsCover(r);
  if (r.state !== "auction") {
    const w = r.members.map((m) => `${nm(m.steward)} at ${m.premium_bps} bps`).join(", ");
    const wt = r.members.map((m) => `${name(m.steward)} at ${m.premium_bps} bps`).join(", ");
    const low = ladder(r)[0];
    if (failedBids)
      add({ key: `close:${r.id}`, kind: "close", exactMs: nsToMs(r.closes_at), actor: "contract", title: "Auction closed", text: covered ? `Lowest bid: ${name(low.steward)} at ${low.premium_bps} bps.` : "The bids did not cover the top-up: nobody wins and every bond goes back.", html: covered ? `Auction closed: lowest bid ${nm(low.steward)} at ${low.premium_bps} bps` : "Auction closed: the bids did not cover the top-up" });
    else
      add({ key: `close:${r.id}`, kind: "close", exactMs: nsToMs(r.closes_at), actor: "contract", title: r.members.length ? "Auction closed" : "Auction closed, no bids", text: r.members.length ? `Lowest premium wins: ${wt}.` : "No steward bid: the rescue ends and the position is as it was.", html: `Auction closed: ${w || "no winner"}` });
  }
  for (const m of r.members) {
    const ref = evmRef(m.evm_tx);
    if (m.evm_tx) add({ key: `topup:${r.id}:${m.steward}`, kind: "topup", exactMs: null, actor: name(m.steward), title: "Topped up", text: `Supplies ${u(m.share_units)} ${C.symbol} to Aave on behalf of the position.`, html: `${nm(m.steward)} tops up ${u(m.share_units)} ${C.symbol} on Aave`, figure: { value: u(m.share_units), unit: C.symbol }, link: ref && "tx" in ref ? refLink(ref) : undefined });
    if (m.confirmed) add({ key: `proven:${r.id}:${m.steward}`, kind: "proven", exactMs: refMs(ref), actor: "contract", title: "Top-up proven", text: ref && "block" in ref ? `A verified read of ${o.evmName} block ${ref.block} shows the position's collateral grew by the top-up.` : `The contract records the top-up as confirmed on ${o.evmName}.`, html: `Top-up proven on ${o.evmName}`, link: ref && "block" in ref ? refLink(ref) : undefined });
  }
  // no time of its own: the deadline passing, or a liquidation, ends it, and the record does not say which
  if (failedBids && covered)
    add({ key: `failed:${r.id}`, kind: "failed", exactMs: null, actor: "contract", title: "No top-up proven", text: "No top-up was proven before the deadline: the rescue ended without a claim.", html: "No top-up proven: the rescue ended" });
  for (const c of claims)
    add({ key: `claim:${c.token_id}`, kind: "claim", exactMs: nsToMs(c.opened_at) ?? nsToMs(r.claims_opened_at), actor: "contract", title: "Claim minted", text: `Claim ${c.token_id} to ${name(c.owner)}: owed ${u(c.owed_units)} ${C.symbol}, the supplied amount plus its premium, fixed in ${C.symbol}.`, html: `Claim ${escHtml(c.token_id)} minted to ${nm(c.owner)}: owed ${u(c.owed_units)} ${C.symbol}`, figure: { value: u(c.owed_units), unit: C.symbol } });
  // the buy-back: the payment into the position, proven; the exact owed amount paid on
  for (const c of claims.filter((x) => x.status === "bought_back")) {
    const ref = evmRef(c.paid_by_tx);
    add({ key: `escrow:${c.token_id}`, kind: "escrow", exactMs: refMs(ref), actor: "borrower", title: "Buy-back paid in", text: `The borrower's payment to the position is proven${ref && "block" in ref ? ` at ${o.evmName} block ${ref.block}` : ""}: the buy-back commits.`, html: `Buy-back payment proven for claim ${escHtml(c.token_id)}`, link: refLink(ref) });
    add({ key: `payout:${c.token_id}`, kind: "payout", exactMs: null, actor: "contract", title: "Claim paid", text: `The contract pays ${name(c.owner)} exactly what claim ${c.token_id} is owed, ${u(c.owed_units)} ${C.symbol}, from the position.`, html: `${nm(c.owner)} paid ${u(c.owed_units)} ${C.symbol}: claim ${escHtml(c.token_id)} closed`, figure: { value: u(c.owed_units), unit: C.symbol } });
  }
  if (r.state === "bought_back") add({ key: `bought:${r.id}`, kind: "bought", exactMs: null, actor: "contract", title: "Bought back", text: "Every claim is bought back: the position is free again.", html: "Bought back" });
  // the settlement: the window lapsed (or the early line was crossed), then the settler's steps
  const st = r.settlement;
  if (st) {
    const ends = claims.map((c) => nsToMs(c.expires_at)).filter((x): x is number => x !== null);
    if (!st.early && ends.length) add({ key: `lapsed:${r.id}`, kind: "lapsed", exactMs: Math.min(...ends), actor: "contract", title: "Buy-back window closed", text: "The buy-back window ended with the claim not bought back.", html: `Buy-back window closed: ${claims.map((c) => escHtml(c.token_id)).join(", ")} not bought back` });
    const by = st.settler ? ` by ${nm(st.settler)}` : "";
    add({ key: `settle:${r.id}`, kind: "settle", exactMs: nsToMs(st.started_at), actor: st.settler ? name(st.settler) : "contract", title: st.early ? "Early settlement started" : "Settlement started", text: st.early ? "The borrower's own health fell under 1.10 net of the claims: the claim settles early at the oracle price." : "No buy-back: the claim settles at the oracle price.", html: `${st.early ? "Early settlement" : "Settlement"} started at the oracle price${by}` });
    if (st.settler && o.debt && st.repay_units && st.repay_units !== "0") {
      const D = o.debt;
      const amt = units(st.repay_units, D.decimals, 2);
      add({ key: `repay:${r.id}`, kind: "repay", exactMs: null, actor: name(st.settler), title: st.repay_confirmed ? "Debt repaid for the position" : "Repaying the position's debt", text: `Repays ${amt} ${D.symbol} of the position's Aave debt on its behalf${st.repay_collateral_units ? `, to be paid back ${u(st.repay_collateral_units)} ${C.symbol} at the oracle price` : ""}.`, html: `${nm(st.settler)} ${st.repay_confirmed ? "repaid" : "repays"} ${amt} ${D.symbol} of the position's debt on Aave`, figure: { value: amt, unit: D.symbol }, pending: !st.repay_confirmed });
    }
    const seen = new Set<string>();
    (st.legs ?? []).forEach((l, i) => {
      const c = l.claim_id ? claims.find((x) => x.token_id === l.claim_id) : undefined;
      const premium = !!l.claim_id && seen.has(l.claim_id);
      if (l.claim_id) seen.add(l.claim_id);
      const amount = typeof l.amount === "object" && l.amount && "exact" in l.amount ? l.amount.exact : null;
      if (amount === "0") return; // a premium leg dropped: nothing sent
      const who = c ? name(c.owner) : l.claim_id ? "the claim owner" : st.settler && amount ? name(st.settler) : "the borrower";
      const what = !l.claim_id ? (amount ? "the repay, at the oracle price" : "the rest of the collateral") : premium ? "the premium" : st.settler && c && c.owner === st.settler && st.repay_units && st.repay_units !== "0" ? "the supplied amount and the repay, at the oracle price" : "the supplied amount";
      const amt = amount ? `${u(amount)} ${C.symbol}` : `the remaining ${C.symbol}`;
      const whoHtml = who.startsWith("the ") ? who : nm(who);
      add({ key: `leg:${r.id}:${i}`, kind: "leg", exactMs: null, actor: "contract", title: l.done ? `${C.symbol} paid to ${who}` : `Paying ${who}`, text: `${amt} withdrawn from Aave and sent to ${who}${who.startsWith("the ") ? "" : "'s"} payout: ${what}.`, html: `${amt} ${l.done ? "withdrawn from Aave and paid" : "being withdrawn from Aave"} to ${whoHtml}${who.startsWith("the ") ? "" : "'s"} payout (${what})`, ...(amount ? { figure: { value: u(amount), unit: C.symbol } } : {}), link: o.evmAddress ? { href: o.evmAddress(l.to), ref: l.to, kind: "address" } : undefined, pending: !l.done });
    });
    if (r.state === "settled") {
      const paid = new Map<string, bigint>();
      for (const l of st.legs ?? []) {
        const c = l.claim_id ? claims.find((x) => x.token_id === l.claim_id) : undefined;
        if (c && l.done && typeof l.amount === "object" && "exact" in l.amount) paid.set(c.owner, (paid.get(c.owner) ?? 0n) + BigInt(l.amount.exact));
      }
      const parts = [...paid].map(([a, v]) => `${nm(a)} paid ${u(v)} ${C.symbol}`);
      const tparts = [...paid].map(([a, v]) => `${name(a)} paid ${u(v)} ${C.symbol} in all`);
      add({ key: `settled:${r.id}`, kind: "settled", exactMs: null, actor: "contract", title: "Settled", text: tparts.length ? `Every leg landed: ${tparts.join(", ")}. The claim is closed.` : "Every leg landed. The claim is closed.", html: parts.length ? `Settled: ${parts.join(", ")}` : "Settled" });
    }
  } else if (r.state === "settled") add({ key: `settled:${r.id}`, kind: "settled", exactMs: null, actor: "contract", title: "Settled", text: "The claim is closed.", html: "Settled" });

  // the order is the flow's; a recorded time places a step exactly, an unrecorded one just after the step before it
  let prev = -Infinity;
  let anchor = nsToMs(r.opened_at) ?? 0;
  return raw.map((x, order) => {
    let at: number;
    if (x.exactMs !== null && x.exactMs > prev) at = x.exactMs;
    else at = Number.isFinite(prev) ? prev + 1 : (x.exactMs ?? anchor);
    const afterMs = anchor;
    if (x.exactMs !== null) anchor = Math.max(anchor, x.exactMs);
    prev = at;
    return { ...x, rescueId: r.id, order, atMs: at, afterMs: x.exactMs !== null ? x.exactMs : afterMs };
  });
}

/** One line of what happened. `atMs` sorts it (a contract time, else its place in the flow);
 *  `exact` says whether the contract records that time for the step itself. */
export type DirectLine = { key: string; atMs: number; exact: boolean; afterMs: number; html: string };

/** Plain event lines for a rescue, from the contract's own records (see `rescueFlow`). */
/** `linkHtml` draws a step's explorer link after its line (none without it). */
export function directLines(r: RescueView, claims: ClaimView[], coll: Token, evmName: string, more: Omit<FlowOpts, "coll" | "evmName"> & { linkHtml?: (href: string, label: string) => string } = {}): DirectLine[] {
  const link = (s: FlowStep) => (s.link && more.linkHtml ? more.linkHtml(s.link.href, s.link.kind === "address" ? "Payout" : "Etherscan") : "");
  return rescueFlow(r, claims, { coll, evmName, ...more }).map((s) => ({ key: s.key, atMs: s.atMs, exact: s.exactMs !== null, afterMs: s.afterMs, html: s.html + link(s) }));
}

/** Whether the stewards' latest bids add up to the whole top-up (else the auction cannot award it). */
export function bidsCover(r: Pick<RescueView, "bids" | "topup_units">): boolean {
  const latest = new Map<string, Bid>();
  for (const b of r.bids) if (!latest.has(b.steward) || latest.get(b.steward)!.seq < b.seq) latest.set(b.steward, b);
  return [...latest.values()].reduce((t, b) => t + BigInt(b.amount_units), 0n) >= BigInt(r.topup_units);
}
/** How a rescue ended, or that it is still running. */
export type Outcome = "running" | "bought_back" | "settled" | "failed" | "no_bids";
export function rescueOutcome(r: Pick<RescueView, "state" | "bids" | "members">): Outcome {
  if (r.state === "bought_back") return "bought_back";
  if (r.state === "settled") return "settled";
  if (r.state === "failed") return r.bids.length === 0 && r.members.length === 0 ? "no_bids" : "failed";
  return "running";
}
export const OUTCOME_WORD: Record<Outcome, string> = { running: "Running", bought_back: "Bought back", settled: "Settled", failed: "Failed", no_bids: "No bids" };
const STAGE: Record<string, string> = { auction: "stewards bidding", top_up_pending: "topping up", open: "claim open", settling: "settling" };

/** One row of the position's protections: a rescue, how it went, who won at what premium. */
export type ProtectionRow = {
  id: number;
  outcome: Outcome;
  /** the running rescue's stage in words, else "" */
  stage: string;
  winners: { steward: string; name: string; bps: number; units: string }[];
  topupUnits: string;
  openedMs: number;
  bids: number;
  /** a failed rescue's bids added up to the whole top-up (so it ended without a proven top-up) */
  covered: boolean;
};
/** Every rescue the position has had, newest first, with the ones that ended with no bids apart. */
export function protectionRows(rs: RescueView[], posId?: number): { rows: ProtectionRow[]; noBids: ProtectionRow[] } {
  const byId = new Map<number, RescueView>();
  for (const r of rs) if (posId === undefined || r.position_id === undefined || r.position_id === posId) byId.set(r.id, r);
  const all = [...byId.values()]
    .sort((a, b) => b.id - a.id)
    .map((r): ProtectionRow => {
      const outcome = rescueOutcome(r);
      const filled = r.members.reduce((t, m) => t + BigInt(m.share_units), 0n);
      return {
        id: r.id,
        outcome,
        stage: outcome === "running" ? STAGE[r.state] ?? r.state : "",
        winners: r.members.map((m) => ({ steward: m.steward, name: name(m.steward), bps: m.premium_bps, units: m.share_units })),
        topupUnits: (r.members.length ? filled : 0n).toString(),
        openedMs: nsToMs(r.opened_at) ?? 0,
        bids: r.bids.length,
        covered: bidsCover(r),
      };
    });
  return { rows: all.filter((x) => x.outcome !== "no_bids"), noBids: all.filter((x) => x.outcome === "no_bids") };
}
/** A finished rescue never changes again: a page reads it once. */
export const rescueFinished = (r: Pick<RescueView, "state">) => r.state === "bought_back" || r.state === "settled" || r.state === "failed";

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

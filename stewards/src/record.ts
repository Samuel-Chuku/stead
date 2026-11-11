// The evidence trail of a live run: every NEAR contract call by every actor in the process (the
// script, the keeper, the stewards), and every Ethereum transaction sent from one of the run's own
// addresses (the borrower, the stewards, each position's MPC-derived address), in chain order.
// The trail is written to disk after every step, so a run that stops halfway still leaves its
// record. The evidence harness (scripts/evidence.ts) re-checks every entry on chain.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeFunctionData, parseAbi, type Hex, type PublicClient } from "viem";
import { callListeners, type CallRecord } from "./near.js";

export type TrailChain = "near-mainnet" | "near-testnet" | "ethereum" | "sepolia" | "ethereum-copy";

export interface TrailEntry {
  chain: TrailChain;
  tx: string;
  at: string; // ISO time: when the call was sent (NEAR); the block's time, or when it was seen on a local copy (Ethereum)
  step: string; // the run step it happened in
  what: string; // plain description
  actor: string; // borrower, deep, keeper, position 15, …
  ok: boolean; // false: the chain refused it (some refusals are the point, e.g. the size cap)
  key: boolean; // a step a reader should see first (the rest is the full trail)
  // what the checker compares with the chain
  signer?: string; // NEAR signer
  receiver?: string; // NEAR contract
  method?: string; // NEAR method, or "DeleteKey" for an access-key deletion
  from?: string; // Ethereum sender
  to?: string; // Ethereum target
  block?: number;
  index?: number;
  error?: string;
}

export interface TrailFile {
  title: string;
  label: string; // REAL FUNDS / REHEARSAL …
  contract: string;
  nearNetwork: "mainnet" | "testnet";
  evmChain: TrailChain;
  evmChainId: number;
  started: string;
  finished?: string;
  outcome?: string; // the run's summary lines, or why it stopped
  addresses: Record<string, string>; // actor name → Ethereum address
  entries: TrailEntry[];
  state?: TrailState;
}

/** The contract's state at the end, by id, for the checker to compare with a live read. */
export interface TrailState {
  read_at: string;
  positions: Record<string, unknown>;
  rescues: Record<string, unknown>;
  claims: Record<string, unknown>;
  aave: Record<string, { collateral_base: string; debt_base: string }>;
}

// ── plain descriptions ──

// the keeper's housekeeping (readings, confirmations, asking for the next payout or leg) is in the
// full trail; its effects on Ethereum are key steps of their own
const KEY_NEAR = new Set(["add_market", "set_limits", "register_position", "sign_action", "bid", "start_settlement", "take_over_settlement", "DeleteKey", "ft_transfer"]);

/** A NEAR call in plain words. */
export function describeNear(c: Pick<CallRecord, "method" | "args">): string {
  const a = c.args as Record<string, any>;
  const pos = a.position_id !== undefined ? `position ${a.position_id}` : "";
  const res = a.rescue_id !== undefined ? `rescue ${a.rescue_id}` : "";
  switch (c.method) {
    case "register_position": return `registers a position on market ${a.market_id}`;
    case "sign_action": return `asks the contract to sign ${a.action?.type ?? "an action"} for ${pos} (MPC)`;
    case "report_health": return `reports ${pos}'s health (temporary reporter)`;
    case "request_verified": return `asks OutLayer for a verified reading of ${pos}`;
    case "bid": return `bids ${a.premium_bps} bps on ${res}`;
    case "close_auction": return `closes the auction of ${res}`;
    case "confirm_topup": return `confirms ${a.steward?.split(".")[0] ?? "a steward"}'s top-up on ${res}`;
    case "confirm_nonce": return `confirms ${pos}'s signed transaction landed (${a.success ? "success" : "failed"})`;
    case "confirm_escrow": return `confirms the buy-back balance held by ${pos}`;
    case "pay_next": return `asks the contract to sign ${pos}'s next queued payout (MPC)`;
    case "start_settlement": return `starts the settlement of ${res}`;
    case "take_over_settlement": return `takes over the settlement of ${res}`;
    case "settle_next": return `asks the contract to sign the next settlement leg of ${res} (MPC)`;
    case "confirm_settlement_repay": return `confirms the settlement repay on ${res}`;
    case "expire_topup": return `expires a missed top-up on ${res}`;
    case "set_limits": return "sets the size cap and the borrower allow-list";
    case "add_market": return "adds the market";
    case "register_steward": return "registers as a steward";
    case "set_evm_payout": return "sets its Ethereum payout address";
    case "burn_nonce": return `burns a stuck nonce of ${pos}`;
    case "replace_pending": return `re-signs ${pos}'s pending transaction with a higher fee`;
    case "storage_deposit": return `registers ${a.account_id ? `${String(a.account_id).slice(0, 8)}…` : "an account"} on the USDC contract (NEAR Intents deposit address)`;
    case "ft_transfer": return `sends ${a.amount !== undefined ? `${Number(BigInt(a.amount)) / 1e6} USDC` : "USDC"} to the NEAR Intents deposit address ${String(a.receiver_id ?? "").slice(0, 8)}…`;
    default: return `${c.method}${pos || res ? ` (${pos || res})` : ""}`;
  }
}

const abi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
  "function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function deposit() payable",
]);
const MAXISH = 2n ** 255n;

export interface Book {
  pool: string;
  tokens: Record<string, { sym: string; decimals: number }>; // lower-case address → token
  names: Record<string, string>; // lower-case address → actor name
}

function amount(v: bigint, d: number): string {
  if (v >= MAXISH) return "all";
  const s = v.toString().padStart(d + 1, "0");
  const whole = s.slice(0, -d) || "0";
  const frac = s.slice(-d).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** An Ethereum transaction in plain words, from its target and calldata. Returns `key: false` for approvals and gas top-ups. */
export function describeEvm(tx: { from: string; to: string | null; input: Hex; value: bigint }, book: Book): { what: string; key: boolean } {
  const name = (a: string) => book.names[a.toLowerCase()] ?? `${a.slice(0, 6)}…${a.slice(-4)}`;
  const tok = (a: string) => book.tokens[a.toLowerCase()];
  const to = (tx.to ?? "").toLowerCase();
  if (!tx.input || tx.input === "0x") {
    const eth = amount(tx.value, 18);
    return { what: `sends ${eth} ETH to ${name(to)}${/^position/.test(name(to)) ? " for gas" : ""}`, key: false };
  }
  let d: { functionName: string; args: readonly unknown[] };
  try {
    d = decodeFunctionData({ abi, data: tx.input }) as typeof d;
  } catch {
    return { what: `calls ${name(to)}`, key: true };
  }
  const a = d.args as any[];
  if (to === book.pool.toLowerCase()) {
    const t = tok(a[0]);
    const amt = t ? `${amount(a[1], t.decimals)} ${t.sym}` : String(a[1]);
    switch (d.functionName) {
      case "supply": {
        const forWhom = a[2].toLowerCase() === tx.from.toLowerCase() ? "" : ` on behalf of ${name(a[2])}`;
        return { what: `supplies ${amt} to Aave${forWhom}${forWhom ? " (top-up)" : ""}`, key: true };
      }
      case "withdraw": return { what: `withdraws ${amt} from Aave to ${name(a[2])}`, key: true };
      case "borrow": return { what: `borrows ${amt} from Aave`, key: true };
      case "repay": {
        const forWhom = a[3].toLowerCase() === tx.from.toLowerCase() ? "" : ` for ${name(a[3])}`;
        return { what: `repays ${amt} to Aave${forWhom}`, key: true };
      }
    }
  }
  const t = tok(to);
  if (t && d.functionName === "transfer") return { what: `sends ${amount(a[1], t.decimals)} ${t.sym} to ${name(a[0])}`, key: true };
  if (t && d.functionName === "approve") return { what: `approves ${name(a[0])} to spend its ${t.sym}`, key: false };
  // WETH's deposit(): ETH delivered by NEAR Intents, wrapped for the top-up
  if (t && d.functionName === "deposit") return { what: `wraps ${amount(tx.value, 18)} ETH into ${t.sym}`, key: true };
  return { what: `${d.functionName} on ${name(to)}`, key: true };
}

// ── the trail ──

export class Trail {
  readonly file: TrailFile;
  private step = "setup";
  private seenEvm = new Set<string>();
  private labels = new Map<string, { what: string; key: boolean }>(); // script labels, by tx hash
  private nextBlock: bigint | undefined;
  private actorOfSigner: (signer: string) => string;

  constructor(readonly path: string, meta: Omit<TrailFile, "entries" | "started" | "addresses">, private pub: PublicClient, private book: Book, actorOfSigner: (s: string) => string) {
    this.file = { ...meta, started: new Date().toISOString(), addresses: {}, entries: [] };
    this.actorOfSigner = actorOfSigner;
  }

  /** Start listening to every NEAR call in this process; Ethereum is scanned from `fromBlock`. */
  private listener = (c: CallRecord) => this.near(c);
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Start listening to every NEAR call in this process, and scan Ethereum from `fromBlock` every
   *  `scanMs` (0: only when `sync` is called), so each tx is filed under the step it happened in. */
  start(fromBlock: bigint, scanMs = 0) {
    this.nextBlock = fromBlock;
    callListeners.push(this.listener);
    if (scanMs > 0) this.timer = setInterval(() => void this.sync(), scanMs);
    this.save();
  }

  setStep(s: string) {
    this.step = s;
  }

  addAddress(name: string, a: string) {
    this.book.names[a.toLowerCase()] = name;
    this.file.addresses[name] = a;
  }

  /** A plain label the script gives a transaction (overrides the automatic one). */
  label(hash: string, what: string, key = true) {
    this.labels.set(hash.toLowerCase(), { what, key });
    const e = this.file.entries.find((x) => x.tx.toLowerCase() === hash.toLowerCase());
    if (e) Object.assign(e, { what, key });
  }

  private near(c: CallRecord) {
    if (!c.hash) return; // never reached a node: nothing on chain to check
    const l = this.labels.get(c.hash.toLowerCase());
    this.file.entries.push({
      chain: this.file.nearNetwork === "mainnet" ? "near-mainnet" : "near-testnet",
      tx: c.hash,
      at: c.sentAt,
      step: this.step,
      what: l?.what ?? describeNear(c),
      actor: this.actorOfSigner(c.signer),
      ok: c.ok,
      key: l?.key ?? KEY_NEAR.has(c.method),
      signer: c.signer,
      receiver: c.contract,
      method: c.method,
      ...(c.error ? { error: c.error } : {}),
    });
    this.save();
  }

  /** An Ethereum transaction not sent from our addresses (e.g. a NEAR Intents solver's delivery), added by hash. */
  addEvm(e: Omit<TrailEntry, "chain" | "at" | "step"> & { step?: string }) {
    this.file.entries.push({ chain: this.file.evmChain, at: new Date().toISOString(), step: e.step ?? this.step, ...e });
    this.save();
  }

  /** A NEAR transaction made outside this process (e.g. the key deletion), added by hand. */
  addNear(e: Omit<TrailEntry, "chain" | "at" | "step"> & { step?: string }) {
    this.file.entries.push({ chain: this.file.nearNetwork === "mainnet" ? "near-mainnet" : "near-testnet", at: new Date().toISOString(), step: e.step ?? this.step, ...e });
    this.save();
  }

  private queue: Promise<void> = Promise.resolve();
  /** Scan new Ethereum blocks now, filed under the current step (scans run one at a time). */
  sync(): Promise<void> {
    const step = this.step;
    this.queue = this.queue.then(() => this.scan(step)).catch(() => this.save());
    return this.queue;
  }

  /** Scan new Ethereum blocks for transactions sent from the run's own addresses. */
  private async scan(step: string) {
    if (this.nextBlock === undefined) return;
    const head = await this.pub.getBlockNumber();
    for (let b = this.nextBlock; b <= head; b++) {
      const blk = await this.pub.getBlock({ blockNumber: b, includeTransactions: true });
      for (const tx of blk.transactions) {
        if (typeof tx === "string" || !this.book.names[tx.from.toLowerCase()] || this.seenEvm.has(tx.hash)) continue;
        this.seenEvm.add(tx.hash);
        const rc = await this.pub.getTransactionReceipt({ hash: tx.hash });
        const d = describeEvm({ from: tx.from, to: tx.to ?? null, input: tx.input, value: tx.value }, this.book);
        const l = this.labels.get(tx.hash.toLowerCase());
        this.file.entries.push({
          chain: this.file.evmChain,
          tx: tx.hash,
          // a local copy's block times don't follow the clock: use when the scan saw it
          at: this.file.evmChain === "ethereum-copy" ? new Date().toISOString() : new Date(Number(blk.timestamp) * 1000).toISOString(),
          step,
          what: l?.what ?? d.what,
          actor: this.book.names[tx.from.toLowerCase()],
          ok: rc.status === "success",
          key: l?.key ?? d.key,
          from: tx.from,
          to: tx.to ?? undefined,
          block: Number(b),
          index: tx.transactionIndex ?? undefined,
        });
      }
      this.nextBlock = b + 1n;
    }
    this.save();
  }

  snapshot(state: Omit<TrailState, "read_at">) {
    this.file.state = { read_at: new Date().toISOString(), ...state };
    this.save();
  }

  finish(outcome: string) {
    if (this.timer) clearInterval(this.timer);
    const i = callListeners.indexOf(this.listener);
    if (i >= 0) callListeners.splice(i, 1); // a finished trail records nothing more
    this.file.finished = new Date().toISOString();
    this.file.outcome = outcome;
    this.save();
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const sorted = { ...this.file, entries: [...this.file.entries].sort((x, y) => x.at.localeCompare(y.at) || (x.block ?? 0) - (y.block ?? 0) || (x.index ?? 0) - (y.index ?? 0)) };
    writeFileSync(this.path, JSON.stringify(sorted, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
  }
}

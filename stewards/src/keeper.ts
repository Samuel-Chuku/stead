// The keeper: reporter + relayer + public housekeeping, one loop.
//  - reports each position's Aave health (TEMPORARY trusted reporter), or, in a verified market,
//    asks the contract for an OutLayer-verified reading instead (the proof decides, not the keeper)
//  - broadcasts MPC-signed txs stored on the contract, then confirms the position nonce
//  - confirms steward top-ups, settlement repays and buy-backs by reading fork logs itself
//  - closes auctions, expires missed top-ups, advances settlement legs (anyone may)
import { type Address, type Hex, decodeEventLog } from "viem";
import { AAVE_BOOK, cfg } from "./config.js";
import { call, view, NEAR, TGAS } from "./near.js";
import { accountData, price, pub, poolAbi, balance } from "./fork.js";
import { log, short, fmt } from "./log.js";
import { nowNs, type Position, type Rescue, type Books, type Watch } from "./types.js";
import { marketAssets } from "./market.js";
import { FINAL, RescueCursor, pollDelay } from "./rescues.js";
import { viewReport } from "./near.js";

// Gas for the txs the keeper has signed (payouts, settlement legs, nonce burns). Measured on live
// Sepolia from a fresh account, the costliest is a withdraw to a new payout (~415k): 600k leaves a
// margin, lowered to the market's own cap where that is smaller.
// Ethereum mainnet: a 1 gwei ceiling (about 25× the base fee when measured) keeps the ETH each
// position must hold up front small (gas limit × max fee); the limit is lowered to the market's cap.
const GAS_BASE = cfg.evm === "sepolia"
  ? { gas_limit: "600000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "100000000" }
  : AAVE_BOOK === "ethereum" // real Ethereum, and the local copy that rehearses it (same profile, same upfront ETH)
    ? { gas_limit: "400000", max_fee_per_gas: "1000000000", max_priority_fee_per_gas: "10000000" }
    : { gas_limit: "400000", max_fee_per_gas: "20000000000", max_priority_fee_per_gas: "1000000000" };
let GAS = GAS_BASE;
async function loadGas() {
  const m = await view<{ gas_limit_cap: string } | null>("get_market", { market_id: cfg.marketId });
  if (m && BigInt(m.gas_limit_cap) < BigInt(GAS_BASE.gas_limit)) GAS = { ...GAS_BASE, gas_limit: m.gas_limit_cap };
}
const REPORT_EVERY_MS = 60_000; // refresh even when nothing moved (settlement needs ≤ 120 s old)
/** The contract's grace before a missed top-up on a verified market may be expired directly. */
const VERIFIED_EXPIRY_GRACE_NS = 15n * 60n * 1_000_000_000n;
const VERIFY_BUSY_MS = 30_000; // verified reading cadence while an auction or claim is open
const VERIFY_IDLE_MS = 30 * 60_000; // HF comfortably above the trigger: one proof per 30 min
const VERIFY_DEPTH = 3n; // the proof program reads head − 3
const VERIFY_STILL_MS = 10 * 60_000; // near the trigger but not moving: one proof per 10 min
const VERIFY_MIN_GAP_MS = 20_000; // never faster (each run costs NEAR; Sepolia blocks are 12 s)

export class Keeper {
  private positions = new Map<number, Position>();
  private lastReport = new Map<number, { key: string; at: number; block: bigint }>();
  private lastEscrow = new Map<number, string>(); // pid → "link:dai" last proven
  private sent = new Map<string, Hex>(); // `${pid}:${nonce}:${sig}` → fork tx hash
  private undecodable = new Set<string>();
  private logCursor = 0n;
  private payoutOf = new Map<string, string>(); // steward → payout (lowercase)
  private running = false;
  private nextProbe = 0; // first position id not seen yet
  private verifiedMarkets?: Set<number>;
  private lastVerify = new Map<number, number>(); // pid → when a verified read was last requested
  private verifyNow = new Map<number, bigint>(); // pid → block of fresh evidence (a Supply) the proof must reach
  public onEvent?: (e: { event: string; data: any }, hash: string) => void;
  private cursor = new RescueCursor();
  private nextProbeAt = 0; // when to look for new position ids again
  private booksMemo = new Map<number, Promise<Books>>(); // one get_books per position per tick

  /** Positions to manage; undefined = all (the long-running keeper). The local-fork demo script scopes it to its own
   *  run, since positions from older runs point at EVM state on forks that no longer exist. */
  public scope?: Set<number>;

  /** The plain health read when each position's last proof was asked for (to skip identical proofs). */
  private provenAt = new Map<number, bigint>();

  /** Account that pays for verified reads (any account may; it must be on the OutLayer secret's access list). */
  public verifyPayer: string;

  constructor(private who = cfg.reporter) {
    this.verifyPayer = process.env.VERIFY_PAYER || who;
  }

  private books(pid: number): Promise<Books> {
    let b = this.booksMemo.get(pid);
    if (!b) {
      b = view<Books>("get_books", { position_id: pid });
      this.booksMemo.set(pid, b);
      b.catch(() => this.booksMemo.delete(pid));
    }
    return b;
  }

  private async callR(method: string, args: Record<string, unknown>, gas?: bigint, deposit?: bigint) {
    this.booksMemo.clear(); // our own call may change the books
    const r = await call(this.who, method, args, { ...(gas ? { gas } : {}), ...(deposit ? { deposit } : {}) });
    this.booksMemo.clear();
    for (const e of r.events) this.onEvent?.(e, r.hash);
    return r;
  }

  async payout(steward: string): Promise<string | undefined> {
    if (!this.payoutOf.has(steward)) {
      const p = await view<string | null>("get_evm_payout", { account_id: steward });
      if (p) this.payoutOf.set(steward, p.toLowerCase());
    }
    return this.payoutOf.get(steward);
  }

  async refreshPositions() {
    // Only this chain's market: positions on other markets point at another EVM chain.
    if (this.scope) {
      for (const id of this.scope) {
        const p = await view<Position | null>("get_position", { position_id: id });
        if (p && p.market_id === cfg.marketId) this.positions.set(id, p);
      }
      return;
    }
    // Long-running: re-read this market's known positions, then probe only for new ids
    // (keeps a 24/7 keeper well under public RPC rate limits)
    for (const id of this.positions.keys()) {
      const p = await view<Position | null>("get_position", { position_id: id });
      if (p) this.positions.set(id, p);
    }
    // new positions appear rarely: probe for them every 30 s, not every tick
    if (Date.now() < this.nextProbeAt) return;
    this.nextProbeAt = Date.now() + 30_000;
    for (let id = this.nextProbe; ; id++) {
      const p = await view<Position | null>("get_position", { position_id: id });
      if (!p) break;
      this.nextProbe = id + 1;
      if (p.market_id === cfg.marketId) this.positions.set(id, p);
    }
  }

  async isVerified(pid: number): Promise<boolean> {
    if (!this.verifiedMarkets) {
      const c = await view<{ markets: number[] } | null>("get_verify_config");
      this.verifiedMarkets = new Set(c?.markets ?? []);
    }
    const p = this.positions.get(pid);
    return p !== undefined && this.verifiedMarkets.has(p.market_id);
  }

  /** Verified market: ask the contract to run the pinned proof program on OutLayer. The result
   *  goes straight to the contract's callback; this keeper only pays for the run and can't alter it. */
  async verify(pid: number, force = false): Promise<{ hash: string; note: string } | undefined> {
    const p = this.positions.get(pid);
    if (!p?.evm_address) return;
    const last = this.lastVerify.get(pid);
    const evidence = this.verifyNow.get(pid);
    // the proof reads head − 3 (re-org margin): wait until the evidence is that deep, then go at once
    const deep = evidence !== undefined && (await pub.getBlockNumber()) - VERIFY_DEPTH >= evidence;
    if (last !== undefined && Date.now() - last < (deep ? 8_000 : VERIFY_MIN_GAP_MS)) return;
    const busy = p.active_auction !== null || p.open_rescues.length > 0;
    const [v, books] = await Promise.all([view<{ last_block: number } | null>("get_verified", { position_id: pid }), this.books(pid)]);
    const behind = BigInt(books.last_event_block) > BigInt(v?.last_block ?? 0);
    // Idle cadence: a plain (unverified) RPC read is only a TRIGGER for paying for a proof; the
    // contract decides on the proof alone. Near the trigger: every minute while the health moves (or
    // is under the trigger), every 10 min while it sits still (a parked demo position would otherwise
    // pay for an identical proof every minute); comfortable: every 30 min.
    let idleMs = VERIFY_IDLE_MS;
    let hfNow: bigint | undefined;
    if (!busy) {
      const [d, params] = await Promise.all([accountData(p.evm_address as Address), view<{ trigger_hf_bps: number }>("get_params")]);
      hfNow = d.hfWad;
      const trigger = BigInt(params.trigger_hf_bps) * 10n ** 14n;
      if (d.debtBase > 0n && d.hfWad < (trigger * 105n) / 100n) idleMs = nearTriggerCadence(d.hfWad, this.provenAt.get(pid), trigger);
    }
    const due = last === undefined || Date.now() - last >= (busy ? VERIFY_BUSY_MS : idleMs);
    if (!force && !behind && !due && !deep) return;
    if (evidence !== undefined && !deep && !due) return;
    this.lastVerify.set(pid, Date.now());
    if (hfNow !== undefined) this.provenAt.set(pid, hfNow);
    // The payer must be allowed to use the proof program's OutLayer secret (the keyed RPC)
    const r = await call(this.verifyPayer, "request_verified", { position_id: pid }, { gas: 300n * TGAS, deposit: NEAR / 10n });
    for (const e of r.events) this.onEvent?.(e, r.hash);
    const ev = r.events.find((e) => e.event === "health_verified")?.data;
    if (ev && evidence !== undefined && BigInt(ev.block) >= evidence) this.verifyNow.delete(pid);
    const refused = r.logs.find((l) => /verified read (not applied|refused|unreadable|failed)/.test(l));
    const note = ev
      ? `block ${ev.block}, HF ${(Number(BigInt(ev.hf_wad) / 10n ** 12n) / 1e6).toFixed(4)}, ${ev.rpcs_agreeing} RPCs agreeing`
      : refused ?? "no reading applied";
    return { hash: r.hash, note };
  }

  /** Read Aave health for one position and report it if it changed (or is getting old). */
  async report(pid: number, force = false): Promise<{ hash: string; auction?: number } | undefined> {
    const p = this.positions.get(pid);
    if (!p?.evm_address) return;
    const a = await marketAssets(p.market_id);
    const [d, pc, pd, block] = await Promise.all([accountData(p.evm_address as Address), price(a.collateral), price(a.debt), pub.getBlockNumber()]);
    // Report on a real change (HF to 1 bps, price, debt appearing/clearing, collateral to 0.01 %);
    // interest moves the raw values every block and must not trigger a NEAR tx each pass.
    // Otherwise refresh every 60 s while an auction or claim is open (settlement and debt-asset
    // buy-backs need a reading ≤ 120 s old), every 5 min otherwise.
    const key = `${d.hfWad / 10n ** 14n}:${pc}:${d.debtBase === 0n}:${d.collateralBase / 10n ** 6n / 100n}`;
    const busy = p.active_auction !== null || p.open_rescues.length > 0;
    const maxAge = busy ? REPORT_EVERY_MS : 5 * REPORT_EVERY_MS;
    const last = this.lastReport.get(pid);
    // Every decision needs a reading at least as new as the last confirmed event
    const books = await view<Books>("get_books", { position_id: pid });
    const behind = last !== undefined && BigInt(books.last_event_block) > last.block;
    if (!force && !behind && last && last.key === key && Date.now() - last.at < maxAge) return;
    const report = {
      hf_wad: d.hfWad.toString(),
      collateral_base: d.collateralBase.toString(),
      debt_base: d.debtBase.toString(),
      collateral_price_base: pc.toString(),
      debt_price_base: pd.toString(),
      block: Number(block),
    };
    const r = await this.callR("report_health", { position_id: pid, report });
    this.lastReport.set(pid, { key, at: Date.now(), block });
    return { hash: r.hash, auction: r.value as number | undefined };
  }

  /** Relayer: broadcast a stored signed tx, wait for it, confirm the nonce on NEAR. */
  async relay(pid: number): Promise<{ evmTx: Hex; ok: boolean; nearTx: string } | undefined> {
    const pending = await view<Position["pending"]>("get_pending_tx", { position_id: pid });
    if (!pending?.signed_raw) return;
    const raw = (pending.signed_raw.startsWith("0x") ? pending.signed_raw : `0x${pending.signed_raw}`) as Hex;
    const k = `${pid}:${pending.tx.nonce}:${raw.slice(-16)}`; // a replacement has a new signature
    if (this.undecodable.has(k)) return this.recover(pid, pending);
    let hash = this.sent.get(k);
    if (!hash) {
      try {
        hash = await pub.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        if (!/decode/i.test((e as Error).message)) throw e;
        // Signed by a contract version before the r/s encoding fix: nodes can't decode it
        this.undecodable.add(k);
        log("relayer", `position ${pid} nonce ${pending.tx.nonce}: stored tx can't be decoded; recovering (nonce burn / re-sign)`);
        return this.recover(pid, pending);
      }
      this.sent.set(k, hash);
    }
    const rc = await pub.waitForTransactionReceipt({ hash });
    const p = this.positions.get(pid)!;
    // A load-balanced RPC can answer from a node a block behind the receipt: wait until the
    // nonce reflects this tx before confirming it
    let onchain = 0;
    for (let i = 0; i < 10; i++) {
      onchain = await pub.getTransactionCount({ address: p.evm_address as Address, blockTag: "latest" });
      if (onchain > pending.tx.nonce) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const r = await this.callR("confirm_nonce", { position_id: pid, onchain_nonce: onchain, success: rc.status === "success", block: Number(rc.blockNumber) });
    return { evmTx: hash, ok: rc.status === "success", nearTx: r.hash };
  }

  /** The stuck-tx recovery (nonce burn / re-sign) for a stored tx no node accepts: a settlement leg is re-signed with a 10 % fee
   *  bump (anyone may); a borrower tx is burned once `nonce_burn_after` has passed (anyone may). */
  private async recover(pid: number, pending: NonNullable<Position["pending"]>): Promise<undefined> {
    const kind = JSON.stringify(pending.kind).toLowerCase();
    const gas = (pending.tx as any).gas as { max_fee_per_gas: string; max_priority_fee_per_gas: string };
    try {
      if (kind.includes("settlement") && !pending.replaced) {
        const bump = (x: string) => ((BigInt(x) * 12n) / 10n).toString();
        const c = await this.callR("replace_pending", { position_id: pid, max_fee_per_gas: bump(gas.max_fee_per_gas), max_priority_fee_per_gas: bump(gas.max_priority_fee_per_gas) }, 150n * 1_000_000_000_000n);
        log("relayer", `position ${pid}: settlement leg re-signed ${short(c.hash)}`);
      } else {
        const params = await view<{ nonce_burn_after_ns: string }>("get_params");
        if (nowNs() < BigInt(pending.signed_at) + BigInt(params.nonce_burn_after_ns)) return;
        const c = await this.callR("burn_nonce", { position_id: pid, gas: GAS }, 150n * 1_000_000_000_000n);
        log("relayer", `position ${pid}: undecodable borrower tx → nonce burned ${short(c.hash)}`);
      }
    } catch (e) {
      log("relayer", `position ${pid} recovery: ${(e as Error).message}`);
    }
    return undefined;
  }

  /** Scan fork logs since the last cursor: steward top-ups and repays (in on-chain order). */
  async scanLogs() {
    // Sepolia: two blocks behind the head, since load-balanced public RPCs can sit a block behind each other
    const head = (await pub.getBlockNumber()) - (cfg.realChain ? 2n : 0n); // anvil mines only on demand: no lag there
    if (this.logCursor === 0n) this.logCursor = head - 50n;
    if (head <= this.logCursor) return;
    const from = this.logCursor + 1n;
    const positions = [...this.positions.values()].filter((p) => p.evm_address);
    const posAddr = new Set(positions.map((p) => p.evm_address!.toLowerCase()));
    const [, , stewards] = await view<[string, string[], string[], boolean]>("get_roles");
    const stewardOf = new Map<string, string>();
    for (const st of stewards) {
      const pay = await this.payout(st);
      if (pay) stewardOf.set(pay, st);
    }

    const logs = (await pub.getLogs({ address: cfg.aave.pool, fromBlock: from, toBlock: head }))
      .sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!);
    this.logCursor = head; // only after a successful read: a failed one is retried, never skipped
    // the live rescues are read only if a log concerns one of our positions
    let rescues: Rescue[] = [];
    let haveRescues = false;
    const live = async () => {
      if (!haveRescues) [rescues, haveRescues] = [await this.liveRescues(), true];
      return rescues;
    };
    for (const lg of logs) {
      let ev: any;
      try {
        ev = decodeEventLog({ abi: poolAbi, data: lg.data, topics: lg.topics });
      } catch {
        continue;
      }
      const block = Number(lg.blockNumber);
      if (ev.eventName === "Supply" && posAddr.has(ev.args.onBehalfOf.toLowerCase())) {
        const pos = positions.find((p) => p.evm_address!.toLowerCase() === ev.args.onBehalfOf.toLowerCase())!;
        if (await this.isVerified(pos.id)) {
          if ((await live()).some((r) => r.position_id === pos.id && r.state === "top_up_pending")) {
            log("keeper", `supply onBehalfOf position ${pos.id} seen (block ${block}) → requesting a verified reading to prove it`);
            this.verifyNow.set(pos.id, BigInt(block));
          }
          continue;
        }
        for (const r of (await live()).filter((r) => r.position_id === pos.id && r.state === "top_up_pending")) {
          for (const m of r.members.filter((m) => !m.confirmed)) {
            if ((await this.payout(m.steward)) === ev.args.user.toLowerCase() && BigInt(ev.args.amount) >= BigInt(m.share_units)) {
              const c = await this.callR("confirm_topup", { rescue_id: r.id, steward: m.steward, units: ev.args.amount.toString(), evm_tx: lg.transactionHash, block });
              log("reporter", `top-up by ${m.steward.split(".")[0]} seen (${cfg.evm} ${short(lg.transactionHash!)}, block ${block}) → confirm_topup ${short(c.hash)}`);
              rescues = await this.liveRescues();
            }
          }
        }
      } else if (ev.eventName === "Repay" && posAddr.has(ev.args.user.toLowerCase()) && !posAddr.has(ev.args.repayer.toLowerCase())) {
        const pos = positions.find((p) => p.evm_address!.toLowerCase() === ev.args.user.toLowerCase())!;
        const repayer = ev.args.repayer.toLowerCase();
        const settling = (await live()).find((r) => r.position_id === pos.id && r.state === "settling" && r.settlement && !r.settlement.repay_confirmed);
        // A verified start: the contract confirms the repay from a proof of the scaled debt drop
        if (settling && (await this.isVerified(pos.id)) && (await view<Watch | null>("get_watch", { position_id: pos.id }).catch(() => null))?.settle?.rescue_id === settling.id) {
          log("keeper", `repay on position ${pos.id} seen (block ${block}) → requesting a verified reading to prove the debt drop`);
          this.verifyNow.set(pos.id, BigInt(block));
          continue;
        }
        if (settling && (await this.payout(settling.settlement!.settler)) === repayer && BigInt(ev.args.amount) >= BigInt(settling.settlement!.repay_units)) {
          const c = await this.callR("confirm_settlement_repay", { rescue_id: settling.id, evm_tx: lg.transactionHash, units: ev.args.amount.toString(), block });
          log("reporter", `settlement repay by ${settling.settlement!.settler.split(".")[0]} seen (${cfg.evm} ${short(lg.transactionHash!)}) → confirmed ${short(c.hash)}`);
          rescues = await this.liveRescues();
        } else if (stewardOf.has(repayer) && rescues.some((r) => r.position_id === pos.id && (r.state === "open" || r.state === "settling"))) {
          // A steward repaid without a committed settlement of its own: reimbursed at par later
          const st = stewardOf.get(repayer)!;
          try {
            const c = await this.callR("confirm_stray_repay", { position_id: pos.id, steward: st, units: ev.args.amount.toString(), evm_tx: lg.transactionHash, block });
            log("reporter", `uncommitted repay by ${st.split(".")[0]} (${cfg.evm} ${short(lg.transactionHash!)}) → recorded for reimbursement ${short(c.hash)}`);
          } catch (e) {
            log("reporter", `repay by ${st.split(".")[0]} not recorded: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  /** Buy-back escrow: prove the position address's own collateral and debt balances while a claim is
   *  open (TEMPORARY reporter; verified balance proofs later). Any buy-back they cover commits. */
  async proveEscrow(pid: number) {
    const p = this.positions.get(pid)!;
    if (!p.evm_address || p.open_rescues.length === 0) return;
    if (await this.isVerified(pid)) return; // balances come from the verified reading
    if (p.pending && JSON.stringify(p.pending.kind).toLowerCase().includes("outflow")) return;
    const books = await this.books(pid);
    if (books.outflows.length) return;
    const block = await pub.getBlockNumber();
    const a = await marketAssets(p.market_id);
    const [coll, debt] = await Promise.all([balance(a.collateral, p.evm_address as Address), balance(a.debt, p.evm_address as Address)]);
    const key = `${coll}:${debt}`;
    if (this.lastEscrow.get(pid) === key || (coll === 0n && debt === 0n && !this.lastEscrow.has(pid))) return;
    try {
      const c = await this.callR("confirm_escrow", { position_id: pid, collateral_units: coll.toString(), debt_units: debt.toString(), block: Number(block) });
      this.lastEscrow.set(pid, key);
      log("reporter", `position ${pid} holds ${fmt(coll, a.cDec)} ${a.cSym} + ${fmt(debt, a.dDec)} ${a.dSym} for buy-back (block ${block}) → confirm_escrow ${short(c.hash)}`);
      await this.report(pid, true); // a DAI buy-back commits on a reading at least this new
    } catch (e) {
      log("reporter", `escrow proof for position ${pid}: ${(e as Error).message}`);
    }
  }

  async liveRescues(): Promise<Rescue[]> {
    const out = await this.cursor.read();
    return out.filter((r) => !FINAL.includes(r.state) && (!this.scope || this.scope.has(r.position_id)));
  }

  /** Public housekeeping anyone may do: close auctions, expire missed top-ups, sign settlement legs. */
  async housekeep() {
    const now = nowNs();
    for (const pid of this.positions.keys()) {
      try {
        const p = this.positions.get(pid)!; // read this tick; the contract refuses a stale pay_next
        const books = await this.books(pid);
        if (books.outflows.length && !p.pending) {
          const o = books.outflows[0];
          const c = await this.callR("pay_next", { position_id: pid, gas: GAS }, 150n * 1_000_000_000_000n);
          const a = await marketAssets(p.market_id);
          const debtSide = JSON.stringify(o.action).includes("debt");
          log("keeper", `position ${pid}: payout signed (${o.purpose}, ${fmt(BigInt(o.amount), debtSide ? a.dDec : a.cDec)} ${debtSide ? a.dSym : a.cSym}${o.action === "withdraw" ? " withdrawn" : ""} → ${short(o.to)}) ${short(c.hash)}`);
        }
      } catch (e) {
        log("keeper", `position ${pid} payout: ${(e as Error).message}`);
      }
    }
    for (const r of await this.liveRescues()) {
      try {
        if (r.state === "auction" && now >= BigInt(r.closes_at)) {
          const c = await this.callR("close_auction", { rescue_id: r.id });
          log("keeper", `auction ${r.id} closed ${short(c.hash)}`);
        } else if (r.state === "top_up_pending" && now > BigInt(r.topup_deadline) + ((await this.isVerified(r.position_id)) ? VERIFIED_EXPIRY_GRACE_NS : 0n)) {
          // verified market: the first verified reading from after the deadline decides (the
          // busy proof cadence keeps them coming); a direct expiry is only the outage fallback
          const c = await this.callR("expire_topup", { rescue_id: r.id });
          log("keeper", `top-up deadline missed on rescue ${r.id} → expire_topup ${short(c.hash)}`);
        } else if (r.state === "settling" && r.settlement?.repay_confirmed) {
          const p = await view<Position>("get_position", { position_id: r.position_id });
          if (!p.pending) {
            const c = await this.callR("settle_next", { rescue_id: r.id, gas: GAS }, 150n * 1_000_000_000_000n);
            log("keeper", `settlement leg signed for rescue ${r.id} (MPC) ${short(c.hash)}`);
          }
        }
      } catch (e) {
        // each leg waits for a reading after the last event; the next pass requests one
        if (!(e as Error).message.includes("predates the last event")) log("keeper", `rescue ${r.id}: ${(e as Error).message}`);
      }
    }
  }

  /** One pass of everything. */
  async tick() {
    this.booksMemo.clear();
    await this.refreshPositions();
    for (const pid of this.positions.keys()) {
      const p = this.positions.get(pid)!;
      if (p.pending?.signed_raw) {
        const r = await this.relay(pid);
        if (r) log("relayer", `position ${pid} nonce ${p.pending.tx.nonce}: ${cfg.evm} ${short(r.evmTx)} ${r.ok ? "ok" : "REVERTED"} → confirm_nonce ${short(r.nearTx)}`);
      }
    }
    await this.scanLogs();
    for (const pid of this.positions.keys()) await this.proveEscrow(pid);
    for (const pid of this.positions.keys()) {
      try {
        if (await this.isVerified(pid)) {
          const v = await this.verify(pid);
          if (v) log("verifier", `position ${pid}: verified read ${short(v.hash)} → ${v.note}`);
          continue;
        }
        const r = await this.report(pid);
        if (r) log("reporter", `report_health position ${pid} ${short(r.hash)}${r.auction != null ? ` → auction ${r.auction} opened` : ""}`);
      } catch (e) {
        log("reporter", `report_health position ${pid}: ${(e as Error).message}`);
      }
    }
    await this.housekeep();
  }

  async run(intervalMs = 3000) {
    this.running = true;
    await loadGas().catch((e) => log("keeper", `market gas cap not read (${(e as Error).message}); using ${GAS.gas_limit}`));
    // Repeated failures (a throttled RPC) back off up to a minute and recover on their own; the
    // NEAR view count is logged every 10 minutes.
    let failures = 0;
    let statsAt = Date.now();
    while (this.running) {
      try {
        await this.tick();
        failures = 0;
      } catch (e) {
        failures++;
        log("keeper", `tick failed${failures > 1 ? ` (${failures} in a row)` : ""}: ${(e as Error).message}`);
      }
      if (Date.now() - statsAt >= 10 * 60_000) {
        log("keeper", viewReport(Date.now() - statsAt));
        statsAt = Date.now();
      }
      await new Promise((r) => setTimeout(r, pollDelay(intervalMs, failures)));
    }
  }
  stop() {
    this.running = false;
  }
}

/** Near the trigger: a proof every minute while the plain health moves (≥ 1 bp since the last proof)
 *  or sits under the trigger; every 10 min while it stays where the last proof found it. */
export function nearTriggerCadence(hfNow: bigint, hfAtLastProof: bigint | undefined, triggerWad: bigint): number {
  if (hfNow < triggerWad || hfAtLastProof === undefined) return REPORT_EVERY_MS;
  const diff = hfNow > hfAtLastProof ? hfNow - hfAtLastProof : hfAtLastProof - hfNow;
  return diff >= 10n ** 14n ? REPORT_EVERY_MS : VERIFY_STILL_MS;
}


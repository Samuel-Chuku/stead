// A steward bot: watches auctions, bids by its strategy, tops up when it wins, settles its
// claims when they expire (or early), and takes over stalled settlements.
import { type Address, type Hex } from "viem";
import { cfg, env, hasEnv, stewardAccount, type StewardName } from "./config.js";
import { call, view, viewReport, NEAR, TGAS } from "./near.js";
import { wallet, write, ensureTokens, fundEth, poolAbi, erc20Abi, MAX, pub, price } from "./fork.js";
import { strategies, type AuctionView } from "./strategy.js";
import { sourceCapital } from "./intents.js";
import { DEFAULTS, clamp, type RiskSettings } from "./risk.js";
import { marketAssets, units } from "./market.js";
import { FINAL, RescueCursor, pollDelay } from "./rescues.js";
import { Hedger, type Venue } from "./hedge.js";
import { PERP } from "./orderly.js";
import { adjust, aiConfig, aiEnabled, aiWarning, type AiContext } from "./ai.js";
import { log, short, fmt } from "./log.js";
import { nowNs, settlementRepayUnits, type Rescue, type Position, type Params, type Claim, type Watch } from "./types.js";

const TAKEOVER_AFTER_NS = 180n * 1_000_000_000n;
const TOPUP_MARGIN_NS = 30n * 1_000_000_000n; // a top-up needs this long left to land before the deadline
const AI_EVERY_MS = 5 * 60_000;
const ROLES: Record<StewardName, string> = {
  swift: "bids first at a fixed spread, whatever the margin",
  patient: "bids late; takes thin margins the others skip, priced for the risk",
  deep: "capital-heavy, low risk: only comfortable margins and sizeable top-ups, low premium, full amount",
  pool: "joins coalitions with a partial amount; same margin filter as deep",
  hedged: "deep's filters; shorts the top-up asset on a testnet perps venue while its claim is open, so it bids without the price-risk premium",
};

export class Steward {
  readonly account: string;
  readonly evm: ReturnType<typeof wallet>;
  private seen = new Map<number, string>(); // rescue → last decision note (log once)
  private bid = new Set<number>();
  private supplied = new Set<string>();
  private repaid = new Set<number>();
  private approved = new Set<string>();
  /** Rescues whose top-up supply this steward has broadcast (the hedge may follow only these). */
  private toppedUp = new Set<number>();
  /** The hedged strategy's venue side (created on first use, once the market is known). */
  private hedger?: Hedger;
  /** Tests inject a fake venue here. */
  venue?: Venue;
  private running = false;
  public onAction?: (what: string, hash: string) => void;

  /** Positions to act on; undefined = all (long-running bot). The local-fork demo script scopes it to its own run. */
  public scope?: Set<number>;

  /** Risk limit per rescue, in whole collateral tokens (STEWARD_<NAME>_CAPACITY; may be fractional, e.g. 0.5 WBTC). */
  capacity?: number;
  capacityUnits?: bigint;
  /** What the strategy reads. Defaults unless a verified model answer changed them. */
  settings: RiskSettings;
  private recent: AiContext["recent"] = [];
  private prices: AiContext["prices"] = [];
  private lastAi = 0;
  private aiBusy = false;

  /** `name` is the strategy. Our four run as `<name>.steadfi.testnet`; anyone else sets
   *  STEWARD_ACCOUNT, STEWARD_EVM_KEY, and optionally STEWARD_CAPACITY (whole collateral tokens) and
   *  STEWARD_SETTINGS (JSON, clamped to the same bounds as every other change). */
  constructor(readonly name: StewardName) {
    const N = name.toUpperCase();
    const pick = (specific: string, generic: string) => (hasEnv(specific) ? env(specific) : hasEnv(generic) ? env(generic) : undefined);
    this.account = process.env.STEWARD_ACCOUNT || stewardAccount(name);
    const key = pick(`STEWARD_${N}_EVM_KEY`, "STEWARD_EVM_KEY");
    if (!key) throw new Error(`missing STEWARD_${N}_EVM_KEY or STEWARD_EVM_KEY in .env`);
    this.evm = wallet(key as Hex);
    const cap = pick(`STEWARD_${N}_CAPACITY`, "STEWARD_CAPACITY");
    if (cap) this.capacity = Number(cap); // turned into units once the market's decimals are known
    const own = process.env.STEWARD_SETTINGS;
    this.settings = own ? clamp(JSON.parse(own), DEFAULTS[name]) : { ...DEFAULTS[name] };
  }

  /** Joins the market on first start: `register_steward` with the storage deposit, paying out to
   *  this bot's EVM wallet. A steward the owner removed keeps settling its claims but never bids. */
  async ensureRegistered(): Promise<"steward" | "removed"> {
    const [, , stewards] = await view<[string, string[], string[], boolean]>("get_roles");
    if (stewards.includes(this.account)) {
      const payout = await view<string | null>("get_evm_payout", { account_id: this.account });
      if (!payout) await call(this.account, "set_evm_payout", { address: this.evm.address }, { gas: 10n * TGAS });
      else if (payout.toLowerCase() !== this.evm.address.toLowerCase()) log(this.name, `note: payout on the contract is ${short(payout)}, this wallet is ${short(this.evm.address)}`);
      return "steward";
    }
    const removed = await view<string[]>("get_removed_stewards");
    if (removed.includes(this.account)) {
      log(this.name, `${this.account} was removed by the contract owner: no new bids; open claims still settle`);
      return "removed";
    }
    if (process.env.STEWARD_AUTO_REGISTER === "false") throw new Error(`${this.account} is not a steward; register_steward first`);
    const deposit = BigInt(await view<string>("get_steward_deposit"));
    const c = await call(this.account, "register_steward", { payout: this.evm.address }, { deposit, gas: 10n * TGAS });
    log(this.name, `registered ${this.account} as a steward (deposit ${Number(deposit) / 1e24} NEAR, payout ${short(this.evm.address)}) ${short(c.hash)}`);
    return "steward";
  }

  private marketOf = new Map<number, number>();
  private async onMyMarket(pid: number): Promise<boolean> {
    if (!this.marketOf.has(pid)) {
      const p = await view<Position | null>("get_position", { position_id: pid });
      if (!p) return false;
      this.marketOf.set(pid, p.market_id);
    }
    return this.marketOf.get(pid) === cfg.marketId;
  }

  private remember(e: AiContext["recent"][number]) {
    this.recent = [...this.recent.filter((x) => !(x.rescue === e.rescue && x.outcome === e.outcome)), e].slice(-10);
  }

  /** Optional AI risk tuning (NEAR AI Cloud). Runs beside the tick loop, never blocks it. */
  private maybeAdjust() {
    if (!aiEnabled() || this.aiBusy || Date.now() - this.lastAi < AI_EVERY_MS) return;
    this.aiBusy = true;
    this.lastAi = Date.now();
    const before = this.settings;
    adjust({ steward: this.name, role: ROLES[this.name], current: before, recent: this.recent, prices: this.prices })
      .then((r) => {
        if (!r.verified && !r.applied_unverified) {
          log(this.name, `[ai] not applied (${r.error}): keeping settings · ${r.model} @ ${r.provider}`);
          return;
        }
        this.settings = r.applied;
        const diff = (Object.keys(before) as (keyof RiskSettings)[])
          .filter((k) => before[k] !== r.applied[k])
          .map((k) => `${k} ${before[k]}→${r.applied[k]}`)
          .join(", ");
        const proof = r.verified
          ? `✔ signed by ${short(r.signing_address ?? "")} (${r.model}) ${r.verify_url}`
          : `UNVERIFIED: ${r.provider} signs nothing; applied because AI_REQUIRE_SIGNATURE is off (${r.model})`;
        const ignored = r.dropped?.length ? ` (ignored, changed without being named in the reason: ${r.dropped.join(", ")})` : "";
        log(this.name, `[ai] ${diff || "no change"}${ignored}: "${r.reason ?? ""}" ${proof}`);
      })
      .finally(() => (this.aiBusy = false));
  }

  private note(rid: number, msg: string) {
    if (this.seen.get(rid) !== msg) {
      this.seen.set(rid, msg);
      log(this.name, msg);
    }
  }

  private async approveOnce(token: Address) {
    if (this.approved.has(token)) return;
    const a = (await pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.evm.address, cfg.aave.pool] })) as bigint;
    if (a < MAX / 2n) await write(this.evm, token, erc20Abi, "approve", [cfg.aave.pool, MAX]);
    this.approved.add(token);
  }

  /** Test tokens from Aave's faucet (and, on the fork, gas), plus Pool approvals up front so a
   *  won top-up is a single supply tx inside the deadline. */
  async fund() {
    await fundEth(this.evm.address);
    const a = await marketAssets();
    // about $60,000 of collateral at the oracle price, and 20,000 of the debt asset
    const px = await price(a.collateral);
    await ensureTokens(this.evm, a.collateral, (60_000n * 10n ** 8n * 10n ** BigInt(a.cDec)) / px);
    await ensureTokens(this.evm, a.debt, units(20_000, a.dDec));
    await this.approveOnce(a.collateral);
    await this.approveOnce(a.debt);
  }

  /** True after a tick that saw a live rescue on this steward's market (poll at full speed). */
  busy = false;
  private cursor = new RescueCursor();

  async tick() {
    const params = await view<Params>("get_params");
    const rescues = await this.cursor.read();
    this.busy = false;
    const mine = rescues.filter((r) => !this.scope || this.scope.has(r.position_id));
    for (const r of mine) {
      if (!FINAL.includes(r.state) && (await this.onMyMarket(r.position_id))) this.busy = true;
      // only rescues on this chain's market: other positions live on another EVM chain
      if (!["bought_back", "settled", "failed"].includes(r.state) && !(await this.onMyMarket(r.position_id))) continue;
      try {
        if (r.state === "auction") await this.onAuction(r, params);
        else if (r.state === "top_up_pending") await this.onTopUp(r);
        else if (r.state === "open") await this.onOpen(r, params);
        else if (r.state === "settling") await this.onSettling(r);
      } catch (e) {
        this.note(r.id, `rescue ${r.id}: ${(e as Error).message}`);
      }
    }
    // after every rescue action of this tick: the top-up always comes before the hedge
    if (this.name === "hedged") await this.syncHedge(mine);
  }

  private async hedge(): Promise<Hedger> {
    if (!this.hedger) {
      const a = await marketAssets();
      const symbol = PERP[a.cSym];
      if (!symbol) throw new Error(`no perp for ${a.cSym} on the venue`);
      this.hedger = new Hedger(this.name, symbol, a.cSym, this.venue);
    }
    return this.hedger;
  }

  /** The units this steward is still owed, from the contract alone (base units of the collateral):
   *  its share once its supply is broadcast; then each open claim's share minus the settlement
   *  legs already paid to it. Every exit (buy-back, settlement, forfeit, failed or refunded top-up,
   *  takeover) drops it to 0 by itself. */
  async hedgeTarget(rescues: Rescue[]): Promise<bigint> {
    let owed = 0n;
    for (const r of rescues) {
      if (FINAL.includes(r.state) || !(await this.onMyMarket(r.position_id))) continue;
      const m = r.members.find((x) => x.steward === this.account);
      if (!m) continue;
      if (r.state === "top_up_pending") {
        if (this.toppedUp.has(r.id)) owed += BigInt(m.share_units);
        continue;
      }
      if ((r.state !== "open" && r.state !== "settling") || !m.claim_id) continue;
      const claim = await view<Claim>("get_claim", { token_id: m.claim_id });
      if (claim.status !== "open" || claim.owner !== this.account) continue;
      const paid = (r.settlement?.legs ?? [])
        .filter((l) => l.claim_id === m.claim_id && l.done && l.amount !== "max")
        .reduce((x, l) => x + BigInt((l.amount as { exact: string }).exact), 0n);
      const left = BigInt(m.share_units) - paid;
      if (left > 0n) owed += left;
    }
    return owed;
  }

  private async syncHedge(rescues: Rescue[]) {
    try {
      const owed = await this.hedgeTarget(rescues);
      const a = await marketAssets();
      const live = rescues.filter((r) => !FINAL.includes(r.state) && r.members.some((x) => x.steward === this.account)).map((r) => r.id);
      await (await this.hedge()).reconcile(Number(owed) / 10 ** a.cDec, `rescues [${live.join(",")}] owed ${fmt(owed, a.cDec)} ${a.cSym}`);
    } catch (e) {
      log(this.name, `unhedged: ${(e as Error).message} (retrying next tick; the top-up is unaffected)`);
    }
  }

  private async onAuction(r: Rescue, params: Params) {
    if (this.bid.has(r.id) || r.bids.some((b) => b.steward === this.account)) return;
    const [nh, pos, market] = await Promise.all([
      view<[string, string, string] | null>("get_net_health", { position_id: r.position_id }),
      view<Position>("get_position", { position_id: r.position_id }),
      view<{ lt_bps: number }>("get_market", { market_id: cfg.marketId }),
    ]);
    if (!nh || !pos.health) return;
    const px = Number(BigInt(pos.health.collateral_price_base)) / 1e8;
    if (this.prices.at(-1)?.collateralUsd !== px) this.prices = [...this.prices, { at: new Date().toISOString(), collateralUsd: px }].slice(-20);
    const a: AuctionView = {
      capBps: r.cap_bps,
      topupUnits: BigInt(r.topup_units),
      topupBase: BigInt(r.topup_base),
      openedAtNs: BigInt(r.opened_at),
      closesAtNs: BigInt(r.closes_at),
      nowNs: nowNs(),
      netHf: Number(BigInt(nh[1]) / 10n ** 12n) / 1e6,
      ltBps: market.lt_bps,
      debtBase: BigInt(pos.health.debt_base),
      earlyHf: params.early_settle_hf_bps / 10_000,
      capacityUnits: this.capacityUnits ?? (this.capacity !== undefined ? units(this.capacity, (await marketAssets()).cDec) : undefined),
      decimals: (await marketAssets()).cDec,
    };
    if (this.name === "hedged") {
      const units = a.capacityUnits !== undefined && a.capacityUnits < a.topupUnits ? a.capacityUnits : a.topupUnits;
      a.hedge = await (await this.hedge()).quote(Number(units) / 10 ** (a.decimals ?? 18));
    }
    if (a.nowNs >= a.closesAtNs) return;
    const d = strategies[this.name](a, this.settings);
    if (!d.bid) {
      this.note(r.id, `auction ${r.id}: ${d.why}`);
      if (!d.wait) this.remember({ rescue: r.id, outcome: `skipped: ${d.why}` });
      return;
    }
    this.remember({ rescue: r.id, outcome: "bid", bps: d.bps });
    this.bid.add(r.id);
    const c = await call(this.account, "bid", { rescue_id: r.id, premium_bps: d.bps, amount_units: d.amountUnits.toString() }, { deposit: BigInt(params.bid_bond), gas: 30n * TGAS });
    const ma = await marketAssets();
    log(this.name, `bid on auction ${r.id}: ${d.bps} bps for ${fmt(d.amountUnits, ma.cDec)} ${ma.cSym} (${d.why}) ${short(c.hash)}`);
    this.onAction?.(`bid ${d.bps} bps`, c.hash);
  }

  private async onTopUp(r: Rescue) {
    const m = r.members.find((m) => m.steward === this.account && !m.confirmed);
    if (!m) return;
    const key = `${r.id}`;
    if (this.supplied.has(key)) return;
    // a supply landing after the deadline would be a gift to the borrower: don't start one this late
    if (nowNs() > BigInt(r.topup_deadline) - TOPUP_MARGIN_NS) return;
    const pos = await view<Position>("get_position", { position_id: r.position_id });
    this.supplied.add(key);
    this.remember({ rescue: r.id, outcome: "won", bps: m.premium_bps });
    let sent = false;
    try {
      const a = await marketAssets();
      await sourceCapital(this.name, this.evm, a.collateral, a.cSym, BigInt(m.share_units), a.cDec);
      await this.approveOnce(a.collateral);
      const tx = await write(this.evm, cfg.aave.pool, poolAbi, "supply", [a.collateral, BigInt(m.share_units), pos.evm_address, 0], () => {
        sent = true;
        this.toppedUp.add(r.id);
      });
      log(this.name, `won rescue ${r.id}: supplied ${fmt(BigInt(m.share_units), a.cDec)} ${a.cSym} onBehalfOf the position (${cfg.evm} ${short(tx)})`);
      this.onAction?.("top-up", tx);
    } catch (e) {
      // Nothing broadcast (e.g. a load-balanced RPC node that hasn't seen our approve yet): the next
      // tick tries again. Once a supply is broadcast it is never resent, so it can't land twice.
      if (!sent) this.supplied.delete(key);
      throw e;
    }
  }

  private async onOpen(r: Rescue, params: Params) {
    const mine = r.members.find((m) => m.steward === this.account && m.claim_id);
    if (!mine) return;
    const claim = await view<Claim>("get_claim", { token_id: mine.claim_id });
    if (claim.status !== "open" || claim.owner !== this.account) return;
    const pos = await view<Position>("get_position", { position_id: r.position_id });
    if (pos.open_rescues[0] !== r.id) return; // oldest first
    // The contract only decides on a reading at least as new as the position's last event
    const books = await view<{ last_event_block: number }>("get_books", { position_id: r.position_id });
    if (!pos.health || pos.health.block < books.last_event_block) return;
    // the claim's own deadline, fixed when it opened (a later window change doesn't move it)
    const expired = nowNs() >= BigInt(claim.expires_at);
    const nh = await view<[string, string, string] | null>("get_net_health", { position_id: r.position_id });
    const early = nh != null && BigInt(nh[1]) < BigInt(params.early_settle_hf_bps) * 10n ** 14n;
    if (!expired && !early) return;
    const c = await call(this.account, "start_settlement", { rescue_id: r.id });
    log(this.name, `claim ${claim.token_id} ${expired ? "expired" : "net HF below early level"} → start_settlement ${short(c.hash)}`);
    this.onAction?.("start_settlement", c.hash);
  }

  private async onSettling(r: Rescue) {
    const s = r.settlement!;
    if (s.repay_confirmed) return;
    if (s.settler !== this.account) {
      // Take over a stalled repayment after 3 min
      const stalled = nowNs() >= BigInt(s.started_at) + TAKEOVER_AFTER_NS;
      if (!stalled) return;
      const c = await call(this.account, "take_over_settlement", { rescue_id: r.id });
      log(this.name, `settlement ${r.id} stalled → took it over ${short(c.hash)}`);
      return;
    }
    if (this.repaid.has(r.id) || BigInt(s.repay_units) === 0n) return;
    this.repaid.add(r.id);
    let sent = false;
    try {
      const [pos, w] = await Promise.all([view<Position>("get_position", { position_id: r.position_id }), view<Watch | null>("get_watch", { position_id: r.position_id }).catch(() => null)]); // older contract: no watch
      // a verified start: the contract confirms the repay from the scaled debt drop
      const need = w?.settle?.rescue_id === r.id ? BigInt(w.settle.need) : undefined;
      const a = await marketAssets();
      const di = need ? ((await pub.readContract({ address: cfg.aave.pool, abi: poolAbi, functionName: "getReserveNormalizedVariableDebt", args: [a.debt] })) as bigint) : 0n;
      const amount = settlementRepayUnits(BigInt(s.repay_units), need, di);
      await ensureTokens(this.evm, a.debt, amount);
      await this.approveOnce(a.debt);
      const tx = await write(this.evm, cfg.aave.pool, poolAbi, "repay", [a.debt, amount, 2n, pos.evm_address], () => (sent = true));
      log(this.name, `settlement ${r.id}: repaid ${fmt(amount, a.dDec)} ${a.dSym} onBehalfOf the position${need ? " (covers the proven scaled drop)" : ""} (${cfg.evm} ${short(tx)})`);
      this.onAction?.("settlement repay", tx);
    } catch (e) {
      if (!sent) this.repaid.delete(r.id); // nothing broadcast: try again next tick
      throw e;
    }
  }

  async run(intervalMs = 2000) {
    this.running = true;
    log(this.name, `${this.account} · ${cfg.contract} market ${cfg.marketId} · wallet ${short(this.evm.address)}`);
    while (this.running) {
      try {
        await this.ensureRegistered();
        // optional: test tokens from Aave's faucet and Pool approvals, so a won top-up is one tx
        if (process.env.STEWARD_FUND_ON_START === "true") await this.fund();
        break;
      } catch (e) {
        log(this.name, `start-up failed: ${(e as Error).message}; retrying in 30 s`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
    if (aiEnabled()) {
      const c = aiConfig();
      log(this.name, `[ai] tuning on: ${c.models.join(" → ")} @ ${c.host}, every ${AI_EVERY_MS / 60_000} min`);
      const w = aiWarning();
      if (w) log(this.name, `[ai] ${w}`);
    }
    // Two speeds: full speed while a rescue on this market is live; the idle interval otherwise
    // (STEWARD_IDLE_INTERVAL_MS, default = the full-speed interval). Repeated failures (a
    // throttled RPC) back off up to a minute and recover on their own.
    const idleMs = Number(process.env.STEWARD_IDLE_INTERVAL_MS ?? intervalMs);
    let failures = 0;
    let statsAt = Date.now();
    while (this.running) {
      try {
        await this.tick();
        failures = 0;
      } catch (e) {
        failures++;
        log(this.name, `tick failed${failures > 1 ? ` (${failures} in a row)` : ""}: ${(e as Error).message}`);
      }
      if (Date.now() - statsAt >= 10 * 60_000) {
        log(this.name, viewReport(Date.now() - statsAt));
        statsAt = Date.now();
      }
      this.maybeAdjust();
      await new Promise((r) => setTimeout(r, pollDelay(this.busy ? intervalMs : idleMs, failures)));
    }
  }
  stop() {
    this.running = false;
  }
}

export const NEAR_BOND = NEAR / 10n;

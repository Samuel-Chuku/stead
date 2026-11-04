// A steward bot: watches auctions, bids by its strategy, tops up when it wins, settles its
// claims when they expire (or early), and takes over stalled settlements.
import { type Address, type Hex } from "viem";
import { cfg, env, stewardAccount, type StewardName } from "./config.js";
import { call, view, NEAR, TGAS } from "./near.js";
import { wallet, write, ensureTokens, fundEth, poolAbi, erc20Abi, MAX, pub } from "./fork.js";
import { strategies, type AuctionView } from "./strategy.js";
import { log, short, fmt } from "./log.js";
import { nowNs, type Rescue, type Position, type Params, type Claim } from "./types.js";

const TAKEOVER_AFTER_NS = 180n * 1_000_000_000n;

export class Steward {
  readonly account: string;
  readonly evm: ReturnType<typeof wallet>;
  private seen = new Map<number, string>(); // rescue → last decision note (log once)
  private bid = new Set<number>();
  private supplied = new Set<string>();
  private repaid = new Set<number>();
  private approved = new Set<string>();
  private running = false;
  public onAction?: (what: string, hash: string) => void;

  /** Positions to act on; undefined = all (long-running bot). The local-fork demo script scopes it to its own run. */
  public scope?: Set<number>;

  constructor(readonly name: StewardName) {
    this.account = stewardAccount(name);
    this.evm = wallet(env(`STEWARD_${name.toUpperCase()}_EVM_KEY`) as Hex);
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

  /** Fork-only: gas and test tokens for this steward's EVM wallet. */
  async fund() {
    await fundEth(this.evm.address);
    await ensureTokens(this.evm, cfg.aave.link, 2_000n * 10n ** 18n);
    await ensureTokens(this.evm, cfg.aave.dai, 20_000n * 10n ** 18n);
  }

  async tick() {
    const params = await view<Params>("get_params");
    const rescues: Rescue[] = [];
    for (let from = 0; ; from += 50) {
      const page = await view<Rescue[]>("get_rescues", { from, limit: 50 });
      rescues.push(...page);
      if (page.length < 50) break;
    }
    for (const r of rescues.filter((r) => !this.scope || this.scope.has(r.position_id))) {
      try {
        if (r.state === "auction") await this.onAuction(r, params);
        else if (r.state === "top_up_pending") await this.onTopUp(r);
        else if (r.state === "open") await this.onOpen(r, params);
        else if (r.state === "settling") await this.onSettling(r);
      } catch (e) {
        this.note(r.id, `rescue ${r.id}: ${(e as Error).message}`);
      }
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
    };
    if (a.nowNs >= a.closesAtNs) return;
    const d = strategies[this.name](a);
    if (!d.bid) {
      this.note(r.id, `auction ${r.id}: ${d.why}`);
      return;
    }
    this.bid.add(r.id);
    const c = await call(this.account, "bid", { rescue_id: r.id, premium_bps: d.bps, amount_units: d.amountUnits.toString() }, { deposit: BigInt(params.bid_bond), gas: 30n * TGAS });
    log(this.name, `bid on auction ${r.id}: ${d.bps} bps for ${fmt(d.amountUnits)} LINK (${d.why}) ${short(c.hash)}`);
    this.onAction?.(`bid ${d.bps} bps`, c.hash);
  }

  private async onTopUp(r: Rescue) {
    const m = r.members.find((m) => m.steward === this.account && !m.confirmed);
    if (!m) return;
    const key = `${r.id}`;
    if (this.supplied.has(key)) return;
    const pos = await view<Position>("get_position", { position_id: r.position_id });
    this.supplied.add(key);
    await ensureTokens(this.evm, cfg.aave.link, BigInt(m.share_units));
    await this.approveOnce(cfg.aave.link);
    const tx = await write(this.evm, cfg.aave.pool, poolAbi, "supply", [cfg.aave.link, BigInt(m.share_units), pos.evm_address, 0]);
    log(this.name, `won rescue ${r.id}: supplied ${fmt(BigInt(m.share_units))} LINK onBehalfOf the position (fork ${short(tx)})`);
    this.onAction?.("top-up", tx);
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
    const expired = nowNs() >= BigInt(r.claims_opened_at) + BigInt(params.buyback_window_ns);
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
    const pos = await view<Position>("get_position", { position_id: r.position_id });
    await ensureTokens(this.evm, cfg.aave.dai, BigInt(s.repay_units));
    await this.approveOnce(cfg.aave.dai);
    const tx = await write(this.evm, cfg.aave.pool, poolAbi, "repay", [cfg.aave.dai, BigInt(s.repay_units), 2n, pos.evm_address]);
    log(this.name, `settlement ${r.id}: repaid ${fmt(BigInt(s.repay_units))} DAI onBehalfOf the position (fork ${short(tx)})`);
    this.onAction?.("settlement repay", tx);
  }

  async run(intervalMs = 2000) {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        log(this.name, `tick failed: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  stop() {
    this.running = false;
  }
}

export const NEAR_BOND = NEAR / 10n;

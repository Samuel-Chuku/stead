// The hedged steward's venue side: price the hedge into the bid, then keep a short on a TESTNET
// perps venue equal to the units this steward is still owed. The top-up always comes first: no
// venue error can delay, skip or fail it (the steward logs "unhedged" and retries).
import * as orderly from "./orderly.js";
import { log } from "./log.js";

/** What a bid needs to know about the hedge (pure data, so the strategy stays a pure function). */
export interface HedgeQuote {
  ok: boolean; // the venue can take this hedge now
  priceRiskBps: number; // λ · σ₂₄ · 10⁴: the term a hedged steward no longer carries
  fundingBps: number; // what the short pays over 24 h (negative funding only; income not counted)
  feeBps: number; // open + close taker fees + slippage
  why: string;
}

/** Hedge parameters: λ and the 24 h volatility σ₂₄ per collateral symbol (overridable with HEDGE_VOL_<SYM>). */
export const LAMBDA = 0.25;
const VOL_24H: Record<string, number> = { LINK: 0.045, WBTC: 0.03, BTC: 0.03, WETH: 0.04, ETH: 0.04 };
export const SLIPPAGE_BPS = 5;
export const vol24 = (sym: string) => Number(process.env[`HEDGE_VOL_${sym}`] ?? VOL_24H[sym] ?? 0.05);

/** The venue operations the hedger uses (Orderly in production, a fake in tests). */
export interface Venue {
  market(symbol: string): Promise<{ baseTick: number; minNotional: number; mark: number; estFunding: number }>;
  freeCollateral(): Promise<number>;
  takerFeeBps(): Promise<number>;
  position(symbol: string): Promise<number>; // negative = short, base units
  /** Bids within `frac` of the mark, base units: what a market sell can actually fill. */
  bidDepth(symbol: string, frac: number): Promise<number>;
  order(symbol: string, side: "SELL" | "BUY", qty: number, reduceOnly: boolean): Promise<{ orderId: number }>;
}

export const orderlyVenue: Venue = {
  market: orderly.market,
  async freeCollateral() {
    const h = await orderly.holding();
    const usdc = h.find((x) => x.token === "USDC");
    return usdc ? usdc.holding - ((usdc as any).frozen ?? 0) : 0;
  },
  async takerFeeBps() {
    const i: any = await orderly.privateCall("GET", "/v1/client/info");
    return Number(i.futures_taker_fee_rate ?? 10); // the venue reports it in bps
  },
  position: orderly.position,
  async bidDepth(symbol, frac) {
    const [ob, m] = await Promise.all([orderly.privateCall<{ bids: { price: number; quantity: number }[] }>("GET", `/v1/orderbook/${symbol}?max_level=50`), orderly.market(symbol)]);
    return (ob.bids ?? []).filter((b) => b.price >= m.mark * (1 - frac)).reduce((a, b) => a + b.quantity, 0);
  },
  async order(symbol, side, qty, reduceOnly) {
    return orderly.marketOrder(symbol, side, qty, reduceOnly);
  },
};

const LEVERAGE = 10; // margin assumed per unit of notional (the venue's IMR is lower)
/** A hedge must be fillable within this distance of the mark (the venue cancels the rest of a
 *  market order beyond its price protection, so a thin book means a partial hedge). */
export const DEPTH_FRAC = 0.01;
const RECHECK_MS = 15_000; // after an order: read the venue again this soon (a partial fill is retried)
const roundDown = (x: number, tick: number) => Math.floor(x / tick + 1e-9) * tick;
const fix = (x: number) => Number(x.toFixed(8));

export class Hedger {
  /** Last target and when the venue was last read: reconcile only on change or every minute. */
  private last?: { target: number; at: number };
  constructor(readonly who: string, readonly symbol: string, readonly assetSym: string, readonly venue: Venue = orderlyVenue) {}

  /** Price the hedge for a top-up of `qty` base units. Any venue failure → ok: false. */
  async quote(qty: number): Promise<HedgeQuote> {
    const priceRiskBps = LAMBDA * vol24(this.assetSym) * 10_000;
    try {
      const [m, free, fee, depth] = await Promise.all([this.venue.market(this.symbol), this.venue.freeCollateral(), this.venue.takerFeeBps(), this.venue.bidDepth(this.symbol, DEPTH_FRAC)]);
      const fundingBps = Math.max(0, -m.estFunding) * 3 * 10_000;
      const feeBps = 2 * fee + SLIPPAGE_BPS;
      const q = roundDown(qty, m.baseTick);
      const notional = q * m.mark;
      if (notional < m.minNotional) return { ok: false, priceRiskBps, fundingBps, feeBps, why: `hedge ${fix(q)} below the venue minimum ($${m.minNotional})` };
      const need = (1.5 * notional) / LEVERAGE;
      if (free < need) return { ok: false, priceRiskBps, fundingBps, feeBps, why: `venue collateral $${free.toFixed(0)} < $${need.toFixed(0)} needed` };
      if (depth < q) return { ok: false, priceRiskBps, fundingBps, feeBps, why: `venue book too thin: ${fix(depth)} bid within ${DEPTH_FRAC * 100} % of the mark for a ${fix(q)} hedge` };
      return { ok: true, priceRiskBps, fundingBps, feeBps, why: `hedge ${fix(q)} ${this.symbol} ≈ $${notional.toFixed(0)} on the venue` };
    } catch (e) {
      return { ok: false, priceRiskBps, fundingBps: 0, feeBps: 0, why: `venue unavailable: ${(e as Error).message}` };
    }
  }

  /** Move the venue short to `target` base units (what the steward is still owed). Never shorts
   *  more than the target; reductions are reduce-only. Returns the order id, if one was sent. */
  async reconcile(target: number, context: string): Promise<number | undefined> {
    const now = Date.now();
    if (this.last && this.last.target === target && now - this.last.at < 60_000) return;
    const m = await this.venue.market(this.symbol);
    const want = -roundDown(target, m.baseTick);
    const have = await this.venue.position(this.symbol);
    this.last = { target, at: now };
    const diff = fix(want - have);
    if (Math.abs(diff) < m.baseTick / 2) return; // converged: next check in a minute
    // not there yet (a new target, or a partial fill the venue cancelled): check again soon
    this.last = { target, at: now - 60_000 + RECHECK_MS };
    if (diff < 0) {
      // more short: never past the target, and only above the venue minimum
      const qty = fix(-diff);
      if (qty * m.mark < m.minNotional) {
        log(this.who, `hedge ${context}: ${qty} ${this.symbol} below the venue minimum, left unhedged`);
        return;
      }
      const o = await this.venue.order(this.symbol, "SELL", qty, false);
      log(this.who, `hedge ${have === 0 ? "OPEN" : "ADJUST"} ${context}: short ${qty} ${this.symbol} → ${fix(want)} (venue order ${o.orderId})`);
      return o.orderId;
    }
    // less short (or closed): reduce-only, never more than the open short
    const qty = fix(Math.min(diff, -have));
    if (qty <= 0) return;
    const o = await this.venue.order(this.symbol, "BUY", qty, true);
    log(this.who, `hedge ${want === 0 ? "CLOSE" : "ADJUST"} ${context}: buy ${qty} ${this.symbol} reduce-only → ${fix(want)} (venue order ${o.orderId})`);
    return o.orderId;
  }
}

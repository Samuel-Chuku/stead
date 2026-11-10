// One demo rescue on a demo borrower's own position (NEAR testnet + Sepolia), the same steps a
// real borrower takes: borrow below the trigger, let the keeper's proven reading open the auction,
// let the stewards bid and top up, buy back exactly the owed amount, then reset the position to
// rest off-screen. Resumable: every step is chosen from chain state, so a restarted runner never
// borrows twice or pays twice. Signs only as the demo borrower (NEAR) and its payout wallet (Sepolia).
import type { Address, Hex } from "viem";
import { cfg } from "./config.js";
import { call, view, TGAS } from "./near.js";
import { pub, wallet, write, ensureTokens, accountData, price, erc20Abi, balance, E8 } from "./fork.js";
import { marketAssets, type MarketAssets } from "./market.js";
import { DEMO, STEP_DEADLINE_MS, buybackUnits, resetPlan, stepOf, type ChainView, type Step } from "./demogate.js";
import type { Books, Claim, Position, Rescue } from "./types.js";
import { sleep } from "./log.js";

const SIGN_GAS = 150n * TGAS;
const EVM_GAS = { gas_limit: "600000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "100000000" };

export interface DemoSlot {
  /** NEAR account of the demo borrower (demo.steadfi.testnet, demo-2.steadfi.testnet). */
  account: string;
  /** Its Sepolia payout wallet's key (receives borrowed DAI and withdrawn collateral, pays the buy-back). */
  evmKey: Hex;
  positionId: number | null;
  /** Collateral at rest, in the collateral's units (as a decimal string in the state file). */
  restUnits: string | null;
}
export interface Hooks {
  step(s: Step, d?: { rescueId?: number; tx?: string; note?: string }): void;
  log(msg: string): void;
}

const pos = (pid: number) => view<Position>("get_position", { position_id: pid });
const rescueOf = (p: Position) => p.active_auction ?? (p.open_rescues.length ? p.open_rescues[0] : null);

async function until<T>(what: string, step: Step, fn: () => Promise<T | undefined | null | false>, everyMs = 4000): Promise<T> {
  const end = Date.now() + (STEP_DEADLINE_MS[step] ?? 5 * 60_000);
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      /* a failed read is retried until the deadline */
    }
    await sleep(everyMs);
  }
  throw new Error(`stopped at: ${what}`);
}

/** The chain state a step is chosen from. */
export async function chainView(pid: number, restUnits: bigint, A: MarketAssets): Promise<ChainView> {
  const p = await pos(pid);
  const d = await accountData(p.evm_address as Address);
  const pc = await price(A.collateral);
  const rid = rescueOf(p);
  const r = rid === null ? null : await view<Rescue>("get_rescue", { rescue_id: rid });
  const books = await view<Books>("get_books", { position_id: pid });
  return {
    hfBps: Number(d.hfWad / 10n ** 14n),
    collateralUnits: (d.collateralBase * 10n ** BigInt(A.cDec)) / pc,
    restUnits,
    activeAuction: p.active_auction,
    openRescues: p.open_rescues,
    rescueState: r?.state ?? null,
    outflows: books.outflows.length,
  };
}

export class DemoRun {
  private w;
  constructor(private slot: DemoSlot, private hooks: Hooks) {
    this.w = wallet(slot.evmKey);
  }
  get payout(): Address {
    return this.w.address;
  }

  /** Sign one Aave action through the contract (MPC) and wait until it lands on Sepolia. */
  private async sign(pid: number, action: Record<string, unknown>, step: Step, label: string) {
    const before = (await pos(pid)).next_nonce;
    const c = await call(this.slot.account, "sign_action", { position_id: pid, action, gas: EVM_GAS }, { gas: SIGN_GAS });
    this.hooks.log(`${label}: sign_action ${c.hash}`);
    // done only when the contract has seen it land (no transaction in flight on the position)
    await until(`${label} on Sepolia`, step, async () => {
      const p = await pos(pid);
      return p.next_nonce > before && p.pending === null;
    });
    return c.hash;
  }

  /** Borrow until Aave's HF is `hfBps`, and send the borrowed DAI to the demo borrower's payout. */
  private async borrowTo(pid: number, A: MarketAssets, hfBps: number, step: Step) {
    const addr = (await pos(pid)).evm_address as Address;
    const d = await accountData(addr);
    const pd = await price(A.debt);
    const target = (d.collateralBase * d.ltBps) / BigInt(hfBps);
    if (target <= d.debtBase) return;
    const units = ((target - d.debtBase) * 10n ** BigInt(A.dDec)) / pd;
    const h = await this.sign(pid, { type: "borrow", amount: units.toString() }, step, `borrow to HF ${hfBps / 10_000}`);
    await this.sign(pid, { type: "transfer_debt", amount: units.toString() }, step, "send the borrowed DAI to the payout");
    return h;
  }

  /** One time per slot: register the position, fund its gas, supply the resting collateral, borrow to 1.17. */
  async prepare(funder: ReturnType<typeof wallet>): Promise<{ positionId: number; restUnits: string }> {
    const A = await marketAssets();
    let pid = this.slot.positionId;
    if (pid === null) {
      const reg = await call<string>(this.slot.account, "register_position", { market_id: cfg.marketId, payout: this.w.address }, { gas: 100n * TGAS });
      pid = reg.events.find((e) => e.event === "position_registered")!.data.position_id as number;
      this.hooks.log(`registered position ${pid} (${reg.hash})`);
    }
    const p = await pos(pid);
    if (p.owner !== this.slot.account || p.payout.toLowerCase() !== this.w.address.toLowerCase()) throw new Error(`position ${pid} is not this demo borrower's`);
    const addr = p.evm_address as Address;
    const rest = this.slot.restUnits ? BigInt(this.slot.restUnits) : (BigInt(DEMO.collateralUsd) * E8 * 10n ** BigInt(A.cDec)) / (await price(A.collateral));
    // gas: the position pays for its MPC-signed transactions, the payout wallet for its own
    for (const [to, floor, fill] of [[addr, 4n, 10n], [this.w.address, 5n, 15n]] as const) {
      if ((await pub.getBalance({ address: to })) >= floor * 10n ** 15n) continue;
      const h = await funder.sendTransaction({ to, value: fill * 10n ** 15n, account: funder.account!, chain: funder.chain });
      await pub.waitForTransactionReceipt({ hash: h });
    }
    const d0 = await accountData(addr);
    if (d0.collateralBase === 0n) {
      const held = await balance(A.collateral, addr);
      if (held < rest) {
        await ensureTokens(this.w, A.collateral, rest - held);
        await write(this.w, A.collateral, erc20Abi, "transfer", [addr, rest - held]);
      }
      const allowed = async (t: Address) => (await pub.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [addr, cfg.aave.pool] })) as bigint;
      if ((await allowed(A.collateral)) < rest) await this.sign(pid, { type: "approve", token: "collateral", amount: "max" }, "reset", "approve collateral");
      if ((await allowed(A.debt)) === 0n) await this.sign(pid, { type: "approve", token: "debt", amount: "max" }, "reset", "approve debt");
      await this.sign(pid, { type: "supply", amount: rest.toString() }, "reset", "supply the resting collateral");
      await this.borrowTo(pid, A, DEMO.baseHfBps, "reset");
    }
    return { positionId: pid, restUnits: rest.toString() };
  }

  /** Bring the position back to rest (collateral at rest, HF 1.17). Allowed only with no open claim. */
  async reset(pid: number, A: MarketAssets) {
    this.hooks.step("reset");
    const addr = (await pos(pid)).evm_address as Address;
    const d = await accountData(addr);
    const plan = resetPlan({ collateralBase: d.collateralBase, debtBase: d.debtBase, ltBps: d.ltBps, priceC: await price(A.collateral), priceD: await price(A.debt), cDec: A.cDec, dDec: A.dDec, restUnits: BigInt(this.slot.restUnits!) });
    if (plan.supplyUnits) {
      const held = await balance(A.collateral, addr);
      if (held < plan.supplyUnits) {
        await ensureTokens(this.w, A.collateral, plan.supplyUnits - held);
        await write(this.w, A.collateral, erc20Abi, "transfer", [addr, plan.supplyUnits - held]);
      }
      await this.sign(pid, { type: "supply", amount: plan.supplyUnits.toString() }, "reset", "supply the missing collateral");
    }
    if (plan.repayUnits) {
      // send only what the position doesn't already hold, so a retried reset never sends twice
      const held = await balance(A.debt, addr);
      if (held < plan.repayUnits) {
        await ensureTokens(this.w, A.debt, plan.repayUnits - held);
        await write(this.w, A.debt, erc20Abi, "transfer", [addr, plan.repayUnits - held]);
      }
      // repay everything the position holds: debt-asset left in the position would be refunded by the
      // next rescue as a stray payment (an extra payout); a slightly higher HF is borrowed back next run
      const repay = held > plan.repayUnits ? held : plan.repayUnits;
      await this.sign(pid, { type: "repay", amount: { exact: repay.toString() } }, "reset", "repay to HF 1.17");
    }
    if (plan.borrowUnits) await this.borrowTo(pid, A, DEMO.baseHfBps, "reset");
    if (plan.withdrawUnits) await this.sign(pid, { type: "withdraw", amount: { exact: plan.withdrawUnits.toString() } }, "reset", "withdraw the extra collateral to the payout");
  }

  /** One run, from wherever the chain says it stands. Returns how the rescue ended. */
  async run(): Promise<{ rescueId: number | null; outcome: "bought_back" | "settled" | "reset_only" }> {
    const pid = this.slot.positionId!;
    const rest = BigInt(this.slot.restUnits!);
    const A = await marketAssets();
    let rid: number | null = null;
    let outcome: "bought_back" | "settled" | "reset_only" = "reset_only";
    let s = stepOf(await chainView(pid, rest, A));
    if (s === "reset") {
      await this.reset(pid, A);
      s = stepOf(await chainView(pid, rest, A));
    }
    if (s === "trigger") {
      this.hooks.step("trigger");
      await this.borrowTo(pid, A, DEMO.triggerHfBps, "trigger");
      s = "reading";
    }
    if (s === "reading") {
      this.hooks.step("reading");
      rid = (await until("waiting for the proven reading", "reading", async () => {
        const id = rescueOf(await pos(pid));
        return id !== null && { id }; // rescue id 0 is falsy
      })).id;
      s = "auction";
    }
    rid ??= rescueOf(await pos(pid));
    if (rid !== null && (s === "auction" || s === "topup")) {
      this.hooks.step("auction", { rescueId: rid });
      await until("the auction", "auction", async () => (await view<Rescue>("get_rescue", { rescue_id: rid })).state !== "auction");
      this.hooks.step("topup", { rescueId: rid });
      const r = await until<Rescue>("waiting for the top-up proof", "topup", async () => {
        const r = await view<Rescue>("get_rescue", { rescue_id: rid });
        if (r.state === "failed") {
          // the winner missed its top-up deadline (bond slashed); the position re-auctions
          const next = rescueOf(await pos(pid));
          if (next !== null && next !== rid) {
            rid = next;
            this.hooks.step("auction", { rescueId: rid, note: "re-auction after a missed top-up" });
          }
          return false;
        }
        return (r.state === "open" || r.state === "bought_back" || r.state === "settling") && r;
      });
      s = r.state === "open" ? "buyback" : r.state === "settling" ? "settling" : "payouts";
    }
    if (rid !== null && s === "buyback") {
      const r = await view<Rescue>("get_rescue", { rescue_id: rid });
      const claims = await Promise.all(r.members.filter((m) => m.claim_id).map((m) => view<Claim>("get_claim", { token_id: m.claim_id })));
      const units = buybackUnits(claims);
      const addr = (await pos(pid)).evm_address as Address;
      // exactly the owed units, in the claim asset; skip if a resumed run already sent them
      if (units > 0n && (await balance(A.collateral, addr)) < units) {
        await ensureTokens(this.w, A.collateral, units);
        const tx = await write(this.w, A.collateral, erc20Abi, "transfer", [addr, units]);
        this.hooks.step("buyback", { rescueId: rid, tx });
      } else this.hooks.step("buyback", { rescueId: rid });
      const end = await until<Rescue>("waiting for the buy-back to commit", "buyback", async () => {
        const r = await view<Rescue>("get_rescue", { rescue_id: rid });
        return r.state !== "open" && r;
      });
      s = end.state === "settling" || end.state === "settled" ? "settling" : "payouts";
    }
    if (rid !== null && s === "settling") {
      this.hooks.step("settling", { rescueId: rid });
      await until("waiting for the settlement", "settling", async () => (await view<Rescue>("get_rescue", { rescue_id: rid })).state === "settled", 10_000);
      outcome = "settled";
    }
    if (s === "payouts" || outcome !== "settled") {
      if (rid !== null && outcome !== "settled") this.hooks.step("payouts", { rescueId: rid });
      await until("waiting for the payouts", "payouts", async () => {
        const p = await pos(pid);
        const books = await view<Books>("get_books", { position_id: pid });
        return !p.open_rescues.length && p.active_auction === null && books.outflows.length === 0;
      }, 6000);
      if (rid !== null && outcome !== "settled") outcome = (await view<Rescue>("get_rescue", { rescue_id: rid })).state === "settled" ? "settled" : "bought_back";
    }
    await this.reset(pid, A);
    this.hooks.step("done", { rescueId: rid ?? undefined });
    return { rescueId: rid, outcome };
  }
}

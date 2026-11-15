// A winning steward's own moves in a recorded rescue, read back from the run's trail (record.ts):
// its bid, where its capital came from (its own WETH, or NEAR Intents: USDC sent on NEAR, a
// solver's ETH delivery on Ethereum, the wrap), its supply to the position, the top-up's check and
// the claim, then how the claim closed (buy-back payout, or the settlement legs).
// Pure: it reads only the entries' actor, what, step, chain, tx, at (and the NEAR method when
// recorded). Nothing here is inferred that the trail does not show.
import type { TrailChain } from "./record.js";

export interface ViewEntry {
  chain: TrailChain;
  tx: string;
  at: string;
  step: string;
  what: string;
  actor: string;
  ok: boolean;
  method?: string;
  link?: string;
  confirmed?: boolean;
}

export type MoveKind =
  | "bid"
  | "capital-own"
  | "intents-quote"
  | "intents-register"
  | "intents-send"
  | "intents-delivery"
  | "intents-missed"
  | "wrap"
  | "supply"
  | "verified"
  | "reported"
  | "claim"
  | "escrow"
  | "payout"
  | "settle-start"
  | "settle-refused"
  | "settle-repay"
  | "settle-leg";

export interface Move {
  kind: MoveKind;
  title: string; // a few words
  detail: string; // one plain sentence
  actor: string; // who acted: the steward, the NEAR Intents solver, the keeper, the position, the contract
  at?: string; // absent for an off-chain step (the 1Click quote)
  after?: string; // a step with no time of its own: the last recorded time before it
  chain?: TrailChain;
  tx?: string;
  link?: string;
  confirmed?: boolean;
  ok?: boolean;
  intents?: boolean; // part of the NEAR Intents leg
  note?: string; // for a step with no transaction of its own: where it comes from ("contract record")
  links?: { href: string; label: string }[]; // every explorer link for the step (a recorded rescue's transactions)
  figure?: { value: string; unit: string };
}

export interface StewardView {
  steward: string;
  premiumBps: number;
  share?: { amount: string; asset: string };
  capital?: "own" | "intents" | "intents-fallback"; // absent when not known (a live rescue)
  intentsSeconds?: number; // USDC sent on NEAR → the solver's ETH seen on Ethereum
  outcome: "bought back" | "settled" | "open";
  moves: Move[];
}

export interface RescueView {
  rescue: string;
  position?: string; // "position B (25)"
  pooled: boolean;
  stewards: StewardView[];
}

const ms = (iso: string) => Date.parse(iso);
const pick = (e: ViewEntry): Pick<Move, "at" | "chain" | "tx" | "link" | "confirmed" | "ok"> => ({ at: e.at, chain: e.chain, tx: e.tx, link: e.link, confirmed: e.confirmed, ok: e.ok });
const isMethod = (e: ViewEntry, m: string, re: RegExp) => e.method === m || (!e.method && re.test(e.what));

const BID = /^bids (\d+) bps on rescue (\S+)/;
const SUPPLY = /^supplies ([\d.]+) (\w+) to Aave on behalf of (position .+?) \(top-up\)$/;
const SEND_USDC = /^sends ([\d.]+) USDC to the NEAR Intents deposit address/;
const REGISTER = /on the USDC contract \(NEAR Intents deposit address\)/;
const DELIVERY = /^a NEAR Intents solver delivers/;
const WRAP = /^wraps ([\d.]+) ETH into (\w+)/;

/** Every rescue a steward bid on and then topped up, with each winner's moves in order. */
export function rescueViews(input: ViewEntry[]): RescueView[] {
  const entries = [...input].sort((a, b) => ms(a.at) - ms(b.at));
  // bids, by rescue, in the order the rescues first saw a bid
  const bids = new Map<string, ViewEntry[]>();
  for (const e of entries) {
    const m = BID.exec(e.what);
    if (m && e.ok) bids.set(m[2], [...(bids.get(m[2]) ?? []), e]);
  }
  const rescueIds = [...bids.keys()];
  const firstBidAt = (r: string) => ms(bids.get(r)![0].at);

  const out: RescueView[] = [];
  rescueIds.forEach((rid, ri) => {
    const until = ri + 1 < rescueIds.length ? firstBidAt(rescueIds[ri + 1]) : Infinity;
    const stewards = [...new Set(bids.get(rid)!.map((b) => b.actor))];
    const views: StewardView[] = [];
    let position: string | undefined;
    for (const s of stewards) {
      const mine = bids.get(rid)!.filter((b) => b.actor === s);
      const last = mine[mine.length - 1];
      const supplyE = entries.find((e) => e.actor === s && e.ok && ms(e.at) >= ms(last.at) && ms(e.at) < until && SUPPLY.test(e.what));
      if (!supplyE) continue; // bid, did not win (or never topped up)
      const [, amount, asset, pos] = SUPPLY.exec(supplyE.what)!;
      position ??= pos;
      const pid = /\((\d+)\)$/.exec(pos)?.[1] ?? pos;
      const bps = Number(BID.exec(last.what)![1]);
      const moves: Move[] = [
        { kind: "bid", title: "Bid won", detail: `Lowest premium on rescue ${rid}: ${bps} bps${mine.length > 1 ? ` (bid ${mine.length} times)` : ""}.`, actor: s, ...pick(last), figure: { value: String(bps), unit: "bps" } },
      ];

      // capital: between the winning bid and the supply
      const window = entries.filter((e) => ms(e.at) >= ms(last.at) && ms(e.at) <= ms(supplyE.at));
      const reg = window.find((e) => e.actor === s && isMethod(e, "storage_deposit", REGISTER));
      const send = window.find((e) => e.actor === s && isMethod(e, "ft_transfer", SEND_USDC) && SEND_USDC.test(e.what));
      const delivery = window.find((e) => e.actor !== s && DELIVERY.test(e.what));
      const wrap = window.find((e) => e.actor === s && WRAP.test(e.what));
      let capital: StewardView["capital"] = "own";
      let intentsSeconds: number | undefined;
      if (send || delivery) {
        capital = delivery ? "intents" : "intents-fallback";
        const quote = delivery && /\(bought with (.+)\)$/.exec(delivery.what)?.[1];
        if (quote) moves.push({ kind: "intents-quote", title: "1Click quote", detail: `Asks 1Click for ETH on Ethereum, paid for in USDC on NEAR. Quote: ${quote}.`, actor: s, intents: true });
        if (reg) moves.push({ kind: "intents-register", title: "Deposit address registered", detail: "Registers the quote's deposit address on the USDC contract on NEAR (storage deposit), so it can receive USDC.", actor: s, ...pick(reg), intents: true });
        if (send) {
          const usdc = SEND_USDC.exec(send.what)![1];
          moves.push({ kind: "intents-send", title: "USDC sent on NEAR", detail: `Sends ${usdc} USDC to the deposit address (ft_transfer).`, actor: s, ...pick(send), intents: true, figure: { value: usdc, unit: "USDC" } });
        }
        if (delivery) {
          intentsSeconds = send ? Math.round((ms(delivery.at) - ms(send.at)) / 1000) : undefined;
          const eth = /delivers ([\d.]+) ETH/.exec(delivery.what)?.[1];
          moves.push({
            kind: "intents-delivery",
            title: "ETH delivered on Ethereum",
            detail: `A solver delivers ${eth ? `${eth} ETH` : `${s}'s ETH`} to ${s}'s Ethereum address${intentsSeconds !== undefined ? `, seen ${intentsSeconds} s after the USDC was sent` : ""}.`,
            actor: delivery.actor,
            ...pick(delivery),
            intents: true,
            ...(intentsSeconds !== undefined ? { figure: { value: String(intentsSeconds), unit: "s" } } : {}),
          });
        } else {
          moves.push({ kind: "intents-missed", title: "No delivery in time", detail: `NEAR Intents did not deliver before the top-up deadline, so ${s} topped up from its own ${asset}.`, actor: s, intents: true });
        }
      } else {
        moves.push({ kind: "capital-own", title: `Own ${asset}`, detail: `Tops up from the ${asset} already in its wallet: no purchase needed.`, actor: s });
      }
      if (wrap) {
        const [, eth, sym] = WRAP.exec(wrap.what)!;
        moves.push({ kind: "wrap", title: `Wrapped into ${sym}`, detail: `Wraps ${eth} ETH into ${sym}, the position's collateral.`, actor: s, ...pick(wrap), intents: capital === "intents" });
      }
      moves.push({ kind: "supply", title: "Supplied to the position", detail: `Supplies ${amount} ${asset} to Aave on behalf of ${pos}.`, actor: s, ...pick(supplyE), figure: { value: amount, unit: asset } });

      // the top-up's check and the claim
      // (a check can carry the same second as the supply, and a local copy's times are when the scan
      // saw the block: look from the bid on)
      const after = entries.filter((e) => ms(e.at) >= ms(last.at));
      const check = after.find(
        (e) =>
          (isMethod(e, "request_verified", /^asks OutLayer for a verified reading/) && new RegExp(`reading of position ${pid}\\b`).test(e.what)) ||
          (isMethod(e, "confirm_topup", /^confirms .+'s top-up/) && e.what.startsWith(`confirms ${s}'s top-up on rescue ${rid}`)),
      );
      if (check) {
        const verified = /verified reading/.test(check.what);
        moves.push(
          verified
            ? { kind: "verified", title: "Top-up verified", detail: `OutLayer's verified reading of ${pos} proves the collateral rose.`, actor: check.actor, ...pick(check) }
            : { kind: "reported", title: "Top-up confirmed", detail: `The keeper reports the supply it saw on Ethereum (temporary reporter, not a proof).`, actor: check.actor, ...pick(check) },
          { kind: "claim", title: "Claim minted", detail: `The contract mints ${s}'s claim (NEP-171) on rescue ${rid}, owed in ${asset}: the ${amount} ${asset} supplied plus the ${bps} bps premium.`, actor: "contract", ...pick(check) },
        );
      }

      // how the claim closed: only entries about this position and this steward
      let outcome: StewardView["outcome"] = "open";
      const close = after.filter((e) => ms(e.at) < until);
      const escrow = close.find((e) => isMethod(e, "confirm_escrow", /^confirms the buy-back balance/) && new RegExp(`held by position ${pid}\\b`).test(e.what));
      const starts = close.filter((e) => (e.method === "start_settlement" || e.method === "take_over_settlement" || /^(starts|takes over) the settlement of rescue/.test(e.what)) && e.what.endsWith(`rescue ${rid}`) && e.actor === s);
      const settleAt = close.find((e) => /^(starts|takes over) the settlement of rescue/.test(e.what) && e.what.endsWith(`rescue ${rid}`) && e.ok);
      if (escrow && (!settleAt || ms(escrow.at) < ms(settleAt.at))) {
        outcome = "bought back";
        moves.push({ kind: "escrow", title: "Buy-back committed", detail: `The borrower's payment is proven held by ${pos}; the contract queues ${s}'s exact payout.`, actor: escrow.actor, ...pick(escrow) });
        for (const p of close.filter((e) => e.actor === pos && ms(e.at) >= ms(escrow.at) && new RegExp(`^sends ([\\d.]+) (\\w+) to ${s}$`).test(e.what))) {
          const [, amt, sym] = /^sends ([\d.]+) (\w+)/.exec(p.what)!;
          moves.push({ kind: "payout", title: "Paid out", detail: `${pos} pays ${s} ${amt} ${sym}, exactly the claim's owed ${asset} valued at the oracle price, signed by the contract.`, actor: pos, ...pick(p), figure: { value: amt, unit: sym } });
        }
      } else if (settleAt) {
        outcome = "settled";
        for (const st of starts) {
          if (st.ok) moves.push({ kind: "settle-start", title: /takes over/.test(st.what) ? "Took over the settlement" : "Started the settlement", detail: `No buy-back: ${s} ${/takes over/.test(st.what) ? "takes over" : "starts"} settling rescue ${rid}, deleveraging at the oracle price.`, actor: s, ...pick(st) });
          else moves.push({ kind: "settle-refused", title: "Settlement already started", detail: `${s}'s own start was refused: another claim owner had started it first, as the contract allows only one settler.`, actor: s, ...pick(st) });
        }
        const repay = close.find((e) => e.actor === s && ms(e.at) >= ms(settleAt.at) && new RegExp(`^repays ([\\d.]+) (\\w+) to Aave for ${pos.replace(/[()]/g, "\\$&")}$`).test(e.what));
        if (repay) {
          const [, amt, sym] = /^repays ([\d.]+) (\w+)/.exec(repay.what)!;
          moves.push({ kind: "settle-repay", title: "Repaid the debt", detail: `As the settler, ${s} repays ${amt} ${sym} of ${pos}'s debt on Aave; it gets this back in collateral at the oracle price.`, actor: s, ...pick(repay), figure: { value: amt, unit: sym } });
        }
        for (const l of close.filter((e) => e.actor === pos && ms(e.at) >= ms(settleAt.at) && new RegExp(`^withdraws ([\\d.]+) (\\w+) from Aave to ${s}$`).test(e.what))) {
          const [, amt, sym] = /^withdraws ([\d.]+) (\w+)/.exec(l.what)!;
          moves.push({ kind: "settle-leg", title: "Settlement leg paid", detail: `${pos} withdraws ${amt} ${sym} from Aave to ${s}, signed by the contract.`, actor: pos, ...pick(l), figure: { value: amt, unit: sym } });
        }
      }
      views.push({ steward: s, premiumBps: bps, share: { amount, asset }, capital, ...(intentsSeconds !== undefined ? { intentsSeconds } : {}), outcome, moves });
    }
    if (views.length > 1) // pooled: every bid that fills part of the top-up wins, each at its own premium
      for (const v of views) Object.assign(v.moves[0], { title: "Bid filled", detail: `${v.premiumBps} bps on rescue ${rid}: the lowest bids share the top-up, each at its own premium.` });
    if (views.length) out.push({ rescue: rid, position, pooled: views.length > 1, stewards: views });
  });
  return out;
}

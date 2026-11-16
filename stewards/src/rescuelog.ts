// Turns what the chain recorded about one rescue into the front end's event log.
// Pure: no network. Input = the contract's EVENT_JSON logs (each with its NEAR transaction and
// block time), the contract's own rescue/claim records, and the EVM token transfers of the
// position's address. Output = the events the live board replays, every one carrying the
// transaction it came from. Nothing is estimated except BIDDING, a display cue placed 1.4 s
// before each real bid and marked `derived`.

export type StewardId = "patient" | "hedged" | "pool" | "deep" | "swift";
export const STEWARDS: StewardId[] = ["patient", "hedged", "pool", "deep", "swift"];

export type Evidence = {
  mark: "proven" | "reported" | "unverified";
  chain: "near-testnet" | "sepolia" | "near-mainnet" | "ethereum";
  tx: string;
  url: string;
  block?: number; // EVM block a proven reading or transfer refers to
  rpcs?: number; // RPCs that agreed on a proven reading
  reporter?: string;
};

/** Seconds from the auction opening, then the event. Amounts are decimal strings in asset units. */
export type RescueEvent = { t: number } & (
  | { kind: "TRIGGER"; position: number; hf: number; evidence: Evidence }
  | { kind: "AUCTION_OPEN"; position: number; durationS: number; topUp: { asset: string; amount: string; usd: number }; capBps: number; evidence: Evidence }
  | { kind: "READING"; hf: number; evidence: Evidence }
  | { kind: "BIDDING"; steward: StewardId; derived: true }
  | { kind: "BID"; steward: StewardId; bps: number; amount: string; evidence: Evidence }
  | { kind: "AUCTION_CLOSE"; winners: { steward: StewardId; bps: number; amount: string }[]; evidence: Evidence }
  | { kind: "TOPUP_SENT"; steward: StewardId; amount: string; asset: string; evidence: Evidence }
  | { kind: "TOPUP_CONFIRMED"; steward: StewardId | null; collateral: string; evidence: Evidence }
  | { kind: "TOPUP_EXPIRED"; slashed: number; evidence: Evidence }
  | { kind: "CLAIM_MINTED"; claim: string; holder: StewardId; owed: string; premium: string; asset: string; windowEndsT: number; evidence: Evidence }
  | { kind: "PAYMENT_IN"; amount: string; asset: string; evidence: Evidence }
  | { kind: "ESCROW_PROVEN"; debtUnits: string; asset: string; evidence: Evidence }
  | { kind: "BUYBACK"; claim: string; amount: string; asset: string; evidence: Evidence }
  | { kind: "BOUGHT_BACK"; evidence: Evidence }
  | { kind: "PAYOUT"; purpose: "buyback" | "refund" | "reimbursement" | string; amount: string; asset: string; claim: string | null; evidence: Evidence }
  | { kind: "SETTLE_START" | "SETTLED" | "LIQUIDATED"; evidence: Evidence }
  /** a stalled settler's settlement taken over by another steward (the fee comes from the stalled one's leg) */
  | { kind: "SETTLE_TAKEOVER"; from: StewardId | null; to: StewardId | null; fee: string; asset: string; evidence: Evidence }
  /** the settler's repay of the position's debt on Aave: its EVM transaction (the debt burned from the
   *  position), and `near` the contract's record of it */
  | { kind: "SETTLE_REPAY"; steward: StewardId | null; amount: string; asset: string; evidence: Evidence; near?: Evidence }
  /** one settlement leg (index `leg` in the contract's settlement) carried out by a transaction the
   *  position sent: an Aave withdraw to the payout, or (batched markets) one transfer per payout */
  | { kind: "SETTLE_LEG"; leg: number; to: string; steward: StewardId | null; purpose: "supplied" | "premium" | "fee" | "repay" | "rest" | "batch"; amount: string; asset: string; evidence: Evidence }
);

export type RescueLog = {
  version: 1;
  title: string;
  label: string; // shown on the board: where this ran and what kind of evidence it carries
  contract: string;
  nearNetwork: "testnet" | "mainnet";
  evmChain: string;
  rescueId: number;
  positionId: number;
  borrower: string;
  market: { id: number; collateral: string; debt: string; collateralDecimals: number; debtDecimals: number; ltBps: number; liqBonusBps: number };
  openedAtMs: number;
  /** At the opening: collateral the contract proved (units), its USD value at the rescue's price,
   *  and the debt that health factor implies (collateral × LT / HF, single collateral). */
  atOpen: { collateral: string; collateralUsd: number; debtUsd: number; priceUsd: number } | null;
  params: { triggerHf: number; targetHf: number; auctionS: number; topupS: number; buybackS: number };
  outcome: string;
  events: RescueEvent[];
};

export type ChainLog = { tsNs: string; tx: string; signer: string; method: string; event: string; data: any };
/** `sender`: who sent the transaction (read for supplies into the position, to tell whose top-up it is). */
/** A transaction the position itself sent (its contract-signed steps), with its raw input. */
export type EvmSent = { block: number; ts: number; tx: string; nonce: number; to: string; input: string; ok: boolean };
export type SettlementLeg = { to: string; amount: "max" | { exact: string } | string; claim_id?: string | null; done?: boolean };
export type EvmTransfer = { block: number; ts: number; tx: string; token: string; from: string; to: string; value: string; decimals: number; sender?: string };
export type RescueRecord = {
  id: number;
  position_id: number;
  seq: number;
  opened_at: string;
  closes_at: string;
  topup_units: string;
  topup_base: string;
  cap_bps: number;
  collateral_price_base: string;
  debt_price_base: string;
  /** The winners: each one's share, and the Sepolia transaction its top-up was proven by. */
  members: { steward: string; premium_bps: number; share_units?: string; amount_units?: string; evm_tx?: string | null }[];
  /** the settlement as the contract records it (settler, repay, legs in order), when there is one */
  settlement?: { settler: string; started_at: string; repay_units?: string; legs: SettlementLeg[] } | null;
};
export type ClaimRecord = { token_id: string; owner: string; share_units: string; premium_units: string; owed_units: string; expires_at: string; evm_topup_tx?: string | null; paid_by_tx?: string | null };

export type Inputs = {
  contract: string;
  nearNetwork: "testnet" | "mainnet";
  evmChain: string;
  rescue: RescueRecord;
  position: { id: number; owner: string; evm_address: string; payout: string; market_id: number };
  market: { collateral: string; debt: string; collateral_decimals: number; debt_decimals: number; lt_bps: number; liq_bonus_bps: number };
  params: { trigger_hf_bps: number; target_hf_bps: number; auction_window_ns: string; topup_deadline_ns: string; buyback_window_ns: string };
  symbols: { collateral: string; debt: string };
  claims: ClaimRecord[];
  logs: ChainLog[];
  transfers: EvmTransfer[];
  /** The transactions the position sent (settlement legs); absent where not read. */
  sent?: EvmSent[];
  /** Each winner's Sepolia wallet (its registered payout), lowercased → steward account. */
  stewardWallets?: Record<string, string>;
};

const WAD = 10n ** 18n;
export const hfOf = (wad: string) => Number((BigInt(wad) * 1_000_000n) / WAD) / 1_000_000;
/** Integer units → decimal string with exactly `dec` places trimmed of trailing zeros (never a float). */
export function units(v: string | bigint, dec: number): string {
  const n = BigInt(v);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const s = a.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec);
  const frac = dec ? s.slice(s.length - dec).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
export const stewardOf = (account: string): StewardId | null => {
  const s = account.split(".")[0] as StewardId;
  return STEWARDS.includes(s) ? s : null;
};

function nearEv(net: "testnet" | "mainnet", tx: string, extra: Partial<Evidence> = {}, mark: Evidence["mark"] = "proven"): Evidence {
  const host = net === "testnet" ? "testnet.nearblocks.io" : "nearblocks.io";
  return { mark, chain: net === "testnet" ? "near-testnet" : "near-mainnet", tx, url: `https://${host}/txns/${tx}`, ...extra };
}
function evmEv(chain: string, tx: string, block: number): Evidence {
  const host = chain === "sepolia" ? "sepolia.etherscan.io" : "etherscan.io";
  return { mark: "proven", chain: chain === "sepolia" ? "sepolia" : "ethereum", tx, url: `https://${host}/tx/${tx}`, block };
}

export function buildLog(inp: Inputs): RescueLog {
  const { rescue, position, market, params } = inp;
  const net = inp.nearNetwork;
  const t0Ns = BigInt(rescue.opened_at);
  const tOf = (ns: string | bigint) => Number((BigInt(ns) - t0Ns) / 1_000_000n) / 1000;
  const tOfS = (s: number) => Number((BigInt(s) * 1_000_000_000n - t0Ns) / 1_000_000n) / 1000;
  const cDec = market.collateral_decimals;
  const dDec = market.debt_decimals;
  const C = inp.symbols.collateral;
  const D = inp.symbols.debt;
  const pid = rescue.position_id;
  const rid = rescue.id;
  const pos = position.evm_address.toLowerCase();
  const claimIds = new Set(inp.claims.map((c) => c.token_id));
  const paidIn = new Map<string, "collateral" | "debt">(); // claim → the asset its buy-back was paid in
  let refundSide: "collateral" | "debt" = "debt";
  const ev: RescueEvent[] = [];
  let repaidNear: { t: number; ev: Evidence } | undefined;

  const logs = [...inp.logs].sort((a, b) => (BigInt(a.tsNs) < BigInt(b.tsNs) ? -1 : BigInt(a.tsNs) > BigInt(b.tsNs) ? 1 : 0));
  // A reading belongs to this rescue only from the opening on (earlier ones are the position's history).
  let opened = false;
  // The proven reading in the opening transaction tells us block and RPC count for the trigger.
  const openTx = logs.find((l) => l.event === "auction_opened" && l.data.rescue_id === rid)?.tx;
  const openReading = logs.find((l) => l.tx === openTx && l.event === "health_verified" && l.data.position_id === pid);

  for (const l of logs) {
    const t = tOf(l.tsNs);
    const d = l.data;
    switch (l.event) {
      case "auction_opened": {
        if (d.rescue_id !== rid) break;
        opened = true;
        // Until 2026-11-09 the contract labelled every opening "TEMPORARY reporter"; an opening is
        // proven when a verified reading with the same health factor opened it in the same receipt
        // (newer openings also say "verified" themselves).
        const proven = openReading && openReading.data.hf_wad === d.hf_wad;
        const e = proven
          ? nearEv(net, l.tx, { block: openReading.data.block, rpcs: openReading.data.rpcs_agreeing })
          : nearEv(net, l.tx, { reporter: l.signer }, "reported");
        const usd = Number(BigInt(d.topup_base)) / 1e8;
        ev.push({ t, kind: "TRIGGER", position: pid, hf: hfOf(d.hf_wad), evidence: e });
        ev.push({ t, kind: "AUCTION_OPEN", position: pid, durationS: Number(BigInt(params.auction_window_ns) / 1_000_000_000n), topUp: { asset: C, amount: units(d.topup_units, cDec), usd }, capBps: d.cap_bps, evidence: e });
        break;
      }
      case "health_verified":
        if (!opened || d.position_id !== pid || l.tx === openTx) break;
        ev.push({ t, kind: "READING", hf: hfOf(d.hf_wad), evidence: nearEv(net, l.tx, { block: d.block, rpcs: d.rpcs_agreeing }) });
        break;
      case "bid_placed": {
        const s = stewardOf(d.steward);
        if (d.rescue_id !== rid || !s) break;
        ev.push({ t: Math.max(0, +(t - 1.4).toFixed(3)), kind: "BIDDING", steward: s, derived: true });
        ev.push({ t, kind: "BID", steward: s, bps: d.premium_bps, amount: units(d.amount_units, cDec), evidence: nearEv(net, l.tx) });
        break;
      }
      case "auction_closed":
        if (d.rescue_id !== rid) break;
        ev.push({
          t,
          kind: "AUCTION_CLOSE",
          winners: (d.winners ?? []).map((w: [string, number, string]) => ({ steward: stewardOf(w[0])!, bps: w[1], amount: units(w[2], cDec) })),
          evidence: nearEv(net, l.tx),
        });
        break;
      case "topup_verified":
        if (d.rescue_id !== rid) break;
        ev.push({ t, kind: "TOPUP_CONFIRMED", steward: null, collateral: units(d.collateral_units, cDec), evidence: nearEv(net, l.tx, { block: d.block }) });
        break;
      case "topup_expired":
        // the top-up deadline passed: unconfirmed members lose their bond
        if (d.rescue_id !== rid) break;
        ev.push({ t, kind: "TOPUP_EXPIRED", slashed: Number(d.slashed ?? 0), evidence: nearEv(net, l.tx) });
        break;
      case "topup_confirmed":
        if (d.rescue_id !== rid) break;
        ev.push({ t, kind: "TOPUP_CONFIRMED", steward: stewardOf(d.steward), collateral: "", evidence: nearEv(net, l.tx, { reporter: l.signer }, "reported") });
        break;
      case "nft_mint":
        for (const id of d.token_ids as string[]) {
          if (!claimIds.has(id)) continue;
          const c = inp.claims.find((x) => x.token_id === id)!;
          const holder = stewardOf(c.owner ?? d.owner_id)!;
          // the contract's own claim record: share supplied + fixed-unit premium, window end
          ev.push({ t, kind: "CLAIM_MINTED", claim: id, holder, owed: units(c.share_units, cDec), premium: units(c.premium_units, cDec), asset: C, windowEndsT: tOf(c.expires_at), evidence: nearEv(net, l.tx) });
        }
        break;
      case "escrow_proven":
        if (d.position_id !== pid) break;
        ev.push({ t, kind: "ESCROW_PROVEN", debtUnits: units(d.debt_units, dDec), asset: D, evidence: nearEv(net, l.tx, { block: d.block }) });
        break;
      case "buyback_committed":
        if (!claimIds.has(d.token_id)) break;
        paidIn.set(d.token_id, d.asset === "debt" ? "debt" : "collateral");
        ev.push({ t, kind: "BUYBACK", claim: d.token_id, amount: units(d.amount, d.asset === "debt" ? dDec : cDec), asset: d.asset === "debt" ? D : C, evidence: nearEv(net, l.tx) });
        break;
      case "bought_back":
        if (d.rescue_id === rid) ev.push({ t, kind: "BOUGHT_BACK", evidence: nearEv(net, l.tx) });
        break;
      case "refund_queued":
        if (d.position_id === pid) refundSide = d.asset === "collateral" ? "collateral" : "debt";
        break;
      case "payout_sent": {
        if (d.position_id !== pid || !opened) break;
        // The event doesn't name the asset: a buy-back payout goes out in the asset its buy-back was
        // committed in (the claim asset when the borrower paid in it), a refund in its queued asset.
        const side = d.token_id ? paidIn.get(d.token_id) ?? "debt" : d.purpose === "refund" ? refundSide : "debt";
        ev.push({ t, kind: "PAYOUT", purpose: d.purpose, amount: units(d.amount, side === "collateral" ? cDec : dDec), asset: side === "collateral" ? C : D, claim: d.token_id ?? null, evidence: nearEv(net, l.tx) });
        break;
      }
      case "settlement_taken_over":
        if (d.rescue_id === rid) ev.push({ t, kind: "SETTLE_TAKEOVER", from: stewardOf(d.from ?? ""), to: stewardOf(d.to ?? ""), fee: units(d.fee_units ?? "0", cDec), asset: C, evidence: nearEv(net, l.tx) });
        break;
      case "settlement_repaid":
        if (d.rescue_id === rid) repaidNear = { t, ev: nearEv(net, l.tx, d.block ? { block: d.block } : {}) };
        break;
      case "settlement_started":
      case "settled":
      case "rescue_liquidated":
        if (d.rescue_id !== rid) break;
        ev.push({ t, kind: l.event === "settled" ? "SETTLED" : l.event === "rescue_liquidated" ? "LIQUIDATED" : "SETTLE_START", evidence: nearEv(net, l.tx) });
        break;
    }
  }
  // Settlement start is a method call, not an event: take the call itself.
  for (const l of logs) if (l.method === "start_settlement" && l.event === "") ev.push({ t: tOf(l.tsNs), kind: "SETTLE_START", evidence: nearEv(net, l.tx) });

  // The settlement's legs: each one carried out by a transaction the position sent after the
  // settlement started (exact: the call's own recipient and amount, never an estimate).
  const settleT = (ev.find((e) => e.kind === "SETTLE_START") as { t: number } | undefined)?.t;
  const st = rescue.settlement;
  const legTx = new Set<string>();
  const sentTx = new Set((inp.sent ?? []).map((x) => x.tx.toLowerCase()));
  if (st && settleT !== undefined && inp.sent?.length) {
    const MAX = ((1n << 256n) - 1n).toString();
    const owner = (cid?: string | null) => inp.claims.find((c) => c.token_id === cid)?.owner ?? null;
    const seenClaim = new Set<string>();
    const legs = st.legs.map((l, i) => {
      const exact = typeof l.amount === "object" && l.amount && "exact" in l.amount ? String(l.amount.exact) : null;
      const to = l.to.toLowerCase();
      let purpose: "supplied" | "premium" | "fee" | "repay" | "rest" | "batch";
      // who the leg pays: the steward whose payout it is (a takeover's fee leg carries the stalled
      // claim's id but pays the steward that took over), else the claim's owner
      const paidTo = inp.stewardWallets?.[to] ?? null;
      const claimOwner = owner(l.claim_id);
      if (l.claim_id) {
        purpose = paidTo && claimOwner && paidTo !== claimOwner ? "fee" : seenClaim.has(l.claim_id) ? "premium" : "supplied";
        if (purpose !== "fee") seenClaim.add(l.claim_id);
      } else purpose = to === pos ? "batch" : exact ? "repay" : "rest";
      const who = paidTo ?? (l.claim_id ? claimOwner : purpose === "repay" ? st.settler : null);
      return { i, to, exact, purpose, steward: who ? stewardOf(who) : null, paid: false };
    });
    const batched = legs.some((l) => l.purpose === "batch");
    const word = (input: string, k: number) => input.slice(10 + 64 * k, 10 + 64 * (k + 1));
    const addr = (w: string) => `0x${w.slice(24)}`.toLowerCase();
    const num = (w: string) => BigInt(`0x${w || "0"}`).toString();
    for (const x of [...inp.sent].sort((a, b) => a.block - b.block || a.nonce - b.nonce)) {
      const t = tOfS(x.ts);
      if (!x.ok || t < settleT - 5) continue;
      const sel = x.input.slice(0, 10).toLowerCase();
      const push = (l: (typeof legs)[number], amount: string) => {
        l.paid = true;
        ev.push({ t, kind: "SETTLE_LEG", leg: l.i, to: l.to, steward: l.steward, purpose: l.purpose, amount, asset: C, evidence: evmEv(inp.evmChain, x.tx, x.block) });
        legTx.add(x.tx.toLowerCase());
      };
      if (sel === "0x69328dec" && addr(word(x.input, 0)) === market.collateral.toLowerCase()) {
        // Pool.withdraw(asset, amount, to): the leg paid to `to` (its exact amount, else "max")
        const to = addr(word(x.input, 2));
        const amt = num(word(x.input, 1));
        const l = legs.find((y) => !y.paid && y.to === to && (y.exact === amt || (y.exact === null && amt === MAX))) ?? legs.find((y) => !y.paid && y.to === to);
        if (!l) continue;
        // a "max" leg's amount: what the withdraw burned from the position
        const burned = inp.transfers.find((b) => b.tx.toLowerCase() === x.tx.toLowerCase() && b.from.toLowerCase() === pos && /^0x0{40}$/i.test(b.to));
        push(l, units(l.exact ?? (amt !== MAX ? amt : burned?.value ?? "0"), cDec));
      } else if (batched && sel === "0xa9059cbb" && x.to.toLowerCase() === market.collateral.toLowerCase()) {
        // collateral.transfer(to, amount): every unpaid leg of that payout, in one transfer
        const to = addr(word(x.input, 0));
        for (const l of legs.filter((y) => !y.paid && y.purpose !== "batch" && y.to === to)) push(l, units(l.exact ?? num(word(x.input, 1)), cDec));
      }
    }
  }
  const repays: { t: number; value: string; ev: Evidence }[] = [];

  // EVM side: the winner's supply, money into the position, and the payouts' transfers.
  // Each winner's top-up is the transaction the contract recorded for it (members[].evm_tx); an amount
  // match is only the fallback for records without it (several shares can be equal, and Aave's mint
  // event adds accrued interest to the amount).
  const open = rescue.members.map((m) => ({ s: stewardOf(m.steward)!, units: m.share_units ?? m.amount_units ?? "", tx: (m.evm_tx ?? "").toLowerCase(), used: false }));
  const lastT = ev.length ? Math.max(...ev.map((e) => e.t)) : 0;
  const boughtT = ev.find((e) => e.kind === "BOUGHT_BACK")?.t;
  for (const x of [...inp.transfers].sort((a, b) => a.block - b.block)) {
    const t = tOfS(x.ts);
    if (t < -5 || t > lastT + 120) continue;
    const to = x.to.toLowerCase();
    const from = x.from.toLowerCase();
    // which of the market's two tokens moved (by address: both can have 18 decimals)
    const tok = x.token.toLowerCase();
    const side = tok === market.collateral.toLowerCase() ? "collateral" : tok === market.debt.toLowerCase() ? "debt" : null;
    const zero = /^0x0{40}$/.test(from);
    if (zero && to === pos && x.decimals === cDec) {
      // aToken minted to the position = collateral supplied; match a winner by amount
      // whose top-up: the transaction's sender is a winner's wallet (exact); else the recorded tx;
      // else, for records with neither, a match by amount
      const who = x.sender ? stewardOf(inp.stewardWallets?.[x.sender.toLowerCase()] ?? "") : null;
      const bySender = who ? open.find((o) => !o.used && o.s === who) : undefined;
      const byTx = open.find((o) => !o.used && o.tx.startsWith("0x") && o.tx === x.tx.toLowerCase());
      const exact = bySender ?? byTx;
      const m = exact ?? (x.sender && inp.stewardWallets ? undefined : open.find((o) => !o.used && o.units === x.value) ?? open.find((o) => !o.used));
      if (!m) continue;
      m.used = true;
      // the amount supplied is the winner's share (the mint event's value can include accrued interest)
      ev.push({ t, kind: "TOPUP_SENT", steward: m.s, amount: units(exact && m.units ? m.units : x.value, cDec), asset: C, evidence: evmEv(inp.evmChain, x.tx, x.block) });
    } else if (to === pos && !zero && side && from === position.payout.toLowerCase() && t > 0 && (boughtT === undefined || t <= boughtT)) {
      // (after the buy-back commits, money the borrower sends in is a repay of its own, not part of the rescue)
      // the borrower's buy-back payment, in whichever asset it paid (the claim asset or the debt asset)
      ev.push({ t, kind: "PAYMENT_IN", amount: units(x.value, side === "collateral" ? cDec : dDec), asset: side === "collateral" ? C : D, evidence: evmEv(inp.evmChain, x.tx, x.block) });
    } else if (from === pos && !side && /^0x0{40}$/.test(to) && settleT !== undefined && t >= settleT - 5 && !sentTx.has(x.tx.toLowerCase()) && (inp.sent || (x.decimals === dDec && dDec !== cDec))) {
      // the position's debt burned in a transaction it didn't send itself: the settler's repay on Aave
      repays.push({ t, value: x.value, ev: evmEv(inp.evmChain, x.tx, x.block) });
    } else if (from === pos && side && t > 0 && !legTx.has(x.tx.toLowerCase())) {
      // attach the EVM transfer to the payout it carried out (same asset and amount, after it)
      const amt = units(x.value, side === "collateral" ? cDec : dDec);
      const p = ev.find((e) => e.kind === "PAYOUT" && e.asset === (side === "collateral" ? C : D) && e.amount === amt && !(e as any).transfer);
      if (p) (p as any).transfer = evmEv(inp.evmChain, x.tx, x.block);
    }
  }
  if (st) {
    const settler = stewardOf(st.settler);
    for (const r of repays) ev.push({ t: r.t, kind: "SETTLE_REPAY", steward: settler, amount: units(r.value, dDec), asset: D, evidence: r.ev, ...(repaidNear ? { near: repaidNear.ev } : {}) });
    if (!repays.length && repaidNear && st.repay_units && st.repay_units !== "0") ev.push({ t: repaidNear.t, kind: "SETTLE_REPAY", steward: settler, amount: units(st.repay_units, dDec), asset: D, evidence: repaidNear.ev });
  }
  ev.sort((a, b) => a.t - b.t || order(a.kind) - order(b.kind));
  // a single winner tops up: name it on the confirmation too
  const sent = ev.filter((e) => e.kind === "TOPUP_SENT");
  for (const e of ev) if (e.kind === "TOPUP_CONFIRMED" && !e.steward && sent.length === 1) e.steward = (sent[0] as any).steward;

  const openEv = ev.find((e) => e.kind === "TRIGGER") as Extract<RescueEvent, { kind: "TRIGGER" }> | undefined;
  const atOpenUnits = logs.find((l) => l.event === "topup_verified" && l.data.rescue_id === rid)?.data.at_open as string | undefined;
  const priceUsd = Number(BigInt(rescue.collateral_price_base)) / 1e8;
  const atOpen = atOpenUnits && openEv
    ? (() => {
        const collateralUsd = (Number(BigInt(atOpenUnits)) / 10 ** cDec) * priceUsd;
        return { collateral: units(atOpenUnits, cDec), collateralUsd, debtUsd: (collateralUsd * market.lt_bps) / 10_000 / openEv.hf, priceUsd };
      })()
    : null;
  const kinds = new Set(ev.map((e) => e.kind));
  const closeEv = ev.find((e) => e.kind === "AUCTION_CLOSE") as Extract<RescueEvent, { kind: "AUCTION_CLOSE" }> | undefined;
  const outcome = kinds.has("BOUGHT_BACK") ? "bought back" : kinds.has("SETTLED") ? "settled" : kinds.has("LIQUIDATED") ? "liquidated"
    : closeEv && !closeEv.winners.length ? "uncovered"
    : kinds.has("TOPUP_EXPIRED") && !kinds.has("CLAIM_MINTED") ? "failed" : "open";
  return {
    version: 1,
    title: `Rescue ${rid} · position ${pid}`,
    label: "",
    contract: inp.contract,
    nearNetwork: net,
    evmChain: inp.evmChain,
    rescueId: rid,
    positionId: pid,
    borrower: position.owner,
    market: { id: position.market_id, collateral: C, debt: D, collateralDecimals: cDec, debtDecimals: dDec, ltBps: market.lt_bps, liqBonusBps: market.liq_bonus_bps },
    openedAtMs: Number(t0Ns / 1_000_000n),
    atOpen,
    params: {
      triggerHf: params.trigger_hf_bps / 10_000,
      targetHf: params.target_hf_bps / 10_000,
      auctionS: Number(BigInt(params.auction_window_ns) / 1_000_000_000n),
      topupS: Number(BigInt(params.topup_deadline_ns) / 1_000_000_000n),
      buybackS: Number(BigInt(params.buyback_window_ns) / 1_000_000_000n),
    },
    outcome,
    events: ev,
  };
}

const ORDER = ["TRIGGER", "AUCTION_OPEN", "READING", "BIDDING", "BID", "AUCTION_CLOSE", "TOPUP_SENT", "TOPUP_CONFIRMED", "TOPUP_EXPIRED", "CLAIM_MINTED", "PAYMENT_IN", "ESCROW_PROVEN", "BUYBACK", "BOUGHT_BACK", "PAYOUT", "SETTLE_START", "SETTLE_TAKEOVER", "SETTLE_REPAY", "SETTLE_LEG", "SETTLED", "LIQUIDATED"];
const order = (k: string) => ORDER.indexOf(k);

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
  | { kind: "CLAIM_MINTED"; claim: string; holder: StewardId; owed: string; premium: string; asset: string; windowEndsT: number; evidence: Evidence }
  | { kind: "PAYMENT_IN"; amount: string; asset: string; evidence: Evidence }
  | { kind: "ESCROW_PROVEN"; debtUnits: string; asset: string; evidence: Evidence }
  | { kind: "BUYBACK"; claim: string; amount: string; asset: string; evidence: Evidence }
  | { kind: "BOUGHT_BACK"; evidence: Evidence }
  | { kind: "PAYOUT"; purpose: "buyback" | "refund" | "reimbursement" | string; amount: string; asset: string; claim: string | null; evidence: Evidence }
  | { kind: "SETTLE_START" | "SETTLED" | "LIQUIDATED"; evidence: Evidence }
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
export type EvmTransfer = { block: number; ts: number; tx: string; token: string; from: string; to: string; value: string; decimals: number };
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
  members: { steward: string; premium_bps: number; amount_units: string }[];
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
  const ev: RescueEvent[] = [];

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
        // The contract labels every opening "TEMPORARY reporter"; it is proven when a verified
        // reading with the same health factor opened it in the same transaction.
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
        ev.push({ t, kind: "BUYBACK", claim: d.token_id, amount: units(d.amount, d.asset === "debt" ? dDec : cDec), asset: d.asset === "debt" ? D : C, evidence: nearEv(net, l.tx) });
        break;
      case "bought_back":
        if (d.rescue_id === rid) ev.push({ t, kind: "BOUGHT_BACK", evidence: nearEv(net, l.tx) });
        break;
      case "payout_sent": {
        if (d.position_id !== pid || !opened) break;
        // Payouts go out in the debt asset after a debt buy-back, otherwise in collateral.
        const asset = D;
        ev.push({ t, kind: "PAYOUT", purpose: d.purpose, amount: units(d.amount, dDec), asset, claim: d.token_id ?? null, evidence: nearEv(net, l.tx) });
        break;
      }
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

  // EVM side: the winner's supply, money into the position, and the payouts' transfers.
  const open = rescue.members.map((m) => ({ s: stewardOf(m.steward)!, units: m.amount_units, used: false }));
  const lastT = ev.length ? Math.max(...ev.map((e) => e.t)) : 0;
  for (const x of [...inp.transfers].sort((a, b) => a.block - b.block)) {
    const t = tOfS(x.ts);
    if (t < -5 || t > lastT + 120) continue;
    const to = x.to.toLowerCase();
    const from = x.from.toLowerCase();
    const zero = /^0x0{40}$/.test(from);
    if (zero && to === pos && x.decimals === cDec) {
      // aToken minted to the position = collateral supplied; match a winner by amount
      const m = open.find((o) => !o.used && o.units === x.value) ?? open.find((o) => !o.used);
      if (!m) continue;
      m.used = true;
      ev.push({ t, kind: "TOPUP_SENT", steward: m.s, amount: units(x.value, cDec), asset: C, evidence: evmEv(inp.evmChain, x.tx, x.block) });
    } else if (to === pos && !zero && x.decimals === dDec && from === position.payout.toLowerCase() && t > 0) {
      ev.push({ t, kind: "PAYMENT_IN", amount: units(x.value, dDec), asset: D, evidence: evmEv(inp.evmChain, x.tx, x.block) });
    } else if (from === pos && x.decimals === dDec && t > 0) {
      // attach the EVM transfer to the payout it carried out (same amount, after it)
      const p = ev.find((e) => e.kind === "PAYOUT" && e.amount === units(x.value, dDec) && !(e as any).transfer);
      if (p) (p as any).transfer = evmEv(inp.evmChain, x.tx, x.block);
    }
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
  const outcome = kinds.has("BOUGHT_BACK") ? "bought back" : kinds.has("SETTLED") ? "settled" : kinds.has("LIQUIDATED") ? "liquidated" : "open";
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

const ORDER = ["TRIGGER", "AUCTION_OPEN", "READING", "BIDDING", "BID", "AUCTION_CLOSE", "TOPUP_SENT", "TOPUP_CONFIRMED", "CLAIM_MINTED", "PAYMENT_IN", "ESCROW_PROVEN", "BUYBACK", "BOUGHT_BACK", "PAYOUT", "SETTLE_START", "SETTLED", "LIQUIDATED"];
const order = (k: string) => ORDER.indexOf(k);

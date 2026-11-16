// Record any finished (or running) rescue from the chains, for its own page: every contract event in
// its time window (NearBlocks list + our node's receipts), the contract's records at the opening, and
// the position address's Sepolia token transfers. Read-only. The time window comes from the rescue's
// own record (opened, claims opened, buy-back window, settlement), so nothing is scanned blindly.
import { buildLog, type ClaimRecord, type Inputs, type RescueLog } from "./rescuelog.js";
import { contractTxs, evmSentTxs, evmTransfers, tokenSymbol, txLogs, type Reader } from "./chainread.js";

const MIN = 60_000_000_000n;

/** The winners' Sepolia wallets (their registered payouts), lowercased → steward account. */
export async function walletsOf(rd: Reader, contract: string, stewards: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const s of new Set(stewards)) {
    const a = await rd.view(contract, "get_evm_payout", { account_id: s }).catch(() => null);
    if (a) out[String(a).toLowerCase()] = s;
  }
  return out;
}

/** When the rescue's last event can have happened (ns), from its record and the contract's params. */
export function windowEnd(r: { opened_at: string; claims_opened_at: string; settlement: { started_at: string } | null }, buybackWindowNs: string, nowNs: bigint): bigint {
  const opened = BigInt(r.opened_at);
  const claims = BigInt(r.claims_opened_at || "0");
  let end = opened + 30n * MIN; // an auction and its top-up end well within half an hour
  if (claims > 0n) end = claims + BigInt(buybackWindowNs) + 30n * MIN; // buy-back, or settlement start, then payouts
  if (r.settlement) end = BigInt(r.settlement.started_at) + 60n * MIN; // settlement legs and payouts
  return end < nowNs ? end : nowNs;
}

/** Which chains a recording comes from: a `.near` contract is NEAR mainnet, an EVM chain id 1 is
 *  Ethereum mainnet (real funds), 11155111 Sepolia; anything else is the local fork (unverified). */
export function recordingChains(contract: string, chainId: number): { nearNetwork: "testnet" | "mainnet"; evmChain: string; label: string } {
  const nearNetwork = contract.endsWith(".near") ? "mainnet" : "testnet";
  if (chainId === 1) return { nearNetwork, evmChain: "ethereum", label: `Real funds, recorded on NEAR ${nearNetwork} and Ethereum mainnet` };
  if (chainId === 11155111) return { nearNetwork, evmChain: "sepolia", label: `Recorded on NEAR ${nearNetwork} and Sepolia` };
  return { nearNetwork, evmChain: "fork", label: `Recorded on NEAR ${nearNetwork} and a local Sepolia fork (unverified)` };
}

/** `onInputs` sees the chain data the log is built from (for offline test fixtures). */
export async function recordRescue(rd: Reader, contract: string, rid: number, nowNs = BigInt(Date.now()) * 1_000_000n, onInputs?: (i: Inputs) => void): Promise<RescueLog> {
  const view = (method: string, args: object, height?: number) => rd.view(contract, method, args, height);
  const rescue = await view("get_rescue", { rescue_id: rid });
  if (!rescue) throw new Error(`no rescue ${rid} on ${contract}`);
  const paramsNow = await view("get_params", {});
  const fromNs = BigInt(rescue.opened_at) - 2n * MIN;
  const toNs = windowEnd(rescue, paramsNow.buyback_window_ns, nowNs);

  const txs = await contractTxs(rd, contract, fromNs, toNs);
  let openAt: { height: number } | undefined;
  let mintAt: { height: number; tx: string } | undefined;
  let closed = false;
  const logs = await txLogs(rd, contract, txs, (l, height) => {
    if (l.event === "auction_opened" && l.data.rescue_id === rid) openAt = { height };
    if (l.event === "auction_closed" && l.data.rescue_id === rid) closed = true;
    if (l.event === "nft_mint" && !mintAt && closed) mintAt = { height, tx: l.tx };
  });
  if (!openAt) throw new Error(`auction_opened for rescue ${rid} not found in its window`);

  const hOpen = openAt.height;
  const params = await view("get_params", {}, hOpen);
  const position = await view("get_position", { position_id: rescue.position_id }, hOpen);
  const market = await view("get_market", { market_id: position.market_id }, hOpen);
  const claims: ClaimRecord[] = [];
  if (mintAt) {
    const ids = logs.filter((l) => l.tx === mintAt!.tx && l.event === "nft_mint").flatMap((l) => l.data.token_ids as string[]);
    for (const id of ids) {
      for (let dh = 0; dh <= 4; dh++) {
        const c = await view("get_claim", { token_id: id }, mintAt.height + dh).catch(() => null);
        if (c && c.rescue_id === rid) {
          claims.push(c);
          break;
        }
      }
    }
  }
  // Sepolia: the position's token transfers (top-ups, payments in, payouts). The local fork copies
  // Sepolia's tokens but its transactions exist nowhere public: no transfers, labelled unverified.
  const where = recordingChains(contract, market.chain_id);
  const sepolia = where.evmChain !== "fork";
  const transfers = sepolia ? await evmTransfers(rd, position.evm_address, Number(fromNs / 1_000_000n)) : [];
  // the position's own transactions (a settlement's legs), only when there was a settlement
  const sent = sepolia && rescue.settlement ? await evmSentTxs(rd, position.evm_address, Number(BigInt(rescue.settlement.started_at) / 1_000_000n) - 5 * 60_000) : undefined;
  const symbols = { collateral: await tokenSymbol(rd, market.collateral), debt: await tokenSymbol(rd, market.debt) };
  // the winners' wallets, and the settler's (a steward that took over a settlement may not be a winner)
  const stewardWallets = await walletsOf(rd, contract, [...rescue.members.map((m: { steward: string }) => m.steward), ...(rescue.settlement?.settler ? [rescue.settlement.settler] : [])]);
  const inputs: Inputs = { contract, nearNetwork: where.nearNetwork, evmChain: where.evmChain, rescue, position, market, params, symbols, claims, logs, transfers, sent, stewardWallets };
  onInputs?.(inputs);
  const log = buildLog(inputs);
  const day = new Date(log.openedAtMs).toISOString().slice(0, 10);
  log.label = `${where.label}, ${day}`;
  return log;
}

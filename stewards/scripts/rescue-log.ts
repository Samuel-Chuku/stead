// npx tsx scripts/rescue-log.ts --rescue 8 [--contract sepolia-demo.steadfi.testnet] [--minutes 20] [--out file] [--raw file]
//
// READ-ONLY. Rebuilds one real rescue's event log from the chains, for the front end's replay:
//  - the contract's transactions in the rescue's time window (NearBlocks API, public),
//  - each transaction's EVENT_JSON logs and the contract's own records at the right blocks
//    (NEAR archival RPC, public),
//  - the position address's token transfers on Sepolia (Blockscout API, public).
// Every event in the output carries the transaction it came from. No keys, no transactions sent.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildLog, STEWARDS, type ClaimRecord, type Inputs } from "../src/rescuelog.js";
import { contractTxs, evmTransfers, reader, scrub, sleep, tokenSymbol, txLogs } from "../src/chainread.js";
import { env, hasEnv } from "../src/config.js";
import { walletsOf } from "../src/recorder.js";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const rid = Number(arg("--rescue"));
if (!Number.isInteger(rid)) throw new Error("usage: --rescue <id>");
const contract = arg("--contract") ?? "sepolia-demo.steadfi.testnet";
const minutes = Number(arg("--minutes") ?? 20);
const out = resolve(arg("--out") ?? join(REPO, "web", "public", "replays", `${contract.split(".")[0]}-rescue-${rid}.json`));
const rawOut = arg("--raw");
// the project's own testnet node (archival, from .env) first when set; public nodes otherwise
const own = hasEnv("QUICKNODE_NEAR_TESTNET_URL") ? [env("QUICKNODE_NEAR_TESTNET_URL")] : [];
const rd = reader("stead-rescue-log", { current: own, archival: own });
const view = (method: string, args: object, height?: number) => rd.view(contract, method, args, height);

async function main() {
  // 1. The bids for this rescue give its time window (stewards' own transactions are few).
  let bidTimes: bigint[] = [];
  const now = BigInt(Date.now()) * 1_000_000n;
  for (const s of STEWARDS) {
    const txs = await contractTxs(rd, contract, 0n, now, `${s}.steadfi.testnet`);
    await sleep(1200);
    for (const t of txs.filter((x) => x.method === "bid")) {
      const st = await rd.rpc("EXPERIMENTAL_tx_status", { tx_hash: t.tx, sender_account_id: t.signer, wait_until: "NONE" });
      const fc = st.transaction.actions?.[0]?.FunctionCall;
      const a = fc ? JSON.parse(Buffer.from(fc.args, "base64").toString()) : null;
      if (a?.rescue_id === rid) bidTimes.push(BigInt(t.tsNs));
    }
  }
  if (!bidTimes.length) throw new Error(`no bids found for rescue ${rid} on ${contract}`);
  bidTimes.sort((a, b) => (a < b ? -1 : 1));
  const fromNs = bidTimes[0] - 120_000_000_000n;
  const toNs = bidTimes[bidTimes.length - 1] + BigInt(minutes * 60) * 1_000_000_000n;
  console.log(`rescue ${rid}: ${bidTimes.length} bids; window ${new Date(Number(fromNs / 1_000_000n)).toISOString()} + ${minutes} min`);

  // 2. Every contract transaction in the window, with its EVENT_JSON logs.
  const txs = await contractTxs(rd, contract, fromNs, toNs);
  let openAt: { height: number } | undefined;
  let mintAt: { height: number; tx: string } | undefined;
  let closed = false;
  const logs = await txLogs(rd, contract, txs, (l, height) => {
    if (l.event === "auction_opened" && l.data.rescue_id === rid) openAt = { height };
    if (l.event === "auction_closed" && l.data.rescue_id === rid) closed = true;
    if (l.event === "nft_mint" && !mintAt && closed) mintAt = { height, tx: l.tx };
  });
  if (!openAt) throw new Error(`auction_opened for rescue ${rid} not in the window; widen it`);
  console.log(`${txs.length} transactions, ${logs.length} events`);

  // 3. The contract's own records at the right heights.
  const hOpen = openAt.height;
  const params = await view("get_params", {}, hOpen);
  const rescue = await view("get_rescue", { rescue_id: rid });
  const position = await view("get_position", { position_id: rescue.position_id }, hOpen);
  const market = await view("get_market", { market_id: position.market_id }, hOpen);
  const claims: ClaimRecord[] = [];
  if (mintAt) {
    const ids = logs.filter((l) => l.tx === mintAt!.tx && l.event === "nft_mint").flatMap((l) => l.data.token_ids as string[]);
    for (const id of ids) {
      for (let dh = 0; dh <= 4; dh++) {
        const c = await view("get_claim", { token_id: id }, mintAt.height + dh).catch(() => null);
        if (c && c.rescue_id === rid) { claims.push(c); break; }
      }
    }
  }

  // 4. The position address's token transfers on Sepolia (supply, payments in, payouts out).
  const transfers = await evmTransfers(rd, position.evm_address, Number(fromNs / 1_000_000n));
  const symbols = { collateral: await tokenSymbol(rd, market.collateral), debt: await tokenSymbol(rd, market.debt) };

  const stewardWallets = await walletsOf(rd, contract, rescue.members.map((m: { steward: string }) => m.steward));
  const inputs: Inputs = { contract, nearNetwork: "testnet", evmChain: "sepolia", rescue, position, market, params, symbols, claims, logs, transfers, stewardWallets };
  if (rawOut) writeFileSync(resolve(rawOut), JSON.stringify(inputs, null, 1));
  const log = buildLog(inputs);
  log.label = `Recorded on NEAR testnet and Sepolia, ${new Date(log.openedAtMs).toISOString().slice(0, 10)}`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(log, null, 1));
  console.log(`${log.events.length} events, outcome ${log.outcome} → ${out}`);
}

main().catch((e) => {
  console.error(scrub(e));
  process.exit(1);
});

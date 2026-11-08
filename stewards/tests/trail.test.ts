import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, parseAbi, type Hex } from "viem";

// The evidence trail of a live run, and the checker that re-reads it on chain. Offline: the chain
// and the RPCs are stand-ins.
const near = vi.hoisted(() => ({ callListeners: [] as ((c: any) => void)[] }));
vi.mock("../src/near.js", () => near);

import { Trail, describeEvm, describeNear, type Book, type TrailFile, type TrailEntry } from "../src/record.js";
import { checkEvm, checkNear, compareState, rpcAny, checkTrail, renderTrail } from "../src/trailcheck.js";

const POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DEEP = "0x26e2ab6ec0e027f01f41cf65ee5375f0692fd41d";
const POS = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const abi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
]);
const book = (): Book => ({ pool: POOL, tokens: { [WETH]: { sym: "WETH", decimals: 18 }, [USDC]: { sym: "USDC", decimals: 6 } }, names: { [DEEP]: "deep", [POS]: "position A (15)" } });
const supplyFor = encodeFunctionData({ abi, functionName: "supply", args: [WETH, 6n * 10n ** 15n, POS, 0] });

describe("plain descriptions", () => {
  it("names a steward's top-up, a payout and an approval; approvals and gas sends are not key steps", () => {
    expect(describeEvm({ from: DEEP, to: POOL, input: supplyFor, value: 0n }, book())).toEqual({ what: "supplies 0.006 WETH to Aave on behalf of position A (15) (top-up)", key: true });
    const pay = encodeFunctionData({ abi, functionName: "transfer", args: [DEEP, 12_500_000n] });
    expect(describeEvm({ from: POS, to: USDC, input: pay, value: 0n }, book())).toEqual({ what: "sends 12.5 USDC to deep", key: true });
    const ap = encodeFunctionData({ abi, functionName: "approve", args: [POOL, 2n ** 256n - 1n] });
    expect(describeEvm({ from: DEEP, to: WETH, input: ap, value: 0n }, book()).key).toBe(false);
    expect(describeEvm({ from: DEEP, to: POS, input: "0x", value: 10n ** 15n }, book())).toEqual({ what: "sends 0.001 ETH to position A (15) for gas", key: false });
  });
  it("names NEAR calls", () => {
    expect(describeNear({ method: "bid", args: { rescue_id: 3, premium_bps: 150 } })).toBe("bids 150 bps on rescue 3");
    expect(describeNear({ method: "sign_action", args: { position_id: 15, action: { type: "withdraw" } } })).toBe("asks the contract to sign withdraw for position 15 (MPC)");
  });
});

/** A stand-in Ethereum: blocks of transactions with receipts. */
function fakeChain(blocks: { from: string; to: string; input: Hex; hash: Hex; ok?: boolean }[][]) {
  return {
    getBlockNumber: async () => BigInt(blocks.length),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
      timestamp: 1_700_000_000n + blockNumber * 12n,
      transactions: (blocks[Number(blockNumber) - 1] ?? []).map((t, i) => ({ ...t, value: 0n, transactionIndex: i })),
    }),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ status: blocks.flat().find((t) => t.hash === hash)?.ok === false ? "reverted" : "success" }),
  };
}
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

describe("the trail", () => {
  it("records every NEAR call (refusals too), every tx from our own addresses only, under the step it happened in, and saves after each", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trail-"));
    const path = join(dir, "run.json");
    const chain = fakeChain([
      [{ from: DEEP, to: POOL, input: supplyFor, hash: h(1) }, { from: STRANGER, to: POOL, input: supplyFor, hash: h(2) }],
      [{ from: POS, to: USDC, input: encodeFunctionData({ abi, functionName: "transfer", args: [DEEP, 1n] }), hash: h(3), ok: false }],
    ]);
    const t = new Trail(path, { title: "t", label: "REHEARSAL", contract: "c.testnet", nearNetwork: "testnet", evmChain: "ethereum-copy", evmChainId: 31338 }, chain as any, book(), (s) => (s === "b.testnet" ? "borrower" : s));
    t.start(1n);
    t.setStep("1: open");
    near.callListeners.forEach((l) => l({ sentAt: new Date().toISOString(), signer: "b.testnet", contract: "c.testnet", method: "register_position", args: { market_id: 0 }, hash: "NearA", ok: true }));
    near.callListeners.forEach((l) => l({ sentAt: new Date().toISOString(), signer: "b.testnet", contract: "c.testnet", method: "sign_action", args: { position_id: 15, action: { type: "supply" } }, hash: "NearB", ok: false, error: "size cap" }));
    near.callListeners.forEach((l) => l({ sentAt: new Date().toISOString(), signer: "b.testnet", contract: "c.testnet", method: "bid", args: {}, ok: false, error: "fetch failed" })); // never reached a node
    t.label("NearB", "a supply over the cap: refused (expected)");
    expect((JSON.parse(readFileSync(path, "utf8")) as TrailFile).entries.length).toBe(2); // saved already
    await t.sync();
    t.setStep("2: rescue");
    t.finish("done");
    const f = JSON.parse(readFileSync(path, "utf8")) as TrailFile;
    expect(f.entries.map((e) => e.tx).sort()).toEqual(["NearA", "NearB", h(1), h(3)].sort()); // the stranger's tx is not ours
    const b = f.entries.find((e) => e.tx === "NearB")!;
    expect(b).toMatchObject({ ok: false, what: "a supply over the cap: refused (expected)", actor: "borrower", method: "sign_action", step: "1: open" });
    const pay = f.entries.find((e) => e.tx === h(3))!;
    expect(pay).toMatchObject({ ok: false, from: POS, to: USDC, block: 2, actor: "position A (15)", step: "1: open" });
    expect(f.outcome).toBe("done");
    near.callListeners.length = 0;
  });
});

const entry = (x: Partial<TrailEntry>): TrailEntry => ({ chain: "ethereum", tx: h(1), at: "", step: "s", what: "w", actor: "a", ok: true, key: true, ...x });

describe("the checker", () => {
  it("confirms an Ethereum tx only when sender, target and outcome match the record", () => {
    const rc = { status: "0x1", blockNumber: "0x10" };
    const tx = { from: DEEP, to: POOL };
    expect(checkEvm(entry({ from: DEEP, to: POOL }), rc, tx)).toEqual({ confirmed: true, status: "✓ block 16" });
    expect(checkEvm(entry({ from: POS, to: POOL }), rc, tx).confirmed).toBe(false);
    expect(checkEvm(entry({ from: DEEP, to: USDC }), rc, tx).confirmed).toBe(false);
    expect(checkEvm(entry({ from: DEEP, to: POOL, ok: false }), rc, tx).confirmed).toBe(false); // recorded as refused, succeeded
    expect(checkEvm(entry({ from: DEEP, to: POOL, ok: false }), { ...rc, status: "0x0" }, tx).status).toMatch(/reverted, as recorded/);
    expect(checkEvm(entry({}), null, null).confirmed).toBe(false);
  });
  it("confirms a NEAR tx only when signer, contract, method and outcome match; a recorded refusal counts", () => {
    const r = (method: string, status: object, signer = "b.testnet") => ({ result: { transaction: { signer_id: signer, receiver_id: "c.testnet", actions: [{ FunctionCall: { method_name: method } }] }, status } });
    const e = entry({ chain: "near-testnet", signer: "b.testnet", receiver: "c.testnet", method: "bid" });
    expect(checkNear(e, r("bid", { SuccessValue: "" })).confirmed).toBe(true);
    expect(checkNear(e, r("start_settlement", { SuccessValue: "" })).confirmed).toBe(false);
    expect(checkNear(e, r("bid", { SuccessValue: "" }, "x.testnet")).confirmed).toBe(false);
    expect(checkNear({ ...e, ok: false }, r("bid", { Failure: {} }))).toEqual({ confirmed: true, status: "✓ refused, as recorded" });
    expect(checkNear(e, r("bid", { Failure: {} })).confirmed).toBe(false);
    const del = { result: { transaction: { signer_id: "app.near", receiver_id: "app.near", actions: [{ DeleteKey: { public_key: "ed25519:x" } }] }, status: { SuccessValue: "" } } };
    expect(checkNear(entry({ chain: "near-mainnet", signer: "app.near", receiver: "app.near", method: "DeleteKey" }), del).confirmed).toBe(true);
  });
  it("names each field of the contract state that changed since the snapshot", () => {
    expect(compareState("rescue", { 3: { state: "settled", members: [1] } }, { 3: { members: [1], state: "settled" } })).toEqual([]);
    expect(compareState("rescue", { 3: { state: "settled" } }, { 3: { state: "open" } })).toEqual(["rescue 3: state"]);
    expect(compareState("claim", { 7: null }, {})).toEqual(["claim 7: not readable now"]);
  });
  it("tries the next RPC when one fails, and never names an RPC in what it returns", async () => {
    const keyed = "https://x.quiknode.pro/SECRET/";
    const seen: string[] = [];
    const fetcher = async (u: string) => {
      seen.push(u);
      if (u === keyed) throw new Error(`${u} 429`);
      return { result: { ok: 1 } };
    };
    expect(await rpcAny([keyed, "https://b"], "m", [], undefined, fetcher)).toEqual({ result: { ok: 1 } });
    expect(seen).toEqual([keyed, "https://b"]);
    const none = await rpcAny([keyed], "m", [], undefined, async () => { throw new Error(`${keyed} down`); });
    expect(JSON.stringify(none)).not.toContain("SECRET");
  });
  it("checks a whole trail and its state, and renders key steps first with the full trail folded", async () => {
    const f: TrailFile = {
      title: "Run", label: "REAL FUNDS", contract: "app.near", nearNetwork: "mainnet", evmChain: "ethereum", evmChainId: 1, started: "2026-11-12T10:00:00Z", finished: "2026-11-12T10:30:00Z", addresses: { deep: DEEP },
      entries: [
        entry({ tx: h(1), from: DEEP, to: POOL, what: "top-up" }),
        entry({ chain: "near-mainnet", tx: "N1", signer: "deep.near", receiver: "app.near", method: "bid", what: "bids", key: false }),
      ],
      state: { read_at: "t", positions: { 15: { owner: "b", health: { hf: 1 } } }, rescues: { 3: { state: "bought_back" } }, claims: { "15-0-1": null }, aave: {} },
    };
    const fetcher = async (_u: string, body: any) => {
      if (body.method === "eth_getTransactionReceipt") return { result: { status: "0x1", blockNumber: "0x5" } };
      if (body.method === "eth_getTransactionByHash") return { result: { from: DEEP, to: POOL } };
      if (body.method === "tx") return { result: { transaction: { signer_id: "deep.near", receiver_id: "app.near", actions: [{ FunctionCall: { method_name: "bid" } }] }, status: { SuccessValue: "" } } };
      if (body.method === "query") {
        const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
        const v = body.params.method_name === "get_claim"
          ? (args.token_id === "15-0-1" ? null : "wrong id type") // claim ids are strings
          : body.params.method_name === "get_position" ? { owner: "b", health: { hf: 2 } } // a newer reading: ignored
          : { state: "bought_back" };
        return { result: { result: [...Buffer.from(JSON.stringify(v))] } };
      }
      throw new Error("?");
    };
    const c = await checkTrail("x.json", f, { ethereum: ["https://e"], sepolia: [], "ethereum-copy": [], "near-mainnet": ["https://n"], "near-testnet": [] }, fetcher);
    expect([c.confirmed, c.total, c.state.matches]).toEqual([2, 2, true]);
    expect(c.entries[0].link).toBe(`https://etherscan.io/tx/${h(1)}`);
    const md = renderTrail(c);
    expect(md).toContain("**2 of 2 recorded transactions confirmed on chain.**");
    const [keyPart, full] = md.split("<details>");
    expect(keyPart).toContain("top-up");
    expect(keyPart).not.toContain("| bids |");
    expect(full).toContain("| bids |");
  });
});

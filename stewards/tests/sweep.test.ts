// Sweeping a position's leftover ETH to its payout: the contract's encoding checked against viem,
// and how the keeper and the trail treat a sweep. Offline.
import { describe, expect, it } from "vitest";
import { parseTransaction, serializeTransaction, type Hex } from "viem";
import { unmineableSweep, healthDropping } from "../src/keeper.js";
import { describeEvm, describeNear, type Book } from "../src/record.js";
import { txValue, type Action } from "../src/types.js";

// The contract's own test vectors (contract/core/tests/sweep.rs): a 0.01 ETH sweep at nonce 0 on
// chain 31337, gas 300,000, max fee 20 gwei, priority 1 gwei, to the fixture payout.
const UNSIGNED = "0x02f2827a6980843b9aca008504a817c800830493e09400000000000000000000000000000000000000b0872386f26fc1000080c0";
const SIGNED = "0x02f874827a6980843b9aca008504a817c800830493e09400000000000000000000000000000000000000b0872386f26fc1000080c0019f7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7b7ba01515151515151515151515151515151515151515151515151515151515151515";
const PAYOUT = "0x00000000000000000000000000000000000000b0";
const tx = {
  type: "eip1559" as const,
  chainId: 31337,
  nonce: 0,
  to: PAYOUT as Hex,
  value: 10n ** 16n,
  data: "0x" as Hex,
  gas: 300_000n,
  maxFeePerGas: 20_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
};

describe("ETH sweep encoding", () => {
  it("the bytes the contract signs are viem's EIP-1559 serialization of the same tx", () => {
    expect(serializeTransaction(tx)).toBe(UNSIGNED);
  });

  it("the signed tx decodes to the payout, the value and no calldata", () => {
    const r = `0x00${"7b".repeat(31)}` as Hex;
    const s = `0x${"15".repeat(32)}` as Hex;
    const signed = serializeTransaction(tx, { r, s, yParity: 1 });
    expect(signed).toBe(SIGNED); // r with its leading zero trimmed, as the contract does
    const p = parseTransaction(signed);
    expect(p.to?.toLowerCase()).toBe(PAYOUT);
    expect(p.value).toBe(10n ** 16n);
    expect(p.data ?? "0x").toBe("0x");
    expect([p.chainId, p.nonce]).toEqual([31337, 0]);
  });
});

describe("the keeper and the trail with a sweep", () => {
  const sweep = { type: "sweep_eth", value: "10000000000000000" } as const;

  it("a sweep larger than the balance after gas goes to the nonce burn; nothing else does", () => {
    expect(unmineableSweep(sweep, "insufficient funds for gas * price + value")).toBe(true);
    expect(unmineableSweep(sweep, "nonce too low")).toBe(false);
    expect(unmineableSweep({ type: "borrower", action: "withdraw" }, "insufficient funds for gas * price + value")).toBe(false);
    expect(unmineableSweep(null, "insufficient funds")).toBe(false);
  });

  it("a sweep never counts as lowering the health", () => {
    expect(healthDropping(sweep)).toBe(false);
  });

  it("reads the value from the stored kind (0 for every other kind)", () => {
    expect(txValue(sweep)).toBe(10n ** 16n);
    expect(txValue({ type: "borrower", action: "borrow" })).toBe(0n);
    expect(txValue({ type: "nonce_burn" })).toBe(0n);
    const a: Action = { type: "sweep_eth", amount: "1" };
    expect(JSON.parse(JSON.stringify(a))).toEqual({ type: "sweep_eth", amount: "1" });
  });

  it("describes the sweep in plain words", () => {
    const POS = "0x00000000000000000000000000000000000000a1";
    const book: Book = { pool: "0x0000000000000000000000000000000000000001", tokens: {}, names: { [POS]: "position A (15)", [PAYOUT]: "borrower" } };
    expect(describeEvm({ from: POS, to: PAYOUT, input: "0x", value: 10n ** 16n }, book)).toEqual({ what: "returns 0.01 ETH left over from gas to borrower", key: false });
    // a gas top-up and a nonce burn read as before
    expect(describeEvm({ from: PAYOUT, to: POS, input: "0x", value: 10n ** 15n }, book).what).toBe("sends 0.001 ETH to position A (15) for gas");
    expect(describeEvm({ from: POS, to: POS, input: "0x", value: 0n }, book).what).toBe("sends 0 ETH to position A (15) for gas");
    expect(describeNear({ method: "sign_action", args: { position_id: 15, action: { type: "sweep_eth", amount: "1" } } })).toBe("asks the contract to sign a sweep of the leftover ETH for position 15 (MPC)");
  });
});

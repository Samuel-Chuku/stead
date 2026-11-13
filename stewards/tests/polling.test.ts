import { describe, it, expect, vi, beforeEach } from "vitest";

// Fewer NEAR views for a 24/7 run, without slowing any reaction: final rescues are never read
// again, owner-set values are cached for minutes, a failing RPC fails over and backs off.
const rpc = vi.hoisted(() => ({
  rescues: [] as { id: number; state: string }[],
  calls: [] as { url: string; method: string; args: any }[],
  down: new Set<string>(),
}));

vi.mock("near-api-js", () => ({
  JsonRpcProvider: class {
    url: string;
    constructor(o: { url: string }) {
      this.url = o.url;
    }
    async sendTransactionUntil() {
      return { transaction: { hash: "h" }, transaction_outcome: { outcome: { logs: [] } }, receipts_outcome: [], status: {} };
    }
    async callFunction(q: { method: string; args: any }) {
      rpc.calls.push({ url: this.url, method: q.method, args: q.args });
      if (rpc.down.has(this.url)) throw new Error("fetch failed");
      if (q.method === "get_rescues") return rpc.rescues.filter((r) => r.id >= q.args.from).slice(0, q.args.limit);
      return { ok: true };
    }
  },
  Account: class {
    async createSignedTransaction() {
      return { transaction: { publicKey: "pk" } };
    }
  },
  actions: { functionCall: () => ({}) },
  baseEncode: () => "h",
  encodeTransaction: () => new Uint8Array(),
}));

vi.mock("../src/config.js", async (orig) => ({ ...(await orig<typeof import("../src/config.js")>()), nearKey: () => "not-a-key" }));

process.env.NEAR_RPC_URL = "https://main.example";
process.env.NEAR_RPC_FALLBACK = "https://backup.example";
const { view, call, viewStats, viewReport } = await import("../src/near.js");
const { RescueCursor, pollDelay } = await import("../src/rescues.js");

const rescue = (id: number, state: string) => ({ id, state });

beforeEach(() => {
  rpc.calls.length = 0;
  rpc.down.clear();
  viewStats.clear();
});

describe("rescue cursor", () => {
  it("pages from the oldest live rescue and never re-reads final ones", async () => {
    rpc.rescues = [...Array.from({ length: 120 }, (_, i) => rescue(i, "settled")), rescue(120, "open"), rescue(121, "failed")];
    const c = new RescueCursor();
    expect((await c.read()).length).toBe(122); // first read: everything (3 pages)
    expect(c.from).toBe(120);
    await new Promise((r) => setTimeout(r, 1600)); // past the short view cache
    rpc.calls.length = 0;
    const again = await c.read();
    expect(again.map((r) => r.id)).toEqual([120, 121]);
    expect(rpc.calls.filter((x) => x.method === "get_rescues")).toHaveLength(1);
  });

  it("with nothing live it starts after the newest, and still sees a new auction", async () => {
    rpc.rescues = [rescue(0, "settled"), rescue(1, "bought_back")];
    const c = new RescueCursor();
    await c.read();
    expect(c.from).toBe(2);
    rpc.rescues.push(rescue(2, "auction"));
    await new Promise((r) => setTimeout(r, 1600));
    expect((await c.read()).map((r) => r.id)).toEqual([2]);
    expect(c.from).toBe(2);
  });

  it("pages by id even when ids have gaps", async () => {
    rpc.rescues = Array.from({ length: 60 }, (_, i) => rescue(i * 2, "open"));
    const c = new RescueCursor();
    expect((await c.read()).length).toBe(60);
  });
});

describe("view cache", () => {
  it("owner-set values are read once per window; live state every tick; a call clears both", async () => {
    await view("get_params");
    await view("get_position", { position_id: 1 });
    await new Promise((r) => setTimeout(r, 1600));
    await view("get_params");
    await view("get_position", { position_id: 1 });
    expect(rpc.calls.filter((x) => x.method === "get_params")).toHaveLength(1);
    expect(rpc.calls.filter((x) => x.method === "get_position")).toHaveLength(2);
    await call("alice.testnet", "bid", {});
    await view("get_params");
    expect(rpc.calls.filter((x) => x.method === "get_params")).toHaveLength(2);
  });

  it("fails over to the backup RPC when the main one is down", async () => {
    rpc.down.add("https://main.example");
    expect(await view("get_position", { position_id: 7 })).toEqual({ ok: true });
    expect(rpc.calls.some((x) => x.url === "https://backup.example" && x.method === "get_position")).toBe(true);
  }, 30_000);

  it("counts the views sent and reports them per day", async () => {
    await view("get_position", { position_id: 9 });
    await view("get_position", { position_id: 9 }); // cached: not counted
    expect(viewStats.get("get_position")).toBe(1);
    expect(viewReport(10 * 60_000)).toMatch(/^1 NEAR views in 10 min \(≈144\/day\): get_position 1/);
  });
});

describe("back-off", () => {
  it("doubles per failure in a row, never past a minute, and resets on success", () => {
    expect(pollDelay(5000, 0)).toBe(5000);
    expect(pollDelay(5000, 1)).toBe(10_000);
    expect(pollDelay(5000, 3)).toBe(40_000);
    expect(pollDelay(5000, 10)).toBe(60_000);
  });
});

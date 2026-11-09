// npx tsx scripts/site-stats.ts [--out ../web/public/stats.json]
//
// READ-ONLY. The homepage totals from the testnet contracts' own records (public RPC views).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { siteStats, type ContractRecords } from "../src/sitestats.js";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const out = resolve(arg("--out") ?? join(REPO, "web", "public", "stats.json"));
const RPC = "https://rpc.testnet.fastnear.com";
const CONTRACTS = ["steadfi.testnet", "sepolia-demo.steadfi.testnet"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function view(contract: string, method: string, args: object): Promise<any> {
  for (let i = 0; ; i++) {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "stead-site-stats" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
    }).catch(() => null);
    const j: any = r?.ok ? await r.json() : null;
    if (j?.result) return JSON.parse(Buffer.from(j.result.result).toString());
    if (i >= 5) throw new Error(`${contract}.${method}: ${j?.error?.cause?.name ?? (r ? `HTTP ${r.status}` : "unreachable")}`);
    await sleep(1500 * (i + 1));
  }
}

async function records(contract: string): Promise<ContractRecords> {
  const rescues = await view(contract, "get_rescues", { from: 0, limit: 500 });
  const positionMarket: Record<number, number> = {};
  for (const id of new Set<number>(rescues.map((r: any) => r.position_id))) {
    const p = await view(contract, "get_position", { position_id: id });
    if (p) positionMarket[id] = p.market_id;
    await sleep(150);
  }
  const marketChain: Record<number, number> = {};
  for (const id of new Set(Object.values(positionMarket))) {
    const m = await view(contract, "get_market", { market_id: id });
    if (m) marketChain[id] = m.chain_id;
  }
  return { contract, rescues, positionMarket, marketChain };
}

const all: ContractRecords[] = [];
for (const c of CONTRACTS) all.push(await records(c));
const s = siteStats(all);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(s, null, 1));
console.log(`${s.rescues} rescues on chains ${s.chains.join(",")} (${s.boughtBack} bought back, ${s.settled} settled); worse off: ${s.worseOff}; median premium ${s.medianPremiumBps} bps; median trigger to claim ${s.medianTriggerToClaimS} s; fork runs not counted: ${s.forkRescues} → ${out}`);

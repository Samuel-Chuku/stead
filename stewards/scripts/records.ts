// npx tsx scripts/records.ts [--out ../web/public/records.json]
//
// READ-ONLY. The list pages' data (positions, rescues, claims, stewards) from the testnet contracts'
// own records, written as the site's fallback snapshot. The live feed serves the same, fresh.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env, REPO } from "../src/config.js";
import { reader, tokenSymbol } from "../src/chainread.js";
import { buildRecords, fetchContract } from "../src/records.js";

const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const out = resolve(arg("--out") ?? join(REPO, "web", "public", "records.json"));
const own = [env("QUICKNODE_NEAR_TESTNET_URL", "")].filter(Boolean);
const rd = reader("stead-records", own.length ? { current: own, archival: own } : {});
const all = [];
for (const c of ["sepolia-demo.steadfi.testnet", "steadfi.testnet"]) all.push(await fetchContract(c, (ct, m, a) => rd.view(ct, m, a as Record<string, unknown>), (a) => tokenSymbol(rd, a)));
const r = buildRecords(all);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(r, null, 1));
console.log(`${r.positions.length} positions, ${r.rescues.length} rescues, ${r.claims.length} claims, ${r.stewards.length} stewards → ${out}`);

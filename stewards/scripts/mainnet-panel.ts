// npx tsx scripts/mainnet-panel.ts [--once] [--every 300] [--out file] [--state file] [--backfill 50400] [--serve 8787] [--host 127.0.0.1]
//
// READ-ONLY feed for the front end's mainnet panel (see src/panel.ts). Runs a cycle every
// `--every` seconds, writes the feed JSON (atomically) and keeps its own state (known borrowers,
// last health factors, history) so coverage grows over time and survives a restart.
// `--serve` also serves the latest feed at GET /mainnet.json (CORS open, read-only).
// RPCs: MAINNET_RPC_URL and MAINNET_RPC_FALLBACK from .env (comma lists), then public ones.
// No URL is ever printed.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env, hasEnv, REPO } from "../src/config.js";
import { cycle, emptyState, panelClient, scrub, type PanelFeed, type PanelState } from "../src/panel.js";

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const once = process.argv.includes("--once");
const everyS = Number(arg("--every") ?? 300);
const out = resolve(arg("--out") ?? join(REPO, "fork", "state", "mainnet-panel.json"));
const statePath = resolve(arg("--state") ?? join(REPO, "fork", "state", "mainnet-panel-state.json"));
const backfill = Number(arg("--backfill") ?? 50_400); // ~7 days of blocks
const port = arg("--serve");
const host = arg("--host") ?? "127.0.0.1";

const list = (...names: string[]) => names.flatMap((n) => (hasEnv(n) ? env(n).split(",") : [])).map((u) => u.trim()).filter(Boolean);
const urls = [...new Set([...list("MAINNET_RPC_URL", "MAINNET_RPC_FALLBACK"), "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"])];
const rpc = panelClient(urls);

function save(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 1));
  renameSync(`${path}.tmp`, path);
}

let state: PanelState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : emptyState();
let latest: PanelFeed | undefined = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
let lastError: string | undefined;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

let busy = false;
async function runOnce() {
  if (busy) return; // a slow cycle (the first backfill) never overlaps the next
  busy = true;
  const t0 = Date.now();
  // work on a copy: a failed cycle leaves the saved state as it was
  const next: PanelState = JSON.parse(JSON.stringify(state));
  try {
    const feed = await cycle(rpc, next, { backfill });
    state = next;
    latest = feed;
    lastError = undefined;
    save(statePath, state);
    save(out, feed);
    const s = feed.summary;
    console.log(
      `${feed.generated} block ${feed.block} · ${feed.coverage.borrowers} borrowers tracked · ${s.nearTrigger} near the trigger (${s.belowTrigger} below) · ` +
        `24 h: ${s.triggers24h} crossed 1.15, ${s.liquidations24h} Aave liquidations, bonus paid ${usd(s.bonusPaid24hUsd)}` +
        (s.compared24h ? `, Stead would have charged ${usd(s.steadPremium24hUsd)} on ${s.compared24h} of them` : "") +
        ` · ${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
  } catch (e) {
    lastError = scrub(e);
    console.error(`${new Date().toISOString()} cycle failed (state kept, retry next cycle): ${lastError}`);
  } finally {
    busy = false;
  }
}

console.log(`READ-ONLY · Aave V3 Ethereum mainnet · ${urls.length} RPCs · feed ${out}${port ? ` · serving http://${host}:${port}/mainnet.json` : ""}`);
if (port) {
  createServer((req, res) => {
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json", "cache-control": "public, max-age=60" };
    if (req.method !== "GET") return void res.writeHead(405, headers).end('{"error":"read-only"}');
    if (req.url?.split("?")[0] === "/mainnet.json") {
      if (!latest) return void res.writeHead(503, headers).end('{"error":"first cycle still running"}');
      return void res.writeHead(200, headers).end(JSON.stringify(latest));
    }
    if (req.url === "/health") return void res.writeHead(200, headers).end(JSON.stringify({ ok: !lastError, generated: latest?.generated, block: latest?.block, lastError }));
    res.writeHead(404, headers).end('{"error":"not found"}');
  }).listen(Number(port), host);
}

await runOnce();
if (once) process.exit(lastError ? 1 : 0);
setInterval(runOnce, everyS * 1000);

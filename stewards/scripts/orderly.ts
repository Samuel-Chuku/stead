// Orderly TESTNET account for the hedged steward. Never prints a key.
//   npx tsx scripts/orderly.ts setup     create keys in ../.env if missing, register, add the trading key
//   npx tsx scripts/orderly.ts faucet    claim 1,000 test USDC (5 claims per account)
//   npx tsx scripts/orderly.ts status    account id, balances, LINK/BTC/ETH positions
//   npx tsx scripts/orderly.ts roundtrip open and close the minimum short on PERP_LINK_USDC (order ids)
import { accountId, ensureKeys, faucet, holding, market, marketOrder, position, register } from "../src/orderly.js";

const cmd = process.argv[2] ?? "status";
const SYMBOLS = ["PERP_LINK_USDC", "PERP_BTC_USDC", "PERP_ETH_USDC"];

if (cmd === "setup") {
  console.log("wallet", ensureKeys());
  console.log("account", await register());
} else if (cmd === "faucet") {
  console.log("faucet", await faucet());
} else if (cmd === "status") {
  console.log("account", await accountId());
  console.log("holding", JSON.stringify(await holding()));
  for (const s of SYMBOLS) console.log(s.padEnd(16), "position", await position(s));
} else if (cmd === "roundtrip") {
  const s = "PERP_LINK_USDC";
  const m = await market(s);
  const qty = Math.ceil((m.minNotional * 1.2) / m.mark / m.baseTick) * m.baseTick;
  const open = await marketOrder(s, "SELL", Number(qty.toFixed(4)));
  console.log(`opened short ${qty} ${s} at ~${m.mark}: order ${open.orderId}`);
  await new Promise((r) => setTimeout(r, 3000));
  console.log("position", await position(s));
  const close = await marketOrder(s, "BUY", Number(qty.toFixed(4)), true);
  console.log(`closed (reduce-only): order ${close.orderId}`);
  await new Promise((r) => setTimeout(r, 3000));
  console.log("position", await position(s));
} else throw new Error(`unknown command ${cmd}`);

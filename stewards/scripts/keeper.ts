// Long-running keeper (reporter + relayer + housekeeping): npm run keeper
import { Keeper } from "../src/keeper.js";
import { DEMO_LABEL, log } from "../src/log.js";

log("keeper", `starting ${DEMO_LABEL}`);
const k = new Keeper();
process.on("SIGINT", () => k.stop());
process.on("SIGTERM", () => k.stop());
await k.run(Number(process.env.KEEPER_INTERVAL_MS ?? 3000));

// Long-running steward bot: npm run steward -- <patient|swift|deep|pool>
import { STEWARDS, type StewardName } from "../src/config.js";
import { Steward } from "../src/steward.js";
import { DEMO_LABEL, log } from "../src/log.js";

const name = process.argv[2] as StewardName;
if (!STEWARDS.includes(name)) throw new Error(`usage: npm run steward -- <${STEWARDS.join("|")}>`);
log(name, `starting ${DEMO_LABEL}`);
const s = new Steward(name);
process.on("SIGINT", () => s.stop());
process.on("SIGTERM", () => s.stop());
await s.run(Number(process.env.STEWARD_INTERVAL_MS ?? 2000));

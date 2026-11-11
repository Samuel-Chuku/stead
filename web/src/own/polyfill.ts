// The NEAR wallet libraries expect Node's globals (Buffer, global, process.env); browsers don't
// have them. Loaded before the libraries, only on the "Protect an Aave position" page.
import { Buffer } from "buffer";
const g = globalThis as Record<string, unknown>;
g.global ??= globalThis;
g.Buffer ??= Buffer;
g.process ??= { env: {}, browser: true, version: "", nextTick: (fn: () => void) => queueMicrotask(fn) };

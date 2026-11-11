// One NEAR wallet connection for the whole site (NEAR Connector: every wallet in its manifest that
// supports testnet), testnet. The connector code loads only when someone connects, or when a
// returning visitor was connected before.
import type { NearConnector } from "@hot-labs/near-connect";

export const STEAD_CONTRACT = "sepolia-demo.steadfi.testnet";
const FLAG = "stead-near-connected";
let connector: Promise<NearConnector> | null = null;
let account: string | null = null;
const listeners = new Set<(a: string | null) => void>();
const tell = () => listeners.forEach((f) => f(account));
const flag = (on: boolean) => {
  try {
    if (on) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    /* the button still works; it just won't remember */
  }
};
const wasConnected = () => {
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
};

function load(): Promise<NearConnector> {
  connector ??= (async () => {
    await import("../own/polyfill");
    const { NearConnector } = await import("@hot-labs/near-connect");
    const c = new NearConnector({
      network: "testnet",
      features: { testnet: true, signAndSendTransaction: true },
      // a limited key for the Stead contract only: later Stead calls need no approval each
      signIn: { contractId: STEAD_CONTRACT, methodNames: [] },
    });
    c.on("wallet:signIn", (t: { accounts: { accountId: string }[] }) => {
      account = t.accounts[0]?.accountId ?? null;
      flag(!!account);
      tell();
    });
    c.on("wallet:signOut", () => {
      account = null;
      flag(false);
      tell();
    });
    return c;
  })();
  return connector;
}

/** The connected account, restoring a previous connection without a prompt. */
export async function nearAccount(): Promise<string | null> {
  if (account || !wasConnected()) return account;
  try {
    const c = await load();
    const { accounts } = await c.getConnectedWallet();
    account = accounts[0]?.accountId ?? null;
  } catch {
    account = null;
  }
  if (!account) flag(false);
  tell();
  return account;
}
export async function connectNear(): Promise<string | null> {
  const c = await load();
  await c.connect();
  return nearAccount().then((a) => a ?? account);
}
export async function disconnectNear() {
  const c = await load();
  await c.disconnect().catch(() => {});
  account = null;
  flag(false);
  tell();
}
export function onNearAccount(f: (a: string | null) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Call the Stead contract from the connected wallet (no deposit). Returns the transaction outcome. */
export async function steadCall(method: string, args: object, gasTgas = 150n): Promise<any> {
  const c = await load();
  const w = await c.wallet();
  return w.signAndSendTransaction({
    receiverId: STEAD_CONTRACT,
    actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: (gasTgas * 1_000_000_000_000n).toString(), deposit: "0" } }],
  } as any);
}

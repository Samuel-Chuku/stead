// One NEAR wallet connection for the whole site (NEAR Connector: every wallet in its manifest that
// supports the network), testnet by default. The "Protect a position" page switches it to mainnet
// while it shows mainnet mode, and back when it closes. The connector code loads only when someone
// connects, or when a returning visitor was connected before.
import type { NearConnector } from "@hot-labs/near-connect";

export type NearNetwork = "testnet" | "mainnet";
/** The Stead contract each network's calls go to. */
export const STEAD_CONTRACTS: Record<NearNetwork, string> = { testnet: "sepolia-demo.steadfi.testnet", mainnet: "app.usestead.near" };
export const STEAD_CONTRACT = STEAD_CONTRACTS.testnet;
let network: NearNetwork = "testnet";
// testnet keeps the key it always had; mainnet remembers its own connection apart
const FLAG = () => (network === "testnet" ? "stead-near-connected" : "stead-near-connected-mainnet");
let connector: Promise<NearConnector> | null = null;
let account: string | null = null;
const listeners = new Set<(a: string | null) => void>();
const tell = () => listeners.forEach((f) => f(account));
const flag = (on: boolean) => {
  try {
    if (on) localStorage.setItem(FLAG(), "1");
    else localStorage.removeItem(FLAG());
  } catch {
    /* the button still works; it just won't remember */
  }
};
const wasConnected = () => {
  try {
    return localStorage.getItem(FLAG()) === "1";
  } catch {
    return false;
  }
};
/** A testnet account name never signs on mainnet: drop a mismatched answer there. */
const fits = (a: string | null | undefined) => (!a ? null : network === "mainnet" && a.endsWith(".testnet") ? null : a);
// the mainnet connector keeps its chosen wallet under its own keys, so the two never mix
const mainnetStorage = {
  get: async (k: string) => {
    try {
      return localStorage.getItem(`stead-mainnet:${k}`);
    } catch {
      return null;
    }
  },
  set: async (k: string, v: string) => {
    try {
      localStorage.setItem(`stead-mainnet:${k}`, v);
    } catch {
      /* ignore */
    }
  },
  remove: async (k: string) => {
    try {
      localStorage.removeItem(`stead-mainnet:${k}`);
    } catch {
      /* ignore */
    }
  },
};

export const nearNetwork = () => network;
/** Switch the site's NEAR connection to another network: forget this one's account (the wallet stays
 *  connected on its own network) and restore the other's, if the visitor connected there before. */
export function setNearNetwork(n: NearNetwork) {
  if (n === network) return;
  network = n;
  connector = null;
  account = null;
  tell();
  void nearAccount();
}

function load(): Promise<NearConnector> {
  connector ??= (async () => {
    await import("../own/polyfill");
    const { NearConnector } = await import("@hot-labs/near-connect");
    const net = network;
    const c = new NearConnector({
      network: net,
      features: net === "mainnet" ? { mainnet: true, signAndSendTransaction: true } : { testnet: true, signAndSendTransaction: true },
      // a limited key for the Stead contract only: later Stead calls need no approval each
      signIn: { contractId: STEAD_CONTRACTS[net], methodNames: [] },
      ...(net === "mainnet" ? { storage: mainnetStorage } : {}),
    });
    c.on("wallet:signIn", (t: { accounts: { accountId: string }[] }) => {
      if (net !== network) return; // a connector from before a network switch
      account = fits(t.accounts[0]?.accountId);
      flag(!!account);
      tell();
    });
    c.on("wallet:signOut", () => {
      if (net !== network) return;
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
  const net = network;
  let found: string | null = null;
  try {
    const c = await load();
    const { accounts } = await c.getConnectedWallet();
    found = fits(accounts[0]?.accountId);
  } catch {
    found = null;
  }
  if (net !== network) return account; // the network changed meanwhile: that restore is someone else's
  account = found;
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
    receiverId: STEAD_CONTRACTS[network],
    actions: [{ type: "FunctionCall", params: { methodName: method, args, gas: (gasTgas * 1_000_000_000_000n).toString(), deposit: "0" } }],
  } as any);
}

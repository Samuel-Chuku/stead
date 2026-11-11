// "Your own rescue": a visitor runs a real Stead rescue with their own wallets (NEAR testnet +
// Sepolia), on the demo contract (3-minute buy-back window, so both endings fit in one sitting).
// Every step is chosen from chain state, so a reload picks up where it was; every transaction the
// visitor signs is listed with its link. Nothing here holds a key: the wallets sign.
import { connectNear, nearAccount, onNearAccount, steadCall } from "../wallet/near";
import { createPublicClient, createWalletClient, custom, http, parseAbi, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { icon } from "../icons";
import { mountLive } from "../board/live";

const CONTRACT = "sepolia-demo.steadfi.testnet";
const MARKET = 1;
const NEAR_RPC = "https://test.rpc.fastnear.com";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const POOL: Address = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";
const ORACLE: Address = "0x2da88497588bf89281816106C7259e31AF45a663";
const LINK: Address = "0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5";
const DAI: Address = "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357";
const E18 = 10n ** 18n;
/** NEAR-only visitors: the sponsor's Sepolia address is the position's payout (it holds the Sepolia side). */
const SPONSOR_PAYOUT: Address = "0xA57b528591700bB77992D095258eF6F921CDAD68";
/** The position's size: 60 LINK; it opens at health 1.20 and is triggered at 1.14. */
const COLLATERAL = 60n * E18;
const POSITION_GAS_WEI = 1_500_000_000_000_000n; // 0.0015 ETH: one signed tx's maximum fee up front, plus spend
const EVM_GAS = { gas_limit: "600000", max_fee_per_gas: "2000000000", max_priority_fee_per_gas: "100000000" };

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const poolAbi = parseAbi(["function getUserAccountData(address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"]);
const oracleAbi = parseAbi(["function getAssetPrice(address) view returns (uint256)"]);
const pub = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (v: bigint, dec = 18, dp = 4) => (Number(v) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: dp });
const feedUrl = () => (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nearView<T>(method: string, args: object): Promise<T> {
  const r = await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) } }) });
  const j = await r.json();
  if (!j.result) throw new Error(j.error?.cause?.name ?? "NEAR view failed");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
}
async function nearBalance(id: string): Promise<bigint | null> {
  const r = await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }) });
  const j = await r.json();
  return j.result ? BigInt(j.result.amount) : null;
}

type Position = { id: number; owner: string; evm_address: string | null; payout: string; next_nonce: number; pending: unknown; active_auction: number | null; open_rescues: number[] };
type Rescue = { id: number; state: string; members: { steward: string; claim_id: string | null }[] };
type Claim = { token_id: string; owed_units: string; status: string };
type TxRow = { at: number; label: string; chain: "near" | "sepolia"; hash: string; ok: boolean; note?: string };
const txHref = (t: TxRow) => (t.chain === "near" ? `https://testnet.nearblocks.io/txns/${t.hash}` : `https://sepolia.etherscan.io/tx/${t.hash}`);

export function mountOwn(root: HTMLElement): () => void {
  let gone = false;
  let near: string | null = null;
  /** "sponsored": NEAR wallet only, the sponsor holds the Sepolia side; "own": the visitor's Sepolia wallet too. */
  let mode: "sponsored" | "own" | null = null;
  const MODE_KEY = () => `stead-own-mode-${near}`;
  const loadMode = () => {
    try {
      const m = localStorage.getItem(MODE_KEY());
      mode = m === "sponsored" || m === "own" ? m : mode;
    } catch {
      /* ignore */
    }
  };
  const setMode = (m: "sponsored" | "own") => {
    mode = m;
    try {
      localStorage.setItem(MODE_KEY(), m);
    } catch {
      /* ignore */
    }
  };
  let evm: Address | null = null;
  let busy = "";
  let error = "";
  let txs: TxRow[] = [];
  let state: { nearYocto: bigint | null; eth: bigint; link: bigint; dai: bigint; pos: Position | null; hf: number | null; coll: bigint; debt: bigint; rescue: Rescue | null; claims: Claim[] } | null = null;
  let stopBoard: () => void = () => {};
  let boardFor: number | null = null;
  let lastRescue: number | null = null; // the visitor's latest rescue, for its story link
  // the steps re-render on every refresh; the live board lives in its own container below them
  root.innerHTML = `<div data-own-main></div><div class="st-own-board" data-own-board hidden></div>`;
  const main = root.querySelector<HTMLElement>("[data-own-main]")!;
  const boardHost = root.querySelector<HTMLElement>("[data-own-board]")!;
  const KEY = () => `stead-own-${near}`;

  try {
    txs = JSON.parse(localStorage.getItem("stead-own-txs") ?? "[]");
  } catch {
    txs = [];
  }
  const saveTxs = () => {
    try {
      localStorage.setItem("stead-own-txs", JSON.stringify(txs.slice(-60)));
    } catch {
      /* the list still shows; it just won't survive a reload */
    }
  };
  const addTx = (t: Omit<TxRow, "at">) => {
    txs.push({ ...t, at: Date.now() });
    saveTxs();
    render();
  };

  // ── wallets ──
  let stopNear: () => void = () => {};
  async function initNear() {
    near = await nearAccount();
    loadMode();
    stopNear = onNearAccount((a) => {
      near = a;
      loadMode();
      void refresh();
    });
  }
  async function connectEvm() {
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No Sepolia wallet found in this browser (MetaMask or another injected wallet).");
    const w = createWalletClient({ chain: sepolia, transport: custom(eth) });
    const [a] = await w.requestAddresses();
    try {
      await w.switchChain({ id: sepolia.id });
    } catch {
      await w.addChain({ chain: sepolia });
    }
    evm = a;
    setMode("own");
  }
  const evmWallet = () => createWalletClient({ account: evm!, chain: sepolia, transport: custom((window as any).ethereum) });

  // ── Stead calls (signed by the visitor's NEAR wallet) ──
  async function stead(method: string, args: object, label: string, gasTgas = 150n): Promise<string> {
    try {
      const out: any = await steadCall(method, args, gasTgas);
      const hash = out?.transaction?.hash ?? out?.transaction_outcome?.id ?? "";
      const failure = [out?.status?.Failure, ...(out?.receipts_outcome ?? []).map((r: any) => r.outcome?.status?.Failure)].find(Boolean);
      if (failure) {
        const msg = JSON.stringify(failure).match(/Smart contract panicked: ([^"\\]+)/)?.[1] ?? "refused";
        addTx({ label: `${label}: refused by the contract ("${msg}")`, chain: "near", hash, ok: false });
        throw Object.assign(new Error(msg), { refused: true });
      }
      addTx({ label, chain: "near", hash, ok: true });
      return hash;
    } catch (e) {
      const m = String((e as Error).message ?? e);
      const panic = m.match(/Smart contract panicked: ([^"\\]+)/)?.[1];
      const hash = (e as any)?.transaction?.hash ?? (e as any)?.txHash;
      if (panic && !(e as any).refused) addTx({ label: `${label}: refused by the contract ("${panic}")`, chain: "near", hash: hash ?? "", ok: false });
      throw panic ? Object.assign(new Error(panic), { refused: true }) : e;
    }
  }
  /** Ask the contract to sign an Aave action for the position, then wait until it lands on Sepolia. */
  async function signAction(pid: number, action: object, label: string) {
    const before = (await nearView<Position>("get_position", { position_id: pid })).next_nonce;
    await stead("sign_action", { position_id: pid, action, gas: EVM_GAS }, `${label} (the contract signs it through NEAR's chain signatures)`);
    busy = `${label}: waiting for it to land on Sepolia…`;
    render();
    for (let i = 0; i < 90; i++) {
      const p = await nearView<Position>("get_position", { position_id: pid });
      if (p.next_nonce > before && p.pending === null) return;
      await sleep(4000);
    }
    throw new Error(`${label} did not land within 6 minutes`);
  }
  async function evmSend(label: string, fn: () => Promise<Hex>) {
    busy = `${label}: confirm in your Sepolia wallet…`;
    render();
    const hash = await fn();
    addTx({ label, chain: "sepolia", hash, ok: true });
    busy = `${label}: waiting for Sepolia…`;
    render();
    await pub.waitForTransactionReceipt({ hash });
  }

  // ── chain state ──
  async function findPosition(): Promise<Position | null> {
    if (!near) return null;
    let id: number | null = null;
    try {
      id = Number(localStorage.getItem(KEY()) ?? "NaN");
    } catch {
      id = null;
    }
    if (id !== null && Number.isInteger(id)) {
      const p = await nearView<Position | null>("get_position", { position_id: id }).catch(() => null);
      if (p && p.owner === near) return p;
    }
    // newest first: a returning visitor's latest position
    for (let i = 60, misses = 0; i >= 0 && misses < 200; i--) {
      const p = await nearView<Position | null>("get_position", { position_id: i }).catch(() => null);
      if (!p) {
        misses++;
        continue;
      }
      if (p.owner === near) {
        try {
          localStorage.setItem(KEY(), String(p.id));
        } catch {
          /* ignore */
        }
        return p;
      }
    }
    return null;
  }
  async function refresh() {
    if (gone) return;
    try {
      const pos = await findPosition();
      const [nearYocto, eth, link, dai] = await Promise.all([
        near ? nearBalance(near) : Promise.resolve(null),
        evm ? pub.getBalance({ address: evm }) : Promise.resolve(0n),
        evm ? pub.readContract({ address: LINK, abi: erc20, functionName: "balanceOf", args: [evm] }) : Promise.resolve(0n),
        evm ? pub.readContract({ address: DAI, abi: erc20, functionName: "balanceOf", args: [evm] }) : Promise.resolve(0n),
      ]);
      let hf: number | null = null, coll = 0n, debt = 0n, rescue: Rescue | null = null, claims: Claim[] = [];
      if (pos?.evm_address) {
        const d = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [pos.evm_address as Address] });
        coll = d[0];
        debt = d[1];
        hf = debt === 0n ? null : Number(d[5] / 10n ** 14n) / 10_000;
        const rid = pos.active_auction ?? pos.open_rescues[0] ?? null;
        if (rid !== null) {
          lastRescue = rid;
          rescue = await nearView<Rescue>("get_rescue", { rescue_id: rid });
          claims = (await Promise.all(rescue.members.filter((m) => m.claim_id).map((m) => nearView<Claim>("get_claim", { token_id: m.claim_id })))).filter(Boolean);
        }
      }
      state = { nearYocto, eth, link, dai, pos, hf, coll, debt, rescue, claims };
    } catch (e) {
      error = `Reading the chains failed (${(e as Error).message}); retrying.`;
    }
    render();
  }

  // ── the steps ──
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = `${label}…`;
    error = "";
    render();
    try {
      await fn();
    } catch (e) {
      error = (e as any).refused ? `The contract refused it: "${(e as Error).message}".` : `${label} stopped: ${(e as Error).message}`;
    }
    busy = "";
    await refresh();
  }
  async function sponsor(what: "fund" | "buyback" | "repay") {
    const r = await fetch(`${feedUrl()}/demo/sponsor`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ near, positionId: state!.pos!.id, what }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    for (const x of j.sent ?? []) addTx({ label: `Sponsor: ${x.label}`, chain: x.chain, hash: x.hash, ok: true });
  }
  const faucet = () =>
    run("Getting test funds", async () => {
      const r = await fetch(`${feedUrl()}/demo/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ near, evm }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      for (const s of j.sent ?? []) addTx({ label: `Test funds: ${s.label}`, chain: s.chain, hash: s.hash, ok: true });
    });
  async function borrowTo(pid: number, hfBps: bigint, label: string) {
    const p = await nearView<Position>("get_position", { position_id: pid });
    const d = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [p.evm_address as Address] });
    const target = (d[0] * d[3]) / hfBps;
    if (target <= d[1]) return;
    const pd = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getAssetPrice", args: [DAI] });
    const units = ((target - d[1]) * E18) / pd;
    await signAction(pid, { type: "borrow", amount: units.toString() }, `Borrow ${fmt(units, 18, 2)} DAI (health to ${(Number(hfBps) / 10_000).toFixed(2)})`);
    await signAction(pid, { type: "transfer_debt", amount: units.toString() }, `Move the borrowed DAI to your Sepolia wallet`);
  }
  const open = () =>
    run("Opening your position", async () => {
      let p = state?.pos ?? null;
      if (!p) {
        await stead("register_position", { market_id: MARKET, payout: mode === "sponsored" ? SPONSOR_PAYOUT : evm }, "Register a position (its Sepolia address is derived by NEAR's MPC network)", 100n);
        for (let i = 0; i < 20 && !(p = await findPosition())?.evm_address; i++) await sleep(2000);
        if (!p?.evm_address) throw new Error("the new position didn't appear");
        state = { ...(state as NonNullable<typeof state>), pos: p };
      }
      const addr = p.evm_address as Address;
      if (mode === "sponsored") {
        busy = "The sponsor sends your position its LINK and gas…";
        render();
        await sponsor("fund").catch((e) => {
          if (!/already done/.test((e as Error).message)) throw e;
        });
      }
      const held = await pub.readContract({ address: LINK, abi: erc20, functionName: "balanceOf", args: [addr] });
      const d0 = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [addr] });
      if (mode === "own" && d0[0] === 0n && held < COLLATERAL) await evmSend(`Send ${fmt(COLLATERAL - held, 18, 0)} LINK to your position`, () => evmWallet().writeContract({ address: LINK, abi: erc20, functionName: "transfer", args: [addr, COLLATERAL - held] }));
      if (mode === "own" && (await pub.getBalance({ address: addr })) < POSITION_GAS_WEI) await evmSend("Send 0.0015 ETH to your position for its gas", () => evmWallet().sendTransaction({ to: addr, value: POSITION_GAS_WEI }));
      const allowed = (t: Address) => pub.readContract({ address: t, abi: erc20, functionName: "allowance", args: [addr, POOL] });
      if ((await allowed(LINK)) < COLLATERAL) await signAction(p.id, { type: "approve", token: "collateral", amount: "max" }, "Let Aave take the position's LINK");
      if ((await allowed(DAI)) === 0n) await signAction(p.id, { type: "approve", token: "debt", amount: "max" }, "Let Aave take DAI repays");
      if (d0[0] === 0n) await signAction(p.id, { type: "supply", amount: COLLATERAL.toString() }, "Supply 60 LINK on Aave");
      await borrowTo(p.id, 12_000n, "Open");
    });
  const trigger = () => run("Triggering a rescue", async () => borrowTo(state!.pos!.id, 11_400n, "Trigger"));
  const tryBreak = (what: "withdraw" | "borrow") =>
    run(what === "withdraw" ? "Trying to withdraw" : "Trying to borrow", async () => {
      const a = what === "withdraw" ? { type: "withdraw", amount: { exact: E18.toString() } } : { type: "borrow", amount: E18.toString() };
      await stead("sign_action", { position_id: state!.pos!.id, action: a, gas: EVM_GAS }, what === "withdraw" ? "Try to withdraw 1 LINK while the claim is open" : "Try to borrow 1 DAI while the claim is open").catch((e) => {
        if (!(e as any).refused) throw e;
      });
    });
  const buyBack = () =>
    run("Buying back", async () => {
      if (mode === "sponsored") return sponsor("buyback");
      const owed = state!.claims.filter((c) => c.status === "open").reduce((s, c) => s + BigInt(c.owed_units), 0n);
      const addr = state!.pos!.evm_address as Address;
      const held = await pub.readContract({ address: LINK, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (owed > held) await evmSend(`Pay exactly the ${fmt(owed - held, 18, 6)} LINK owed into your position`, () => evmWallet().writeContract({ address: LINK, abi: erc20, functionName: "transfer", args: [addr, owed - held] }));
    });
  const close = () =>
    run("Closing your position", async () => {
      const p = state!.pos!;
      const addr = p.evm_address as Address;
      const d = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [addr] });
      if (d[1] > 0n && mode === "sponsored") {
        await sponsor("repay").catch((e) => {
          if (!/already done|no debt/.test((e as Error).message)) throw e;
        });
        await signAction(p.id, { type: "repay", amount: "max" }, "Repay all the debt");
      } else if (d[1] > 0n) {
        const pd = await pub.readContract({ address: ORACLE, abi: oracleAbi, functionName: "getAssetPrice", args: [DAI] });
        const need = (d[1] * E18 * 1002n) / 1000n / pd; // a little over the debt: interest keeps accruing
        const held = await pub.readContract({ address: DAI, abi: erc20, functionName: "balanceOf", args: [addr] });
        if (held < need) await evmSend(`Send ${fmt(need - held, 18, 2)} DAI to your position to repay`, () => evmWallet().writeContract({ address: DAI, abi: erc20, functionName: "transfer", args: [addr, need - held] }));
        await signAction(p.id, { type: "repay", amount: "max" }, "Repay all the debt");
      }
      const left = await pub.readContract({ address: DAI, abi: erc20, functionName: "balanceOf", args: [addr] });
      if (left > 0n) await signAction(p.id, { type: "transfer_debt", amount: left.toString() }, "Return the unused DAI to your wallet");
      if ((await pub.readContract({ address: POOL, abi: poolAbi, functionName: "getUserAccountData", args: [addr] }))[0] > 0n) await signAction(p.id, { type: "withdraw", amount: "max" }, "Withdraw all the LINK to your wallet");
    });

  // ── the page ──
  function stepHtml(n: number, title: string, done: boolean, active: boolean, body: string) {
    return `<li class="st-own-step${done ? " is-done" : active ? " is-now" : ""}"><span class="st-own-num" aria-hidden="true">${n}</span><div><h3>${title}${done ? '<span class="st-visually-hidden"> (done)</span>' : ""}</h3>${active || done ? `<div class="st-own-body">${body}</div>` : ""}</div></li>`;
  }
  function render() {
    if (gone) return;
    const s = state;
    const pos = s?.pos ?? null;
    const opened = !!pos && s!.coll > 0n;
    const rescue = s?.rescue ?? null;
    const sponsored = mode === "sponsored";
    const funded = !!s && (s.nearYocto ?? 0n) >= 20_000_000_000_000_000_000_000n && (sponsored || (s.eth >= 2_000_000_000_000_000n && (opened || s.link >= COLLATERAL)));
    const triggered = opened && (rescue !== null || (s!.hf !== null && s!.hf < 1.15));
    const ended = opened && !rescue && s!.hf !== null && s!.hf >= 1.4; // after a rescue, health is back near 1.50
    const closed = !!pos && s!.coll === 0n && s!.debt === 0n && txs.some((t) => /Withdraw all/.test(t.label));
    const btn = (label: string, attr: string, primary = false, off = false) => `<button type="button" class="${primary ? "st-push" : "st-secondary"} st-cut" ${attr}${busy || off ? ' aria-disabled="true" disabled' : ""}>${primary ? '<span class="st-lamp" aria-hidden="true"></span>' : ""}${label}</button>`;
    const steps = [
      stepHtml(1, "Connect a NEAR testnet wallet", !!near, !near, near ? `Connected as <strong>${esc(near)}</strong>${s?.nearYocto != null ? ` · ${fmt(s.nearYocto, 24, 3)} NEAR` : ""}${s?.nearYocto != null && s.nearYocto < 10_000_000_000_000_000_000_000n ? ` · <span class="st-own-warn">your account needs a little testnet NEAR to sign: get 10 from <a class="st-textlink" href="https://near-faucet.io" target="_blank" rel="noopener">a NEAR testnet faucet</a></span>` : ""}` : `<p>Your NEAR account owns the position and signs its Stead calls. Any NEAR wallet with testnet works (Meteor, Intear, Nightly, Ledger, NEAR CLI and more). Connecting adds a limited key for the Stead contract only, so the calls below need few approvals.</p><div class="st-own-buttons">${btn("Connect NEAR wallet", "data-near", true)}</div>`),
      stepHtml(2, "Sepolia side: your wallet, or ours", !!mode, !!near && !mode, mode === "own" && evm ? `Your Sepolia wallet <span class="st-mono">${evm.slice(0, 8)}…${evm.slice(-6)}</span>${s ? ` · ${fmt(s.eth, 18, 4)} ETH · ${fmt(s.link, 18, 2)} LINK · ${fmt(s.dai, 18, 2)} DAI` : ""}` : mode === "sponsored" ? `NEAR only: the sponsor holds the Sepolia side. Your position's payout is the sponsor's address; it funds the position and pays the buy-back when you ask.` : `<p>The position's money lives on Sepolia. <strong>Only a NEAR wallet?</strong> Let the sponsor hold the Sepolia side: it funds your position and pays the buy-back when you ask; test funds go back to it at the end. <strong>Have a Sepolia wallet?</strong> Use it: you fund the position and get everything back.</p><div class="st-own-buttons">${btn("Only NEAR: sponsor the Sepolia side", "data-sponsored", true)}${btn("Use my Sepolia wallet", "data-evm")}</div>`),
      stepHtml(3, "Get test funds", funded || sponsored, mode === "own" && !funded && !opened, `<p>You need about 0.03 NEAR, 0.002 Sepolia ETH and 60 LINK (+20 LINK if you buy back). We sponsor one set per wallet per day: 0.04 NEAR, 0.0025 Sepolia ETH, 80 LINK and 5 DAI.</p><div class="st-own-buttons">${btn("Send me test funds", "data-faucet", true)}</div>`),
      stepHtml(4, "Open your position", opened, (sponsored ? !!near : funded) && !opened, `<p>Registers a position on the demo contract; its Sepolia address is derived by NEAR's MPC network, and only the contract can sign for it. Then 60 LINK goes in${sponsored ? " (from the sponsor)" : ""}, and the contract supplies it on Aave and borrows DAI to a health factor of 1.20.${sponsored ? " Every step is a Stead call from your NEAR wallet." : " Two Sepolia confirmations, the rest are Stead calls."}</p><div class="st-own-buttons">${btn("Open my position", "data-open", true)}</div>`),
      stepHtml(5, "Trigger a rescue", triggered || ended, opened && !triggered && !ended, `<p>Borrow a little more, to a health factor of 1.14: under Stead's 1.15 trigger. The keeper's proven reading then opens a real auction among the stewards.</p><div class="st-own-buttons">${btn("Borrow to 1.14", "data-trigger", true)}</div>`),
      stepHtml(6, "Watch your rescue, try to break it, choose the ending", ended, triggered && !ended, `${rescue ? `<p>Rescue <strong>#${rescue.id}</strong>: ${esc(rescue.state.replace(/_/g, " "))}. ${rescue.state === "open" ? `Claims are open: buy them back by paying exactly what is owed into your position, or do nothing and watch the claim settle after the demo contract's 3-minute window.` : "Stewards are bidding and topping up; watch it below."}</p>` : `<p>Waiting for the proven reading to open the auction (30 to 60 seconds).</p>`}
        <div class="st-own-buttons">${rescue?.state === "open" ? btn("Buy back now", "data-buyback", true) : ""}${rescue ? btn("Try to withdraw 1 LINK", 'data-break="withdraw"') + btn("Try to borrow 1 DAI", 'data-break="borrow"') : ""}</div>
        <p class="st-own-hint">The live board for your position is below.</p>`),
      stepHtml(7, "Close and get everything back", closed, ended && !closed, `<p>Repay the debt from your DAI, then withdraw all the LINK to your Sepolia wallet.${lastRescue !== null ? ` Your rescue's full story, every step with its transaction: <a class="st-textlink" href="?rescue=sepolia-demo:${lastRescue}#/rescues">rescue #${lastRescue}</a> (it appears a few minutes after the rescue ends).` : ""}</p><div class="st-own-buttons">${btn("Close my position", "data-close", true)}</div>`),
    ];
    main.innerHTML = `
      <section class="st-panel st-sect st-own">
        <header class="st-list-head"><div class="st-label">YOUR OWN RESCUE · NEAR TESTNET AND SEPOLIA</div><h1 class="st-page-title">Run a rescue with your own wallets</h1>
          <p class="st-list-sub">Everything below is real, on testnets: your NEAR account owns the position, the contract signs its Aave transactions through NEAR's chain signatures, and the stewards that rescue it are the same bots as everywhere on this site. About 15 to 20 minutes: each Aave step waits for Sepolia.</p></header>
        ${busy ? `<p class="st-own-busy" role="status"><span class="st-live-dot" aria-hidden="true"></span>${esc(busy)}</p>` : ""}
        ${error ? `<p class="st-own-error" role="alert">${esc(error)}</p>` : ""}
        <ol class="st-own-steps">${steps.join("")}</ol>
        ${txs.length ? `<div class="st-label st-runlog-head">YOUR TRANSACTIONS</div><ol class="st-runlog">${txs
          .slice()
          .reverse()
          .map((t) => `<li><span class="st-runlog-time">${new Date(t.at).toISOString().slice(11, 19)}</span><span class="st-runlog-label">${esc(t.label)}</span>${t.hash ? `<a class="st-txlink" href="${txHref(t)}" target="_blank" rel="noopener"><span>${t.chain === "near" ? "NearBlocks" : "Etherscan"}</span><span class="st-txlink-where">${t.hash.slice(0, 8)}…</span>${icon("external", 12)}</a>` : ""}</li>`)
          .join("")}</ol>` : ""}
      </section>`;
    main.querySelector("[data-near]")?.addEventListener("click", () => run("Connecting your NEAR wallet", async () => void (near = await connectNear())));
    main.querySelector("[data-sponsored]")?.addEventListener("click", () => {
      setMode("sponsored");
      render();
    });
    main.querySelector("[data-evm]")?.addEventListener("click", () => run("Connecting your Sepolia wallet", connectEvm));
    main.querySelector("[data-faucet]")?.addEventListener("click", faucet);
    main.querySelector("[data-open]")?.addEventListener("click", open);
    main.querySelector("[data-trigger]")?.addEventListener("click", trigger);
    main.querySelector("[data-buyback]")?.addEventListener("click", buyBack);
    main.querySelector("[data-close]")?.addEventListener("click", close);
    main.querySelectorAll<HTMLButtonElement>("[data-break]").forEach((b) => b.addEventListener("click", () => tryBreak(b.dataset.break as "withdraw" | "borrow")));
    // the live board for this position while a rescue runs: mounted once, not on every refresh
    const show = !!pos && triggered && !ended;
    boardHost.hidden = !show;
    if (show && boardFor !== pos!.id) {
      stopBoard();
      boardFor = pos!.id;
      stopBoard = mountLive(boardHost, () => {}, "live", (r) => r.contract === CONTRACT && r.positionId === pos!.id);
    } else if (!show && boardFor !== null) {
      stopBoard();
      boardFor = null;
    }
  }

  void (async () => {
    main.innerHTML = `<section class="st-panel st-page"><div class="st-label">YOUR OWN RESCUE</div><p class="st-empty">Loading the wallets…</p></section>`;
    await initNear().catch((e) => (error = `NEAR wallets could not load (${(e as Error).message}).`));
    const eth = (window as any).ethereum;
    if (eth) {
      const accts: string[] = await eth.request({ method: "eth_accounts" }).catch(() => []);
      if (accts[0]) evm = accts[0] as Address;
    }
    await refresh();
  })();
  const timer = window.setInterval(() => !busy && void refresh(), 8000);
  return () => {
    gone = true;
    clearInterval(timer);
    stopBoard();
    stopNear();
  };
}

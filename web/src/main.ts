// Stead front end: the app shell (sidebar, mobile drawer, theme switch) and hash routes.
// Pages fill the content column; the shell holds no data of its own.
import { icon, logo, type IconName } from "./icons";
import { mountReplay } from "./board/player";
import { mountLive } from "./board/live";
import type { BoardMode } from "./board/view";
import type { Recording } from "./board/controls";
import { mountProofs, mountRescue } from "./rescue/page";
import { mountHome } from "./home/page";
import { loadRecords, mountList } from "./lists/pages";
import { mountMainnet } from "./mainnet/page";
import { mountHow } from "./how/page";
import { bindCrowns } from "./crown";
/** The live feed (and its recordings): the local one when the app runs locally. */
const liveFeedUrl = () => (import.meta as any).env?.VITE_LIVE_FEED ?? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://127.0.0.1:8788" : "https://live.usestead.xyz");

/** The recorded rescue the live board replays: a real auction on Sepolia, rebuilt from the chains. */
const REPLAY_URL = "/replays/sepolia-demo-rescue-8.json";
/** Recorded rescues the live board can replay (?replay=<id>). */
const REPLAYS: Recording[] = [
  { id: "mainnet-81", label: "Rescue 81 · bought back", url: "/replays/mainnet-rescue-81.json", net: "mainnet" },
  { id: "mainnet-78", label: "Rescue 78 · settled", url: "/replays/mainnet-rescue-78.json", net: "mainnet" },
  { id: "8", label: "Rescue 8", url: "/replays/sepolia-demo-rescue-8.json", net: "testnet" },
  { id: "10", label: "Rescue 10 · pooled", url: "/replays/sepolia-demo-rescue-10.json", net: "testnet" },
  { id: "11", label: "Rescue 11 · pooled", url: "/replays/sepolia-demo-rescue-11.json", net: "testnet" },
  { id: "14", label: "Rescue 14 · pooled", url: "https://live.usestead.xyz/rescue/sepolia-demo.steadfi.testnet/14.json", net: "testnet" },
];
/** The Sepolia demo contract's recordings (its rescue pages, lists and proofs). */
const TESTNET_REPLAYS = REPLAYS.filter((x) => x.net === "testnet");
const DEFAULT_REPLAY = "8";
let replayNote = ""; // shown once on the replay that opened because nothing was live
const replayId = () => {
  const r = new URLSearchParams(location.search).get("replay");
  return REPLAYS.some((x) => x.id === r) ? r! : DEFAULT_REPLAY;
};
/** #/live opens on LIVE; ?replay=<id> (or the REPLAY switch) opens a recorded rescue; ?demo opens DEMO. */
const boardMode = (): BoardMode => {
  const q = new URLSearchParams(location.search);
  return q.has("replay") ? "replay" : q.has("demo") ? "demo" : "live";
};
function setBoardMode(m: BoardMode) {
  const u = new URL(location.href);
  if (m === "replay") u.searchParams.set("replay", replayId());
  else u.searchParams.delete("replay");
  if (m === "demo") u.searchParams.set("demo", "");
  else u.searchParams.delete("demo");
  // choosing LIVE sticks even when nothing is live (otherwise the page opens on a replay)
  if (m === "live") u.searchParams.set("live", "");
  else u.searchParams.delete("live");
  u.searchParams.delete("t");
  history.replaceState(null, "", u);
  fill("live");
}

type Route = "overview" | "how" | "live" | "try" | "mainnet" | "rescues" | "positions" | "stewards" | "claims" | "proofs";

const NAV: { id: Route; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "how", label: "How it works", icon: "proofs" },
  { id: "live", label: "Live auctions", icon: "live" },
  { id: "try", label: "Protect a position", icon: "rescues" },
  { id: "mainnet", label: "On mainnet", icon: "ethereum" },
  { id: "rescues", label: "Rescues", icon: "rescues" },
  { id: "positions", label: "Positions", icon: "positions" },
  { id: "stewards", label: "Stewards", icon: "stewards" },
  { id: "claims", label: "Claims", icon: "claims" },
  { id: "proofs", label: "Proofs", icon: "proofs" },
];

/** What each page will hold; shown until the page is built (no invented figures). */
const PAGES: Record<Route, { label: string; title: string; body: string }> = {
  overview: { label: "OVERVIEW", title: "Overview", body: "Totals across every rescue, read from the contract. Built after the live board." },
  live: { label: "LIVE AUCTIONS", title: "Live auctions", body: "The live board replays a recorded rescue from its event log: annunciator, health gauge, flip clock, bid ladder, stewards and journal. It is the next step." },
  mainnet: { label: "MAINNET", title: "On mainnet", body: "" },
  try: { label: "PROTECT AN AAVE POSITION", title: "Protect an Aave position", body: "" },
  how: { label: "HOW IT WORKS", title: "How it works", body: "" },
  rescues: { label: "RESCUES", title: "Rescues", body: "Each rescue with its timeline, cost chart, auction results, claims and proofs." },
  positions: { label: "POSITIONS", title: "Positions", body: "Protected positions and their health factors, each with its evidence mark." },
  stewards: { label: "STEWARDS", title: "Stewards", body: "The five example strategies, their bids and their claims. Anyone can register a steward." },
  claims: { label: "CLAIMS", title: "Claims", body: "Open claims with their buy-back windows, and the claims bought back or settled." },
  proofs: { label: "PROOFS", title: "Proofs", body: "Every verified reading and every transaction behind a rescue, linked to its record." },
};

// ───────────────────────────── theme ─────────────────────────────

type Theme = "light" | "dark";
const currentTheme = (): Theme => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
function setTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("stead-theme", t);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme-set]")) b.setAttribute("aria-pressed", String(b.dataset.themeSet === t));
}

// ───────────────────────────── markup ─────────────────────────────

/** The homepage is the empty route; every app route has a name. */
/** The landing page: the site root on usestead.xyz. On app.usestead.xyz the root opens the app. */
const isHome = () => !location.hostname.startsWith("app.") && !NAV.some((n) => n.id === location.hash.replace(/^#\/?/, ""));
const route = (): Route => {
  const r = location.hash.replace(/^#\/?/, "") as Route;
  return NAV.some((n) => n.id === r) ? r : "live";
};

function navItems(active: Route): string {
  return NAV.map(
    (n) => `<a class="st-nav-item st-cut" href="#/${n.id}" data-route="${n.id}"${n.id === active ? ' aria-current="page"' : ""}>
      ${icon(n.icon)}
      <span class="st-nav-label">${n.label}</span>
      <span class="st-nav-count" data-count="${n.id}"></span>
    </a>`,
  ).join("");
}

/** The status card's network: the mainnet position page (?net=mainnet#/try) runs on Ethereum; every other page shows Sepolia. */
const networkName = (r: Route) => (r === "mainnet" || new URLSearchParams(location.search).get("net") === "mainnet" ? "Ethereum" : "Sepolia");

function sidebarBody(active: Route, inDrawer: boolean): string {
  const t = currentTheme();
  return `
    <div class="st-brand-row">
      <a class="st-brand" href="#/" aria-label="Stead, home">${logo(26)}</a>
      ${inDrawer ? `<button type="button" class="st-icon-btn st-icon-btn--drawer" data-close aria-label="Close menu">${icon("close", 18)}</button>` : ""}
    </div>
    <div class="st-micro">MENU</div>
    <div class="st-nav">${navItems(active)}</div>
    <div class="st-sidebar-foot">
      <dl class="st-status">
        <div><dt>NETWORK</dt><dd data-status="network">${networkName(active)}</dd></div>
        <div><dt>READINGS</dt><dd data-status="readings">—</dd></div>
        <div><dt>STEWARDS</dt><dd data-status="stewards">—</dd></div>
      </dl>
      <div class="st-seg" role="group" aria-label="Theme">
        <button type="button" data-theme-set="light" aria-pressed="${t === "light"}">LIGHT</button>
        <button type="button" data-theme-set="dark" aria-pressed="${t === "dark"}">DARK</button>
      </div>
      <button type="button" class="st-push st-push--small st-cut st-connect" data-connect aria-live="polite"><span class="st-lamp" aria-hidden="true"></span><span data-connect-label>CONNECT NEAR</span></button>
    </div>`;
}

function page(r: Route): string {
  const p = PAGES[r];
  return `
    <section class="st-panel st-page" aria-labelledby="page-title">
      <header class="st-panel-head">
        <div class="st-label">${p.label}</div>
        <h1 class="st-page-title" id="page-title">${p.title}</h1>
      </header>
      <p class="st-empty">${p.body}</p>
    </section>`;
}

function shell(r: Route): string {
  return `
    <a class="st-skip" href="#content">Skip to content</a>
    <header class="st-appbar">
      <button type="button" class="st-icon-btn st-icon-btn--drawer" data-open aria-label="Open menu" aria-expanded="false" aria-controls="drawer">${icon("menu", 20)}</button>
      <a class="st-appbar-mark" href="#/" aria-label="Stead, home">${logo(22)}</a>
      <span class="st-appbar-right" data-live-chip></span>
    </header>
    <div class="st-shell">
      <nav class="st-sidebar st-panel" aria-label="Main">${sidebarBody(r, false)}</nav>
      <main class="st-content" id="content" tabindex="-1"></main>
    </div>
    <button type="button" class="st-scrim" data-close tabindex="-1" aria-label="Close menu"></button>
    <nav class="st-drawer" id="drawer" aria-label="Main" inert>
      <div class="st-drawer-inner st-panel">${sidebarBody(r, true)}</div>
    </nav>`;
}

// ───────────────────────────── behaviour ─────────────────────────────

const app = document.getElementById("app")!;

function setDrawer(open: boolean) {
  const drawer = document.getElementById("drawer");
  const opener = document.querySelector<HTMLButtonElement>("[data-open]");
  if (!drawer || !opener) return; // the homepage has no drawer
  document.body.classList.toggle("st-drawer-open", open);
  opener.setAttribute("aria-expanded", String(open));
  if (open) {
    drawer.removeAttribute("inert");
    drawer.querySelector<HTMLAnchorElement>(".st-nav-item")?.focus();
  } else {
    drawer.setAttribute("inert", "");
    if (drawer.contains(document.activeElement)) opener.focus();
  }
}

let unmount: () => void = () => {};
function fill(r: Route) {
  unmount();
  unmount = () => {};
  const content = document.querySelector<HTMLElement>("#content")!;
  const q = new URLSearchParams(location.search);
  if (r === "live" && boardMode() === "live" && !q.has("live")) {
    // nothing live right now: open on a recorded rescue instead of an empty board (LIVE is one click)
    let gone = false;
    unmount = () => void (gone = true);
    content.innerHTML = `<section class="st-panel st-page"><div class="st-label">LIVE AUCTIONS</div><p class="st-empty">Looking for a live rescue…</p></section>`;
    void fetch(`${liveFeedUrl()}/live.json`, { signal: AbortSignal.timeout(4000), cache: "no-store" })
      .then((x) => x.json())
      .then((j) => (j.rescues ?? []).length > 0, () => false)
      .then((isLive) => {
        if (gone) return;
        if (isLive) {
          unmount = mountLive(content, setBoardMode, "live");
          return;
        }
        replayNote = "No rescue is running right now, so this is a recorded one, replayed from its events. LIVE shows the next real rescue; DEMO starts one.";
        fill2();
      });
    const fill2 = () => {
      const u = new URL(location.href);
      u.searchParams.set("replay", replayId());
      history.replaceState(null, "", u);
      fill("live");
    };
    return;
  }
  if (r === "live" && boardMode() !== "replay") {
    unmount = mountLive(content, setBoardMode, boardMode() === "demo" ? "demo" : "live");
  } else if (r === "live") {
    let stop = () => {};
    let gone = false;
    unmount = () => { gone = true; stop(); };
    const cur = replayId();
    const note = replayNote;
    replayNote = "";
    void mountReplay(content, REPLAYS.find((x) => x.id === cur)!.url, {
      replays: REPLAYS,
      current: cur,
      note,
      onMode: setBoardMode,
      onPick(id) {
        const u = new URL(location.href);
        u.searchParams.set("replay", id);
        u.searchParams.delete("t");
        history.replaceState(null, "", u);
        fill("live");
      },
    }).then((s) => (gone ? s() : (stop = s)));
  } else if (r === "rescues" && new URLSearchParams(location.search).has("rescue")) {
    // a recorded rescue's own page (?rescue=<id>)
    // ?rescue=<contract>:<id> ("sepolia-demo:14", "steadfi:20") or a bare id on the demo contract
    const raw = new URLSearchParams(location.search).get("rescue") ?? "";
    const [short, id] = raw.includes(":") ? raw.split(":") : ["sepolia-demo", raw];
    const contract = short === "steadfi" ? "steadfi.testnet" : `${short}.steadfi.testnet`;
    const published = short === "sepolia-demo" ? TESTNET_REPLAYS.find((x) => x.id === id)?.url : undefined;
    void mountRescue(content, [`${liveFeedUrl()}/rescue/${contract}/${id}.json`, ...(published ? [published] : [])]);
  } else if (r === "overview" || r === "positions" || r === "rescues" || r === "claims" || r === "stewards") {
    unmount = mountList(content, r, TESTNET_REPLAYS.map((x) => ({ id: x.id, contract: "sepolia-demo.steadfi.testnet", rescueId: Number(x.id) })));
  } else if (r === "how") {
    unmount = mountHow(content);
  } else if (r === "try") {
    // the wallet libraries load only here (a few hundred KB): say so while they download
    content.innerHTML = `<section class="st-panel st-page" aria-busy="true"><div class="st-label">PROTECT AN AAVE POSITION</div><p class="st-empty">Loading the wallet tools…</p></section>`;
    let stop = () => {};
    let gone = false;
    unmount = () => {
      gone = true;
      stop();
    };
    void import("./own/polyfill")
      .then(() => import("./own/page"))
      .then((m) => (gone ? undefined : (stop = m.mountOwn(content))));
  } else if (r === "mainnet") {
    unmount = mountMainnet(content);
  } else if (r === "proofs") {
    void mountProofs(content, TESTNET_REPLAYS);
  } else content.innerHTML = page(r);
}

let layout: "home" | "app" | null = null;
function render() {
  unmount();
  unmount = () => {};
  if (isHome()) {
    layout = "home";
    document.title = "Stead · liquidation rescue market";
    unmount = mountHome(app, REPLAY_URL);
    window.scrollTo(0, 0);
    return;
  }
  layout = "app";
  const r = route();
  app.innerHTML = shell(r);
  showNear(nearShown);
  fill(r);
  fillStatus();
  document.title = `${PAGES[r].title} · Stead`;
}

/** The sidebar's status card, from the contracts' records: how Sepolia readings are proven and how many stewards are registered. */
function fillStatus() {
  loadRecords().then(
    ({ rec }) => {
      const sep = rec.positions.filter((p) => p.chain === "Sepolia" && p.hfSource);
      const proven = sep.filter((p) => p.hfSource === "verified").length;
      for (const el of document.querySelectorAll<HTMLElement>('[data-status="readings"]')) el.textContent = sep.length ? `${proven}/${sep.length} proven` : "—";
      for (const el of document.querySelectorAll<HTMLElement>('[data-status="stewards"]')) el.textContent = `${rec.stewards.length} registered`;
    },
    () => {},
  );
}

function onRoute() {
  if ((isHome() ? "home" : "app") !== layout) return render();
  if (layout === "home") return;
  const r = route();
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".st-nav-item")) {
    if (a.dataset.route === r) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-status="network"]')) el.textContent = networkName(r);
  fill(r);
  document.title = `${PAGES[r].title} · Stead`;
  if (document.body.classList.contains("st-drawer-open")) setDrawer(false);
}

// The NEAR wallet button (sidebar and drawer): connect through NEAR Connector, show the account,
// a second click disconnects. The connector loads only when used or when a visitor was connected.
let nearShown: string | null = null;
function showNear(a: string | null) {
  nearShown = a;
  for (const el of document.querySelectorAll<HTMLElement>("[data-connect-label]")) el.textContent = a ? (a.length > 22 ? `${a.slice(0, 20)}…` : a) : "CONNECT NEAR";
  for (const b of document.querySelectorAll<HTMLElement>("[data-connect]")) {
    b.classList.toggle("is-connected", !!a);
    b.title = a ? `Connected as ${a}. Click to disconnect.` : "Connect a NEAR testnet wallet";
  }
}
async function nearButton() {
  const w = await import("./wallet/near");
  if (nearShown) {
    if (confirmDisconnect()) await w.disconnectNear();
    return;
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-connect-label]")) el.textContent = "CONNECTING…";
  try {
    await w.connectNear();
  } catch {
    /* closed the wallet window */
  }
  showNear(await w.nearAccount());
}
/** Disconnect needs no dialog: the button label already says who is connected; a second click within 4 s confirms. */
let armedAt = 0;
function confirmDisconnect(): boolean {
  if (Date.now() - armedAt < 4000) return true;
  armedAt = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>("[data-connect-label]")) el.textContent = "CLICK AGAIN TO DISCONNECT";
  setTimeout(() => showNear(nearShown), 4000);
  return false;
}
void import("./wallet/near").then(async (w) => {
  w.onNearAccount(showNear);
  showNear(await w.nearAccount());
});

app.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-connect]")) return void nearButton();
  // menu links open a page fresh: page options (?rescue, ?replay, ?demo) belong to the page they were set on
  const nav = t.closest<HTMLAnchorElement>("a.st-nav-item");
  if (nav && location.search && !(e as MouseEvent).metaKey && !(e as MouseEvent).ctrlKey) {
    e.preventDefault();
    history.pushState(null, "", location.pathname + nav.getAttribute("href"));
    onRoute();
    return;
  }
  const theme = t.closest<HTMLButtonElement>("[data-theme-set]");
  if (theme) return setTheme(theme.dataset.themeSet as Theme);
  if (t.closest("[data-open]")) return setDrawer(true);
  if (t.closest("[data-close]")) return setDrawer(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("st-drawer-open")) setDrawer(false);
});
// Leaving the mobile layout with the drawer open closes it.
matchMedia("(min-width: 900px)").addEventListener("change", (m) => m.matches && setDrawer(false));
// Follow the system theme until the viewer picks one.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (m) => {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("stead-theme");
  } catch {}
  if (!saved) {
    document.documentElement.setAttribute("data-theme", m.matches ? "dark" : "light");
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-theme-set]")) b.setAttribute("aria-pressed", String(b.dataset.themeSet === currentTheme()));
  }
});
window.addEventListener("hashchange", onRoute);

bindCrowns();
render();
// Screenshot/testing aid: ?drawer=open opens the drawer on load.
if (new URLSearchParams(location.search).get("drawer") === "open") setDrawer(true);

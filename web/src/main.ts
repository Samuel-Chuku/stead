// Stead front end: the app shell (sidebar, mobile drawer, theme switch) and hash routes.
// Pages fill the content column; the shell holds no data of its own.
import { icon, logo, type IconName } from "./icons";
import { mountReplay } from "./board/player";
import { mountRescue } from "./rescue/page";

/** The recorded rescue the live board replays: a real auction on Sepolia, rebuilt from the chains. */
const REPLAY_URL = "/replays/sepolia-demo-rescue-8.json";

type Route = "overview" | "live" | "rescues" | "positions" | "stewards" | "claims" | "proofs";

const NAV: { id: Route; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "live", label: "Live auctions", icon: "live" },
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

function sidebarBody(active: Route, inDrawer: boolean): string {
  const t = currentTheme();
  return `
    <div class="st-brand-row">
      <a class="st-brand" href="#/live" aria-label="Stead, live auctions">${logo(26)}</a>
      ${inDrawer ? `<button type="button" class="st-icon-btn st-icon-btn--drawer" data-close aria-label="Close menu">${icon("close", 18)}</button>` : ""}
    </div>
    <div class="st-micro">MENU</div>
    <div class="st-nav">${navItems(active)}</div>
    <div class="st-sidebar-foot">
      <dl class="st-status">
        <div><dt>NETWORK</dt><dd>Sepolia</dd></div>
        <div><dt>READINGS</dt><dd data-status="readings">—</dd></div>
        <div><dt>STEWARDS</dt><dd data-status="stewards">—</dd></div>
      </dl>
      <div class="st-seg" role="group" aria-label="Theme">
        <button type="button" data-theme-set="light" aria-pressed="${t === "light"}">LIGHT</button>
        <button type="button" data-theme-set="dark" aria-pressed="${t === "dark"}">DARK</button>
      </div>
      <button type="button" class="st-push st-push--small st-cut" data-connect><span class="st-lamp" aria-hidden="true"></span>CONNECT NEAR</button>
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
      <a class="st-appbar-mark" href="#/live" aria-label="Stead, live auctions">${logo(22)}</a>
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
  const drawer = document.getElementById("drawer")!;
  const opener = document.querySelector<HTMLButtonElement>("[data-open]")!;
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
  if (r === "live") {
    let stop = () => {};
    let gone = false;
    unmount = () => { gone = true; stop(); };
    void mountReplay(content, REPLAY_URL).then((s) => (gone ? s() : (stop = s)));
  } else if (r === "rescues") {
    void mountRescue(content, REPLAY_URL);
  } else content.innerHTML = page(r);
}

function render() {
  const r = route();
  app.innerHTML = shell(r);
  fill(r);
  document.title = `${PAGES[r].title} · Stead`;
}

function onRoute() {
  const r = route();
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".st-nav-item")) {
    if (a.dataset.route === r) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  fill(r);
  document.title = `${PAGES[r].title} · Stead`;
  if (document.body.classList.contains("st-drawer-open")) setDrawer(false);
}

app.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
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

render();
// Screenshot/testing aid: ?drawer=open opens the drawer on load.
if (new URLSearchParams(location.search).get("drawer") === "open") setDrawer(true);

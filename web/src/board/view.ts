// The live board's DOM. Built once per log; `update(board)` only changes text, classes and the
// few positions/widths that animate (CSS transitions do the motion). No timers in here.
import type { RescueLog, StewardId } from "../../../stewards/src/rescuelog";
import { CODE, consequence, fmtAmt, isPooled, RISK, RISK_WORD, RULE, STEWARD_ORDER, type Board, type LampId } from "./model";
import { poolMarkup, updatePool } from "./pool";
import { closingMarkup, txLink, updateClosing } from "./closing";
import { crown } from "../crown";
import { powerOn } from "../ambience/stead-ambience.js";
import { clockDigits, marketChip, replayGroups } from "./controls";

/** The recordings as one compact native menu, real funds first (keyboard and screen readers for free). */
function watchMenu(list: ReplayChoice[], current: string | undefined, mode: BoardMode) {
  const opt = (r: ReplayChoice) => `<option value="${esc(r.id)}"${r.id === current ? " selected" : ""}>${esc(r.label)}</option>`;
  const groups = replayGroups(list);
  const body = groups.length > 1 ? groups.map((g) => `<optgroup label="${esc(g.label)}">${g.items.map(opt).join("")}</optgroup>`).join("") : list.map(opt).join("");
  return `<label class="st-select st-watch"><span class="st-select-label">${mode === "replay" ? "WATCH" : "RESCUE"}</span><select data-pick-menu aria-label="${mode === "replay" ? "Recorded rescue to watch" : "Open rescue to follow"}">${body}</select></label>`;
}

export type ReplayChoice = { id: string; label: string; net?: "mainnet" | "testnet" };

const LAMPS: { id: LampId; cls: string }[] = [
  { id: "TRIGGER", cls: "exposure" },
  { id: "AUCTION", cls: "acting" },
  { id: "TOP-UP", cls: "acting" },
  { id: "CLAIM OPEN", cls: "exposure" },
  { id: "TRIP", cls: "trip" },
];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (hf: number) => Math.max(0, Math.min(100, ((hf - 0.9) / 0.8) * 100));
const tile = (s: StewardId, size: number) => `<span class="st-tile st-tile--${size}" style="--sc: var(--st-steward-${s})" aria-hidden="true">${CODE[s]}</span>`;
const clockText = (ms: number) => new Date(ms).toISOString().slice(11, 21);

export type BoardMode = "replay" | "live" | "demo";
export type BoardControls = { onToggle: () => void; replays?: ReplayChoice[]; current?: string; onPick?: (id: string) => void; mode?: BoardMode; onMode?: (m: BoardMode) => void; delayS?: number };

/** The LIVE / REPLAY / DEMO switch. DEMO starts a real rescue on a demo borrower's testnet position. */
export function modeSwitch(mode: BoardMode) {
  return `<div class="st-seg st-seg--mode" role="group" aria-label="Mode">
          <button type="button" data-mode="live" aria-pressed="${mode === "live"}">${mode === "live" ? `<span class="st-live-dot" aria-hidden="true"></span>` : ""}LIVE</button>
          <button type="button" data-mode="replay" aria-pressed="${mode === "replay"}">REPLAY</button>
          <button type="button" data-mode="demo" aria-pressed="${mode === "demo"}">DEMO</button>
        </div>`;
}
export function bindModeSwitch(root: HTMLElement, mode: BoardMode, onMode?: (m: BoardMode) => void) {
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-mode]")) b.addEventListener("click", () => b.dataset.mode !== mode && onMode?.(b.dataset.mode as BoardMode));
}

export function mountBoard(root: HTMLElement, log: RescueLog, controls: BoardControls) {
  const mode = controls.mode ?? "replay";
  const pooled = isPooled(log);
  const m = log.market;
  const a = log.atOpen;
  const liqCost = a ? (a.debtUsd * 0.5 * m.liqBonusBps) / 10_000 : null;
  // the stewards that run on the recording's network: mainnet runs three of the five
  const roster = log.evmChain === "ethereum" ? STEWARD_ORDER.filter((x) => x === "patient" || x === "deep" || x === "swift") : STEWARD_ORDER;
  for (const el of document.querySelectorAll<HTMLElement>('[data-status="network"]')) el.textContent = log.evmChain === "ethereum" ? "Ethereum" : "Sepolia";
  dispatchEvent(new CustomEvent("stead:net", { detail: log.evmChain === "ethereum" ? "mainnet" : "testnet" }));
  root.innerHTML = `
  <div class="st-board">
    <header class="st-annunciator" aria-label="Status" data-panel>
      <div class="st-lamps" role="list" aria-label="Phase">${LAMPS.map((l) => `<div class="st-lamp-cell" data-lamp="${l.id}" data-tone="${l.cls}" role="listitem" title="${l.id}"><span class="st-dot" aria-hidden="true"></span>${l.id}</div>`).join("")}</div>
      <div class="st-annunciator-right">
        <span class="st-chip-market${log.evmChain === "ethereum" ? " st-chip-market--real" : ""}">${esc(marketChip(log))}</span>
        ${modeSwitch(mode)}
        ${controls.replays && controls.replays.length > 1 ? watchMenu(controls.replays, controls.current, mode) : ""}
        ${mode === "replay" ? `<button type="button" class="st-push st-push--small st-cut" data-toggle><span class="st-lamp" aria-hidden="true"></span><span data-toggle-label>PLAY</span></button>` : ""}
      </div>
    </header>
    <section class="st-error st-board-warn" role="alert" data-warn hidden><h2>Do not repay on Aave directly</h2><p data-warn-text></p></section>

    <div class="st-board-grid">
      <section class="st-panel st-board-panel st-pos" aria-label="Position" data-panel>
        <div class="st-panel-head">
          <div class="st-label">POSITION ${log.positionId} · ${m.collateral}/${m.debt}</div>
          <div class="st-idline">${esc(log.borrower)}</div>
        </div>
        <div class="st-gauge-wrap">
          <div class="st-gauge" role="img" aria-label="Health factor">
            <div class="st-gauge-fill"></div>
            <div class="st-gauge-mark st-gauge-mark--target" style="bottom: 75%"></div>
            <div class="st-gauge-mark st-gauge-mark--trigger" style="bottom: 31.25%"></div>
            <div class="st-gauge-mark st-gauge-mark--trip" style="bottom: 12.5%"></div>
          </div>
          <div class="st-gauge-labels" aria-hidden="true">
            <span style="bottom: 100%">1.70</span>
            <span style="bottom: 75%">1.50 TARGET</span>
            <span class="st-gl-trigger" style="bottom: 31.25%">1.15 TRIGGER</span>
            <span class="st-gl-trip" style="bottom: 12.5%">1.00 TRIP</span>
            <span style="bottom: 0%">0.90</span>
          </div>
          <div class="st-hf-block">
            <div class="st-label">HEALTH FACTOR</div>
            <div class="st-hf" data-hf>—</div>
            <p class="st-consequence" data-consequence></p>
            <a class="st-evidence" data-hf-evidence target="_blank" rel="noopener"></a>
            <span class="st-idline" data-hf-block></span>
          </div>
        </div>
        <dl class="st-pos-facts">
          <div><dt>COLLATERAL</dt><dd data-coll>${a ? `${fmtAmt(a.collateral)} ${m.collateral}` : "—"}</dd></div>
          <div><dt>DEBT</dt><dd>${a ? a.debtUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + m.debt : "—"}</dd></div>
          <div><dt>TOP-UP TO ${log.params.targetHf.toFixed(2)}</dt><dd data-topup>—</dd></div>
          <div><dt>LIQUIDATION COST</dt><dd>${liqCost !== null ? usd(liqCost) : "—"}</dd></div>
        </dl>
        <div class="st-claim-slot" data-claim></div>
      </section>

      <section class="st-panel st-board-panel st-auction" aria-label="Auction" data-panel>
        <div class="st-auction-head">
          <div class="st-panel-head">
            <div class="st-label">RESCUE AUCTION · LOWEST PREMIUM WINS</div>
            <h2 class="st-panel-title" data-title></h2>
            <div class="st-panel-sub" data-subtitle></div>
          </div>
          <div class="st-flip" aria-label="Time left" role="timer" data-clock>
            <span class="st-flap" data-m1>0</span><span class="st-flap" data-m2>0</span><span class="st-flap st-flap--colon">:</span><span class="st-flap" data-d1>4</span><span class="st-flap" data-d2>5</span>
          </div>
        </div>
        <div class="st-ladder-head" aria-hidden="true">
          <span>#</span><span>STEWARD</span><span class="st-axis"><span>0</span><span>100</span><span>200</span><span>300 bps</span></span><span>PREMIUM</span><span>COST</span>
        </div>
        <div class="st-ladder" role="list" aria-label="Bids, lowest premium first">
          ${roster.map((s) => `<div class="st-placeholder" style="--rank:${roster.indexOf(s)}">watching</div>`).join("")}
          ${roster.map(
            (s) => `<div class="st-row" role="listitem" data-row="${s}" style="--sc: var(--st-steward-${s}); --flash-c: var(--st-steward-${s})">
              <span class="st-rank" data-rank></span>
              <span class="st-row-steward">${tile(s, 26)}<span class="st-row-name">${s}</span><span class="st-badge" data-badge></span></span>
              <span class="st-bar"><span class="st-bar-fill" data-fill></span><span class="st-bar-prev" data-prev></span></span>
              <span class="st-premium" data-bps></span>
              <span class="st-cost" data-cost></span>
            </div>`,
          ).join("")}
        </div>
        <div class="st-pipe-row" data-pipe hidden>
          <span class="st-pipe-who" data-pipe-who></span>
          <span class="st-pipe" data-pipe-bar aria-hidden="true"></span>
          <span class="st-pipe-to">position ${log.positionId}</span>
          <span class="st-pipe-label" data-pipe-label></span>
          <span class="st-pipe-tx" data-pipe-tx></span>
        </div>
      </section>

      <section class="st-panel st-board-panel st-rack" aria-label="Stewards" data-panel>
        <div class="st-rack-head st-label"><span>STEWARDS</span><span>RISK APPETITE</span></div>
        <div class="st-rack-cards">
        ${roster.map(
          (s) => `<div class="st-card" data-card="${s}" style="--sc: var(--st-steward-${s})">
            ${tile(s, 32)}
            <div class="st-card-body">
              <div class="st-card-top"><span class="st-card-name">${s}</span>
                <span class="st-risk" role="img" aria-label="Risk appetite: ${RISK_WORD[RISK[s]]}">${[1, 2, 3, 4, 5].map((i) => `<span class="st-pip${i <= RISK[s] ? " st-pip--on" : ""}"></span>`).join("")}</span>
              </div>
              <div class="st-card-rule">${RULE[s]}</div>
              <div class="st-card-status" data-status></div>
            </div>
          </div>`,
        ).join("")}
        </div>
        <p class="st-rack-note">Colour runs cool to warm with risk appetite. Anyone can register a steward; these ${roster.length === 3 ? "three run on mainnet" : "five are example strategies"}.</p>
      </section>
    </div>

    ${pooled ? poolMarkup(log) : ""}
    ${closingMarkup(log)}
    <section class="st-journal" aria-label="Journal" data-panel>
      <div class="st-journal-head">${mode === "live" ? `JOURNAL · LIVE · ${controls.delayS ?? 6} S BEHIND THE CHAIN` : mode === "demo" ? `JOURNAL · DEMO · STARTED FROM THIS PAGE · ${controls.delayS ?? 6} S BEHIND THE CHAIN` : "JOURNAL · REPLAY OF A RECORDED RESCUE"} · ${esc(log.label.toUpperCase())}</div>
      <div class="st-journal-lines" data-journal data-theme="dark"></div>
    </section>
  </div>`;

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  // the board's panels power on once a session, after first paint (its figures are live, so none roll)
  requestAnimationFrame(() => powerOn(root));
  root.querySelector("[data-toggle]")?.addEventListener("click", controls.onToggle);
  bindModeSwitch(root, mode, controls.onMode);
  root.querySelector<HTMLSelectElement>("[data-pick-menu]")?.addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (id !== controls.current) controls.onPick?.(id);
  });
  const poolState = { fell: new Map<string, number>(), tagKey: "" };
  const closeState = { key: "" };
  const open = log.events.find((e) => e.kind === "AUCTION_OPEN") as any;
  q("[data-topup]").textContent = open ? `${fmtAmt(open.topUp.amount)} ${open.topUp.asset}` : "—";

  let lastClock = -1;
  let lastJournal = -1;
  let lastClaim = "";
  const flashed = new Map<StewardId, number>();

  return {
    setPlaying(playing: boolean, ended: boolean) {
      if (mode !== "replay") return;
      q("[data-toggle-label]").textContent = playing ? "PAUSE" : ended ? "REPLAY AGAIN" : "PLAY";
      q("[data-toggle]").setAttribute("aria-pressed", String(playing));
    },
    update(b: Board) {
      for (const l of LAMPS) q(`[data-lamp="${l.id}"]`).classList.toggle("is-lit", b.lamps[l.id]);

      // health factor
      const fill = q(".st-gauge-fill");
      if (b.hf === null) {
        fill.style.height = "0%";
        q("[data-hf]").textContent = "—";
        q("[data-consequence]").textContent = "";
      } else {
        fill.style.height = pct(b.hf) + "%";
        fill.classList.toggle("is-below", b.below);
        const hfEl = q("[data-hf]");
        hfEl.textContent = b.hf.toFixed(2);
        hfEl.classList.toggle("is-below", b.below);
        q(".st-gauge").setAttribute("aria-label", `Health factor ${b.hf.toFixed(2)}`);
        q("[data-consequence]").innerHTML = `${m.collateral} can fall <strong>${consequence(b.hf)}%</strong> before liquidation.`;
      }
      const ev = q<HTMLAnchorElement>("[data-hf-evidence]");
      if (b.hfEvidence) {
        ev.hidden = false;
        ev.href = b.hfEvidence.url;
        ev.className = `st-evidence st-evidence--${b.hfEvidence.mark}`;
        ev.innerHTML = `<span class="st-evidence-mark" aria-hidden="true"></span>${b.hfEvidence.mark === "proven" ? `PROVEN · ${b.hfEvidence.rpcs ?? ""} RPC` : b.hfEvidence.mark === "reported" ? `REPORTED · ${b.hfEvidence.reporter}` : "FORK · UNVERIFIED"}`;
        ev.title = b.hfEvidence.mark === "proven" ? `${b.hfEvidence.rpcs} RPCs agreed on this reading` : "";
        q("[data-hf-block]").textContent = b.hfEvidence.block ? `block ${b.hfEvidence.block.toLocaleString("en-US")}` : "";
      } else {
        ev.hidden = true;
        q("[data-hf-block]").textContent = "";
      }

      // collateral: the proven amount after the top-up, else the amount at the opening
      q("[data-coll]").textContent = b.collateral ? `${fmtAmt(b.collateral)} ${m.collateral}` : a ? `${fmtAmt(a.collateral)} ${m.collateral}` : "—";

      // settlement running: the warning stays up until it ends
      const warn = q("[data-warn]") as HTMLElement;
      if (warn.hidden !== !b.warning) warn.hidden = !b.warning;
      if (b.warning && q("[data-warn-text]").textContent !== b.warning) q("[data-warn-text]").textContent = b.warning;

      // auction head
      q("[data-title]").textContent = b.title;
      q("[data-subtitle]").textContent = b.subtitle;
      if (b.clock !== lastClock) {
        // minutes and seconds: a mainnet auction runs 120 s, so "80" must read 01:20
        const s = clockDigits(b.clock);
        ["[data-m1]", "[data-m2]", "[data-d1]", "[data-d2]"].forEach((sel, i) => {
          const d = q(sel);
          if (d.textContent !== s[i]) flip(d, s[i]);
        });
        lastClock = b.clock;
      }

      // ladder
      const anyBid = b.rows.some((r) => r.bps !== null);
      root.querySelector(".st-ladder")!.classList.toggle("has-bids", anyBid);
      for (const r of b.rows) {
        const el = root.querySelector<HTMLElement>(`[data-row="${r.steward}"]`);
        if (!el) continue;
        el.style.setProperty("--rank", String(r.rank ?? 4)); // top = rank × the CSS row pitch
        el.classList.toggle("is-in", r.bps !== null);
        el.classList.toggle("is-first", r.rank === 0);
        el.classList.toggle("is-won", r.badge === "WON");
        el.querySelector("[data-rank]")!.textContent = r.rank !== null ? String(r.rank + 1) : "";
        const badge = el.querySelector<HTMLElement>("[data-badge]")!;
        const kind = r.badge.toLowerCase();
        if (badge.dataset.kind !== kind) {
          if (r.badge === "WON") badge.innerHTML = crown(r.steward, [["Premium", `${r.bps} bps`], ...(r.cost !== null ? ([["Cost", `$${r.cost.toFixed(2)}`]] as [string, string][]) : [])], 15);
          else badge.textContent = r.badge;
          badge.dataset.kind = kind;
        }
        el.querySelector<HTMLElement>("[data-fill]")!.style.width = r.bps !== null ? `${Math.min(100, r.bps / 3)}%` : "0%";
        const prev = el.querySelector<HTMLElement>("[data-prev]")!;
        prev.style.left = `${Math.min(100, (r.prevBps ?? r.bps ?? 0) / 3)}%`;
        prev.hidden = r.prevBps === null;
        el.querySelector("[data-bps]")!.textContent = r.bps !== null ? `${r.bps} bps` : "";
        el.querySelector("[data-cost]")!.textContent = r.cost !== null ? usd(r.cost) : "";
        // a new bid flashes once (shakes too if late); keyed by the bid's time so a replay restarts it
        if (r.fresh && r.bidT !== null && flashed.get(r.steward) !== r.bidT) {
          flashed.set(r.steward, r.bidT);
          el.classList.remove("is-fresh", "is-late");
          void el.offsetWidth;
          el.classList.add(r.late ? "is-late" : "is-fresh");
        }
        if (r.bidT === null) flashed.delete(r.steward);
      }

      // feed pipe
      const pipe = q("[data-pipe]");
      if (b.pipe) {
        pipe.hidden = false;
        q("[data-pipe-who]").innerHTML = `${tile(b.pipe.steward, 22)}${b.pipe.steward}`;
        const bar = q("[data-pipe-bar]");
        bar.style.setProperty("--sc", `var(--st-steward-${b.pipe.steward})`);
        bar.classList.toggle("is-flowing", b.pipe.flowing);
        bar.classList.toggle("is-done", b.pipe.done);
        q("[data-pipe-label]").textContent = `${b.pipe.done ? "SUPPLIED" : b.pipe.flowing ? "SUPPLYING" : "TO SUPPLY"} ${fmtAmt(b.pipe.amount)} ${b.pipe.asset}`;
        const sentTx = b.topups.find((x) => x.steward === b.pipe!.steward)?.tx ?? null;
        const txEl = q("[data-pipe-tx]");
        const txKey = sentTx ? `${sentTx.tx}:${b.pipe.done}` : "";
        if (txEl.dataset.key !== txKey) {
          txEl.dataset.key = txKey;
          txEl.innerHTML = sentTx ? `<span>${b.pipe.done ? "Funded, proven on chain" : "Funding sent"}: ${b.pipe.steward}'s supply on Aave</span>${txLink(sentTx)}` : "";
        }
      } else pipe.hidden = true;

      // steward rack
      for (const c of b.stewards) {
        const el = root.querySelector<HTMLElement>(`[data-card="${c.steward}"]`);
        if (!el) continue; // a steward that doesn't run on this recording's network
        el.classList.toggle("is-bidding", c.bidding);
        el.classList.toggle("is-won", c.won);
        const st = el.querySelector<HTMLElement>("[data-status]")!;
        st.textContent = c.status;
        st.classList.toggle("is-blink", c.bidding);
      }

      // claim (lockout tag)
      const key = b.claim ? `${b.claim.id}|${b.claim.closed}|${b.claim.windowLeft}|${!!b.settlement}|${b.window?.paidIn ?? ""}|${b.window?.proven ?? ""}` : "";
      if (key !== lastClaim) {
        const slot = q("[data-claim]");
        const wasOpen = lastClaim.includes("|false|");
        lastClaim = key;
        if (!b.claim) slot.innerHTML = "";
        else if (b.claim.closed) {
          slot.innerHTML = `<p class="st-claim-closed">Claim <span class="st-mono">${esc(b.claim.id)}</span> ${b.claim.closedText}. Withdrawals unlocked.</p>`;
        } else {
          const mm = String(Math.floor(b.claim.windowLeft / 60)).padStart(2, "0");
          const ss = String(b.claim.windowLeft % 60).padStart(2, "0");
          const tag = slot.querySelector(".st-tag");
          const html = `
              <div class="st-tag-top">${tile(b.claim.holder, 22)}<span class="st-tag-title">LOCKED OUT · CLAIM <span class="st-mono">${esc(b.claim.id)}</span></span></div>
              <div class="st-tag-lines">Owed to ${b.claim.holder}: ${b.claim.owed} ${b.claim.asset} + ${b.claim.premium} ${b.claim.asset} premium<br>${b.settlement ? "Settling at the oracle price" : `Withdrawals locked on position ${log.positionId} until buy-back`}${b.window?.paidIn ? `<br>Borrower paid ${b.window.paidIn} in${b.window.proven ? ", proven" : " · waiting for its proof"}` : ""}</div>
              ${b.settlement ? "" : `<div class="st-tag-window"><span>BUY-BACK WINDOW</span><span class="st-tag-count">${mm}:${ss}</span></div>`}`;
          if (tag && wasOpen) tag.innerHTML = html;
          else slot.innerHTML = `<div class="st-tag st-cut st-cut--l">${html}</div>`;
        }
      }

      if (pooled) updatePool(root, log, b, poolState);
      updateClosing(root, log, b, closeState);

      // journal (newest first)
      if (b.journal.length !== lastJournal) {
        lastJournal = b.journal.length;
        q("[data-journal]").innerHTML = b.journal
          .map(
            (l) => `<div class="st-jline"><span class="st-jtime">${clockText(log.openedAtMs + l.t * 1000)}</span><span class="st-jkind" data-tone="${l.tone}">${l.kind}</span><span class="st-jtext">${
              l.evidence ? `<a href="${l.evidence.url}" target="_blank" rel="noopener">${esc(l.text)}</a>` : esc(l.text)
            }</span></div>`,
          )
          .join("") || `<div class="st-jline st-jline--quiet">${mode !== "replay" ? `Rescue ${log.rescueId} opened. Events appear here as the chains record them.` : `Press PLAY to replay rescue ${log.rescueId} from its recorded events.`}</div>`;
      }
    },
  };
}

function flip(el: HTMLElement, ch: string) {
  el.textContent = ch;
  el.classList.remove("st-flip-a", "st-flip-b");
  void el.offsetWidth;
  el.classList.add(el.dataset.f === "a" ? "st-flip-b" : "st-flip-a");
  el.dataset.f = el.dataset.f === "a" ? "b" : "a";
}

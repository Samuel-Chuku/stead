/* Stead ambience: market field, power-on, number roll.
   Vanilla ES module, no dependencies. Reads colours from the --st-* tokens.
   Every effect is skipped or frozen under prefers-reduced-motion. */

const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/* ------------------------------------------------------------------ */
/* 1. Market field                                                     */
/*    Every glyph is a simulated Aave position. Slow price waves move  */
/*    across the field and push health factors down. A glyph that     */
/*    crosses the trigger flashes amber, gets bracketed (a steward     */
/*    caught it), and its health resets to the 1.50 target. The        */
/*    pointer adds pressure: nearby positions drift toward the trigger */
/*    and get caught by the same rule.                                 */
/* ------------------------------------------------------------------ */
const TRIGGER = 1.15, TARGET = 1.5;
const BANDS = [ // [min HF, glyph, alpha]. Safe positions draw nothing: the field is
  [2.0, '', 0],    // mostly empty, and only pressure shows up, as fronts that move.
  [1.7, '·', 0.16],
  [1.45, ':', 0.24],
  [1.25, '+', 0.34],
  [1.15, '×', 0.46],
  [0, '#', 0.6],
];

export function mountMarketField(canvas, opts = {}) {
  const o = { cell: 15, fps: 24, lens: 120, onRescue: null, ...opts };
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, cols = 0, rows = 0, cells = [], dpr = 1;
  let mouse = { x: -9999, y: -9999, on: false };
  let raf = 0, last = 0, t = 0, running = false, visible = true;
  let colors = {};

  const readColors = () => {
    colors = {
      ink: css('--st-ink', '#1D1F1C'),
      amber: css('--st-exposure', '#E9A93A'),
      ground: css('--st-ground', '#C9CFC3'),
      font: css('--st-font-mono', 'ui-monospace, monospace'),
    };
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const build = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / o.cell); rows = Math.ceil(h / o.cell);
    cells = new Array(cols * rows).fill(0).map(() => ({
      h0: rand(1.35, 2.6),      // health with no price move
      k: rand(0.6, 1.4),        // how hard price moves hit this position
      caught: 0,                // seconds left showing the bracket
      flash: 0,                 // seconds left of amber
      hf: 2,
      p: 0,                     // pointer pressure, 0..1: the cursor is a local price drop
    }));
  };

  // Two slow fronts plus a ripple: a price path that travels across the market.
  const price = (x, y, t) =>
    0.6 * Math.sin(x * 0.06 - t * 0.35 + Math.sin(y * 0.05 + t * 0.1)) +
    0.35 * Math.sin((x + y) * 0.03 + t * 0.22) +
    0.10 * Math.sin(x * 0.4 + y * 0.31 + t * 1.3);

  let cooldown = 0;
  const step = (dt) => {
    const atRisk = [], pressed = [];
    // Pointer pressure: positions near the cursor drift toward the trigger over about a second,
    // and drift back once it leaves. The catch rule below is unchanged, so they get caught the same way.
    const R = o.lens, R2 = R * R;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const c = cells[j * cols + i];
      let near = 0;
      if (mouse.on && dt > 0) {
        const dx = i * o.cell + o.cell / 2 - mouse.x, dy = j * o.cell + o.cell / 2 - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < R2) near = 1 - Math.sqrt(d2) / R;
      }
      c.p += near > c.p ? Math.min(near - c.p, dt * 0.9) : -Math.min(c.p, dt * 0.45);
      if (c.caught > 0) { c.caught -= dt; c.flash -= dt; continue; }
      c.hf = c.h0 * (1 - 0.34 * c.k * Math.max(0, price(i, j, t))) * (1 - 0.3 * c.p);
      if (c.hf < TRIGGER) { atRisk.push(j * cols + i); if (c.p > 0.25) pressed.push(j * cols + i); }
      c.h0 += (rand(1.35, 2.6) - c.h0) * 0.0004; // slow drift so the market never settles
    }
    // Stewards catch one position at a time, a few per second at most: never a strobe. Positions
    // pushed under by the pointer are caught first, a little faster.
    cooldown -= dt;
    if (dt > 0 && cooldown <= 0 && atRisk.length) {
      const pool = pressed.length ? pressed : atRisk;
      const idx = pool[Math.floor(Math.random() * pool.length)], c = cells[idx];
      c.flash = 0.35; c.caught = 1.8;
      c.h0 = Math.max(c.h0, TARGET / (1 - 0.34 * c.k) + 0.02); // topped up to the target
      c.hf = TARGET;
      cooldown = pressed.length ? rand(0.25, 0.5) : rand(0.35, 0.9);
      o.onRescue && o.onRescue({ col: idx % cols, row: Math.floor(idx / cols) });
    }
  };

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = `500 ${Math.round(o.cell * 0.68)}px ${colors.font}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const L = o.lens, L2 = L * L;
    let hover = null;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const c = cells[j * cols + i];
      const x = i * o.cell + o.cell / 2, y = j * o.cell + o.cell / 2;
      let lens = 0;
      if (mouse.on) {
        const dx = x - mouse.x, dy = y - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < L2) lens = 1 - Math.sqrt(d2) / L;
        if (Math.abs(dx) <= o.cell / 2 && Math.abs(dy) <= o.cell / 2) hover = c;
      }
      if (c.caught > 0) {
        const a = Math.min(1, c.caught / 0.4);
        ctx.globalAlpha = 0.55 * a;
        ctx.fillStyle = c.flash > 0 ? colors.amber : colors.ink;
        ctx.fillText(c.flash > 0 ? '#' : '·', x, y);
        ctx.fillStyle = colors.ink;
        ctx.globalAlpha = 0.6 * a;
        ctx.fillText('[', x - o.cell * 0.42, y); ctx.fillText(']', x + o.cell * 0.42, y);
        continue;
      }
      let b = BANDS.find(([min]) => c.hf >= min);
      if (!b[1]) { if (lens > 0.35) { ctx.globalAlpha = lens * 0.18; ctx.fillStyle = colors.ink; ctx.fillText('·', x, y); } continue; }
      ctx.globalAlpha = Math.min(0.9, b[2] + lens * 0.5);
      ctx.fillStyle = colors.ink;
      ctx.fillText(b[1], x, y);
    }
    ctx.globalAlpha = 1;
    // cursor readout: the position under the pointer
    if (hover && mouse.on) {
      const label = hover.caught > 0 ? 'RESCUED · HF 1.50' : `HF ${hover.hf.toFixed(2)}`;
      ctx.font = `600 11px ${css('--st-font-head', 'sans-serif')}`;
      const tw = ctx.measureText(label).width + 14;
      const lx = Math.min(mouse.x + 14, w - tw - 4), ly = Math.max(mouse.y - 28, 4);
      ctx.fillStyle = colors.ink; ctx.fillRect(lx, ly, tw, 20);
      ctx.fillStyle = colors.ground; ctx.textAlign = 'left';
      ctx.fillText(label, lx + 7, ly + 10.5);
    }
  };

  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (now - last < 1000 / o.fps) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    t += dt; step(dt); draw();
  };
  const start = () => { if (running || reduce()) return; running = true; last = performance.now(); raf = requestAnimationFrame(loop); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };

  // pressure only where the field shows: not through an opaque panel set on top of it (the replay)
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    const over = e.target instanceof Element ? e.target.closest('.st-panel') : null;
    mouse = { x: e.clientX - r.left, y: e.clientY - r.top, on: !over || over === host };
  };
  const onLeave = () => { mouse.on = false; };
  const host = canvas.parentElement;
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);
  // start mid-market, not from a blank state (also after a resize rebuilds the grid, so the
  // reduced-motion still frame is never empty)
  const warm = () => { for (let k = 0; k < 40; k++) { t += 0.05; step(0); } };
  const ro = new ResizeObserver(() => { build(); warm(); draw(); }); ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible && !document.hidden ? start() : stop(); }); io.observe(canvas);
  const onVis = () => (document.hidden || !visible ? stop() : start());
  document.addEventListener('visibilitychange', onVis);
  const mo = new MutationObserver(() => { readColors(); draw(); }); // theme switch
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  readColors(); build(); warm();
  draw(); start();

  return () => { stop(); ro.disconnect(); io.disconnect(); mo.disconnect(); document.removeEventListener('visibilitychange', onVis); host.removeEventListener('pointermove', onMove); host.removeEventListener('pointerleave', onLeave); };
}

/* ------------------------------------------------------------------ */
/* 2. Power-on: panels come up like a panel of instrument lamps        */
/*    (a short tube-light flicker), in reading order, once a session.  */
/* ------------------------------------------------------------------ */
export function powerOn(root = document, { force = false } = {}) {
  const panels = [...root.querySelectorAll('[data-panel]')];
  let seen = false;
  try { seen = sessionStorage.getItem('st-powered') === '1'; sessionStorage.setItem('st-powered', '1'); } catch (e) {}
  if (reduce() || (seen && !force)) { rollNumbers(root, { instant: true }); return; }
  panels.forEach((p, i) => {
    p.style.animation = `st-power 420ms steps(1, end) ${i * 70}ms both`;
    p.addEventListener('animationend', () => { p.style.animation = ''; }, { once: true });
  });
  setTimeout(() => rollNumbers(root), Math.min(panels.length, 6) * 70 + 200);
}

/* ------------------------------------------------------------------ */
/* 3. Number roll: digits spin and settle left to right, the way a     */
/*    mechanical counter catches up. Non-digits never move.            */
/* ------------------------------------------------------------------ */
export function rollNumbers(root = document, { instant = false, selector = '[data-roll]' } = {}) {
  root.querySelectorAll(selector).forEach((el) => {
    const final = el.dataset.roll || el.textContent;
    el.dataset.roll = final;
    if (instant || reduce()) { el.textContent = final; return; }
    const chars = [...final];
    const settle = chars.map((ch, i) => 260 + i * 70 + Math.random() * 80);
    const t0 = performance.now();
    const tick = (now) => {
      const e = now - t0; let done = true;
      el.textContent = chars.map((ch, i) => {
        if (!/\d/.test(ch) || e >= settle[i]) return ch;
        done = false; return String((Math.floor(e / 45) + i * 3) % 10);
      }).join('');
      if (!done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* Re-roll a number when it scrolls into view for the first time. */
export function rollOnView(root = document) {
  if (reduce()) return;
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { rollNumbers(e.target.parentElement || e.target); io.unobserve(e.target); }
  }), { threshold: 0.6 });
  root.querySelectorAll('[data-roll-view]').forEach((el) => io.observe(el));
}

/* ------------------------------------------------------------------ */
/* 4. Glyph mark: the Cradle mark drawn in characters, for one large   */
/*    moment on the page (the footer or the "how it works" header).    */
/*    The rails are steady box glyphs; the held position (the disc)    */
/*    churns, because it is the thing that moves with the market.      */
/* ------------------------------------------------------------------ */
const MARK_PATH = 'M7 14 V39 H41 V14';
export function mountGlyphMark(canvas, opts = {}) {
  const o = { cell: 10, fps: 14, ...opts };
  const ctx = canvas.getContext('2d');
  const CHURN = '#%&@$*+=';
  let w, h, cols, rows, mask = [], raf = 0, last = 0, t = 0, dpr = 1, mouse = { x: -1e4, y: -1e4 };
  const build = () => {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2); w = r.width; h = r.height;
    canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.floor(w / o.cell); rows = Math.floor(h / o.cell);
    // rasterise the mark at grid resolution: 1 = rail, 2 = disc
    const off = document.createElement('canvas'); off.width = cols; off.height = rows;
    const g = off.getContext('2d'); const s = Math.min(cols, rows * 1.0) / 48; // cells are square
    g.translate((cols - 48 * s) / 2, (rows - 48 * s) / 2); g.scale(s, s);
    g.strokeStyle = '#f00'; g.lineWidth = 5.5; g.stroke(new Path2D(MARK_PATH));
    g.lineWidth = 3; g.stroke(new Path2D('M2 14 H12 M36 14 H46'));
    g.fillStyle = '#0f0'; g.beginPath(); g.arc(24, 24, 8, 0, Math.PI * 2); g.fill();
    const d = g.getImageData(0, 0, cols, rows).data; mask = [];
    for (let k = 0; k < cols * rows; k++) mask[k] = d[k * 4 + 1] > 120 ? 2 : d[k * 4] > 120 ? 1 : 0;
  };
  const draw = () => {
    const ink = css('--st-ink', '#1D1F1C');
    ctx.clearRect(0, 0, w, h);
    ctx.font = `500 ${Math.round(o.cell * 0.9)}px ${css('--st-font-mono', 'monospace')}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = ink;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const m = mask[j * cols + i], x = i * o.cell + o.cell / 2, y = j * o.cell + o.cell / 2;
      const dx = x - mouse.x, dy = y - mouse.y, lens = Math.max(0, 1 - Math.hypot(dx, dy) / 140);
      if (m === 1) { ctx.globalAlpha = 0.55 + lens * 0.4; ctx.fillText('=', x, y); }
      else if (m === 2) { ctx.globalAlpha = 0.5 + lens * 0.45; ctx.fillText(CHURN[(i * 7 + j * 13 + Math.floor(t * 6 + (i ^ j))) % CHURN.length], x, y); }
      else if (lens > 0) { ctx.globalAlpha = lens * 0.12; ctx.fillText('·', x, y); }
    }
    ctx.globalAlpha = 1;
  };
  const loop = (now) => { raf = requestAnimationFrame(loop); if (now - last < 1000 / o.fps) return; t += (now - last) / 1000; last = now; draw(); };
  const host = canvas.parentElement;
  const onMove = (e) => { const r = canvas.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onLeave = () => { mouse = { x: -1e4, y: -1e4 }; };
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);
  const ro = new ResizeObserver(() => { build(); draw(); }); ro.observe(canvas);
  build(); draw();
  let io = null;
  if (!reduce()) {
    io = new IntersectionObserver(([e]) => { cancelAnimationFrame(raf); if (e.isIntersecting) { last = performance.now(); raf = requestAnimationFrame(loop); } });
    io.observe(canvas);
  }
  // cleanup, for pages that unmount (the same pattern as the field's)
  return () => { cancelAnimationFrame(raf); ro.disconnect(); io && io.disconnect(); host.removeEventListener('pointermove', onMove); host.removeEventListener('pointerleave', onLeave); };
}

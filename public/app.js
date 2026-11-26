// Win probability page. One chart per matchup, showing the first team's win %.
const GAP_SECONDS = 30 * 60; // quiet stretches longer than this get squeezed
const GAP_WIDTH = 10 * 60; // ...down to this much horizontal room
const FLAT_EPS = 0.0005; // win-prob changes smaller than 0.05 points count as "flat"
const JUMP = 0.02; // steps of 2+ points are real swings and stay sharp
const VIEW_KEY = 'winprob.view';
const REFRESH_MS = 15000; // live refresh; easy on a small server with many viewers
const EVENT_HOVER_PX = 10; // hovering this close to a swing dot shows its story
const PANEL_W = 260;

const { css, matchupColors, alpha } = window.TeamColors;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
const fmtFull = (ts) => `${fmtDay(ts)} ${new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
// Win % as shown. 100% and 0% are kept for matchups that are actually over
// (no projected points left on either side); before that a near-certain result
// reads like "99.6" / "0.4", because one late TD can still move it.
function winNum(p, over) {
  const n = Math.round(p * 100);
  if (over) return String(n);
  // Above 99% or below 1%: one decimal, never rounded all the way to 100.0 / 0.0.
  if (p > 0.99) return Math.min(99.9, Math.round(p * 1000) / 10).toFixed(1);
  if (p < 0.01) return Math.max(0.1, Math.round(p * 1000) / 10).toFixed(1);
  return String(n);
}
const isOver = (ap, bp, aproj, bproj) => Math.abs(aproj - ap) < 0.05 && Math.abs(bproj - bp) < 0.05;
const pct = (p, over = true) => `${winNum(p, over)}%`;
const L = () => window.Looks.chart();
let lastData = null;

/** Pull a team color part of the way toward the look's ink (Paper's "printed" lines). */
function inked(hex, t) {
  if (!t) return hex;
  const ink = css('--ink');
  const n1 = parseInt(hex.slice(1), 16);
  const n2 = parseInt(ink.slice(1), 16);
  const ch = (n, sh) => (n >> sh) & 255;
  const mixc = (sh) => Math.round(ch(n1, sh) * (1 - t) + ch(n2, sh) * t);
  return '#' + [16, 8, 0].map((sh) => mixc(sh).toString(16).padStart(2, '0')).join('');
}

/** Apply the active look to a chart's static options (fonts, grid, line). */
function styleChart(chart) {
  const look = L();
  Chart.defaults.font.family = look.font;
  const font = { family: look.font, size: look.fontSize, weight: look.fontWeight };
  const sx = chart.options.scales.x;
  const sy = chart.options.scales.y;
  sx.border.color = css('--axis');
  sx.ticks.color = css('--muted');
  sx.ticks.font = font;
  sx.ticks.autoSkipPadding = 18; // wide fonts (Doto) need room between time labels
  sx.ticks.includeBounds = false; // no extra label jammed against the last one at the edge
  sy.ticks.color = css('--muted');
  sy.ticks.font = font;
  sy.grid.display = look.gridLines;
  sy.grid.color = css('--grid');
  const line = chart.data.datasets[2];
  line.borderWidth = look.lineWidth;
  line.borderDash = look.dash;
  // Teletext draws chunky square steps; everything else a smooth curve.
  line.stepped = look.stepped ? 'middle' : false;
  line.cubicInterpolationMode = look.stepped ? 'default' : 'monotone';
  line.borderJoinStyle = look.join || 'round';
  line.borderCapStyle = look.cap || 'round';
  const dots = chart.data.datasets[1];
  dots.pointBorderWidth = 2;
  dots.pointStyle = look.pointStyle || 'circle';
}

// Riso: shade with a halftone dot screen in the team's ink instead of a flat tint.
const halftones = new Map();
function halftone(hex) {
  if (!halftones.has(hex)) {
    const c = document.createElement('canvas');
    c.width = c.height = 6;
    const g = c.getContext('2d');
    g.fillStyle = alpha(hex, 0.55);
    g.beginPath();
    g.arc(3, 3, 1.25, 0, Math.PI * 2);
    g.fill();
    halftones.set(hex, g.createPattern(c, 'repeat'));
  }
  return halftones.get(hex);
}
const shade = (hex) => (L().halftone ? halftone(hex) : alpha(hex, L().fillAlpha));

let weeks = [];
let current = null; // { season, week }
let view = readView(); // 'game' (Gametime) or 'week' (Whole week)
const charts = new Map(); // matchup_id -> { chart, els }
let lastTs = null;
const panel = $('hover-panel');
const avatarById = new Map(); // roster_id -> Sleeper avatar hash

// ---- Avatar bubbles ------------------------------------------------------
function avatarUrl(who) {
  if (!who) return null;
  if (who.pos === 'DEF') return `https://sleepercdn.com/images/team_logos/nfl/${String(who.player_id).toLowerCase()}.png`;
  if (who.pos === 'TEAM') {
    const a = avatarById.get(who.roster_id);
    return a ? `https://sleepercdn.com/avatars/thumbs/${a}` : null;
  }
  return `https://sleepercdn.com/content/nfl/players/thumb/${who.player_id}.jpg`;
}

/** Round avatar in the team's color; falls back to a plain colored dot. */
function bubbleHtml(e, size) {
  const url = avatarUrl(e.who);
  const style = `--ring:${e.color};width:${size}px;height:${size}px`;
  if (!url) return `<span class="bubble no-photo" style="${style}"></span>`;
  const headshot = !['DEF', 'TEAM'].includes(e.who.pos);
  return `<span class="bubble${headshot ? ' headshot' : ''}" style="${style}" title="${esc(e.who.name || '')}"><img src="${url}" alt="" loading="lazy"
    onerror="this.parentNode.classList.add('empty');this.remove()"></span>`;
}

function readView() {
  try { return localStorage.getItem(VIEW_KEY) === 'week' ? 'week' : 'game'; } catch { return 'game'; }
}
function saveView(v) {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window etc. */ }
}

/**
 * Smooth the staircase the game clock creates without blunting real swings.
 * The win % sits flat between ESPN clock refreshes, then drops a notch. Draw
 * through the middle of each flat stretch instead, but where two stretches
 * differ by JUMP or more keep both edges, so a TD stays a sharp jump.
 */
function smoothLine(series, xs) {
  const runs = [];
  for (let i = 0; i < series.length; ) {
    let j = i;
    while (j + 1 < series.length && Math.abs(series[j + 1][1] - series[i][1]) < FLAT_EPS) j++;
    runs.push({ i, j, v: series[i][1] * 100 });
    i = j + 1;
  }
  const pts = [];
  const push = (x, y) => {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - x) < 1e-9) last.y = y;
    else pts.push({ x, y });
  };
  runs.forEach((r, k) => {
    const prev = runs[k - 1];
    const next = runs[k + 1];
    const sharpIn = !prev || Math.abs(r.v - prev.v) >= JUMP * 100;
    const sharpOut = !next || Math.abs(next.v - r.v) >= JUMP * 100;
    if (sharpIn) push(xs[r.i], r.v);
    push((xs[r.i] + xs[r.j]) / 2, r.v);
    if (sharpOut) push(xs[r.j], r.v);
  });
  return pts;
}

// Hover reads the exact (hidden) series: nearest raw point by x.
Chart.Interaction.modes.raw = (chart, e) => {
  const meta = chart.getDatasetMeta(0);
  if (!meta.data.length) return [];
  const pos = Chart.helpers.getRelativePosition(e, chart);
  const i = nearestIndex(meta.data, pos.x, (el) => el.x);
  return [{ element: meta.data[i], datasetIndex: 0, index: i }];
};

/** Squeeze long quiet gaps so game windows sit side by side. */
function compress(series) {
  const xs = [];
  const gaps = [];
  let x = 0;
  for (let i = 0; i < series.length; i++) {
    if (i > 0) {
      const dt = series[i][0] - series[i - 1][0];
      if (dt > GAP_SECONDS) {
        gaps.push({ x: x + GAP_WIDTH / 2, ts: series[i][0] });
        x += GAP_WIDTH;
      } else x += dt;
    }
    xs.push(x);
  }
  return { xs, gaps };
}

function nearestIndex(arr, v, get = (a) => a) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) < v) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(get(arr[lo - 1]) - v) < Math.abs(get(arr[lo]) - v)) lo--;
  return lo;
}

// Day dividers at squeezed gaps, the 50% line, and the hover crosshair.
const overlayPlugin = {
  id: 'overlay',
  beforeDatasetsDraw(chart) {
    const st = chart.$state;
    if (!st) return;
    const { ctx, chartArea, scales } = chart;
    const look = L();
    ctx.save();
    // Scoreboard: a panel of unlit bulbs behind the chart.
    if (look.dotGrid) {
      ctx.fillStyle = css('--grid');
      for (let y = chartArea.top + 3; y < chartArea.bottom; y += 7) {
        for (let x = chartArea.left + 3; x < chartArea.right; x += 7) ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    ctx.strokeStyle = css('--axis');
    ctx.fillStyle = css('--muted');
    ctx.lineWidth = 1;
    ctx.font = `${look.fontWeight} 11px ${look.font}`;
    // Whole week: faint band behind each game window.
    ctx.fillStyle = alpha(css('--ink-2'), 0.07);
    for (const [a, b] of st.bands) {
      const x1 = scales.x.getPixelForValue(a);
      const x2 = scales.x.getPixelForValue(b);
      ctx.fillRect(x1, chartArea.top, Math.max(2, x2 - x1), chartArea.bottom - chartArea.top);
    }
    ctx.fillStyle = css('--muted');
    ctx.setLineDash([3, 3]);
    for (const g of st.gaps) {
      const px = scales.x.getPixelForValue(g.x);
      ctx.beginPath();
      ctx.moveTo(px, chartArea.top);
      ctx.lineTo(px, chartArea.bottom);
      ctx.stroke();
      const label = fmtDay(g.ts);
      ctx.fillText(look.upperTicks ? label.toUpperCase() : label, px + 4, chartArea.top + 10);
    }
    ctx.setLineDash(look.midDash);
    ctx.lineCap = 'round';
    ctx.lineWidth = look.dotGrid ? 2.5 : 1;
    const y50 = scales.y.getPixelForValue(50);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y50);
    ctx.lineTo(chartArea.right, y50);
    ctx.stroke();
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const { ctx, chartArea } = chart;
    // Drag-to-zoom: shade the stretch being selected.
    const sel = chart.$state && chart.$state.select;
    if (sel) {
      const x1 = Math.max(chartArea.left, Math.min(sel[0], sel[1]));
      const x2 = Math.min(chartArea.right, Math.max(sel[0], sel[1]));
      ctx.save();
      ctx.fillStyle = alpha(css('--ink-2'), 0.14);
      ctx.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
      ctx.strokeStyle = css('--ink-2');
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x1 + 0.5, chartArea.top + 0.5, x2 - x1 - 1, chartArea.bottom - chartArea.top - 1);
      ctx.restore();
    }
    const active = chart.tooltip && chart.tooltip.getActiveElements().filter((a) => a.datasetIndex === 0);
    if (active && active.length) {
      const x = active[0].element.x;
      ctx.save();
      ctx.strokeStyle = css('--ink-2');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    }
  },
};

/** Hover readout that sits beside the card, never under the cursor. In the large view it fills the side column. */
function externalTooltip({ chart, tooltip }) {
  const st = chart.$state;
  const point = (tooltip.dataPoints || []).find((d) => d.datasetIndex === 0);
  const readout = chart.canvas.closest('#detail') && chart.canvas.closest('.card').querySelector('.detail-readout');
  if (!tooltip.opacity || !point || !st || st.select) {
    if (readout) clearReadout(readout);
    else if (panel.dataset.owner === String(st && st.id)) panel.hidden = true;
    return;
  }
  const [ts, p, ap, bp, aproj, bproj] = st.series[point.dataIndex];
  const px = point.element.x;
  const nearby = st.events.filter((e) => Math.abs(chart.scales.x.getPixelForValue(e.x) - px) <= EVENT_HOVER_PX);
  const over = isOver(ap, bp, aproj, bproj);
  const row = (name, color, prob, pts, proj) => `
    <div class="hp-row"><span class="swatch" style="background:${color}"></span><span class="hp-name">${esc(name)}</span>
    <b>${pct(prob, over)}</b></div><div class="hp-sub">${pts.toFixed(2)} pts · proj ${proj.toFixed(1)}</div>`;
  const html = `
    <div class="hp-time">${fmtFull(ts)}</div>
    ${row(st.a, st.colors.a, p, ap, aproj)}
    ${row(st.b, st.colors.b, 1 - p, bp, bproj)}
    ${nearby.map((e) => `<div class="hp-event">${bubbleHtml(e, 32)}
      <div><b>+${Math.round(e.delta * 100)}% ${esc(e.team)}</b><div>${esc(e.text)}</div><div class="hp-sub">${fmtFull(e.ts)}</div></div></div>`).join('')}`;
  if (readout) {
    readout.innerHTML = html;
    readout.classList.remove('idle');
    return;
  }
  panel.innerHTML = html;
  panel.dataset.owner = String(st.id);
  panel.hidden = false;

  const card = chart.canvas.closest('.card').getBoundingClientRect();
  const h = panel.offsetHeight;
  let left;
  let top = card.top;
  if (card.right + 8 + PANEL_W <= window.innerWidth) left = card.right + 8;
  else if (card.left - 8 - PANEL_W >= 0) left = card.left - 8 - PANEL_W;
  else {
    // Phone width: no room beside the card, so drop it just below.
    left = Math.max(8, card.left);
    top = card.bottom + 8;
  }
  top = Math.min(Math.max(8, top), window.innerHeight - h - 8);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

/** A matchup card. `big` builds the large view's version, with a side column for the readout. */
function makeCard(m, container = $('grid'), big = false) {
  const card = document.createElement('section');
  card.className = big ? 'card big' : 'card';
  const swings = '<details class="swings" open><summary>Big swings <span class="count"></span></summary><ul></ul></details>';
  card.innerHTML = `
    <div class="teams">
      <div class="trow a"><span class="swatch"></span><span class="name a-name"></span><span class="lead"></span>
        <span class="proj a-proj"></span><span class="pts a-pts"></span><span class="pct a-pct"></span></div>
      <div class="trow b"><span class="swatch"></span><span class="name b-name"></span><span class="lead"></span>
        <span class="proj b-proj"></span><span class="pts b-pts"></span><span class="pct b-pct"></span></div>
    </div>
    <div class="chart-wrap"><canvas role="img"></canvas></div>
    ${big ? `<div class="detail-side"><div class="detail-readout idle"></div>${swings}</div>` : swings}`;
  container.appendChild(card);
  const q = (s) => card.querySelector(s);
  const els = {
    aName: q('.a-name'), bName: q('.b-name'), aRow: q('.trow.a'), bRow: q('.trow.b'),
    aPts: q('.a-pts'), bPts: q('.b-pts'),
    aProj: q('.a-proj'), bProj: q('.b-proj'),
    aPct: q('.a-pct'), bPct: q('.b-pct'),
    canvas: q('canvas'), list: q('.swings ul'), count: q('.swings .count'), swings: q('.swings'),
  };

  // Scriptable options get the chart through their context; `chart` isn't assigned yet on first draw.
  const color = (c, side) => (c.chart.$state ? c.chart.$state.lineColors[side] : css(side === 'a' ? '--team-a' : '--team-b'));
  const chart = new Chart(els.canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          // 0: exact series, invisible; hover and the readout use it.
          data: [],
          parsing: false,
          showLine: false,
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
          order: 3,
        },
        {
          // 1: swing markers
          data: [],
          parsing: false,
          showLine: false,
          fill: false,
          pointRadius: (c) => (c.raw && c.chart.$state && c.raw.ev.id === c.chart.$state.highlight ? L().dotRadius + 2.5 : L().dotRadius),
          pointHoverRadius: (c) => (c.raw && c.chart.$state && c.raw.ev.id === c.chart.$state.highlight ? L().dotRadius + 2.5 : L().dotRadius),
          // Broadcast: solid team dot. Paper: hollow ink-tinted ring. Scoreboard: lit amber bulb.
          pointBackgroundColor: (c) => {
            if (!c.raw) return 'transparent';
            const look = L();
            if (look.dot === 'hollow') return css('--surface');
            if (look.dot === 'bulb') return css('--ink-2');
            return c.raw.ev.color;
          },
          pointBorderColor: (c) => {
            if (!c.raw) return 'transparent';
            const look = L();
            if (look.dot === 'hollow') return inked(c.raw.ev.color, look.inkMix);
            if (look.dot === 'bulb') return c.raw.ev.color;
            return css('--surface');
          },
          pointBorderWidth: 2,
          order: 1,
        },
        {
          // 2: the visible, smoothed line and its shading
          data: [],
          parsing: false,
          borderWidth: 2,
          borderJoinStyle: 'round',
          borderCapStyle: 'round',
          cubicInterpolationMode: 'monotone',
          pointRadius: 0,
          pointHoverRadius: 0,
          segment: { borderColor: (c) => ((c.p0.parsed.y + c.p1.parsed.y) / 2 >= 50 ? color(c, 'a') : color(c, 'b')) },
          borderColor: (c) => color(c, 'a'),
          fill: { target: { value: 50 }, above: (c) => shade(color(c, 'a')), below: (c) => shade(color(c, 'b')) },
          order: 2,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'raw', intersect: false },
      layout: { padding: { top: 4, right: 6 } },
      scales: {
        x: {
          type: 'linear',
          grid: { display: false },
          border: { color: css('--axis') },
          ticks: {
            color: css('--muted'),
            maxTicksLimit: 6,
            maxRotation: 0,
            callback(v) {
              const st = this.chart.$state; // `this` is the scale
              if (!st || !st.series.length) return '';
              if (st.mode === 'week') {
                // Under a day and a half on screen: day names would be useless, show times.
                if (this.max - this.min < 36 * 3600) return fmtTime(st.first + v);
                return new Date((st.first + v) * 1000).toLocaleDateString([], { weekday: 'short' });
              }
              return fmtTime(st.series[nearestIndex(st.xs, v)][0]);
            },
          },
          // Whole week: one label per day, at noon.
          afterBuildTicks(scale) {
            const st = scale.chart.$state;
            if (!st || st.mode !== 'week' || scale.max - scale.min < 36 * 3600) return;
            // Only days inside what's on screen (a zoomed chart starts mid-week).
            const ticks = [];
            const lo = st.first + scale.min;
            const d = new Date(lo * 1000);
            d.setHours(12, 0, 0, 0);
            if (d.getTime() / 1000 < lo) d.setDate(d.getDate() + 1);
            for (; d.getTime() / 1000 <= st.first + scale.max; d.setDate(d.getDate() + 1)) ticks.push({ value: d.getTime() / 1000 - st.first });
            scale.ticks = ticks;
          },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: css('--grid') },
          border: { display: false },
          ticks: { color: css('--muted'), stepSize: 25, callback: (v) => `${v}%` },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false, external: externalTooltip, filter: (item) => item.datasetIndex === 0 },
      },
    },
    plugins: [overlayPlugin],
  });
  els.canvas.addEventListener('mouseleave', () => {
    panel.hidden = true;
    const readout = card.querySelector('.detail-readout');
    if (readout) clearReadout(readout);
  });
  if (big) chart.options.scales.x.ticks.maxTicksLimit = 12; // room for more time labels
  const entry = { chart, els, card, mid: m.matchup_id, big };
  attachDragZoom(entry);
  return entry;
}

const DRAG_MIN_PX = 6; // less movement than this is a click, not a drag

/**
 * Click a chart: open the large view. Drag across it: zoom into that stretch of
 * time (opening the large view first when it's a grid card). On the grid, touch
 * keeps scrolling the page; in the large view a touch drag zooms too.
 */
function attachDragZoom(entry) {
  const { chart, els, big } = entry;
  const canvas = els.canvas;
  let start = null;
  const xOf = (e) => e.clientX - canvas.getBoundingClientRect().left;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (!big && e.pointerType === 'touch') { start = { x: xOf(e), touch: true }; return; }
    start = { x: xOf(e) };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!start || start.touch || !chart.$state) return;
    const x = xOf(e);
    if (Math.abs(x - start.x) < DRAG_MIN_PX && !chart.$state.select) return;
    chart.$state.select = [start.x, x];
    panel.hidden = true;
    chart.draw();
  });
  const finish = (e, cancelled) => {
    if (!start) return;
    const s = start;
    start = null;
    const sel = chart.$state && chart.$state.select;
    if (chart.$state) chart.$state.select = null;
    chart.draw();
    if (cancelled) return;
    if (!sel || Math.abs(sel[1] - sel[0]) < DRAG_MIN_PX) {
      if (!big && (!s.touch || Math.abs(xOf(e) - s.x) < DRAG_MIN_PX)) openDetail(entry.mid);
      return;
    }
    const range = pixelsToRange(chart, sel[0], sel[1]);
    if (!range) return;
    if (big) zoomTo(range);
    else openDetail(entry.mid, range);
  };
  canvas.addEventListener('pointerup', (e) => finish(e, false));
  canvas.addEventListener('pointercancel', (e) => finish(e, true));
  if (big) canvas.addEventListener('dblclick', () => resetZoom());
}

/** A selected pixel stretch as real times, or null if it covers less than two data points. */
function pixelsToRange(chart, p1, p2) {
  const st = chart.$state;
  const { left, right } = chart.chartArea;
  const clamp = (p) => Math.max(left, Math.min(right, p));
  const v1 = chart.scales.x.getValueForPixel(clamp(Math.min(p1, p2)));
  const v2 = chart.scales.x.getValueForPixel(clamp(Math.max(p1, p2)));
  if (!st.series.length) return null;
  // Whole week: x is seconds since the week's first row. Gametime: x is squeezed,
  // so map through the nearest data point.
  const toTs = (v) => (st.mode === 'week' ? st.first + v : st.series[nearestIndex(st.xs, v)][0]);
  const from = Math.floor(toTs(v1));
  const to = Math.ceil(toTs(v2));
  if (to - from < 2) return null;
  return { from, to };
}

function clearReadout(el) {
  el.classList.add('idle');
  el.innerHTML = '<p class="muted">Hover the chart for the score at any moment. Drag across it to zoom in; double-click to zoom back out.</p>';
}

function render(data) {
  const fresh = data !== lastData; // new data from the server, not just a restyle
  lastData = data;
  for (const t of data.teams || []) avatarById.set(t.roster_id, t.avatar);
  const ids = new Set(data.matchups.map((m) => m.matchup_id));
  for (const [id, c] of charts) {
    if (!ids.has(id)) {
      c.chart.destroy();
      c.els.canvas.closest('.card').remove();
      charts.delete(id);
    }
  }
  for (const m of data.matchups) {
    if (!charts.has(m.matchup_id)) charts.set(m.matchup_id, makeCard(m));
    drawMatchup(charts.get(m.matchup_id), m, data);
  }
  refreshDetail(fresh);
}

/**
 * Draw one matchup into a card. `zoom` ({ from, to, series, events }) swaps in
 * full-detail data for a stretch of time and fits the % axis to it.
 */
function drawMatchup({ chart, els }, m, data, zoom = null) {
  const threshold = window.TeamColors.threshold(); // this viewer's "big swing" size, in points
  const mine = window.TeamColors.mine(); // colors this viewer picked, else the look's defaults
  const colors = matchupColors({ color: mine[m.a.roster_id] }, { color: mine[m.b.roster_id] });
  const series = zoom ? zoom.series : m.series;
  const allEvents = zoom ? zoom.events : m.events;
  const week = data.mode === 'week';
  const { xs, gaps } = week ? { xs: series.map((s) => s[0] - data.first), gaps: [] } : compress(series);
  const bands = week ? (data.liveRanges || []).map(([a, b]) => [a - data.first, b - data.first]) : [];

  // Swing markers sit on the line at the moment of the swing.
  const events = allEvents
    .filter((e) => e.delta * 100 >= threshold && series.length)
    .map((e) => {
      const i = nearestIndex(series, e.ts, (s) => s[0]);
      const helpsA = e.roster_id === m.a.roster_id;
      return {
        ...e,
        i,
        x: xs[i],
        y: series[i][1] * 100,
        team: helpsA ? m.a.name : m.b.name,
        color: helpsA ? colors.a : colors.b,
      };
    });

  const prevHighlight = chart.$state && chart.$state.highlight;
  const ink = L().inkMix;
  chart.$state = {
    id: m.matchup_id, mode: data.mode, first: data.first, series, xs, gaps, bands,
    a: m.a.name, b: m.b.name, colors, lineColors: { a: inked(colors.a, ink), b: inked(colors.b, ink) },
    events, highlight: prevHighlight,
  };
  styleChart(chart);
  chart.data.datasets[0].data = series.map((s, i) => ({ x: xs[i], y: s[1] * 100 }));
  chart.data.datasets[1].data = events.map((e) => ({ x: e.x, y: e.y, ev: e }));
  chart.data.datasets[2].data = smoothLine(series, xs);
  const sx = chart.options.scales.x;
  const sy = chart.options.scales.y;
  if (zoom) {
    // Zoomed: just the selected stretch, with the % axis fitted to it.
    sx.min = xs[0] ?? 0;
    sx.max = xs[xs.length - 1] ?? 1;
    Object.assign(sy, fitPercent(series));
    sy.ticks.stepSize = undefined; // let Chart.js pick tidy steps for the fitted range
  } else {
    sx.min = week ? 0 : xs[0] ?? 0;
    sx.max = week ? Math.max(1, data.lastTs - data.first) : xs[xs.length - 1] ?? 1;
    Object.assign(sy, { min: 0, max: 100 });
    sy.ticks.stepSize = 25;
  }
  chart.update('none');

  const last = m.series[m.series.length - 1];
  els.aName.textContent = m.a.name;
  els.bName.textContent = m.b.name;
  els.aName.title = m.a.owner || '';
  els.bName.title = m.b.owner || '';
  els.aRow.style.setProperty('--tc', colors.a);
  els.bRow.style.setProperty('--tc', colors.b);
  if (last) {
    const [, p, ap, bp, aproj, bproj] = last;
    // The % sign (or "pct.") comes from the look's CSS.
    const over = isOver(ap, bp, aproj, bproj);
    els.aPct.textContent = winNum(p, over);
    els.bPct.textContent = winNum(1 - p, over);
    els.aRow.classList.toggle('leader', p >= 0.5);
    els.bRow.classList.toggle('leader', p < 0.5);
    els.aPts.textContent = ap.toFixed(2);
    els.bPts.textContent = bp.toFixed(2);
    els.aProj.textContent = `proj ${aproj.toFixed(1)}`;
    els.bProj.textContent = `proj ${bproj.toFixed(1)}`;
    els.canvas.setAttribute('aria-label', `${m.a.name} ${pct(p, over)} vs ${m.b.name} ${pct(1 - p, over)} win probability over time`);
  }

  // Swing list, newest first.
  els.count.textContent = events.length ? `(${events.length})` : '';
  els.swings.hidden = !events.length;
  els.list.innerHTML = [...events].reverse().map((e) => `
    <li data-id="${e.id}" style="--tc:${e.color}">${bubbleHtml(e, 26)}
    <span class="sw-time">${fmtTime(e.ts)}</span>
    <span class="sw-text">${esc(e.text)}</span>
    <b class="sw-pct">+${Math.round(e.delta * 100)}%</b>
    <span class="sw-team">${esc(e.team)}</span></li>`).join('');
  for (const li of els.list.children) {
    const setHl = (id) => { chart.$state.highlight = id; chart.update('none'); };
    li.onmouseenter = () => setHl(Number(li.dataset.id));
    li.onmouseleave = () => setHl(null);
  }
}

/** % axis range for a zoomed stretch: the data's span plus a margin, in steps of 5, at least 10 wide. */
function fitPercent(series) {
  if (!series.length) return { min: 0, max: 100 };
  let lo = 100;
  let hi = 0;
  for (const s of series) {
    lo = Math.min(lo, s[1] * 100);
    hi = Math.max(hi, s[1] * 100);
  }
  let min = Math.floor((lo - 5) / 5) * 5;
  let max = Math.ceil((hi + 5) / 5) * 5;
  if (max - min < 10) {
    const mid = (min + max) / 2;
    min = Math.floor((mid - 5) / 5) * 5;
    max = min + 10;
  }
  if (min < 0) { max -= min; min = 0; }
  if (max > 100) { min -= max - 100; max = 100; }
  return { min: Math.max(0, min), max: Math.min(100, max) };
}

// ---- Large view: one matchup over most of the screen, with drag-to-zoom ----
const detail = {
  mid: null, // matchup shown, or null when closed
  entry: null, // its card and chart
  stack: [], // zoom ranges, innermost last
  zoomData: null, // full-detail data for the innermost range
  pushed: false, // whether opening it added a history entry
  req: 0, // ignores late answers to superseded range requests
};

function openDetail(mid, range = null, { push = true } = {}) {
  if (!lastData) return;
  const m = lastData.matchups.find((x) => x.matchup_id === mid);
  if (!m) return;
  if (detail.mid !== mid) {
    closeDetail({ silent: true });
    detail.mid = mid;
    detail.entry = makeCard(m, $('detail-slot'), true);
    clearReadout(detail.entry.card.querySelector('.detail-readout'));
  }
  $('detail').hidden = false;
  document.body.classList.add('detail-open');
  panel.hidden = true;
  if (push && !detail.pushed) {
    history.pushState({ detail: mid }, '', `#m=${mid}`);
    detail.pushed = true;
  }
  detail.stack = [];
  detail.zoomData = null;
  drawDetail();
  $('detail-close').focus({ preventScroll: true });
  if (range) zoomTo(range);
}

/** Close the large view. From the × / Esc / backdrop this steps history back, which lands here again. */
function closeDetail({ silent = false, fromHistory = false } = {}) {
  if (detail.mid === null) return;
  if (!silent && !fromHistory && detail.pushed) {
    history.back(); // the popstate handler finishes closing
    return;
  }
  if (!fromHistory && !detail.pushed && location.hash.startsWith('#m=')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  detail.entry.chart.destroy();
  detail.entry.card.remove();
  Object.assign(detail, { mid: null, entry: null, stack: [], zoomData: null, pushed: false });
  $('detail').hidden = true;
  document.body.classList.remove('detail-open');
}

function zoomTo(range) {
  detail.stack.push(range);
  fetchZoom();
}
function zoomOut() {
  detail.stack.pop();
  if (detail.stack.length) fetchZoom();
  else { detail.zoomData = null; drawDetail(); }
}
function resetZoom() {
  if (!detail.stack.length) return;
  detail.stack = [];
  detail.zoomData = null;
  drawDetail();
}

async function fetchZoom() {
  const range = detail.stack[detail.stack.length - 1];
  if (!range || !current || detail.mid === null) return;
  const req = ++detail.req;
  const p = new URLSearchParams({ season: current.season, week: current.week, matchup: detail.mid, from: range.from, to: range.to, mode: lastData.mode });
  try {
    const data = await (await fetch(`api/range?${p}`)).json();
    if (req !== detail.req || detail.mid === null) return;
    if (!data.series || data.series.length < 2) {
      // Nothing recorded in that stretch: stay where we were.
      detail.stack.pop();
      if (!detail.stack.length) detail.zoomData = null;
      drawDetail();
      $('detail-range').textContent = 'Nothing recorded in that stretch';
      return;
    }
    detail.zoomData = { ...range, series: data.series, events: data.events };
    drawDetail();
  } catch { /* keep the current view; the next refresh tries again */ }
}

function drawDetail() {
  if (detail.mid === null || !lastData) return;
  const m = lastData.matchups.find((x) => x.matchup_id === detail.mid);
  if (!m) { closeDetail(); return; }
  const zoom = detail.stack.length ? detail.zoomData : null;
  drawMatchup(detail.entry, m, lastData, zoom);
  const zoomed = !!zoom;
  $('detail-out').hidden = !zoomed;
  $('detail-reset').hidden = detail.stack.length < 2;
  $('detail-range').textContent = zoomed ? rangeLabel(zoom.series[0][0], zoom.series[zoom.series.length - 1][0]) : (lastData.mode === 'week' ? 'Whole week' : 'Gametime');
}

/** Keep the large view in step with the grid. New data re-fetches a zoomed stretch; a restyle just redraws. */
function refreshDetail(fresh) {
  if (detail.mid === null) return;
  if (fresh && detail.stack.length) fetchZoom();
  else drawDetail();
}

function rangeLabel(a, b) {
  const sameDay = fmtDay(a) === fmtDay(b);
  return sameDay ? `${fmtDay(a)} ${fmtTime(a)}–${fmtTime(b)}` : `${fmtDay(a)} ${fmtTime(a)} – ${fmtDay(b)} ${fmtTime(b)}`;
}

function setupDetail() {
  $('detail-close').onclick = () => closeDetail();
  $('detail-backdrop').onclick = () => closeDetail();
  $('detail-out').onclick = () => zoomOut();
  $('detail-reset').onclick = () => resetZoom();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detail.mid !== null) closeDetail();
  });
  window.addEventListener('popstate', () => {
    const mid = hashMatchup();
    if (mid === null) closeDetail({ fromHistory: true });
    else if (mid !== detail.mid) openDetail(mid, null, { push: false });
  });
}

/** The matchup in a "#m=3" link, or null. */
function hashMatchup() {
  const mt = /^#m=(\d+)$/.exec(location.hash);
  return mt ? Number(mt[1]) : null;
}

function buildViewToggle() {
  const box = $('segments');
  box.innerHTML = '';
  for (const [v, label] of [['game', 'Gametime'], ['week', 'Whole week']]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.view = v;
    b.onclick = () => {
      if (view === v) return;
      view = v;
      saveView(v);
      markPressed();
      closeDetail();
      load();
    };
    box.appendChild(b);
  }
  markPressed();
}
function markPressed() {
  for (const b of $('segments').children) b.setAttribute('aria-pressed', String(b.dataset.view === view));
}

function updateStatus() {
  if (!lastTs) return;
  const ago = Math.max(0, Math.round(Date.now() / 1000 - lastTs));
  $('status').innerHTML = (ago < 120
    ? `<span class="live-tag">Live</span> updated ${ago}s ago`
    : `Last update ${fmtFull(lastTs)}`) + (fallbackNote ? ' · No games yet this week, showing the whole week' : '');
}
let fallbackNote = false;

// One request at a time: if a load is asked for while one is running (a slow
// connection, or a week/view switch mid-refresh), run it once afterwards.
let loading = false;
let reloadAgain = false;
async function load() {
  if (!current) return;
  if (loading) { reloadAgain = true; return; }
  loading = true;
  try {
    const p = new URLSearchParams({ season: current.season, week: current.week, mode: view });
    const data = await (await fetch(`api/week?${p}`)).json();
    lastTs = data.lastTs;
    fallbackNote = !!data.fallback;
    $('empty').hidden = data.matchups.length > 0;
    render(data);
    updateStatus();
  } finally {
    loading = false;
    if (reloadAgain) { reloadAgain = false; load().catch(() => {}); }
  }
}

const isLive = () => lastTs && Date.now() / 1000 - lastTs < 300 && current === weeks[0];

async function init() {
  fetch('api/meta').then((r) => r.json()).then((m) => {
    if (m.name) { $('league-title').textContent = m.name; document.title = `${m.name} · Win probability`; }
  }).catch(() => {});

  weeks = await (await fetch('api/weeks')).json();
  const sel = $('week');
  sel.innerHTML = weeks.map((w, i) => `<option value="${i}">Week ${w.week}${w.season !== weeks[0].season ? ` (${w.season})` : ''}</option>`).join('');
  if (!weeks.length) { $('empty').hidden = false; $('status').textContent = ''; return; }
  current = weeks[0];
  sel.onchange = () => { current = weeks[Number(sel.value)]; closeDetail(); load(); };
  buildViewToggle();
  setupDetail();
  window.Looks.onChange(() => { if (lastData) render(lastData); });
  // Charts draw on a canvas, which won't pick up a web font that arrives late; redraw then.
  if (document.fonts) document.fonts.addEventListener('loadingdone', () => { if (lastData) render(lastData); });
  await load();
  // A shared "#m=3" link opens that matchup's large view straight away.
  if (hashMatchup() !== null) openDetail(hashMatchup(), null, { push: false });

  window.addEventListener('scroll', () => { panel.hidden = true; }, { passive: true });
  // Teletext's page header clock ("Fri 20 Nov 21:14/05"); hidden in the other looks.
  const tick = () => {
    const d = new Date();
    const two = (n) => String(n).padStart(2, '0');
    $('tt-clock').textContent = `${d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }).replace(',', '')} ${two(d.getHours())}:${two(d.getMinutes())}/${two(d.getSeconds())}`;
  };
  tick();
  setInterval(tick, 1000);

  setInterval(() => {
    if (document.hidden) return; // nobody's looking: don't refresh a background tab
    if (isLive()) load().catch(() => {});
    else updateStatus();
  }, REFRESH_MS);
  // Back to the tab: catch up straight away instead of waiting for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && isLive()) load().catch(() => {});
  });
}

init().catch((e) => { $('status').textContent = `Error: ${e.message}`; });

// Win probability page. One chart per matchup, showing the first team's win %.
const GAP_SECONDS = 30 * 60; // quiet stretches longer than this get squeezed
const GAP_WIDTH = 10 * 60; // ...down to this much horizontal room
const FLAT_EPS = 0.0005; // win-prob changes smaller than 0.05 points count as "flat"
const JUMP = 0.02; // steps of 2+ points are real swings and stay sharp
const VIEW_KEY = 'winprob.view';
const REFRESH_MS = 5000;
const EVENT_HOVER_PX = 10; // hovering this close to a swing dot shows its story
const PANEL_W = 260;

const { css, matchupColors, alpha } = window.TeamColors;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
const fmtFull = (ts) => `${fmtDay(ts)} ${new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
const pct = (p) => `${Math.round(p * 100)}%`;

let weeks = [];
let current = null; // { season, week }
let view = readView(); // 'game' (Gametime) or 'week' (Whole week)
let threshold = 5;
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
  if (!url) return `<span class="bubble empty" style="${style}"></span>`;
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
    ctx.save();
    ctx.strokeStyle = css('--axis');
    ctx.fillStyle = css('--muted');
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
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
      ctx.fillText(fmtDay(g.ts), px + 4, chartArea.top + 10);
    }
    ctx.setLineDash([]);
    const y50 = scales.y.getPixelForValue(50);
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y50);
    ctx.lineTo(chartArea.right, y50);
    ctx.stroke();
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
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

/** Hover readout that sits beside the card, never under the cursor. */
function externalTooltip({ chart, tooltip }) {
  const st = chart.$state;
  const point = (tooltip.dataPoints || []).find((d) => d.datasetIndex === 0);
  if (!tooltip.opacity || !point || !st) {
    if (panel.dataset.owner === String(st && st.id)) panel.hidden = true;
    return;
  }
  const [ts, p, ap, bp, aproj, bproj] = st.series[point.dataIndex];
  const px = point.element.x;
  const nearby = st.events.filter((e) => Math.abs(chart.scales.x.getPixelForValue(e.x) - px) <= EVENT_HOVER_PX);
  const row = (name, color, prob, pts, proj) => `
    <div class="hp-row"><span class="swatch" style="background:${color}"></span><span class="hp-name">${esc(name)}</span>
    <b>${pct(prob)}</b></div><div class="hp-sub">${pts.toFixed(2)} pts · proj ${proj.toFixed(1)}</div>`;
  panel.innerHTML = `
    <div class="hp-time">${fmtFull(ts)}</div>
    ${row(st.a, st.colors.a, p, ap, aproj)}
    ${row(st.b, st.colors.b, 1 - p, bp, bproj)}
    ${nearby.map((e) => `<div class="hp-event">${bubbleHtml(e, 32)}
      <div><b>+${Math.round(e.delta * 100)}% ${esc(e.team)}</b><div>${esc(e.text)}</div><div class="hp-sub">${fmtFull(e.ts)}</div></div></div>`).join('')}`;
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

function makeCard(m) {
  const card = document.createElement('section');
  card.className = 'card';
  card.innerHTML = `
    <div class="teams">
      <div class="team"><span class="swatch a-sw"></span><span class="name a-name"></span></div>
      <div class="nums"><span class="pts a-pts"></span> <span class="proj a-proj"></span> <span class="pct a-pct"></span></div>
      <div class="team"><span class="swatch b-sw"></span><span class="name b-name"></span></div>
      <div class="nums"><span class="pts b-pts"></span> <span class="proj b-proj"></span> <span class="pct b-pct"></span></div>
    </div>
    <div class="chart-wrap"><canvas role="img"></canvas></div>
    <details class="swings" open><summary>Big swings <span class="count"></span></summary><ul></ul></details>`;
  $('grid').appendChild(card);
  const q = (s) => card.querySelector(s);
  const els = {
    aName: q('.a-name'), bName: q('.b-name'), aSw: q('.a-sw'), bSw: q('.b-sw'),
    aPts: q('.a-pts'), bPts: q('.b-pts'),
    aProj: q('.a-proj'), bProj: q('.b-proj'),
    aPct: q('.a-pct'), bPct: q('.b-pct'),
    canvas: q('canvas'), list: q('.swings ul'), count: q('.swings .count'), swings: q('.swings'),
  };

  // Scriptable options get the chart through their context; `chart` isn't assigned yet on first draw.
  const color = (c, side) => (c.chart.$state ? c.chart.$state.colors[side] : css(side === 'a' ? '--team-a' : '--team-b'));
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
          pointRadius: (c) => (c.raw && c.chart.$state && c.raw.ev.id === c.chart.$state.highlight ? 6.5 : 4),
          pointHoverRadius: (c) => (c.raw && c.chart.$state && c.raw.ev.id === c.chart.$state.highlight ? 6.5 : 4),
          pointBackgroundColor: (c) => (c.raw ? c.raw.ev.color : 'transparent'),
          pointBorderColor: () => css('--surface'),
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
          fill: { target: { value: 50 }, above: (c) => alpha(color(c, 'a'), 0.14), below: (c) => alpha(color(c, 'b'), 0.14) },
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
                // Under a day and a half of data: day names would be useless, show times.
                if (this.max < 36 * 3600) return fmtTime(st.first + v);
                return new Date((st.first + v) * 1000).toLocaleDateString([], { weekday: 'short' });
              }
              return fmtTime(st.series[nearestIndex(st.xs, v)][0]);
            },
          },
          // Whole week: one label per day, at noon.
          afterBuildTicks(scale) {
            const st = scale.chart.$state;
            if (!st || st.mode !== 'week' || scale.max < 36 * 3600) return;
            const ticks = [];
            const d = new Date(st.first * 1000);
            d.setHours(12, 0, 0, 0);
            if (d.getTime() / 1000 < st.first) d.setDate(d.getDate() + 1);
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
  els.canvas.addEventListener('mouseleave', () => { panel.hidden = true; });
  return { chart, els };
}

function render(data) {
  threshold = data.settings ? data.settings.eventThreshold : threshold;
  const colorById = new Map(((data.settings && data.settings.teams) || []).map((t) => [t.roster_id, t.color]));
  for (const t of (data.settings && data.settings.teams) || []) avatarById.set(t.roster_id, t.avatar);
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
    const { chart, els } = charts.get(m.matchup_id);
    const colors = matchupColors({ color: colorById.get(m.a.roster_id) }, { color: colorById.get(m.b.roster_id) });
    const week = data.mode === 'week';
    const { xs, gaps } = week ? { xs: m.series.map((s) => s[0] - data.first), gaps: [] } : compress(m.series);
    const bands = week ? (data.liveRanges || []).map(([a, b]) => [a - data.first, b - data.first]) : [];

    // Swing markers sit on the line at the moment of the swing.
    const events = m.events
      .filter((e) => e.delta * 100 >= threshold && m.series.length)
      .map((e) => {
        const i = nearestIndex(m.series, e.ts, (s) => s[0]);
        const helpsA = e.roster_id === m.a.roster_id;
        return {
          ...e,
          i,
          x: xs[i],
          y: m.series[i][1] * 100,
          team: helpsA ? m.a.name : m.b.name,
          color: helpsA ? colors.a : colors.b,
        };
      });

    const prevHighlight = chart.$state && chart.$state.highlight;
    chart.$state = {
      id: m.matchup_id, mode: data.mode, first: data.first, series: m.series, xs, gaps, bands,
      a: m.a.name, b: m.b.name, colors, events, highlight: prevHighlight,
    };
    chart.data.datasets[0].data = m.series.map((s, i) => ({ x: xs[i], y: s[1] * 100 }));
    chart.data.datasets[1].data = events.map((e) => ({ x: e.x, y: e.y, ev: e }));
    chart.data.datasets[2].data = smoothLine(m.series, xs);
    chart.options.scales.x.min = week ? 0 : xs[0] ?? 0;
    chart.options.scales.x.max = week ? Math.max(1, data.lastTs - data.first) : xs[xs.length - 1] ?? 1;
    chart.update('none');

    const last = m.series[m.series.length - 1];
    els.aName.textContent = m.a.name;
    els.bName.textContent = m.b.name;
    els.aName.title = m.a.owner || '';
    els.bName.title = m.b.owner || '';
    els.aSw.style.background = colors.a;
    els.bSw.style.background = colors.b;
    if (last) {
      const [, p, ap, bp, aproj, bproj] = last;
      els.aPct.textContent = pct(p);
      els.bPct.textContent = pct(1 - p);
      els.aPts.textContent = ap.toFixed(2);
      els.bPts.textContent = bp.toFixed(2);
      els.aProj.textContent = `proj ${aproj.toFixed(1)}`;
      els.bProj.textContent = `proj ${bproj.toFixed(1)}`;
      els.canvas.setAttribute('aria-label', `${m.a.name} ${pct(p)} vs ${m.b.name} ${pct(1 - p)} win probability over time`);
    }

    // Swing list, newest first.
    els.count.textContent = events.length ? `(${events.length})` : '';
    els.swings.hidden = !events.length;
    els.list.innerHTML = [...events].reverse().map((e) => `
      <li data-id="${e.id}">${bubbleHtml(e, 26)}
      <span class="sw-time">${fmtTime(e.ts)}</span>
      <span class="sw-text">${esc(e.text)}</span>
      <b class="sw-delta">+${Math.round(e.delta * 100)}% ${esc(e.team)}</b></li>`).join('');
    for (const li of els.list.children) {
      const setHl = (id) => { chart.$state.highlight = id; chart.update('none'); };
      li.onmouseenter = () => setHl(Number(li.dataset.id));
      li.onmouseleave = () => setHl(null);
    }
  }
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
    ? `<span class="live-dot"></span>Live · updated ${ago}s ago`
    : `Last update ${fmtFull(lastTs)}`) + (fallbackNote ? ' · No games yet this week, showing the whole week' : '');
}
let fallbackNote = false;

async function load() {
  if (!current) return;
  const p = new URLSearchParams({ season: current.season, week: current.week, mode: view });
  const data = await (await fetch(`api/week?${p}`)).json();
  lastTs = data.lastTs;
  fallbackNote = !!data.fallback;
  $('empty').hidden = data.matchups.length > 0;
  render(data);
  updateStatus();
}

async function init() {
  fetch('api/meta').then((r) => r.json()).then((m) => {
    if (m.name) { $('league-title').textContent = m.name; document.title = `${m.name} · Win probability`; }
    $('settings-link').hidden = !m.admin; // the public site has no settings
  }).catch(() => {});

  weeks = await (await fetch('api/weeks')).json();
  const sel = $('week');
  sel.innerHTML = weeks.map((w, i) => `<option value="${i}">Week ${w.week}${w.season !== weeks[0].season ? ` (${w.season})` : ''}</option>`).join('');
  if (!weeks.length) { $('empty').hidden = false; $('status').textContent = ''; return; }
  current = weeks[0];
  sel.onchange = () => { current = weeks[Number(sel.value)]; load(); };
  buildViewToggle();
  await load();

  window.addEventListener('scroll', () => { panel.hidden = true; }, { passive: true });
  setInterval(() => {
    const live = lastTs && Date.now() / 1000 - lastTs < 300;
    if (live && current === weeks[0]) load().catch(() => {});
    else updateStatus();
  }, REFRESH_MS);
}

init().catch((e) => { $('status').textContent = `Error: ${e.message}`; });

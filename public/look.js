// Three looks for the site, picked per browser: Broadcast, Paper, Scoreboard.
// The CSS lives in looks.css, scoped to <html data-look="...">. This file
// saves and applies the choice, draws the picker, and holds the chart
// settings each look needs (the CSS can't reach inside the <canvas>).
(function () {
  const KEY = 'winprob.look';
  const LOOKS = [
    { id: 'broadcast', label: 'Broadcast' },
    { id: 'paper', label: 'Paper' },
    { id: 'scoreboard', label: 'Scoreboard' },
    { id: 'blueprint', label: 'Blueprint' },
    { id: 'riso', label: 'Riso' },
    { id: 'teletext', label: 'Teletext' },
  ];

  // How each look draws its charts.
  const CHART = {
    broadcast: {
      font: "'Barlow Condensed', 'Arial Narrow', sans-serif",
      fontSize: 13,
      fontWeight: 600,
      lineWidth: 3.5,
      dash: [],
      inkMix: 0, // how far to pull team colors toward the ink color
      fillAlpha: 0.16,
      gridLines: true,
      dotGrid: false,
      midDash: [6, 6],
      dot: 'fill', // fill | hollow | bulb
      dotRadius: 4.5,
      upperTicks: true,
    },
    paper: {
      font: "'Courier Prime', 'Courier New', monospace",
      fontSize: 11,
      fontWeight: 400,
      lineWidth: 1.8,
      dash: [],
      inkMix: 0.35,
      fillAlpha: 0.08,
      gridLines: false,
      dotGrid: false,
      midDash: [2, 4],
      dot: 'hollow',
      dotRadius: 4,
      upperTicks: false,
    },
    scoreboard: {
      font: "'Doto', 'Courier Prime', monospace",
      fontSize: 13,
      fontWeight: 800,
      lineWidth: 3.5,
      dash: [0.1, 6.5],
      inkMix: 0,
      fillAlpha: 0.07,
      gridLines: false,
      dotGrid: true,
      midDash: [0.1, 6],
      dot: 'bulb',
      dotRadius: 5,
      upperTicks: true,
    },
    // Engineering drawing: thin linework on graph paper, center-line style 50% mark.
    blueprint: {
      font: "'IBM Plex Mono', 'Courier New', monospace",
      fontSize: 11,
      fontWeight: 400,
      lineWidth: 2,
      dash: [],
      inkMix: 0,
      fillAlpha: 0.12,
      gridLines: false,
      dotGrid: false,
      paperGrid: true,
      midDash: [12, 4, 2, 4],
      dot: 'hollow',
      dotRadius: 4.5,
      upperTicks: true,
    },
    // Two-ink risograph print: fat strokes, halftone-dot shading.
    riso: {
      font: "'Fragment Mono', 'Courier New', monospace",
      fontSize: 11,
      fontWeight: 400,
      lineWidth: 4,
      dash: [],
      inkMix: 0,
      fillAlpha: 0.14,
      halftone: true,
      gridLines: false,
      dotGrid: false,
      midDash: [],
      dot: 'fill',
      dotRadius: 5.5,
      upperTicks: true,
    },
    // 1980s TV text service: chunky stepped blocks, square markers.
    teletext: {
      font: "'VT323', 'Courier New', monospace",
      fontSize: 16,
      fontWeight: 400,
      lineWidth: 4,
      dash: [],
      stepped: true,
      join: 'miter',
      cap: 'butt',
      inkMix: 0,
      fillAlpha: 0.22,
      gridLines: false,
      dotGrid: false,
      midDash: [4, 4],
      dot: 'fill',
      pointStyle: 'rect',
      dotRadius: 5,
      upperTicks: true,
    },
  };

  const valid = (id) => LOOKS.some((l) => l.id === id);
  let current = document.documentElement.dataset.look;
  if (!valid(current)) {
    try { current = localStorage.getItem(KEY); } catch { current = null; }
    if (!valid(current)) current = 'broadcast';
    document.documentElement.dataset.look = current;
  }
  const listeners = [];

  function set(id) {
    if (!valid(id) || id === current) return;
    current = id;
    document.documentElement.dataset.look = id;
    try { localStorage.setItem(KEY, id); } catch { /* private window etc. */ }
    renderPicker();
    // getComputedStyle (used by the listeners) recalculates styles on demand, so
    // the new look's variables are already readable here, even in a background tab.
    listeners.forEach((fn) => fn(id));
  }

  function renderPicker() {
    const box = document.getElementById('look-picker');
    if (!box) return;
    box.innerHTML = '';
    for (const l of LOOKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = l.label;
      b.setAttribute('aria-pressed', String(l.id === current));
      b.onclick = () => set(l.id);
      box.appendChild(b);
    }
  }

  window.Looks = {
    list: LOOKS,
    current: () => current,
    chart: () => CHART[current],
    set,
    onChange: (fn) => listeners.push(fn),
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderPicker);
  else renderPicker();
})();

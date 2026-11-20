// Shared color helpers for the chart page and the settings page.
(function () {
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  };
  // Rough perceptual distance (redmean); under ~90 two line colors are hard to tell apart.
  function distance(h1, h2) {
    const [r1, g1, b1] = rgb(h1);
    const [r2, g2, b2] = rgb(h2);
    const rm = (r1 + r2) / 2;
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  }
  const CLASH = 90;

  /** Colors for a matchup: first team, second team, and whether a fallback kicked in. */
  function matchupColors(a, b) {
    const defA = css('--team-a');
    const defB = css('--team-b');
    const ca = a.color || defA;
    let cb = b.color || defB;
    let fallback = false;
    if (distance(ca, cb) < CLASH) {
      fallback = true;
      cb = distance(ca, defB) >= distance(ca, defA) ? defB : defA;
    }
    return { a: ca, b: cb, fallback };
  }

  const alpha = (hex, a) => {
    const [r, g, b] = rgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  };

  // Team colors this viewer picked on the settings page, saved in this browser only
  // (like the look). They win over the look's default colors, for this viewer alone.
  const MINE_KEY = 'winprob.teamColors';
  function mine() {
    try { return JSON.parse(localStorage.getItem(MINE_KEY)) || {}; } catch { return {}; }
  }
  function setMine(obj) {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(obj)); } catch { /* private window etc. */ }
  }

  // How big a swing (in win % points) this viewer wants marked. Also per browser.
  const THRESHOLD_KEY = 'winprob.swingThreshold';
  const DEFAULT_THRESHOLD = 5;
  function threshold() {
    let t = NaN;
    try { t = Number(localStorage.getItem(THRESHOLD_KEY)); } catch { /* blocked storage */ }
    return t >= 2 && t <= 30 ? t : DEFAULT_THRESHOLD;
  }
  function setThreshold(t) {
    try { localStorage.setItem(THRESHOLD_KEY, String(t)); } catch { /* private window etc. */ }
  }

  window.TeamColors = { css, distance, matchupColors, alpha, CLASH, mine, setMine, threshold, setThreshold, DEFAULT_THRESHOLD };
})();

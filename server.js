// Local website: node server.js  ->  http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./lib/config');
const { open, getSetting, setSetting } = require('./lib/db');
const { describe } = require('./lib/events');

const db = open();
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const TARGET_POINTS = 1500; // per matchup series, after downsampling

const weeksQ = db.prepare(`SELECT season, week, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last
  FROM snapshots GROUP BY season, week ORDER BY season DESC, week DESC`);
const teamsQ = db.prepare('SELECT roster_id, name, owner, avatar, color FROM teams ORDER BY roster_id');
const setColorQ = db.prepare('UPDATE teams SET color = ? WHERE roster_id = ?');
const eventsQ = db.prepare(`SELECT id, ts, matchup_id, roster_id, delta, win_prob, players_json, label FROM events
  WHERE season = ? AND week = ? AND ts BETWEEN ? AND ? ORDER BY ts`);
const latestPairsQ = db.prepare(`SELECT matchup_id, roster_id FROM snapshots
  WHERE (season, week) = (SELECT season, week FROM snapshots ORDER BY ts DESC LIMIT 1)
  GROUP BY matchup_id, roster_id ORDER BY matchup_id, roster_id`);
const DEFAULT_THRESHOLD = 5; // percentage points
const spanQ = db.prepare('SELECT MIN(ts) AS first, MAX(ts) AS last FROM snapshots WHERE season = ? AND week = ?');
const countAllQ = db.prepare('SELECT COUNT(DISTINCT ts) AS count FROM snapshots WHERE season = ? AND week = ? AND ts BETWEEN ? AND ?');
const countLiveQ = db.prepare('SELECT COUNT(DISTINCT ts) AS count FROM snapshots WHERE season = ? AND week = ? AND ts BETWEEN ? AND ? AND live = 1');
const liveTsQ = db.prepare('SELECT DISTINCT ts FROM snapshots WHERE season = ? AND week = ? AND live = 1 ORDER BY ts');
// Bucket by `res` seconds; SQLite returns the other columns from the row with max(ts).
const seriesAllQ = db.prepare(`SELECT matchup_id, roster_id, MAX(ts) AS ts, points, proj_final, win_prob
  FROM snapshots WHERE season = ? AND week = ? AND ts BETWEEN ? AND ?
  GROUP BY matchup_id, roster_id, ts / ? ORDER BY ts`);
const seriesLiveQ = db.prepare(`SELECT matchup_id, roster_id, MAX(ts) AS ts, points, proj_final, win_prob
  FROM snapshots WHERE season = ? AND week = ? AND ts BETWEEN ? AND ? AND live = 1
  GROUP BY matchup_id, roster_id, ts / ? ORDER BY ts`);
const WEEK_POINTS = 2000; // time buckets across the whole week
const RANGE_GAP = 10 * 60; // live stretches closer than this count as one game window

/** Time ranges [start, end] when games were live, for shading and filtering. */
function liveRanges(season, week) {
  const ranges = [];
  for (const { ts } of liveTsQ.all(season, week)) {
    const last = ranges[ranges.length - 1];
    if (last && ts - last[1] <= RANGE_GAP) last[1] = ts;
    else ranges.push([ts, ts]);
  }
  return ranges;
}

/**
 * mode "game": only rows recorded while games were live, downsampled by row count.
 * mode "week": every row on a real time axis, downsampled into even time buckets.
 */
function weekData(season, week, mode = 'game') {
  const span = spanQ.get(season, week);
  if (!span.first) return { season, week, mode, matchups: [], lastTs: null };
  const from = span.first;
  const to = span.last;
  const ranges = liveRanges(season, week);
  // No games played yet this week: Gametime would be empty, so show the week instead.
  let fallback = false;
  if (mode === 'game' && !ranges.length) {
    mode = 'week';
    fallback = true;
  }
  let res;
  let rows;
  if (mode === 'week') {
    res = Math.max(1, Math.ceil((to - from + 1) / WEEK_POINTS));
    rows = seriesAllQ.all(season, week, from, to, res);
  } else {
    const { count } = countLiveQ.get(season, week, from, to);
    res = Math.max(1, Math.ceil(count / TARGET_POINTS));
    rows = seriesLiveQ.all(season, week, from, to, res);
  }
  const teams = new Map(teamsQ.all().map((t) => [t.roster_id, t]));

  const byMatchup = new Map();
  for (const r of rows) {
    if (!byMatchup.has(r.matchup_id)) byMatchup.set(r.matchup_id, { rosters: new Set(), byTs: new Map() });
    const m = byMatchup.get(r.matchup_id);
    m.rosters.add(r.roster_id);
    const key = Math.floor(r.ts / res);
    if (!m.byTs.has(key)) m.byTs.set(key, {});
    m.byTs.get(key)[r.roster_id] = r;
  }

  const matchups = [];
  for (const [mid, m] of [...byMatchup].sort((x, y) => x[0] - y[0])) {
    const [ra, rb] = [...m.rosters].sort((x, y) => x - y);
    const series = [];
    for (const pt of m.byTs.values()) {
      const a = pt[ra];
      const b = pt[rb];
      if (!a || !b) continue;
      series.push([a.ts, +a.win_prob.toFixed(4), a.points, b.points, +a.proj_final.toFixed(2), +b.proj_final.toFixed(2)]);
    }
    const team = (rid) => ({ roster_id: rid, ...(teams.get(rid) || { name: `Team ${rid}` }) });
    matchups.push({ matchup_id: mid, a: team(ra), b: team(rb), series, events: [] });
  }
  const byId = new Map(matchups.map((m) => [m.matchup_id, m]));
  const duringGames = (ts) => ranges.some(([a, b]) => ts >= a - 60 && ts <= b + 60);
  for (const e of eventsQ.all(season, week, from, to)) {
    const m = byId.get(e.matchup_id);
    if (!m || (mode !== 'week' && !duringGames(e.ts))) continue;
    const players = JSON.parse(e.players_json || '[]');
    // Who the bubble shows: the biggest contributor in favor of the team the swing
    // helped (their own scorer, or an opponent's negative play), else the biggest mover.
    const helps = (p) => (p.roster_id === e.roster_id ? p.delta_pts : -p.delta_pts);
    const star = [...players].sort((x, y) => helps(y) - helps(x))[0];
    const who = star ? { player_id: star.player_id, pos: star.pos, roster_id: star.roster_id, name: star.name } : null;
    m.events.push({ id: e.id, ts: e.ts, roster_id: e.roster_id, delta: +e.delta.toFixed(4), win_prob: +(e.win_prob ?? 0).toFixed(4), text: describe({ ...e, players }), who });
  }
  return { season, week, mode, fallback, res, first: span.first, lastTs: span.last, liveRanges: ranges, matchups, settings: settingsData() };
}

function settingsData() {
  const pairs = new Map();
  for (const r of latestPairsQ.all()) {
    if (!pairs.has(r.matchup_id)) pairs.set(r.matchup_id, []);
    pairs.get(r.matchup_id).push(r.roster_id);
  }
  return {
    teams: teamsQ.all(),
    eventThreshold: getSetting(db, 'eventThreshold', DEFAULT_THRESHOLD),
    pairs: [...pairs.values()].filter((p) => p.length === 2),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e5) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
  });
}

async function saveSettings(body) {
  const colors = body.colors || {};
  for (const [rid, color] of Object.entries(colors)) {
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`bad color for team ${rid}`);
    setColorQ.run(color, Number(rid));
  }
  if (body.eventThreshold !== undefined) {
    const t = Number(body.eventThreshold);
    if (!(t >= 2 && t <= 50)) throw new Error('threshold must be 2-50');
    setSetting(db, 'eventThreshold', t);
  }
  return settingsData();
}

let meta = null;
async function getMeta() {
  if (!meta) {
    const r = await fetch(`https://api.sleeper.app/v1/league/${config.leagueId}`, { signal: AbortSignal.timeout(8000) });
    const league = await r.json();
    meta = { name: league.name };
  }
  return meta;
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Only the admin listener serves the settings page and accepts setting changes.
const ADMIN_ONLY = new Set(['/settings.html', '/settings.js', '/api/settings']);

const handler = (admin) => (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!admin && ADMIN_ONLY.has(url.pathname)) return send(res, 404, 'Not found', 'text/plain');
    if (url.pathname === '/api/weeks') return send(res, 200, weeksQ.all());
    if (url.pathname === '/api/settings' && req.method === 'GET') return send(res, 200, settingsData());
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      readBody(req).then(saveSettings).then((s) => send(res, 200, s), (e) => send(res, 400, { error: e.message }));
      return;
    }
    if (url.pathname === '/api/meta') {
      getMeta().then((m) => send(res, 200, { ...m, admin }), () => send(res, 200, { name: null, admin }));
      return;
    }
    if (url.pathname === '/api/week') {
      const season = url.searchParams.get('season');
      const week = Number(url.searchParams.get('week'));
      const mode = url.searchParams.get('mode') === 'week' ? 'week' : 'game';
      return send(res, 200, weekData(season, week, mode));
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
};

// Locally (no ADMIN_PORT): one site with the settings page included.
// On the server: set ADMIN_PORT and the public site (PORT) has no settings;
// the admin copy listens on 127.0.0.1 only, reachable through an SSH tunnel.
const PORT = Number(process.env.PORT) || config.port;
const HOST = process.env.HOST || undefined;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || null;

http.createServer(handler(!ADMIN_PORT)).listen(PORT, HOST, () =>
  console.log(`Win probability site${ADMIN_PORT ? ' (public, no settings)' : ''}: http://${HOST || 'localhost'}:${PORT}`));
if (ADMIN_PORT) {
  http.createServer(handler(true)).listen(ADMIN_PORT, '127.0.0.1', () =>
    console.log(`Admin site with settings: http://127.0.0.1:${ADMIN_PORT} (use an SSH tunnel)`));
}

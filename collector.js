// Live win-probability collector.
// Run:  node collector.js            (Ctrl+C to stop; restart any time, it appends)
//       node collector.js --week 10  (force a week)
//
// Every tick goes straight into data/winprob.db, so stopping loses at most one
// second. Restarting just keeps appending to the same week. When no NFL game is
// live or about to start, it slows to one check a minute and only stores rows
// whose numbers actually changed, so you can also just leave it running all week.

const config = require('./lib/config');
const sleeper = require('./lib/sleeper');
const { getGameClock } = require('./lib/espn');
const { teamOutlook, winProb } = require('./lib/model');
const { SwingDetector, diffPlays } = require('./lib/events');
const { open } = require('./lib/db');

const args = process.argv.slice(2);
const forcedWeek = args.includes('--week') ? Number(args[args.indexOf('--week') + 1]) : null;
const LEAGUE = config.leagueId;
const PRE_GAME_WINDOW_MS = 15 * 60 * 1000;
const STATS_EVERY_MS = 60 * 1000;
const LABEL_LOOKBACK_SEC = 10 * 60;

const db = open();
const insert = db.prepare(`INSERT OR REPLACE INTO snapshots
  (ts, season, week, matchup_id, roster_id, points, proj_final, win_prob, live)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const upsertTeam = db.prepare(`INSERT INTO teams (roster_id, name, owner, avatar) VALUES (?, ?, ?, ?)
  ON CONFLICT (roster_id) DO UPDATE SET name = excluded.name, owner = excluded.owner, avatar = excluded.avatar`);
const lastRow = db.prepare(`SELECT points, win_prob, proj_final FROM snapshots
  WHERE season = ? AND week = ? AND roster_id = ? ORDER BY ts DESC LIMIT 1`);
const insertPlayerPts = db.prepare(`INSERT OR REPLACE INTO player_points (ts, season, week, roster_id, player_id, points)
  VALUES (?, ?, ?, ?, ?, ?)`);
const lastPlayerPts = db.prepare(`SELECT roster_id, player_id, points, MAX(ts) AS ts FROM player_points
  WHERE season = ? AND week = ? GROUP BY roster_id, player_id`);
const insertEvent = db.prepare(`INSERT INTO events (ts, season, week, matchup_id, roster_id, delta, win_prob, players_json, label, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`);
const updateEvent = db.prepare(`UPDATE events SET ts = ?, roster_id = ?, delta = ?, win_prob = ?, players_json = ?, label = ? WHERE id = ?`);
const recentEvents = db.prepare(`SELECT id, players_json FROM events
  WHERE season = ? AND week = ? AND ts >= ? AND players_json LIKE ? ORDER BY ts DESC`);
const setEventPlayers = db.prepare('UPDATE events SET players_json = ? WHERE id = ?');

let ctx = { season: null, week: null, scoring: null, projections: new Map(), seasonOver: false };
let lastStateCheck = 0;
let lastProjCheck = 0;
let lastTeamsCheck = 0;
let lastStatsCheck = 0;
let prevStats = null;
let playerPts = new Map(); // "roster:player" -> last stored points
let detector = null;
let stopping = false;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function startWeek() {
  playerPts = new Map();
  for (const r of lastPlayerPts.all(ctx.season, ctx.week)) playerPts.set(`${r.roster_id}:${r.player_id}`, r.points);
  prevStats = null;
  detector = new SwingDetector((e) => {
    const players = JSON.stringify(e.players);
    if (e.id === undefined) {
      return Number(insertEvent.run(e.ts, ctx.season, ctx.week, e.matchup_id, e.roster_id, e.delta, e.win_prob, players, e.label).lastInsertRowid);
    }
    updateEvent.run(e.ts, e.roster_id, e.delta, e.win_prob, players, e.label, e.id);
    return e.id;
  });
}

async function refreshContext(now) {
  let projReloaded = false;
  if (now - lastStateCheck > 10 * 60e3 || (!ctx.week && !ctx.seasonOver)) {
    const [state, league] = await Promise.all([sleeper.getState(), sleeper.getLeague(LEAGUE)]);
    const week = forcedWeek || state.week;
    // Fantasy season is over once the league is marked complete, the NFL has
    // moved past its regular season, or we're past the last playoff week.
    const st = league.settings || {};
    const rounds = Math.ceil(Math.log2(Math.max(2, st.playoff_teams || 2)));
    const roundWeeks = st.playoff_round_type === 2 ? 2 * rounds : st.playoff_round_type === 1 ? rounds + 1 : rounds;
    const lastWeek = (st.playoff_week_start || 15) + roundWeeks - 1;
    const over = !forcedWeek && (league.status === 'complete' || state.season_type !== 'regular' || week > lastWeek);
    if (over && !ctx.seasonOver) log(`Season complete (league status "${league.status}", NFL ${state.season_type} week ${state.week}, last fantasy week ${lastWeek}). Nothing more to record; checking hourly.`);
    if (!over && ctx.seasonOver) log('Season is active again.');
    ctx.seasonOver = over;
    if (over) {
      lastStateCheck = now;
      return false;
    }
    const changed = week !== ctx.week || league.season !== ctx.season;
    ctx.season = league.season;
    ctx.scoring = league.scoring_settings;
    ctx.week = week;
    lastStateCheck = now;
    if (changed) {
      log(`League "${league.name}", season ${ctx.season}, week ${ctx.week}`);
      const resumed = db.prepare('SELECT COUNT(*) n, MAX(ts) t FROM snapshots WHERE season = ? AND week = ?').get(ctx.season, ctx.week);
      if (resumed.n) log(`Resuming: ${resumed.n} rows already stored for this week (last at ${new Date(resumed.t * 1000).toLocaleString()})`);
      lastProjCheck = 0;
      startWeek();
    }
  }
  if (ctx.seasonOver) return false; // between hourly checks: nothing to load
  if (now - lastTeamsCheck > 60 * 60e3) {
    const teams = await sleeper.getTeams(LEAGUE);
    for (const t of teams) upsertTeam.run(t.roster_id, t.name, t.owner, t.avatar);
    lastTeamsCheck = now;
  }
  if (now - lastProjCheck > 10 * 60e3) {
    const first = lastProjCheck === 0;
    ctx.projections = await sleeper.getProjections(ctx.season, ctx.week, ctx.scoring);
    lastProjCheck = now;
    projReloaded = !first;
    log(`Loaded ${ctx.projections.size} player projections`);
  }
  return projReloaded;
}

/** Every minute: see which TDs/FGs/INTs happened and put names on recent events. */
async function labelPlays(now, starters) {
  if (now - lastStatsCheck < STATS_EVERY_MS) return;
  lastStatsCheck = now;
  const stats = await sleeper.getStats(ctx.season, ctx.week);
  if (prevStats) {
    const since = Math.floor(now / 1000) - LABEL_LOOKBACK_SEC;
    for (const { player_id, play } of diffPlays(prevStats, stats, starters)) {
      for (const ev of recentEvents.all(ctx.season, ctx.week, since, `%"player_id":"${player_id}"%`)) {
        const players = JSON.parse(ev.players_json);
        const p = players.find((x) => x.player_id === player_id);
        if (!p || (p.play || '').includes(play)) continue;
        p.play = p.play ? `${p.play} + ${play}` : play;
        setEventPlayers.run(JSON.stringify(players), ev.id);
        log(`Labeled event: ${p.name} ${play}`);
        break; // most recent event only
      }
    }
  }
  prevStats = stats;
}

async function tick() {
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const projReloaded = await refreshContext(now);
  if (ctx.seasonOver) {
    lastStateCheck = Math.max(lastStateCheck, now - 10 * 60e3 + 60 * 60e3); // next check in an hour
    return { active: false, stored: 0, rows: [], clock: { games: [], nextKickoff: null }, seasonOver: true };
  }
  const [matchups, clock] = await Promise.all([
    sleeper.getMatchups(LEAGUE, ctx.week),
    getGameClock(ctx.season, ctx.week),
  ]);

  // A week with no fantasy matchups (e.g. NFL week 18) needs no per-second polling.
  const hasMatchups = matchups.some((m) => m.matchup_id != null);
  const active = hasMatchups && (clock.anyLive || (clock.nextKickoff !== null && clock.nextKickoff - now < PRE_GAME_WINDOW_MS));

  // Per-starter point changes since last tick.
  const changesByRoster = new Map();
  const playerRows = [];
  const starters = [];
  for (const m of matchups) {
    const changes = [];
    for (const pid of m.starters || []) {
      if (!pid || pid === '0') continue;
      starters.push(pid);
      const pts = Number((m.players_points || {})[pid]) || 0;
      const key = `${m.roster_id}:${pid}`;
      const prev = playerPts.get(key);
      if (prev === undefined || Math.abs(prev - pts) > 1e-6) {
        playerPts.set(key, pts);
        playerRows.push([m.roster_id, pid, pts]);
        if (prev !== undefined) {
          const p = ctx.projections.get(pid) || {};
          changes.push({ player_id: pid, roster_id: m.roster_id, name: p.name || pid, pos: p.pos || '', delta_pts: pts - prev });
        }
      }
    }
    changesByRoster.set(m.roster_id, changes);
  }

  // Group the rosters into head-to-head pairs.
  const pairs = new Map();
  for (const m of matchups) {
    if (m.matchup_id == null) continue;
    if (!pairs.has(m.matchup_id)) pairs.set(m.matchup_id, []);
    pairs.get(m.matchup_id).push(m);
  }

  const rows = [];
  const detectorInput = [];
  for (const [mid, teams] of pairs) {
    if (teams.length !== 2) continue;
    const [a, b] = teams.sort((x, y) => x.roster_id - y.roster_id);
    const oa = teamOutlook(a, ctx.projections, clock.fracLeft, config.playerSdFraction);
    const ob = teamOutlook(b, ctx.projections, clock.fracLeft, config.playerSdFraction);
    const pa = winProb(oa, ob);
    rows.push([mid, a.roster_id, oa.points, oa.expected, pa]);
    rows.push([mid, b.roster_id, ob.points, ob.expected, 1 - pa]);
    detectorInput.push({
      matchup_id: mid, ra: a.roster_id, rb: b.roster_id, wpA: pa,
      changes: [...changesByRoster.get(a.roster_id), ...changesByRoster.get(b.roster_id)],
    });
  }

  // While idle, only store rows that changed (e.g. stat corrections), so the
  // quiet days between game windows stay empty on the chart.
  let toStore = rows;
  if (!active) {
    toStore = rows.filter(([, rid, pts, proj, wp]) => {
      const prev = lastRow.get(ctx.season, ctx.week, rid);
      return !prev || Math.abs(prev.points - pts) > 0.001 || Math.abs(prev.win_prob - wp) > 0.0005 || Math.abs(prev.proj_final - proj) > 0.05;
    });
  }

  db.exec('BEGIN');
  try {
    for (const [mid, rid, pts, proj, wp] of toStore) insert.run(ts, ctx.season, ctx.week, mid, rid, pts, proj, wp, clock.anyLive ? 1 : 0);
    for (const [rid, pid, pts] of playerRows) insertPlayerPts.run(ts, ctx.season, ctx.week, rid, pid, pts);
    // Idle ticks are a minute apart; only look for swings on stored ticks.
    if (toStore.length) detector.tick(ts, detectorInput, { projReloaded });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  if (active) await labelPlays(now, starters).catch((e) => log('Warning: stats fetch failed:', e.message));
  return { active, stored: toStore.length, rows, clock };
}

let tickCount = 0;
async function loop() {
  while (!stopping) {
    const started = Date.now();
    let wait = config.pollMs;
    try {
      const r = await tick();
      wait = r.active ? config.pollMs : config.idlePollMs;
      tickCount++;
      if (r.seasonOver) {
        // stay quiet; the season-complete message was logged once
      } else if (!r.active || tickCount % 30 === 1) {
        const live = r.clock.games.filter((g) => g.state === 'in').length;
        const summary = [];
        for (let i = 0; i < r.rows.length; i += 2) {
          summary.push(`#${r.rows[i][0]} ${(r.rows[i][4] * 100).toFixed(0)}-${(r.rows[i + 1][4] * 100).toFixed(0)}`);
        }
        log(`${r.active ? 'LIVE' : 'idle'} | ${live} NFL games live | stored ${r.stored} rows | ${summary.join('  ')}`);
        if (!r.active && r.clock.nextKickoff) log(`Next kickoff: ${new Date(r.clock.nextKickoff).toLocaleString()} (checking once a minute until then)`);
      }
    } catch (e) {
      log('Warning: tick failed, will retry:', e.message);
    }
    if (args.includes('--once')) break;
    const elapsed = Date.now() - started;
    await new Promise((res) => setTimeout(res, Math.max(0, wait - elapsed)));
  }
  db.close();
  log('Collector stopped. Run it again any time to pick up where it left off.');
}

process.on('SIGINT', () => {
  if (stopping) process.exit(0);
  stopping = true;
  log('Stopping after the current tick...');
});

loop();

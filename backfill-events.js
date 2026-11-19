// One-off: find big swings in weeks recorded before player-level tracking
// existed. Each swing is pinned on the starter whose NFL game was in progress
// at that moment (or lists the candidates when several were playing).
// Safe to re-run: it replaces its own earlier backfill events.
// Run: node backfill-events.js

const config = require('./lib/config');
const sleeper = require('./lib/sleeper');
const { getGameClock } = require('./lib/espn');
const { open } = require('./lib/db');
const { SwingDetector, PLAY_LABELS } = require('./lib/events');

const GAME_WINDOW_SEC = 4.5 * 3600; // kickoff to final whistle, generously
const TD_KEYS = ['rush_td', 'rec_td', 'pass_td', 'def_td', 'st_td'];

/** Starters, player info, game times and final stats for one week. */
async function weekContext(season, week) {
  const league = await sleeper.getLeague(config.leagueId);
  const [matchups, projections, stats, clock] = await Promise.all([
    sleeper.getMatchups(config.leagueId, week),
    sleeper.getProjections(season, week, league.scoring_settings),
    sleeper.getStats(season, week),
    getGameClock(season, week),
  ]);
  const starters = new Map(matchups.map((m) => [m.roster_id, (m.starters || []).filter((p) => p && p !== '0')]));
  const kickoff = new Map();
  for (const g of clock.games) for (const t of g.teams) kickoff.set(t, g.kickoff / 1000);
  return { starters, projections, stats, kickoff };
}

/** Replace team-level entries with the player(s) who could have scored then. */
function attribute(ctx, ev, players, tdUsed) {
  return players.map((p) => {
    if (p.pos !== 'TEAM') return p;
    const live = (ctx.starters.get(p.roster_id) || []).filter((pid) => {
      const team = (ctx.projections.get(pid) || {}).team;
      const ko = ctx.kickoff.get(team);
      return ko !== undefined && ev.ts >= ko - 300 && ev.ts <= ko + GAME_WINDOW_SEC;
    });
    const info = (pid) => ctx.projections.get(pid) || { name: pid, pos: '' };
    if (live.length !== 1) {
      return live.length ? { ...p, candidates: live.map((pid) => info(pid).name) } : p;
    }
    const pid = live[0];
    const { name, pos } = info(pid);
    let play = null;
    // A TD-sized jump: if the player's final line has only one kind of TD, name it.
    if (p.delta_pts >= (pos === 'QB' ? 4 : 6)) {
      const st = ctx.stats.get(pid) || {};
      const kinds = TD_KEYS.filter((k) => st[k] > 0);
      const used = tdUsed.get(pid) || 0;
      if (kinds.length === 1 && used < st[kinds[0]]) {
        play = PLAY_LABELS[kinds[0]];
        tdUsed.set(pid, used + 1);
      }
    }
    return { player_id: pid, roster_id: p.roster_id, name, pos, delta_pts: p.delta_pts, play };
  });
}

const db = open();
const teams = new Map(db.prepare('SELECT roster_id, name FROM teams').all().map((t) => [t.roster_id, t.name]));
const weeks = db.prepare(`SELECT DISTINCT season, week FROM snapshots s
  WHERE NOT EXISTS (SELECT 1 FROM player_points p WHERE p.season = s.season AND p.week = s.week)`).all();

const insert = db.prepare(`INSERT INTO events (ts, season, week, matchup_id, roster_id, delta, win_prob, players_json, label, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')`);
const update = db.prepare(`UPDATE events SET ts = ?, roster_id = ?, delta = ?, win_prob = ?, players_json = ?, label = ? WHERE id = ?`);

async function main() {
for (const { season, week } of weeks) {
  db.exec('BEGIN');
  db.prepare(`DELETE FROM events WHERE season = ? AND week = ? AND source = 'backfill'`).run(season, week);
  const detector = new SwingDetector((e) => {
    const players = JSON.stringify(e.players);
    if (e.id === undefined) return Number(insert.run(e.ts, season, week, e.matchup_id, e.roster_id, e.delta, e.win_prob, players, e.label).lastInsertRowid);
    update.run(e.ts, e.roster_id, e.delta, e.win_prob, players, e.label, e.id);
    return e.id;
  });

  const rows = db.prepare(`SELECT ts, matchup_id, roster_id, points, win_prob FROM snapshots
    WHERE season = ? AND week = ? ORDER BY ts, matchup_id, roster_id`).iterate(season, week);
  const lastPts = new Map();
  let curTs = null;
  let byMatchup = new Map();
  const flush = () => {
    if (curTs === null) return;
    const input = [];
    for (const [mid, rs] of byMatchup) {
      if (rs.length !== 2) continue;
      const [a, b] = rs;
      const changes = [];
      for (const r of rs) {
        const prev = lastPts.get(r.roster_id);
        lastPts.set(r.roster_id, r.points);
        if (prev !== undefined && Math.abs(prev - r.points) > 1e-6) {
          changes.push({ player_id: `team:${r.roster_id}`, roster_id: r.roster_id, name: teams.get(r.roster_id) || `Team ${r.roster_id}`, pos: 'TEAM', delta_pts: r.points - prev });
        }
      }
      input.push({ matchup_id: mid, ra: a.roster_id, rb: b.roster_id, wpA: a.win_prob, changes });
    }
    // Projections reload every 10 minutes; we can't tell those ticks apart in
    // old data, so swings with no score change get the generic label.
    detector.tick(curTs, input);
    byMatchup = new Map();
  };
  for (const r of rows) {
    if (r.ts !== curTs) {
      flush();
      curTs = r.ts;
    }
    if (!byMatchup.has(r.matchup_id)) byMatchup.set(r.matchup_id, []);
    byMatchup.get(r.matchup_id).push(r);
  }
  flush();

  // Second pass: name the players.
  try {
    const ctx = await weekContext(season, week);
    const tdUsed = new Map();
    const evs = db.prepare(`SELECT id, ts, players_json FROM events WHERE season = ? AND week = ? AND source = 'backfill' ORDER BY ts`).all(season, week);
    const setPlayers = db.prepare('UPDATE events SET players_json = ? WHERE id = ?');
    for (const ev of evs) setPlayers.run(JSON.stringify(attribute(ctx, ev, JSON.parse(ev.players_json || '[]'), tdUsed)), ev.id);
  } catch (e) {
    console.warn(`Week ${week}: couldn't look up players (${e.message}); keeping team-level descriptions.`);
  }
  db.exec('COMMIT');
  const n = db.prepare(`SELECT COUNT(*) n FROM events WHERE season = ? AND week = ? AND source = 'backfill'`).get(season, week).n;
  console.log(`Season ${season} week ${week}: ${n} swing events saved`);
}
if (!weeks.length) console.log('Nothing to backfill: every recorded week has player-level data.');
}

main().catch((e) => {
  try { db.exec('ROLLBACK'); } catch {}
  console.error(e);
  process.exit(1);
});

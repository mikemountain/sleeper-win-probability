const BASE = 'https://api.sleeper.app';

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const getState = () => getJson(`${BASE}/v1/state/nfl`);
const getLeague = (id) => getJson(`${BASE}/v1/league/${id}`);
const getUsers = (id) => getJson(`${BASE}/v1/league/${id}/users`);
const getRosters = (id) => getJson(`${BASE}/v1/league/${id}/rosters`);
const getMatchups = (id, week) => getJson(`${BASE}/v1/league/${id}/matchups/${week}`);

/** Team display names: team_name from user metadata, falling back to display_name. */
async function getTeams(id) {
  const [users, rosters] = await Promise.all([getUsers(id), getRosters(id)]);
  const byUser = new Map(users.map((u) => [u.user_id, u]));
  return rosters.map((r) => {
    const u = byUser.get(r.owner_id) || {};
    return {
      roster_id: r.roster_id,
      name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
      owner: u.display_name || '',
      avatar: u.avatar || null,
    };
  });
}

/** Score a projected stat line with the league's scoring settings. */
function scoreStats(stats, scoring) {
  let pts = 0;
  for (const [k, v] of Object.entries(stats || {})) {
    const mult = scoring[k];
    if (typeof mult === 'number' && typeof v === 'number') pts += v * mult;
  }
  return pts;
}

/**
 * Returns Map(player_id -> { proj, team, name, pos }), with projections scored
 * using this league's own scoring settings.
 */
async function getProjections(season, week, scoring) {
  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `position[]=${p}`).join('&');
  const rows = await getJson(`${BASE}/projections/nfl/${season}/${week}?season_type=regular&${pos}`);
  const out = new Map();
  for (const r of rows) {
    const p = r.player || {};
    out.set(String(r.player_id), {
      proj: Math.max(0, scoreStats(r.stats, scoring)),
      team: r.team || null,
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      pos: (p.fantasy_positions || [])[0] || '',
    });
  }
  return out;
}

/** Live stat lines: Map(player_id -> stats). Sleeper's CDN caches this for up to 5 minutes. */
async function getStats(season, week) {
  const pos = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].map((p) => `position[]=${p}`).join('&');
  const rows = await getJson(`${BASE}/stats/nfl/${season}/${week}?season_type=regular&${pos}`);
  return new Map(rows.map((r) => [String(r.player_id), r.stats || {}]));
}

module.exports = { getState, getLeague, getTeams, getMatchups, getProjections, getStats, scoreStats };

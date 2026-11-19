// ESPN's public scoreboard has the game clock, which Sleeper does not expose.
const URL_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

// ESPN abbreviation -> Sleeper abbreviation where they differ.
const TO_SLEEPER = { WSH: 'WAS', LA: 'LAR' };

/**
 * Returns {
 *   fracLeft: Map(sleeperTeam -> fraction of game remaining, 0..1),
 *   anyLive, nextKickoff (ms or null), games: [...]
 * }
 * Teams missing from the scoreboard (bye week) are absent -> treated as 0 remaining.
 */
async function getGameClock(season, week) {
  const url = `${URL_BASE}?seasontype=2&week=${week}&dates=${season}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const j = await res.json();

  const fracLeft = new Map();
  const games = [];
  let anyLive = false;
  let nextKickoff = null;

  for (const ev of j.events || []) {
    const comp = ev.competitions[0];
    const st = comp.status;
    const state = st.type.state; // pre | in | post
    let frac;
    if (state === 'pre') frac = 1;
    else if (state === 'post') frac = 0;
    else {
      anyLive = true;
      const period = st.period || 1;
      const clock = Number(st.clock) || 0; // seconds left in the period
      frac = period <= 4 ? ((4 - period) * 900 + clock) / 3600 : 0.02; // OT: a little left
      frac = Math.min(1, Math.max(0.005, frac));
    }
    const kickoff = Date.parse(ev.date);
    if (state === 'pre' && (nextKickoff === null || kickoff < nextKickoff)) nextKickoff = kickoff;
    const teams = comp.competitors.map((c) => TO_SLEEPER[c.team.abbreviation] || c.team.abbreviation);
    for (const t of teams) fracLeft.set(t, frac);
    games.push({ teams, state, frac, detail: st.type.shortDetail, kickoff });
  }
  return { fracLeft, anyLive, nextKickoff, games };
}

module.exports = { getGameClock };

// Detects big win-probability swings and records what caused them.
//
// Each tick, every matchup reports its first team's win prob and the starters
// whose points changed since the last tick. A tick where something moved opens
// (or joins) a 60-second "cluster" for that matchup, because Sleeper sometimes
// posts the yards and the TD a second or two apart. Once a cluster's total swing
// reaches MIN_STORE it is saved as an event, and later ticks in the same
// cluster update it. The page decides which events to show using the
// viewer's own threshold from the settings page, so changing it applies to past events too.

const MIN_STORE = 0.02; // store every swing of 2+ points; the page filters further
const MERGE_SEC = 60;
const MOVE_EPS = 0.01; // a tick that moves win prob by 1+ point counts as "something happened"

const PLAY_LABELS = {
  pass_td: 'pass TD',
  rush_td: 'rush TD',
  rec_td: 'rec TD',
  fgm: 'FG',
  pass_int: 'INT thrown',
  fum_lost: 'fumble lost',
  def_td: 'D/ST TD',
  st_td: 'return TD',
  int: 'INT',
  safe: 'safety',
};

class SwingDetector {
  /** save(event) -> id; called for new events (event.id undefined) and updates. */
  constructor(save) {
    this.save = save;
    this.prev = new Map(); // matchup_id -> win prob of team A last tick
    this.clusters = new Map(); // matchup_id -> open cluster
  }

  /**
   * m: { matchup_id, ra, rb, wpA, changes: [{ player_id, roster_id, name, pos, delta_pts }] }
   * opts: { projReloaded }
   */
  tick(ts, matchups, opts = {}) {
    for (const m of matchups) {
      const prevWp = this.prev.get(m.matchup_id);
      this.prev.set(m.matchup_id, m.wpA);
      if (prevWp === undefined) continue; // first tick after start: just a baseline

      const dwp = m.wpA - prevWp;
      const scored = m.changes.filter((c) => Math.abs(c.delta_pts) > 1e-6);
      if (Math.abs(dwp) < MOVE_EPS && !scored.length) continue;

      let c = this.clusters.get(m.matchup_id);
      // A projection reload never merges with a scoring play, and vice versa.
      const kind = scored.length ? 'play' : opts.projReloaded ? 'proj' : 'clock';
      if (!c || ts - c.start > MERGE_SEC || (c.kind !== kind && (c.kind === 'proj' || kind === 'proj'))) {
        c = { start: ts, startWp: prevWp, kind, players: new Map(), peakTs: ts, peakMove: 0, id: undefined, m };
        this.clusters.set(m.matchup_id, c);
      }
      if (kind === 'play') c.kind = 'play';
      for (const s of scored) {
        const key = `${s.roster_id}:${s.player_id}`;
        const p = c.players.get(key) || { ...s, delta_pts: 0, play: null };
        p.delta_pts += s.delta_pts;
        c.players.set(key, p);
      }
      if (Math.abs(dwp) >= c.peakMove) {
        c.peakMove = Math.abs(dwp);
        c.peakTs = ts;
      }

      const total = m.wpA - c.startWp;
      if (Math.abs(total) < MIN_STORE && c.id === undefined) continue;
      const helpsA = total >= 0;
      const event = {
        id: c.id,
        ts: c.peakTs,
        matchup_id: m.matchup_id,
        roster_id: helpsA ? m.ra : m.rb,
        delta: Math.abs(total),
        win_prob: helpsA ? m.wpA : 1 - m.wpA,
        players: [...c.players.values()]
          .map((p) => ({ ...p, delta_pts: Math.round(p.delta_pts * 100) / 100 }))
          .sort((x, y) => Math.abs(y.delta_pts) - Math.abs(x.delta_pts)),
        label: c.kind === 'proj' ? 'Projection update' : c.kind === 'clock' ? 'Game clock / status change' : null,
      };
      c.id = this.save(event);
    }
  }
}

/** Human-readable description of a stored event. */
function describe(e) {
  const players = e.players || [];
  if (!players.length) return e.label || 'Swing';
  return players
    .slice(0, 3)
    .map((p) => {
      const pts = `${p.delta_pts > 0 ? '+' : ''}${p.delta_pts.toFixed(2)} pts`;
      if (p.pos === 'TEAM') return `${p.name} ${pts}${p.candidates ? ` (${p.candidates.join(' or ')})` : ''}`;
      if (p.play) return `${p.name} ${p.play} (${pts})`;
      // A defense starts each game with its points-allowed bonus (e.g. +10 for
      // 0 allowed), which isn't a play. The server sets defStart for these.
      if (p.defStart) return `${p.name} DEF started (${pts})`;
      const likelyTd = p.delta_pts >= (p.pos === 'QB' ? 4 : 6);
      return `${p.name} ${pts}${likelyTd ? ' (likely TD)' : ''}`;
    })
    .join(', ');
}

/**
 * Compare two stat snapshots (Map player_id -> stats) and return
 * [{ player_id, play }] for counters that went up.
 */
function diffPlays(before, after, playerIds) {
  const out = [];
  for (const pid of playerIds) {
    const a = before.get(pid);
    const b = after.get(pid);
    if (!a || !b) continue;
    for (const [key, label] of Object.entries(PLAY_LABELS)) {
      const n = (b[key] || 0) - (a[key] || 0);
      if (n > 0) out.push({ player_id: pid, play: n > 1 ? `${n} ${label}s` : label });
    }
  }
  return out;
}

module.exports = { SwingDetector, describe, diffPlays, MIN_STORE, PLAY_LABELS };

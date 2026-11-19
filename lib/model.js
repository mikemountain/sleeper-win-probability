// Win-probability model. Pure functions, so it is easy to tweak.
//
// Each starter:   remaining = projection * fraction of their NFL game left
//                 variance  = (sdFrac * projection)^2 * fraction left
// Team expected final = live points + sum(remaining); team variance = sum(variance)
// P(A wins) = Phi((E_A - E_B) / sqrt(Var_A + Var_B))

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/**
 * team: { points, starters: [player_id] }
 * projections: Map(id -> { proj, team })
 * fracLeft: Map(nflTeam -> 0..1)
 */
function teamOutlook(team, projections, fracLeft, sdFrac = 0.5) {
  let remaining = 0;
  let variance = 0;
  let playersLeft = 0;
  for (const pid of team.starters || []) {
    if (!pid || pid === '0') continue; // empty slot
    const p = projections.get(String(pid));
    if (!p || !p.team) continue;
    const f = fracLeft.get(p.team) ?? 0; // not on the scoreboard = bye
    if (f <= 0) continue;
    playersLeft++;
    remaining += p.proj * f;
    // floor of 2 pts so a zero-projection starter still adds some uncertainty
    variance += (sdFrac * Math.max(p.proj, 2)) ** 2 * f;
  }
  const points = Number(team.points) || 0;
  return { points, expected: points + remaining, variance, playersLeft };
}

function winProb(a, b) {
  const v = a.variance + b.variance;
  if (v < 1e-9) {
    if (Math.abs(a.points - b.points) < 1e-9) return 0.5;
    return a.points > b.points ? 1 : 0;
  }
  return normCdf((a.expected - b.expected) / Math.sqrt(v));
}

module.exports = { teamOutlook, winProb, normCdf };

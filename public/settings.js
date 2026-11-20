// The viewer's own settings: look, team colors and how big a swing must be to get
// a marker. All saved in this browser only (localStorage), so every viewer can set
// things up their way. There are no league-wide settings.
const { css, matchupColors, mine, setMine, threshold, setThreshold, DEFAULT_THRESHOLD } = window.TeamColors;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null; // { teams, pairs } from the server
let myColors = mine();

// Look tiles: each tile carries its own data-look, so it previews that look's
// page color, ink, type and two team colors.
function renderLooks() {
  const box = $('look-tiles');
  box.innerHTML = '';
  for (const l of window.Looks.list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look-tile';
    b.dataset.look = l.id;
    b.setAttribute('aria-pressed', String(l.id === window.Looks.current()));
    b.innerHTML = `<span class="lt-name">${esc(l.label)}</span>
      <span class="lt-bars"><i style="background:var(--team-a)"></i><i style="background:var(--team-b)"></i></span>`;
    b.onclick = () => window.Looks.set(l.id);
    box.appendChild(b);
  }
}

// The color a team is drawn in when this viewer hasn't picked one: the look's
// default for its side of this week's matchup.
function baseColor(t) {
  const pair = state.pairs.find((p) => p.includes(t.roster_id));
  const second = pair && Math.min(...pair) !== t.roster_id; // the server draws the lower roster id first
  return css(second ? '--team-b' : '--team-a');
}

function renderTeams() {
  const box = $('teams');
  box.innerHTML = state.teams.map((t) => {
    const own = myColors[t.roster_id];
    const tag = own ? 'your color' : 'default';
    return `<div class="team-row" data-id="${t.roster_id}">
      <input type="color" value="${own || baseColor(t)}" aria-label="Color for ${esc(t.name)}">
      <div><div class="name">${esc(t.name)}<span class="default-tag">${tag}</span></div>
      <div class="owner">${esc(t.owner || '')}</div></div>
      <button class="btn reset" ${own ? '' : 'disabled'}>Reset</button>
    </div>`;
  }).join('');
  for (const row of box.children) {
    const id = Number(row.dataset.id);
    const input = row.querySelector('input');
    input.oninput = () => { myColors[id] = input.value; setMine(myColors); renderClashes(); };
    input.onchange = () => renderTeams();
    row.querySelector('.reset').onclick = () => { delete myColors[id]; setMine(myColors); renderTeams(); };
  }
  $('reset-all').hidden = !Object.keys(myColors).length;
  renderClashes();
}

function renderClashes() {
  const byId = new Map(state.teams.map((t) => [t.roster_id, t]));
  const color = (id) => myColors[id] || baseColor(byId.get(id));
  const msgs = [];
  for (const [ra, rb] of state.pairs) {
    if (!byId.has(ra) || !byId.has(rb)) continue;
    const [a, b] = ra < rb ? [ra, rb] : [rb, ra];
    if (matchupColors({ color: color(a) }, { color: color(b) }).fallback) {
      msgs.push(`${esc(byId.get(a).name)} and ${esc(byId.get(b).name)} play each other this week and their colors are too similar, so ${esc(byId.get(b).name)} will be drawn in a default color. Change one of them to fix it.`);
    }
  }
  $('clashes').innerHTML = msgs.map((m) => `<div class="warn">${m}</div>`).join('');
}

$('reset-all').onclick = () => { myColors = {}; setMine(myColors); renderTeams(); };

window.Looks.onChange(() => {
  renderLooks();
  if (state) renderTeams(); // look defaults differ
});

renderLooks();

function renderThreshold() {
  const t = threshold();
  $('threshold').value = t;
  $('threshold-val').textContent = `${t}%`;
  $('threshold-reset').hidden = t === DEFAULT_THRESHOLD;
}
$('threshold').oninput = (e) => { setThreshold(Number(e.target.value)); renderThreshold(); };
$('threshold-reset').onclick = () => { setThreshold(DEFAULT_THRESHOLD); renderThreshold(); };
renderThreshold();

fetch('api/teams')
  .then((r) => r.json())
  .then((s) => { state = s; renderTeams(); })
  .catch((e) => { $('teams').textContent = `Couldn't load the teams: ${e.message}`; });

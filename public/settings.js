const { css, matchupColors } = window.TeamColors;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = null; // { teams, eventThreshold, pairs }
const colors = new Map(); // roster_id -> '#hex' or null (default)

function renderTeams() {
  const box = $('teams');
  box.innerHTML = state.teams.map((t) => {
    const c = colors.get(t.roster_id);
    return `<div class="team-row" data-id="${t.roster_id}">
      <input type="color" value="${c || css('--muted')}" aria-label="Color for ${esc(t.name)}">
      <div><div class="name">${esc(t.name)}${c ? '' : '<span class="default-tag">default</span>'}</div>
      <div class="owner">${esc(t.owner || '')}</div></div>
      <button class="btn reset" ${c ? '' : 'disabled'}>Reset</button>
    </div>`;
  }).join('');
  for (const row of box.children) {
    const id = Number(row.dataset.id);
    row.querySelector('input').oninput = (e) => { colors.set(id, e.target.value); renderClashes(); };
    row.querySelector('input').onchange = () => renderTeams();
    row.querySelector('.reset').onclick = () => { colors.set(id, null); renderTeams(); };
  }
  renderClashes();
}

function renderClashes() {
  const byId = new Map(state.teams.map((t) => [t.roster_id, t]));
  const msgs = [];
  for (const [ra, rb] of state.pairs) {
    const ca = colors.get(ra);
    const cb = colors.get(rb);
    if (!ca || !cb) continue;
    if (matchupColors({ color: ca }, { color: cb }).fallback) {
      msgs.push(`${esc(byId.get(ra).name)} and ${esc(byId.get(rb).name)} play each other this week and their colors are too similar. The second team will be drawn in a default color until you change one.`);
    }
  }
  $('clashes').innerHTML = msgs.map((m) => `<div class="warn">${m}</div>`).join('');
}

function renderThreshold() {
  $('threshold').value = state.eventThreshold;
  $('threshold-val').textContent = `${state.eventThreshold}%`;
}

async function load() {
  state = await (await fetch('api/settings')).json();
  colors.clear();
  for (const t of state.teams) colors.set(t.roster_id, t.color || null);
  renderTeams();
  renderThreshold();
}

$('threshold').oninput = (e) => { state.eventThreshold = Number(e.target.value); renderThreshold(); };
$('save').onclick = async () => {
  $('saved').textContent = 'Saving…';
  const res = await fetch('api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ colors: Object.fromEntries(colors), eventThreshold: state.eventThreshold }),
  });
  const body = await res.json();
  if (!res.ok) { $('saved').textContent = `Couldn't save: ${body.error}`; return; }
  state = body;
  $('saved').textContent = 'Saved';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
};

load().catch((e) => { $('teams').textContent = `Error: ${e.message}`; });

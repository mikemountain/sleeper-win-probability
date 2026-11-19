// Settings: config.json (committed defaults), overridden by config.local.json
// (git-ignored, for your league ID) and then by environment variables.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => {
  const p = path.join(ROOT, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
};

const config = { ...read('config.json'), ...read('config.local.json') };
if (process.env.SLEEPER_LEAGUE_ID) config.leagueId = process.env.SLEEPER_LEAGUE_ID;

if (!config.leagueId) {
  console.error(
    'No Sleeper league ID set. Create config.local.json next to config.json containing\n' +
      '  { "leagueId": "<your league id>" }\n' +
      'or set the SLEEPER_LEAGUE_ID environment variable.'
  );
  process.exit(1);
}

module.exports = config;

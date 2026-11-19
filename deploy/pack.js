// Builds dist/winprob-deploy.tgz: the app plus a clean copy of your database,
// ready to copy to the droplet. Run from the project folder: node deploy/pack.js
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage', 'sleeper-winprob');
const OUT = path.join(DIST, 'winprob-deploy.tgz');
const INCLUDE = ['collector.js', 'server.js', 'backfill-events.js', 'config.json', 'config.local.json', 'README.md', 'DEPLOY.md', 'lib', 'public', 'deploy'];

fs.rmSync(path.join(DIST, 'stage'), { recursive: true, force: true });
fs.rmSync(OUT, { force: true });
fs.mkdirSync(path.join(STAGE, 'data'), { recursive: true });

for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(STAGE, item), { recursive: true });
}

// A consistent snapshot of the database, even if the collector is running.
const dbFile = path.join(ROOT, 'data', 'winprob.db');
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec(`VACUUM INTO '${path.join(STAGE, 'data', 'winprob.db').replace(/'/g, "''")}'`);
  db.close();
}

// Relative paths: GNU tar (Git Bash) would read "C:" as a remote host.
const tar = spawnSync('tar', ['-czf', 'winprob-deploy.tgz', '-C', 'stage', 'sleeper-winprob'], { cwd: DIST, stdio: 'inherit' });
if (tar.status !== 0) throw new Error('tar failed');
fs.rmSync(path.join(DIST, 'stage'), { recursive: true, force: true });
const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`Built ${OUT} (${mb} MB)`);

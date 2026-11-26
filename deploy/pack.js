// Builds dist/winprob-deploy.tgz, ready to copy to the droplet.
// Run from the project folder:
//   node deploy/pack.js            app + a clean copy of your database (first install)
//   node deploy/pack.js --app-only app only (updates; the droplet keeps its own database)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage', 'sleeper-winprob');
const OUT = path.join(DIST, 'winprob-deploy.tgz');
const INCLUDE = ['collector.js', 'server.js', 'backfill-events.js', 'config.json', 'config.local.json', 'config.local.example.json', 'README.md', 'DEPLOY.md', 'lib', 'public', 'deploy'];
const appOnly = process.argv.includes('--app-only');

// Stamp the build so you can tell what's running on the droplet (/winprob/api/meta).
// A build with uncommitted changes is marked "-modified" so it's never mistaken for a commit.
const git = (...args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const commit = (git('rev-parse', '--short', 'HEAD').stdout || 'unknown').trim();
const dirty = (git('status', '--porcelain', '--untracked-files=no').stdout || '').replace(/\s+$/, '');
const version = `${commit}${dirty ? '-modified' : ''} ${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`;
if (dirty) {
  console.warn('Warning: this build includes uncommitted changes:');
  console.warn(dirty.split('\n').map((l) => `  ${l}`).join('\n'));
}

fs.rmSync(path.join(DIST, 'stage'), { recursive: true, force: true });
fs.rmSync(OUT, { force: true });
fs.mkdirSync(path.join(STAGE, 'data'), { recursive: true });

for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(STAGE, item), { recursive: true });
}
fs.writeFileSync(path.join(STAGE, 'VERSION'), `${version}\n`);

// A consistent snapshot of the database, even if the collector is running.
// Only used on a first install; setup.sh never replaces a database already on the droplet.
const dbFile = path.join(ROOT, 'data', 'winprob.db');
if (!appOnly && fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec(`VACUUM INTO '${path.join(STAGE, 'data', 'winprob.db').replace(/'/g, "''")}'`);
  db.close();
}

// Relative paths: GNU tar (Git Bash) would read "C:" as a remote host.
const tar = spawnSync('tar', ['-czf', 'winprob-deploy.tgz', '-C', 'stage', 'sleeper-winprob'], { cwd: DIST, stdio: 'inherit' });
if (tar.status !== 0) throw new Error('tar failed');
fs.rmSync(path.join(DIST, 'stage'), { recursive: true, force: true });
const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`Built ${OUT} (${mb} MB, ${appOnly ? 'app only' : 'app + database'}), version ${version}`);

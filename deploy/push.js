// One-command update of the droplet from your PC:
//   node deploy/push.js USER@DROPLET_IP
// Builds the package (app only; the droplet keeps its own database), copies it
// over with scp, then runs setup.sh there over ssh. setup.sh replaces the app
// code exactly and checks the website is serving the new version.
//
// First install, to bring over the history recorded on your PC as well:
//   node deploy/push.js USER@DROPLET_IP --with-db
//
// The host can also come from the WINPROB_HOST environment variable or a
// "deployHost" entry in config.local.json. Uses your normal ssh/scp setup;
// you'll be asked for your sudo password on the droplet if it needs one.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const withDb = args.includes('--with-db');

let localConfig = {};
try { localConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.local.json'), 'utf8')); } catch { /* optional */ }
const host = args.find((a) => !a.startsWith('--')) || process.env.WINPROB_HOST || localConfig.deployHost;
if (!host) {
  console.error('Usage: node deploy/push.js USER@DROPLET_IP [--with-db]');
  console.error('(or set WINPROB_HOST, or "deployHost" in config.local.json)');
  process.exit(1);
}

function run(cmd, cmdArgs) {
  console.log(`\n> ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error(`\n${cmd} failed (exit ${r.status}). Nothing after this step ran.`);
    process.exit(r.status || 1);
  }
}

run(process.execPath, [path.join('deploy', 'pack.js'), ...(withDb ? [] : ['--app-only'])]);
run('scp', [path.join('dist', 'winprob-deploy.tgz'), `${host}:/tmp/winprob-deploy.tgz`]);
// A fresh folder each time, so nothing left over from an earlier unpack gets installed.
run('ssh', ['-t', host, [
  'set -e',
  'cd /tmp',
  'rm -rf sleeper-winprob',
  'tar -xzf winprob-deploy.tgz',
  'sudo bash sleeper-winprob/deploy/setup.sh',
  'rm -rf sleeper-winprob winprob-deploy.tgz',
].join(' && ')]);
console.log('\nDone.');

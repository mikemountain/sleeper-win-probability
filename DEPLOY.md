# Putting the tracker on your DigitalOcean droplet

Once this is done, the droplet runs two background services: the collector and the website. They start on boot and restart themselves if they crash. Your league opens **https://yoursite.com/winprob/**. Each viewer picks their own look, team colors and swing size on the Settings page; those choices stay in their browser.

Replace `USER@DROPLET_IP` below with how you normally SSH in (e.g. `root@203.0.113.10`). The commands assume Ubuntu or Debian on the droplet, with nginx already serving your site.

**Already installed? Skip to [Updating](#updating): it's one command.**

## 1. On your PC: build the package

Stop the local collector first (Ctrl+C in its window), so no new data is recorded after the snapshot. Then, in PowerShell:

```bash
cd "C:\Users\micha\claude projects\sleeper-winprob"
```

```bash
node deploy\pack.js
```

This builds `dist\winprob-deploy.tgz`, containing the app and a copy of everything recorded so far. Each build is stamped with the git commit it came from; the stamp ends in `-modified` if you had uncommitted changes.

## 2. Copy it to the droplet

```bash
scp dist\winprob-deploy.tgz USER@DROPLET_IP:/tmp/
```

## 3. On the droplet: install

```bash
ssh USER@DROPLET_IP
```

Then, on the droplet:

```bash
cd /tmp && rm -rf sleeper-winprob && tar -xzf winprob-deploy.tgz && sudo bash sleeper-winprob/deploy/setup.sh
```

This script:
- installs Node 24 if needed
- creates a `winprob` system user
- copies the app to `/opt/sleeper-winprob`
- starts both services
- puts the nginx snippet at `/etc/nginx/snippets/winprob.conf`

## 4. Hook it into your site (first time only)

Open your site's nginx config. It's usually `/etc/nginx/sites-available/default` or `/etc/nginx/sites-available/yoursite`. Add this one line inside the `server { ... }` block that serves your domain (the one with `listen 443 ssl` if you use HTTPS):

```nginx
include snippets/winprob.conf;
```

Then test and reload:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Open https://yoursite.com/winprob/ and the charts should be there. Link to it from any page of your site.

> **If yoursite.com is still served from S3/CloudFront**, nginx on the droplet never sees those requests. In that case, point a subdomain like `winprob.yoursite.com` at the droplet, or add a CloudFront behavior for `/winprob/*` that uses the droplet as its origin.

## Updating

From PowerShell on your PC, in the project folder:

```powershell
node deploy\push.js USER@DROPLET_IP
```

This builds the package (app only), copies it over, and runs `setup.sh` on the droplet. You may be asked for your droplet password and your sudo password. `setup.sh` then:
- **replaces the app code exactly.** Anything edited or added in `/opt/sleeper-winprob` on the droplet is removed, so the droplet runs exactly what's in your project folder. Make changes on your PC and commit them, not on the droplet.
- **keeps the database** (`data/`). Your `config.local.json` is copied over too.
- **restarts both services**, then checks the website reports the new version. It prints `Website is running version …` when it worked.

To skip typing the address each time, add `"deployHost": "USER@DROPLET_IP"` to `config.local.json`, then just run `node deploy\push.js`.

**Which version is live?** Open `https://yoursite.com/winprob/api/meta`. `version` shows the commit and build time; it should match `git log -1` on your PC.

## Day to day

- **Nothing to start:** the collector runs all week. It checks once a minute when there are no games and once a second during games. It follows the weeks into your playoffs on its own.
- **After the championship:** once Sleeper marks the league complete, or the NFL moves into its postseason, the collector logs "Season complete" and stops recording. It then rechecks once an hour. The website keeps showing the whole season's history.
- **Live log:**

  ```bash
  journalctl -u winprob-collector -f
  ```

- **Restart both services:**

  ```bash
  sudo systemctl restart winprob-collector winprob-web
  ```

- **Backups:** the history lives in `/opt/sleeper-winprob/data/winprob.db`.
- **Don't double-collect:** don't run the collector on your PC as well. It would write to a separate, local database that the website never sees.

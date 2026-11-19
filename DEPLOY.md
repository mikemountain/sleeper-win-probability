# Putting the tracker on your DigitalOcean droplet

Once this is done, the droplet runs two background services: the collector and the website. They start on boot and restart themselves if they crash. Your league opens **https://yoursite.com/winprob/**, and the settings page is only reachable through an SSH tunnel.

Replace `USER@DROPLET_IP` below with how you normally SSH in (e.g. `root@203.0.113.10`). The commands assume Ubuntu or Debian on the droplet, with nginx already serving your site.

## 1. On your PC: build the package

Stop the local collector first (Ctrl+C in its window), so no new data is recorded after the snapshot. Then, in PowerShell:

```bash
cd "C:\Users\micha\claude projects\sleeper-winprob"
```

```bash
node deploy\pack.js
```

This builds `dist\winprob-deploy.tgz`, containing the app and a copy of everything recorded so far.

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
cd /tmp && tar -xzf winprob-deploy.tgz && sudo bash sleeper-winprob/deploy/setup.sh
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

## Changing settings (team colors, swing threshold)

The public page has no settings. To change them, open a tunnel from your PC:

```bash
ssh -L 3117:127.0.0.1:3117 USER@DROPLET_IP
```

While that's connected, open http://localhost:3117/settings.html on your PC. Changes show up on the public page right away.

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

- **Updating the code later:** repeat steps 1–3. The database already on the droplet is kept, so the copy in the package is ignored.
- **Backups:** the history lives in `/opt/sleeper-winprob/data/winprob.db`.
- **Don't double-collect:** don't run the collector on your PC as well. It would write to a separate, local database that the website never sees.

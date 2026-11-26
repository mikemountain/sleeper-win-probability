# Sleeper win probability tracker

Logs a win probability for every matchup in the league once a second during games, and shows the history as charts on a local website. Needs only Node (no `npm install`).

## Set your league

Copy `config.local.example.json` to `config.local.json` and put your Sleeper league ID in it. The ID is the number in your league's URL, `sleeper.com/leagues/<id>`. That file is git-ignored. Alternatively, set the `SLEEPER_LEAGUE_ID` environment variable.

## Use it

- **Collector:** double-click `start-collector.cmd` (or run `node collector.js`). Leave the window open while games are on.
  - Stop it any time with Ctrl+C or by closing the window. Start it again later and it keeps appending to the same week.
  - When no NFL game is live or starting within 15 minutes, it checks once a minute and only saves changes. That means you can also just leave it running all week.
- **Website:** double-click `start-site.cmd` (or run `node server.js`), then open http://localhost:3000. While the collector is running, the page refreshes itself every 15 seconds (paused while the tab is in the background).

- **Bigger charts and zoom:** click a chart to open that matchup across most of the screen. Drag across any chart to zoom into that stretch of time at full detail (down to one point a second); drag again to zoom further, double-click or Zoom out to back out. Links like `/#m=3` open a matchup straight away.
- **Swing markers:** dots on each chart, plus a "Big swings" list underneath, show when a team's win chance jumped and which player caused it. A play type such as "rec TD" or "FG" is added within a few minutes, once Sleeper's stats feed catches up. Until then a big jump says "(likely TD)".
- **Your settings** (Settings link at the top of the page): pick a look, your own team colors, and how big a swing needs to be before it gets a marker (default 5%). All saved in your browser only; nobody else sees them. The looks are Broadcast (TV graphics), Paper (newspaper sports page), Scoreboard (stadium board), Trading card (1970s football card), Riso (two-ink zine print) or Teletext (1980s TV text page).
- **Weeks recorded before swing tracking:** run `node backfill-events.js` once to give them team-level markers.

Data is stored in `data/winprob.db` (SQLite). Back up that one file to keep your history.

## How the probability is calculated

Sleeper doesn't publish the win probability shown in its app, so this computes its own (`lib/model.js`):

- Each starter's remaining points = their projection (scored with this league's settings) × the fraction of their NFL game still to play. The game clock comes from ESPN's public scoreboard.
- A team's expected final = live points + the sum of its starters' remaining points. Uncertainty shrinks as games run down.
- Win % comes from a normal distribution of the projected margin between the two teams.

Change `playerSdFraction` in `config.json` to make the curves swingier (higher) or steadier (lower).

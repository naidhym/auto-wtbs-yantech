# Production Runbook

## Prerequisites

- Node.js 22.13.0 or newer (`.nvmrc` pins a compatible Node 22 release).
- A dedicated deployment directory for Auto WTB Bot.
- Telegram API credentials and Admin Bot credentials stored only in `.env`.
- Telegram user accounts must already have legitimate access to every assigned broadcast channel. The service never auto-joins channels.

## Install and verify

```bash
npm ci
npm run check
npm run build
```

Copy `.env.example` to `.env`, fill the required values, and keep the file outside source control and deployment archives.

## PM2

```bash
npx pm2 start ecosystem.config.cjs
npx pm2 save
npx pm2 status auto-wtb-bot
```

The PM2 definition uses one fork-mode instance. Multiple process instances are not supported because Telegram listeners and SQLite dispatch claims belong to one runtime. PM2 allows 15 seconds for graceful shutdown; the application default drain timeout is 10 seconds.

## Shutdown and restart

```bash
npx pm2 stop auto-wtb-bot
npx pm2 restart auto-wtb-bot
```

Shutdown order is Admin Bot, channel subscriptions, in-flight automation, Telegram clients, SQLite, then logger. Do not copy the database while the process is running.

## Backup

1. Stop `auto-wtb-bot` through PM2.
2. Copy `.env`, `data/auto-wtb.sqlite`, and the entire `data/sessions/` tree to encrypted storage.
3. Preserve file permissions and keep each `data/sessions/<account-key>/` directory together.
4. Start the service and verify `/start` → Status plus listener startup logs.

Application logs are optional audit evidence and are not required to restore configuration or sessions.

## Restore

1. Install the exact source package and run `npm ci` plus `npm run build`.
2. Keep the process stopped.
3. Restore `.env`, the SQLite file, and `data/sessions/` to the configured paths.
4. Preserve account-key directory names; never move one session into another account directory.
5. Start through PM2 and verify migration version, restored accounts, assignments, listeners, and automation state.

Migration startup is transactional and idempotent. Persistent dispatch claims prevent a duplicate reply when Telegram re-delivers an already processed source update after restart.

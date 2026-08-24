# Auto WTB Bot

Standalone service untuk memonitor channel Telegram dengan rule per-channel dan konfigurasi keyword global.

> Status: **M6 FINAL COMPLETE**. Auto reply hanya dieksekusi dari Telegram broadcast channel post yang lolos seluruh safety gate.

## Isolation guarantee

Project ini tidak membaca atau mengubah source, configuration, database, maupun session milik UBOT atau WTB Bot existing.

- PM2 process: `auto-wtb-bot`
- Default database: `./data/auto-wtb.sqlite`
- Default Telegram session directory: `./data/sessions`
- Default application log directory: `./logs`
- Telegram user client dan Admin Bot memakai adapter dan credential boundary berbeda
- `.env`, database, session, logs, dependencies, dan build output tidak masuk Git

## Stack

- Node.js 22.13.0+ (`.nvmrc`: 22.23.2)
- TypeScript 6.0.3
- GramJS 2.26.22 (`telegram`)
- Telegraf 4.16.3
- SQLite melalui built-in `node:sqlite` / `DatabaseSync`
- Pino 10.3.1
- Zod 4.4.3
- PM2 7.0.3

Versi compatibility-sensitive dikunci di `package.json` dan `package-lock.json`.

## Setup

```bash
npm ci
cp .env.example .env
npm run check
npm run build
npm start
```

Minimal `.env` untuk menjalankan foundation tanpa Admin Bot:

```env
NODE_ENV=production
LOG_LEVEL=info
ADMIN_BOT_ENABLED=false
```

Untuk mengaktifkan Admin Bot dan login user account:

```env
ADMIN_BOT_ENABLED=true
ADMIN_BOT_TOKEN=telegram_bot_token
OWNER_TELEGRAM_ID=123456789
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=telegram_application_api_hash
```

`ADMIN_BOT_TOKEN` dan `OWNER_TELEGRAM_ID` wajib ketika Admin Bot aktif. User selain exact Owner ID mendapat `Access denied`.

## Production runtime

Urutan startup:

1. Validasi Node.js 22.13.0+ dan environment.
2. Membuat directory database, Telegram session, dan logs.
3. Membuka dedicated SQLite database.
4. Menjalankan migration yang belum pernah diterapkan.
5. Membuat account/session manager untuk Owner yang dikonfigurasi.
6. Restore session semua account enabled secara independen.
7. Menjalankan Admin Bot bila diaktifkan sebagai Owner-only control panel.
8. Menjalankan listener assignment account/channel yang efektif secara terisolasi dan meneruskan channel post ke pipeline automation.
9. Menunggu `SIGINT` atau `SIGTERM`.

Urutan shutdown:

1. Stop Admin Bot.
2. Stop semua listener channel secara independen.
3. Cancel dan drain seluruh in-flight automation task.
4. Cancel login aktif dan destroy semua GramJS client secara independen.
5. Close SQLite.
6. Flush dan close application log.

`uncaughtException` dan `unhandledRejection` dicatat sebagai fatal error, kemudian memicu graceful shutdown sebelum exit code 1.

## Admin Bot button-first UX

`/start` adalah entry point dan menampilkan menu lengkap:

- `👤 Accounts`
- `📡 Channels`
- `📋 Rules`
- `📝 Reply Templates`
- `📊 Status`
- `❤️ Health`

Menu `📋 Rules` menyediakan `🎯 Trigger Keywords`, `🚫 Exclude Keywords`, `🧹 Cleanup Patterns`, `💬 Reply Templates`, `⚙️ Settings / Status`, Add Rule, daftar rule, Refresh, dan Back. Input global dipisahkan koma, di-trim, nilai kosong diabaikan, dideduplikasi, dan disimpan lower-case.

CRUD rule per-channel, enable/disable, dan cleanup sender-name pattern tetap aktif. Reply Template sekarang dimiliki satu Telegram account dan dikelola dari `Accounts → account detail → 💬 Reply Templates`; rule hanya dapat menghubungkan template milik account yang ditugaskan ke channel rule. Flow account/session serta channel M1–M3 tidak diubah. Admin Bot tidak join channel; user account yang ditugaskan tetap harus sudah memiliki akses.

Account detail juga menyediakan Reply Delay, Auto Reaction, Auto Reply Settings, dan Limits. Channel detail menampilkan status `BLOCKED` serta manual Resume. Menu utama menyediakan persistent `STOP ALL`/`RESUME ALL` tanpa menghapus configuration.

Logs dashboard dan statistics UI belum diimplementasikan.

## GramJS foundation

`GramJsClientService` menyediakan lifecycle, auth, channel resolve, dan scoped subscription adapter:

- `connect()`
- `disconnect()`
- `reconnect()`
- `getStatus()`
- `authenticate()`
- `isAuthorized()`
- `exportSession()`
- `resolveChannel()`
- `subscribeChannel()`

Satu instance mewakili satu `accountKey`; tidak ada singleton client bersama. Session disimpan atomik sebagai `data/sessions/<account-key>/telegram.session`, tidak di SQLite, dan dimuat hanya ke client dengan key yang sama. Kegagalan restore/reconnect menggunakan `Promise.allSettled` atau catch per-account agar tidak menghentikan client lain.

## Database

Migration v1 membuat schema foundation. Migration v2 menambahkan nomor telepon account. Migration v3 mengubah channel menjadi entity global dan menambahkan `account_channels` many-to-many. Migration v4 menyediakan rules/reply templates. Migration v5 mengubah Reply Template menjadi account-scoped. Migration v6 menambahkan per-account automation settings, persistent dispatch/deduplication, channel-level cleanup block, dan global emergency state tanpa memindahkan data M1–M5.

## Final execution contract

- Hanya event GramJS yang lolos sebagai broadcast channel post (`broadcast=true`, `post=true`, dan Telegram channel ID cocok) yang diproses.
- Group, supergroup, discussion/comment, private/DM, unknown event, dan channel identity mismatch dicatat sebagai `non_channel_ignored` lalu dihentikan sebelum matching.
- Text dinormalisasi NFKC, case-insensitive, punctuation/whitespace dasar.
- `ANY exclude matched` menghasilkan `EXCLUDED` dan menang atas trigger.
- Jika tidak ada exclude, `ANY trigger matched` menghasilkan `MATCH`; tanpa trigger menghasilkan `IGNORE` tanpa action.
- Cleanup pattern global dan per-rule diperiksa terhadap sender/display name dan hanya menghasilkan `CLEANUP_MATCH`.
- Rule per-channel yang enabled tetap dievaluasi setelah hard channel-only guard.
- Log match/exclude menyimpan account, channel, dan keyword yang cocok tanpa menyimpan isi pesan.
- Satu source message diklaim secara persistent dengan unique `(channel_id, source_message_id)` sebelum delay, sehingga listener/reconnect/restart tidak menggandakan reply.
- Account dipilih deterministik dari assignment efektif dengan urutan assignment ID; enabled template yang terhubung ke enabled channel rule diprioritaskan, lalu enabled template dengan ID terendah milik account tersebut.
- Delay disimpan sebagai integer milliseconds dan menerima input 0–600 detik termasuk decimal.
- Cooldown, hourly limit, dan rolling 24-hour daily limit diterapkan per account sebelum send.
- Reply dikirim sebagai Telegram channel comment memakai `commentTo`; source dan sent reply message ID langsung disimpan, sedangkan direct reply link disimpan jika tersedia.
- Reaction ❤️ opsional dan non-fatal: unsupported menjadi `SKIPPED`, error reaction menjadi `FAILED`, sedangkan reply tetap `SUCCESS`.
- Cleanup sender-name match memblokir channel secara persistent dan menghentikan listener seluruh assignment channel sampai Owner melakukan Resume.
- Successful/failed reply dikirim oleh Telegram userbot yang melakukan aksi ke Monitoring Bot target yang dikonfigurasi per account. Notification sukses selalu menautkan source WTB post; reply message ID dan optional reply/comment link tetap disimpan hanya untuk audit. Cleanup block tetap memberi safety notification ke Owner/Admin Bot.

Adapter memakai `node:sqlite`, sehingga instalasi SQLite tidak menjalankan `node-gyp` dan tidak memerlukan Python atau Visual Studio Build Tools. Karena `node:sqlite` berjalan tanpa flag mulai Node.js 22.13.0, versi tersebut menjadi minimum runtime.

Detail kolom dan foreign key ada di [docs/DATABASE_SCHEMA.md](docs/DATABASE_SCHEMA.md).

## Commands

```bash
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
npm run check
npm start
```

Untuk production dengan PM2:

```bash
npm run build
npx pm2 start ecosystem.config.cjs
```

Deployment, shutdown, backup, dan restore dijelaskan di [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Milestone status

M6 adalah milestone final dan sudah selesai. Tidak ada milestone M7. Lihat [docs/MILESTONES.md](docs/MILESTONES.md).

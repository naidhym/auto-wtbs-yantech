# Architecture Boundary

## Runtime separation

Sistem dirancang sebagai satu project mandiri dengan dua adapter Telegram yang tidak saling bertukar kredensial atau session.

1. **Telegram user client (GramJS)**
   - Setiap account memiliki instance `GramJsClientService` dan adapter GramJS sendiri.
   - Setiap instance memiliki unique `accountKey` dan session file sendiri.
   - `AccountManagerService` mengisolasi OTP/2FA waiter, timeout, cancellation, restore, dan reconnect per account.
   - Tidak boleh menggunakan token Admin Bot.

2. **Admin Bot (Telegraf)**
   - Menyediakan startup/stop, Owner ID guard, button-first health/account UI, dan login conversation M2.
   - Semua message dan callback query melewati pemeriksaan exact `Owner ID` sebelum handler.
   - M4 menyediakan menu Rules lengkap: global trigger/exclude/cleanup, per-channel rules, dan status; Reply Template per-account dikelola dari detail account.
   - M5 menyediakan per-account reply safety settings, channel Resume, serta emergency STOP/RESUME.
   - Tidak boleh menggunakan GramJS session account.

3. **Application/domain modules**
   - Menjadi tempat use case accounts, channels, rules, logs, dan statistics.
   - Adapter Telegram tidak boleh mengakses tabel tanpa repository/service boundary.

4. **Dedicated SQLite storage**
   - Lokasi default `./data/auto-wtb.sqlite`.
   - Adapter memakai built-in `node:sqlite` / `DatabaseSync`; minimum runtime Node.js 22.13.0.
   - Tidak ada fallback menuju path database project lain.
   - M1 menggunakan transactional versioned migrations.

## Target module ownership

| Modul | Milestone | Tanggung jawab |
| --- | --- | --- |
| `database` | M1 | Connection, migration, transaction, repository base |
| `accounts` | M2 | Owner-scoped account CRUD/nickname, login state, dan session storage |
| `user-client` | M1–M6 | Per-account GramJS lifecycle/auth, scoped subscription, channel comment/reaction, dan Saved Messages notification |
| `channels` | M3 | Independent channel registry, many-to-many assignments, validation, isolated listener lifecycle |
| `rules` | M4 | Global config, per-channel rule CRUD, account-scoped reply templates, normalized matching, dan hard channel-only guard |
| `admin-bot` | M1–M6 | Owner guard, account/channel/rule UI, settings, dan emergency controls |
| `automation` | M5–M6 | Deterministic dispatch, delay, reply/reaction, dedup, limits, account notification, dan safety guard |
| `logs` | M3–M6 | Audit event dengan ownership scope |
| `statistics` | M4–M6 | Agregasi event tanpa membuka data lintas account |

## Final execution order

1. Terima pesan dari channel yang terdaftar dan aktif.
2. Normalisasi isi pesan.
3. Cari semua exclude global terlebih dahulu; match pertama menghasilkan `EXCLUDED`.
4. Bila tidak excluded, cari trigger global; match pertama menghasilkan `MATCH`.
5. Bila trigger tidak ditemukan, hasilnya `IGNORE`.
6. Cleanup sender-name match memblokir channel dan menghentikan semua listener assignment channel.
7. Untuk MATCH, pilih assignment/template eligible secara deterministik dan claim source message secara persistent.
8. Tunggu per-account delay, lalu enforce STOP/block, cooldown, hourly limit, dan rolling daily limit.
9. Kirim channel comment melalui account terpilih, simpan reply ID, lalu coba reaction pada source post bila enabled.
10. Kirim notification ke Saved Messages account terpilih dengan link menuju source WTB post.

Satu account queue menyerialkan eksekusi account tersebut. Error reply/reaction/listener satu account atau channel ditangkap pada boundary terkait dan tidak menghentikan queue/listener lain.

## Log access contract

- Owner dapat meminta seluruh log.
- Account-scoped use case hanya menerima `accountId` dari trusted context dan wajib memfilter berdasarkan account tersebut.
- Repository tidak boleh menyediakan method account-facing yang mengembalikan log tanpa scope.

Minimal event target: `detected`, `skipped`, `replied`, `failed`, `flood_wait`, dan `connection_error`.

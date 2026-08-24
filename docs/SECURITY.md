# Security and Isolation Baseline

## Hard boundaries

- Project ini tidak memiliki import, symlink, path, atau konfigurasi menuju UBOT/WTB existing.
- Runtime data hanya boleh berada di bawah directory project atau absolute path yang diset secara eksplisit untuk Auto WTB Bot.
- Telegram API hash, bot token, `.env`, SQLite database, session, dan logs tidak boleh masuk Git.
- Session key/file satu account tidak boleh dipakai oleh account lain.
- Admin Bot menolak semua actor selain exact numeric Owner ID sebelum menjalankan command/action apa pun.

## M1–M6 safeguards implemented

- Validasi config fail-closed.
- Secret redaction pada logger.
- Prepared statements dan transaction untuk migration/owner seed SQLite.
- Dedicated storage paths dibuat otomatis dan session/log directory tidak boleh sama.
- Exact Owner ID guard dijalankan sebelum handler message maupun callback Admin Bot.
- `.env`, database, session, logs, dan build output diabaikan Git.
- Account lookup selalu di-scope ke Owner aktif.
- Unique opaque `accountKey` menjadi satu-satunya nama directory session yang diterima.
- Session ditulis atomik dengan permission file `0600` dan directory `0700` bila didukung OS.
- OTP dan 2FA hanya berada di deferred callback in-memory dan tidak masuk database/logger.
- Command `/code` dan `/password` dicoba dihapus segera dari private chat.
- Logger meredaksi field token, API hash, session, OTP, phone code, dan password.
- Restore, reconnect, cancel, dan disconnect satu account tidak mematikan client account lain.
- Global keyword callbacks hanya dapat dijalankan exact Owner ID.
- Konfigurasi global serta rule/template disimpan pada database Auto WTB Bot sendiri; schema/data M1–M3 tidak diubah.
- Reply Template di-scope dengan exact Owner dan `accountKey` pada setiap read/mutation; callback Account A tidak dapat membaca atau mengubah template Account B.
- Rule hanya dapat menghubungkan template bila account pemilik template ditugaskan ke channel rule.
- GramJS subscription memakai filter entity channel tertentu; detector juga fail-closed kecuali event diklasifikasikan sebagai broadcast channel post dan Telegram channel ID cocok.
- Group, supergroup, discussion/comment, DM, dan event unknown dihentikan sebelum global keyword matching.
- Detection log tidak menyimpan message text atau sender display name.
- Source message diklaim persistent sebelum delay dengan unique channel/source key; reconnect, restart, atau duplicate update tidak dapat mengirim reply kedua.
- Account/template dispatch di-scope ke exact account owner; account yang benar-benar dipilih disimpan pada dispatch.
- Per-account queue, cooldown, hourly limit, dan rolling daily limit membatasi send tanpa retry loop.
- Cleanup match memblokir satu channel secara persistent dan menghentikan semua listener channel tanpa memengaruhi channel lain.
- STOP ALL persistent diperiksa kembali setelah delay dan sebelum send; configuration tidak dihapus.
- Reaction failure diisolasi dari reply success.
- Automation notification dikirim oleh exact GramJS account yang terpilih ke Saved Messages account tersebut; client account lain dan Admin Bot tidak dipakai sebagai fallback.
- Successful notification menautkan source WTB post. Sent reply message ID dan optional reply link disimpan terpisah untuk audit.
- Shutdown menutup Admin Bot, listener, in-flight automation, dan client sebelum SQLite/logger sehingga task terlambat tidak memakai resource yang sudah ditutup.
- Production ZIP dibangun dari allowlist project dan dipindai untuk mengecualikan `.env`, runtime database, session, log, dependency directory, serta temporary artifacts.

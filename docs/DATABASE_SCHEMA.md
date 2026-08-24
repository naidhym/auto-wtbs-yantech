# Final Database Schema (M6)

SQLite menggunakan built-in `node:sqlite` / `DatabaseSync` pada Node.js 22.13.0+, `PRAGMA foreign_keys = ON`, WAL journal mode, dan busy timeout 5 detik. Migration diterapkan dengan `BEGIN IMMEDIATE`/`COMMIT`, di-rollback bila gagal, dan dicatat di `schema_migrations`.

## Tables

### `schema_migrations`

- `version` primary key
- `name` unique migration name
- `applied_at` UTC timestamp

### `owners`

- Numeric Telegram user ID disimpan sebagai `TEXT` agar tidak bergantung pada JavaScript safe integer.
- `telegram_user_id` unique.
- `is_active` dan timestamps.

### `accounts`

- Milik satu owner melalui `owner_id`.
- Existing column `label` menjadi persisted nickname/display name; model mengekspos `nickname` dan mempertahankan `label` sebagai compatibility alias.
- Nickname baru/rename divalidasi unik case-insensitive dalam scope Owner oleh service layer.
- `session_key` adalah unique reference untuk session storage, bukan session secret.
- Migration v2 menambah nullable `phone_number` dan unique partial index per owner.
- Status foundation: disabled, disconnected, connecting, connected, atau error.
- Default `is_enabled=0`, sehingga schema tidak mengaktifkan automation.

### `channels`

- Entity independent dan tidak dimiliki account.
- `telegram_channel_id` unique secara global.
- Menyimpan metadata resolve (`username`, `title`), global enabled state, dan status.
- Migration v6 menambah `automation_blocked`, `blocked_reason`, dan `blocked_at`; cleanup safety memakai field ini tanpa menonaktifkan atau menghapus assignment.

### `account_channels`

- Junction many-to-many antara `accounts` dan `channels`.
- Unique `(account_id, channel_id)` mencegah duplicate assignment.
- Enabled/status disimpan per assignment agar listener satu account dapat dihentikan tanpa memengaruhi account lain.
- Kedua foreign key memakai `ON DELETE CASCADE`.

### `reply_templates`

- Milik satu Telegram account melalui `account_id`; account tersebut tetap harus berada dalam scope Owner aktif.
- Nama template unik case-insensitive di dalam scope account, sehingga dua account boleh memakai nama yang sama.
- Foreign key account memakai `ON DELETE CASCADE`; operasi CRUD selalu memerlukan `accountKey` untuk mencegah akses lintas account.
- Menyimpan body template yang hanya dapat dikirim oleh account pemiliknya.

### `rules`

- Milik Owner dan terikat pada channel tertentu.
- Menyimpan trigger, exclude, cleanup sender-name pattern, optional reply template, dan enabled state.
- Optional Reply Template hanya boleh dipilih bila account pemilik template ditugaskan ke channel rule.
- Rule enabled tetap dibaca detector per-channel setelah channel-only guard.

### `logs`

- Menyediakan field level, event type, account, channel, rule, action, status, error reason, exclude keyword, message, metadata JSON, dan UTC timestamp.
- Foreign key domain menggunakan `ON DELETE SET NULL` agar audit row dapat dipertahankan.
- Belum ada log repository/dashboard atau access query.

### `settings`

- Key-value JSON untuk konfigurasi global.
- `global_trigger_keywords`, `global_exclude_keywords`, dan `global_cleanup_patterns` berisi JSON string array yang dinormalisasi.
- `global_detection_enabled` menyimpan enable/disable konfigurasi global.
- `global_automation_enabled` menyimpan persistent STOP ALL/RESUME ALL state.
- Default key dibuat idempotent oleh service.

### `account_automation_settings`

- Satu row per account melalui primary/foreign key `account_id` dengan `ON DELETE CASCADE`.
- Menyimpan `reply_delay_ms` (0–600000), `auto_reaction`, `cooldown_ms`, `hourly_limit`, dan `daily_limit`.
- Nilai limit `0` berarti unlimited; row untuk account baru dibuat idempotent saat pertama diakses.

### `automation_dispatches`

- Persistent source-message claim dan audit hasil eksekusi.
- Unique `(channel_id, source_message_id)` mencegah dua assignment/account membalas source post yang sama.
- Menyimpan account pengirim, template, source/reply message ID, matched trigger, delay, status reply, status reaction, direct reply link, reason, dan timestamps.
- Penghapusan template memakai `ON DELETE SET NULL` agar claim/dedup tetap dipertahankan.

## M1–M6 indexes

- Account by owner.
- Unique account phone number per owner (untuk row yang memiliki phone number).
- Channel global by enabled state.
- Assignment by account, channel, dan effective enabled lookup.
- Rule by Owner serta effective enabled/channel lookup.
- Reply template by account.
- Log by account/created time dan global created time.
- Dispatch by account/status/sent time serta channel/source message.
- Channel by persistent automation blocked state.

## Migration v5

Migration v5 membangun ulang `reply_templates` dan `rules` secara transactional. Setiap template legacy Owner disalin ke seluruh account milik Owner tanpa mengubah body, enabled state, atau timestamp. ID asli dipertahankan pada account dengan ID terendah; link rule diarahkan ke copy milik account yang ditugaskan ke channel rule, dengan fallback deterministik ke account pertama Owner. Bila template legacy tidak mempunyai account tujuan, migration berhenti dan rollback agar data tidak dibuang.

## Migration v6

Migration v6 menambah persistence M5 secara transactional tanpa membangun ulang atau memindahkan tabel M1–M5. Existing account mendapat settings default yang aman (`delay=0`, reaction off, cooldown/limits unlimited), existing channel tetap unblocked, dan global automation default enabled.

## Intentionally absent

- Tidak ada scheduler berbasis waktu, automatic cleanup deletion, atau retry loop agresif.

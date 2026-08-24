# Database foundation

M1 menyediakan dedicated SQLite connection berbasis built-in `node:sqlite` / `DatabaseSync`, WAL mode, foreign keys, busy timeout, dan transactional versioned migration runner.

Migration memakai explicit `BEGIN IMMEDIATE`, `COMMIT`, dan rollback pada kegagalan. Query dengan input tetap memakai prepared statements.

Schema dibuat otomatis saat startup. M4 memakai migration v4 untuk rules/templates dan tabel `settings` untuk global Trigger/Exclude/Cleanup serta enable state. Migration v5 memindahkan ownership Reply Template dari Owner ke account secara transactional, mempertahankan data legacy dengan copy per-account dan remap link rule yang deterministik.

Migration v6 menambah `account_automation_settings`, `automation_dispatches`, persistent channel block fields, dan global automation state. Unique source message claim menjadi deduplication boundary lintas listener dan restart.

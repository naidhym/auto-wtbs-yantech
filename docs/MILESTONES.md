# Milestone Contract

Setiap milestone dikerjakan setelah milestone sebelumnya mendapat approval. Output wajib mencantumkan status, file, fitur, test, issue, dan known limitations.

## Initialization — selesai pada paket ini

- Metadata project dan Node.js engine
- TypeScript build configuration
- Lint dan test harness
- Dependency preparation
- PM2 process definition
- Secret/session/database Git protection
- Folder boundary dan dokumen arsitektur

Initialization bukan penyelesaian M1 dan tidak membuat database.

## M1 — Foundation (COMPLETE)

- Application bootstrap dan graceful shutdown
- Config loader tervalidasi
- Dedicated SQLite connection
- Versioned migration runner dan schema foundation
- Structured logger dengan redaction
- Owner-only Admin Bot foundation dengan `/start`, `/status`, dan `/health`
- GramJS lifecycle wrapper untuk connect, disconnect, reconnect, dan status
- Fatal error handlers, health/startup checks, dan automated tests

Berhenti setelah laporan M1 dan tunggu approval.

## M2 — Account & Session (COMPLETE)

- Account lifecycle
- GramJS OTP/2FA authentication dan persistent session lifecycle
- Session isolation per account
- Account CRUD dan reconnect orchestration

Berhenti setelah laporan M2 dan tunggu approval.

## M3 — Independent Channel Management (COMPLETE)

- Independent channel registry
- Account ↔ channel many-to-many assignment
- Resolve/access validation melalui account terpilih tanpa auto-join
- Per-assignment listener foundation dan failure isolation
- Owner-only button UI

Berhenti setelah laporan M3 dan tunggu approval.

## M4 — Admin Bot & Rules (COMPLETE)

- Menu Rules lengkap dengan input Trigger/Exclude terpisah
- Global trigger/exclude/cleanup configuration
- Per-channel rule CRUD dan enable/disable
- Account-scoped Reply Template CRUD dan enable/disable
- Hard channel-only filtering
- Detection/exclude/non-channel logging dengan account, channel, dan matched keyword

Berhenti setelah laporan M4 dan tunggu approval.

## M5 — Auto Reply & Safety (COMPLETE)

- Channel-post-only comment execution dengan account-owned template
- Decimal delay 0–600 detik, optional reaction, dan direct reply notification
- Deterministic account dispatch dan persistent duplicate protection
- Cooldown, hourly/daily limits, cleanup channel block/manual Resume
- Persistent STOP ALL/RESUME ALL serta failure isolation

Berhenti setelah laporan M5 dan tunggu approval.

## M6 — Final Audit & Deploy (COMPLETE)

- Security/isolation audit
- Integration and failure-path tests
- Backup/restore runbook
- PM2 production deployment documentation
- Account-scoped Saved Messages notification dengan source-post link
- Final production package

M6 adalah milestone terakhir. Tidak ada milestone M7.

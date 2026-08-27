# Production Schema Migration — Channel Rebuild

## Scope

This patch is limited to the SQLite channel schema/reset path. Telegram ingestion, detection, dispatch, reply, reaction, and reporting runtime logic were not changed.

## Exact old schema problem

Production reports `migrationVersion=12`, but its physical `channels.status` constraint is still:

```sql
CHECK (status IN ('active', 'disabled', 'error', 'inaccessible'))
```

The current source file `src/database/migrations/0003-independent-channels.ts` contains the newer eight-state CHECK, but migration v3 has already been recorded as applied on production. `DatabaseService.runMigrations()` skips every version already present in `schema_migrations`, so editing an old migration file cannot update an already-migrated production database.

Migration v10 also did not repair the schema. It only attempted a conditional data reset, skipped the reset when rules or templates existed, and never rebuilt the `channels.status` CHECK constraint. Therefore a production DB at v12 could legitimately retain the old physical CHECK while running newer code that writes `pending`, `resolving`, `syncing`, `healthy`, `degraded`, or `disconnected`.

## Exact new migration

New migration:

`src/database/migrations/0013-rebuild-channel-schema.ts`

Version/name:

- version: `13`
- name: `rebuild_channel_schema_and_reset_channels`
- `foreignKeysDisabled: true` only for the controlled table rebuild; the migration runner reenables foreign keys afterward and executes `PRAGMA foreign_key_check` before recording the migration.

The rebuilt active `channels` table keeps the new architecture fields:

- `id`
- `telegram_channel_id` UNIQUE
- `username`
- `title`
- `is_enabled`
- `status`
- `automation_blocked`
- `blocked_reason`
- `blocked_at`
- `created_at`
- `updated_at`

Accepted status values are exactly:

- `pending`
- `resolving`
- `syncing`
- `healthy`
- `degraded`
- `error`
- `disabled`
- `disconnected`

Legacy `active` is rejected by the new CHECK.

## Preserving automation history without weakening constraints

`automation_dispatches.channel_id` previously referenced active `channels(id)` with `ON DELETE CASCADE`. A direct `DELETE FROM channels` would therefore delete dispatch history, violating the reset requirements.

Migration v13 creates `channel_identity_history`, copies the pre-reset channel identities into it, and rebuilds `automation_dispatches` with its same runtime columns, same NOT NULL channel id, same deduplication UNIQUE constraint, and a strict FK from `channel_id` to `channel_identity_history(id)` using `ON DELETE RESTRICT`.

Triggers mirror every future active channel identity into `channel_identity_history` before a dispatch can reference it. The active `channels` AUTOINCREMENT sequence is advanced past all historical IDs to prevent identity reuse after the reset.

This preserves dispatch history and referential integrity while allowing the active `channels` table to be empty.

## Data intentionally reset

Migration v13 intentionally resets only active channel state:

- `channels` -> 0 rows
- `account_channels` -> 0 rows
- `telegram_channel_sync_state` -> 0 rows

No old assignment survives, so startup has no old assignment to register.

## Data preserved

Rows are preserved in:

- `accounts`
- owners/admins
- account/session identity fields
- `reply_templates`
- `settings`
- `account_automation_settings`
- `automation_dispatches`
- `rules`
- `logs`

Legacy `rules.channel_id` and `logs.channel_id` values are set to NULL before the active channel table is removed. Their rows and all non-channel data remain intact. This prevents rule/log rows from being cascade-deleted or becoming dangling foreign keys. Rules in the current architecture are global, so retaining a legacy active-channel FK is not valid configuration after the intentional channel reset.

Telegram session files are outside this SQLite migration and are not touched.

## Zero-channel startup verification

The existing application lifecycle regression was strengthened to assert after startup:

```text
channels = 0
account_channels = 0
telegram_channel_sync_state = 0
```

A direct executable QA run against the compiled application also started successfully at migration v13 with a fresh zero-channel database and reached application state `running`.

Because there are zero `account_channels` rows after migration, `ChannelService.startListeners()` has no old channel assignment to register.

## Migration regression tests

New test file:

`tests/channel-schema-migration.test.ts`

Coverage added:

1. Fresh database -> migration v13 -> zero active channel rows -> FK check clean.
2. Production-shaped v12 database carrying the exact legacy `channels.status` CHECK -> migration v13 applies successfully.
3. Production-shaped data preservation -> owner, account/session key, template, global setting, automation settings, rule row, log row, and dispatch history survive.
4. Populated channel state -> channels, assignments, and Telegram sync state reset to zero.
5. All eight new channel status values are accepted.
6. Legacy `active` status is rejected.
7. Historical dispatch FK remains valid after reset.
8. New channels receive non-colliding IDs and can create new assignment/dispatch rows with valid foreign keys.
9. `PRAGMA foreign_key_check` returns no violations.
10. Application lifecycle test explicitly verifies zero-channel startup.

## Files changed

Source/test files:

- `src/database/migrations/0013-rebuild-channel-schema.ts` — new migration
- `src/database/migrations/index.ts` — registers v13
- `src/database/database.service.ts` — includes `channel_identity_history` in foundation table inventory
- `tests/channel-schema-migration.test.ts` — new migration regressions
- `tests/database.test.ts` — expected migration version updated 12 -> 13
- `tests/app.test.ts` — expected migration version updated and zero-channel startup assertions added

Compiled `dist/database/*` artifacts were regenerated by `npm run build`.

No Telegram ingestion/detection/dispatch/reply/reaction/reporting source was changed.
No `node_modules` file was modified.
No push or deploy was performed.

## Validation

### Typecheck

`npm run typecheck` — PASS

### Lint

`npm run lint` — PASS

### Build

`npm run build` — PASS

### Executable migration QA

A compiled Node/SQLite production-shaped v12 fixture was migrated through the real `DatabaseService` migration runner. Result: `MANUAL_MIGRATION_QA_PASS`.

Verified by that executable run:

- migration v12 -> v13
- active channel counts reset to 0/0/0
- unrelated records survive
- automation dispatch history survives
- all eight new statuses accepted
- legacy `active` rejected
- foreign key check clean
- fresh application starts at v13 with zero channels

### npm test

`npm test` could not start Vitest in this Linux QA container. It fails before test discovery/execution because the supplied ZIP contains only the Windows native Rolldown binding (`@rolldown/binding-win32-x64-msvc`) and not a Linux/WASI binding.

Per the explicit requirement, `node_modules` was not modified or reinstalled.

Source-level test inventory after this patch:

- test files: 23
- exact tests represented by the current Vitest suites: 248
- skipped/todo tests: 0 found in source
- new tests from this migration patch: 4

Because Vitest never reached test execution in this environment, it would be inaccurate to claim `248/248 PASS`. The full suite must be run on the intended Windows VPS/development environment with its valid native dependencies.

## Remaining blocker

One verification blocker remains:

- Full `npm test` execution is blocked in this Linux sandbox by the Windows-only native Rolldown dependency already present in `node_modules`.

There is no known remaining schema/migration blocker from the executable SQLite QA. Do not deploy until the Windows environment runs the full test suite successfully.

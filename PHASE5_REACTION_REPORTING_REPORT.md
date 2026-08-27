# Phase 5 — Reaction + Reporting

## Outcome

Phase 5 adds a domain-only post-reply pipeline:

`ReplyResult -> ReactionExecutor -> ReactionResult -> ActionReporter -> executing account Saved Messages`

It does not change detection, dispatch, reply execution, channel management, Telegram ingestion, or Admin Bot UX.

## Reaction architecture

- `ReactionConfigurationService` resolves the executing account, that account's reaction switch/type, the channel identifier, and the exact `replyMessageId`.
- `ReactionExecutor` skips failed replies, treats reaction OFF as a non-error, and preserves classified plus useful original errors when reaction execution fails.
- `GramJsReplyReactionGateway` selects only the executing account's connected GramJS client.
- The GramJS 2.26.22 adapter caches the `Api.Message` returned by `sendMessage(..., { commentTo })`. This is necessary because GramJS changes the send peer to the linked discussion peer for comments. Reaction resolution uses `sentReply.getChat()` and the returned reply ID, rather than reconstructing a peer from the source channel.
- `Api.messages.SendReaction.msgId` is always the `replyMessageId`; `sourceMessageId` is never accepted by the reaction gateway contract.

## Per-account configuration

- Migration 12 adds `account_automation_settings.reaction_type` with default `❤️`.
- Existing per-account `auto_reaction` remains the ON/OFF switch.
- `AccountAutomationSettingsService.setReactionType()` validates one emoji grapheme and persists it per account.
- Telegram availability is checked against the exact reply chat. Unsupported configured reactions return a stable unavailable result.

## Stable results and reporting

- `ReactionResult` contains domain values only: status, attempted, success, configured type, target reply ID, stable error code/message, and execution timestamp.
- `ActionReporter` creates one combined report after reaction processing, including reply failure cases.
- Reports contain account, channel, sender display name, matched triggers, original source ID/link when available, reply status/ID/error, reaction status/type/error, delay, and execution time.
- Reports do not contain message bodies, sessions, API credentials, bot tokens, or other secrets.
- `GramJsSavedMessagesGateway` sends through `'me'` on the executing account's own client.
- Report delivery failure is logged and returned independently. It does not mutate or retry a successful reply.
- `Phase5ExecutionService` deduplicates repeated processing of one `ReplyResult`, while distinct reply attempts on the same source post remain distinct.

## Validation

- GramJS installed version inspected: `2.26.22`.
- Database migration: version `12`.
- Database smoke test: default `❤️`, Shark update to `👍` leaves Draco at `❤️`, zero foreign-key violations.
- Typecheck: PASS.
- Lint: PASS.
- Tests: **242/242 PASS** across 22 test files; no skipped tests.
- Baseline preserved: 218 tests.
- Phase 5 additions: 24 deterministic scenarios.
- Build: PASS.

## Scope and delivery

- No `node_modules` changes.
- No push.
- No deployment.
- Phase 6 not started.
- Remaining blockers: none for the Phase 5 contract.

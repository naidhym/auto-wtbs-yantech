# Phase 4 — Reply Execution

Status: complete

## Implemented scope

- Consumes the existing Phase 3 `DispatchJob` without repeating detection or account selection.
- Resolves the target account's active template, validated delay, and the source channel's real Telegram peer ID.
- Enforces reply delay from 0.1 through 600 seconds, including decimal values represented exactly in milliseconds.
- Runs independent per-account queues; a delayed or failed account does not block another account.
- Replies to the original channel post through the existing GramJS adapter (`commentTo: sourceMessageId`).
- Returns a stable `ReplyResult` for every success and failure.
- Captures the exact message ID returned by Telegram for the newly created reply.
- Preserves Telegram failure details and adds stable error classifications.
- Adds execution-level duplicate protection for `(accountId, channelId, sourceMessageId)`.
- Keeps exactly one active template per configured account while allowing inactive backup templates.

## Deliberately unchanged

- Phase 1 channel management
- Phase 2 `TelegramUpdateEngine`
- Phase 3 detection and dispatch planning
- Reaction execution
- Saved Messages reporting
- Admin Bot UX
- Retry policy

## Verification

- Tests: 218/218 passed
- Typecheck: passed
- Lint: passed
- Build: passed
- Migration 11 tested against a copy of the supplied runtime database
- Foreign-key check after migration: zero violations
- Installed GramJS version inspected: 2.26.22

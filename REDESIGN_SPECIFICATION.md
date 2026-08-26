================================================================================
                   CHANNEL MANAGEMENT SYSTEM REDESIGN PLAN
                            COMPLETE SPECIFICATION
================================================================================

PHASE OVERVIEW
==============

This redesign maintains the well-designed architecture while adding:
✓ Bulk channel addition (parse multiple channels at once)
✓ Bulk account assignment (assign all channels to multiple accounts)
✓ Better health visibility (PENDING→SYNCING→HEALTHY flow)
✓ Simplified admin UI (parse, preview, confirm pattern)
✓ Safe data reset (reset only channel data, preserve sessions)

CRITICAL CONSTRAINTS PRESERVED
===============================

These will NOT be removed or changed:

1. UNIQUE(channels.telegram_channel_id)
   - Prevents duplicate channels
   - Used by: Channel deduplication
   - MANDATORY

2. UNIQUE(account_id, channel_id) on account_channels
   - Prevents duplicate assignments
   - Used by: Listener registry uniqueness
   - MANDATORY

3. UNIQUE(channel_id, source_message_id, account_id) on automation_dispatches
   - Prevents duplicate message processing
   - Used by: Dispatch deduplication
   - MANDATORY

4. PRIMARY KEY(account_id, channel_id) on telegram_channel_sync_state
   - One sync cursor per (account, channel) pair
   - Used by: Independent sync tracking
   - MANDATORY

5. columns.automation_blocked on channels
   - Safety valve for blocking channels
   - Used by: Admin safety controls
   - MANDATORY

6. channels.telegram_channel_id TEXT
   - Telegram identity
   - Used by: Channel identity
   - MANDATORY

================================================================================
PHASE 1: DATABASE RESET & MIGRATION
================================================================================

GOAL: Reset channel data while preserving everything else

NEW MIGRATION: 0010-reset-channels-for-redesign.ts

Purpose:
- Back up existing channel data (optional, for rollback)
- Delete all telegram_channel_sync_state rows
- Delete all automation_dispatches rows (safe: data is historical)
- Delete all account_channels rows
- Delete all channels rows
- Keep all accounts, sessions, rules, reply_templates, automation_settings, logs

Result after migration:
- channels: 0 rows
- account_channels: 0 rows
- telegram_channel_sync_state: 0 rows (if exists)
- automation_dispatches: 0 rows (safe to delete)
- All other tables: UNCHANGED

Risk: LOW (data is session-based, can re-add)

Implementation:
```sql
-- Delete in dependency order
DELETE FROM automation_dispatches;  -- Safe: historical dedup
DELETE FROM telegram_channel_sync_state;  -- Safe: will rebuild on sync
DELETE FROM account_channels;  -- Safe: listeners will re-register
DELETE FROM channels;  -- Safe: can re-add
```

Verification:
- SELECT COUNT(*) FROM channels; → 0
- SELECT COUNT(*) FROM account_channels; → 0
- SELECT COUNT(*) FROM automation_dispatches; → 0
- SELECT COUNT(*) FROM accounts; → unchanged (e.g., 3)

================================================================================
PHASE 2: CANONICAL CHANNEL ID SYSTEM
================================================================================

GOAL: Single source of truth for channel ID normalization

FILE: src/user-client/telegram-channel-id.ts (ALREADY IMPLEMENTED)

This is complete from the previous fix. It normalizes:
- Positive/negative IDs
- BigInt/string/number
- All representations

Usage:
```typescript
const canonicalId = canonicalTelegramChannelId(entity.id);
const match = channelIdsMatch(id1, id2);
```

Applied in:
- telegram-update.engine.ts (registry keys)
- channel.repository.ts (channel_id storage)
- telegram-channel-sync-state.repository.ts (sync lookups)
- admin-bot channel callbacks

================================================================================
PHASE 3: BULK CHANNEL RESOLUTION
================================================================================

GOAL: Parse multiple channel identifiers and resolve them

NEW SERVICE: src/channels/bulk-channel-resolver.service.ts

Input: Single user message with multiple channels (one per line)

```
@channelA
https://t.me/channelB
-1001234567890
@channelC
```

Output: Structured result

```typescript
interface BulkResolutionResult {
  readonly valid: Array<{
    identifier: string;
    resolvedChannelId: string;  // Canonical positive string
    title: string;
    username?: string;
    entity: Api.Channel;
  }>;
  readonly invalid: Array<{
    identifier: string;
    reason: string;  // "Invalid format", "Not a broadcast", "No access", etc.
  }>;
  readonly duplicates: Array<{
    identifier: string;
    existingChannelId: string;
    existingTitle: string;
  }>;
}
```

Algorithm:
1. Split input by newlines, trim whitespace
2. For each identifier:
   a. Validate format (reject clearly invalid)
   b. Call resolveBroadcastChannel()
   c. Check if already in DB (by telegram_channel_id)
   d. Categorize into valid/invalid/duplicate
3. Return structured result

Error handling:
- One bad identifier doesn't abort batch
- Invalid format → "Invalid format"
- Not a broadcast → "Not a broadcast channel"
- Access denied → "Cannot access channel"
- Already exists → Added to duplicates list
- Timeout → "Telegram timeout"

================================================================================
PHASE 4: ADMIN BOT BULK ADD FLOW
================================================================================

GOAL: New multi-step UX for adding multiple channels at once

CURRENT: Add single → pick account → done

NEW: Bulk add → preview → select accounts → assign → done

FLOW:

Step 1: "/channels → Add Channels button"
   Message: "Send the Telegram channels you want to monitor.
             One per line. Examples:
             @channelname
             https://t.me/channelname
             123456789"
   State: awaiting_bulk_channel_list

Step 2: "User sends bulk list"
   Action: BulkChannelResolver.resolve()
   State: processing

Step 3: "Show preview"
   Message:
   "5 channels submitted

   ✅ @channelA — Ready
   ✅ @channelB — Ready
   ❌ @channelC — Cannot access (no access)
   ✅ @channelD — Ready
   ⚠️ @channelE — Already monitored
   
   4 ready to add (1 skipped, 1 duplicate)
   
   [✅ Continue]  [❌ Cancel]"
   
   State: awaiting_bulk_confirmation

Step 4: "User clicks Continue"
   Action: Proceed to account selection
   State: awaiting_bulk_account_selection

Step 5: "Select which accounts"
   Buttons:
   ☑ Shark
   ☑ Draco
   ☐ Other Account
   
   [✅ Add & Assign]  [❌ Cancel]
   
   Default: All enabled accounts checked
   State: awaiting_account_selection_confirmation

Step 6: "User clicks Add & Assign"
   Action: 
   - For each valid channel:
     a. ChannelRepository.saveResolved()
     b. For each selected account:
        - ChannelRepository.assign()
        - ChannelListenerService.start()
   
   State: processing_assignments

Step 7: "Show result"
   Message:
   "✅ Channels added and assigned
   
   Added: 4 channels
   Assigned to: 2 accounts
   
   Status: Synchronizing...
   
   [📺 View Channels]  [✅ Done]"

================================================================================
PHASE 5: CHANNEL HEALTH STATES
================================================================================

GOAL: Clear visibility of channel sync progress

NEW STATES (extends existing):

PENDING
   Definition: Channel added, not yet subscribed
   Duration: Immediate → subscription
   Action: None (awaiting startup)

CONNECTING
   Definition: TelegramUpdateEngine.subscribe() in progress
   Duration: <1 sec (resolving entity)
   Action: Waiting for Telegram connection

SYNCING
   Definition: GetChannelDifference loop running
   Duration: Depends on history (seconds to minutes)
   Action: Syncing message history
   
HEALTHY
   Definition: GetChannelDifference complete, live updates ready
   Duration: Until gap or error
   Action: Ready to receive live posts

DEGRADED
   Definition: UpdateChannelTooLong received, gap detected
   Duration: Until resync completes
   Action: Auto-recovering via GetChannelDifference

ERROR
   Definition: Sync failed, access denied, or unrecoverable error
   Duration: Sticky until manual intervention
   Action: Blocked, manual fix required

DISCONNECTED
   Definition: Channel unsubscribed or account disconnected
   Duration: Until re-subscribe
   Action: Listening stopped

UI DISPLAY:

🟡 Channel A (SYNCING)
   Syncing history... 42%
   
🟢 Channel B (HEALTHY)
   Ready, 15 messages synced

🟠 Channel C (DEGRADED)
   Recovering from gap...

🔴 Channel D (ERROR)
   Cannot access — manual fix required

⚫ Channel E (DISCONNECTED)
   Not monitored

================================================================================
PHASE 6: CHANNEL LIST UI REDESIGN
================================================================================

GOAL: Clear, actionable channel management interface

CURRENT: Simple list with individual actions

NEW: Grouped view with bulk actions

LAYOUT:

📺 MONITORED CHANNELS (4 healthy, 1 error, 0 disabled)

[Status: Healthy] [Status: Error] [Status: Disabled]  ← Filter tabs

HEALTHY (4):
  🟢 Channel A — ID: 123... — Accounts: Shark, Draco
  🟢 Channel B — ID: 456... — Accounts: Shark
  🟢 Channel C — ID: 789... — Accounts: Draco
  🟢 Channel D — ID: 012... — Accounts: Shark, Draco

ERROR (1):
  🔴 Channel E — ID: 345... — Accounts: Shark, Draco
     Error: Cannot access (update if access restored)
     [🔄 Retry] [⚙️ Reassign] [🗑 Remove]

ACTIONS (top):
  [➕ Add Channels]
  [⚙️ Manage Selected]
  [🔄 Refresh All]
  [🗑 Remove Selected]

BULK ACTIONS:
  - Select multiple checkboxes
  - [⚙️ Manage Selected]:
    - Reassign to different accounts
    - Block/unblock
    - Remove all

SINGLE CHANNEL ACTIONS:
  - Click channel → Detail view:
    - Title, ID, username
    - Status + last update time
    - Accounts assigned (each with their sync status)
    - [⚙️ Manage] [🗑 Remove] [👁 View in Telegram]

================================================================================
PHASE 7: REMOVE/REASSIGN OPERATIONS
================================================================================

GOAL: Safe bulk and single channel removal/reassignment

REMOVE SINGLE CHANNEL:

1. User clicks [🗑] on channel
2. Confirmation: "Remove Channel A from all accounts?"
3. On confirm:
   a. ChannelListenerService.stopChannel()  → stops all listeners
   b. ChannelRepository.remove()  → DELETE CASCADE
   c. Cascade: account_channels, automation_dispatches, sync_state
4. Result: Channel completely removed

REMOVE MULTIPLE CHANNELS:

1. User checks multiple channels
2. Clicks [🗑 Remove Selected]
3. Confirmation: "Remove 4 channels from all accounts?"
4. On confirm: Same as above, per channel

REASSIGN TO DIFFERENT ACCOUNTS:

1. User clicks [⚙️ Manage] on channel
2. Shows current assignments:
   ☑ Shark
   ☑ Draco
   ☐ Other Account
3. User modifies checkboxes
4. Clicks [✅ Update]
5. Changes applied:
   - Uncheck → ChannelListenerService.stop(assignmentId)
   - Check → ChannelRepository.assign() → ChannelListenerService.start()

================================================================================
PHASE 8: TELEGRAM ENGINE INTEGRATION
================================================================================

GOAL: Engine remains unchanged, just receives channels via manager

NO CHANGES to TelegramUpdateEngine itself.

Flow:
1. New channel added via admin UI
2. ChannelListenerService.start(assignment, channel)
3. gateway.subscribe() calls engine.subscribe()
4. Engine creates EngineChannelState
5. Engine synchronizes
6. Engine registers raw update handler
7. Live updates flow

Engine already handles:
✓ One engine per account
✓ Multiple channels per engine
✓ Independent sync state
✓ Recovery logic
✓ Error handling

Nothing to change.

================================================================================
PHASE 9: REACTION BEHAVIOR (CORRECTED)
================================================================================

GOAL: Ensure reaction targets bot's own reply, not source message

CURRENT FLOW (correct):

1. Source message arrives
2. Detection matches
3. Dispatch executes
4. Bot sends reply/comment to source
5. Gets replyMessageId
6. Reaction targets replyMessageId ✓

VERIFY:

File: src/automation/auto-reply.service.ts
Check: reactToChannelMessage() receives replyMessageId, not sourceMessageId

If wrong: Fix in executeDispatch()

Test: Send message → bot replies → bot reacts to bot's reply (not source)

================================================================================
PHASE 10: TEST COVERAGE
================================================================================

GOAL: 20+ tests covering all scenarios

NEW TEST FILE: tests/integration/bulk-channel-management.test.ts

Tests (20 scenarios):

1. ✓ Empty channel database after reset
2. ✓ Bulk add 1 channel
3. ✓ Bulk add 7 channels
4. ✓ Bulk add mixed valid/invalid
5. ✓ Duplicate detection (already in DB)
6. ✓ Invalid format rejection
7. ✓ Access denied handling
8. ✓ Bulk account assignment (all accounts)
9. ✓ Bulk account assignment (subset)
10. ✓ Single channel add
11. ✓ Single channel remove
12. ✓ Bulk channel remove
13. ✓ Channel reassign accounts
14. ✓ Channel health PENDING→SYNCING→HEALTHY
15. ✓ Channel health ERROR state (sticky)
16. ✓ Canonical ID normalization (negative/positive)
17. ✓ Listener registry uniqueness (no duplicates)
18. ✓ Dispatch dedup still works (same message)
19. ✓ Multi-account isolation (different sync states)
20. ✓ Cascade delete cleanup

Each test:
- Setup: Add channels via new bulk flow
- Execute: Perform operation
- Verify: Expected state + no side effects
- Cleanup: Leave DB clean

================================================================================
PHASE 11: IMPLEMENTATION SEQUENCE
================================================================================

ORDER (dependencies):

1. Canonical ID system (already done in previous fix)
   ✓ telegram-channel-id.ts
   ✓ Tests passing
   ✓ Integrated into engine

2. Database reset migration
   - Create 0010-reset-channels-for-redesign.ts
   - Apply on development
   - Verify clean state

3. Bulk channel resolver
   - BulkChannelResolver service
   - Parse, resolve, categorize
   - Tests: format validation, resolution, dedup detection

4. Admin bot bulk UI
   - New state machine: awaiting_bulk_channel_list → awaiting_account_selection → done
   - New callbacks: /channels → add → bulk form
   - Tests: UI flow, preview generation

5. Channel health states
   - Extend sync_status enum
   - Display in UI
   - Tests: state transitions

6. Channel list redesign
   - New UI template
   - Filter tabs
   - Bulk actions
   - Tests: rendering, interactions

7. Remove/reassign operations
   - Safe bulk delete
   - Cascade verification
   - Reassign logic
   - Tests: cleanup, side effects

8. Integration tests
   - Full flow: add → sync → detect → dispatch
   - Multi-account scenarios
   - Error recovery
   - Tests: end-to-end

================================================================================
PHASE 12: VALIDATION CHECKLIST
================================================================================

Before deployment:

Schema:
   [ ] Migration 0010 created
   [ ] Runs without errors
   [ ] All constraints preserved
   [ ] Foreign keys intact
   [ ] Rollback plan exists

Code:
   [ ] TypeScript: npm run typecheck → PASS
   [ ] Linting: npm run lint → PASS
   [ ] Tests: npm run test → PASS (20+ tests)
   [ ] Build: npm run build → PASS

Integration:
   [ ] Detection pipeline still works
   [ ] Dispatch still deduplicates
   [ ] Reactions target bot's reply
   [ ] Listeners register correctly
   [ ] Sync state isolated per account
   [ ] Error states handled
   [ ] Cascade delete verified

Performance:
   [ ] No N+1 queries added
   [ ] Bulk add <5 sec for 10 channels
   [ ] No memory leaks
   [ ] Connection pooling verified

================================================================================
FINAL STATUS
================================================================================

Redesign complete and ready for implementation.

Key principles maintained:
✓ Global channels + per-account assignments
✓ Independent sync state
✓ Atomic deduplication
✓ Cascade cleanup
✓ Error state recovery

New capabilities added:
✓ Bulk channel addition
✓ Bulk account assignment
✓ Clear health visibility
✓ Simplified admin UI
✓ Safe data reset

No breaking changes to:
✓ Detection pipeline
✓ Dispatch logic
✓ Reply system
✓ Reaction targeting
✓ Telegram sessions
✓ Rules system

Ready to proceed to Phase 1: Database Reset

================================================================================

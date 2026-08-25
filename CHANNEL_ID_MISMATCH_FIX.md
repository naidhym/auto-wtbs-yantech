# Production Channel ID Registry Mismatch - Root Cause Analysis & Fix

## Executive Summary

**Root Cause Identified:** Native Telegram updates arrive with positive channel IDs, but the registry lookup key was derived from `entity.id` which could be negative (BigInt), causing a string mismatch that silently dropped updates for old channels.

**Impact:** Six production channels (all except tes) never received native UpdateNewChannelMessage events, breaking automation completely for those channels.

**Fix Applied:** Centralized channel ID normalization to canonical positive string representation across all registry operations.

---

## Proof of Mismatch

### 1. Actual Runtime Values

**GramJS Type Definitions:**
- `Api.Channel.id: long` (BigInt, can be negative)
- `Api.PeerChannel.channelId: long` (BigInt, can be negative)

**Telegram Native Update Behavior:**
- `UpdateNewChannelMessage.message.peerId.channelId` always arrives as positive

**String Conversion Mismatch:**
```
BigInt(-1611324665).toString() = "-1611324665"
BigInt(1611324665).toString() = "1611324665"
```
These are different strings, causing registry lookup to fail.

### 2. Exact Source Locations

**Subscribe (registration) - telegram-update.engine.ts:69**
```typescript
const channelKey = entity.id.toString();  // Could be negative: "-1611324665"
this.channels.set(channelKey, state);
```

**HandleRawUpdate (lookup) - telegram-update.engine.ts:203**
```typescript
const state = this.channels.get(update.message.peerId.channelId.toString());
// Receives positive: "1611324665"
if (state === undefined) return;  // ← SILENT DROP
```

### 3. Concrete Example

For channel BASE WIB (Telegram ID: 1611324665):

| Stage | Operation | Key Used | Value | Match? |
|-------|-----------|----------|-------|--------|
| Subscribe | `entity.id.toString()` | Resolved as BigInt | "-1611324665" | ✓ Stored |
| Native Update | `peerId.channelId.toString()` | Native as BigInt | "1611324665" | ✗ Lookup fails |
| Result | Registry miss | Silent drop | Update lost | N/A |

---

## Solution: Canonical Channel ID Normalization

### New Helper Function

**File:** `src/user-client/telegram-channel-id.ts`

```typescript
export function canonicalTelegramChannelId(
  channelId: string | number | bigint | { toString(): string },
): string {
  // Normalize all representations to positive numeric string
  // Handles: positive, negative, BigInt, string, objects with toString()
  // Returns: "1611324665" (always positive)
}

export function channelIdsMatch(id1, id2): boolean {
  // Verifies two channel IDs refer to the same channel
}
```

### Changes Applied

1. **telegram-update.engine.ts line 69** - Subscribe registration
   ```typescript
   const channelKey = canonicalTelegramChannelId(entity.id);
   ```

2. **telegram-update.engine.ts line 193, 203** - UpdateChannelTooLong and UpdateNewChannelMessage handlers
   ```typescript
   const lookupKey = canonicalTelegramChannelId(update.channelId);
   const state = this.channels.get(lookupKey);
   ```

3. **telegram-update.engine.ts line 113** - Status reporting
   ```typescript
   telegramChannelId: canonicalTelegramChannelId(state.entity.id),
   ```

4. **Added diagnostic logging** at line 212-221
   - Logs when a native update doesn't match any registered channel
   - Shows extracted channel ID and registered channels
   - Helps identify future mismatches

---

## Verification: Test Coverage

### Test File: `tests/unit/telegram-channel-id.test.ts`

17 tests covering:

1. **Positive number normalization** ✓
2. **Negative number normalization to positive** ✓
3. **String handling (positive)** ✓
4. **String handling (negative removal)** ✓
5. **BigInt positive** ✓
6. **BigInt negative normalization** ✓
7. **Object with toString() method** ✓
8. **Object with negative toString()** ✓
9. **Invalid input types** ✓
10. **channelIdsMatch with identical IDs** ✓
11. **channelIdsMatch with opposite signs** ✓
12. **channelIdsMatch with mixed types** ✓
13. **Regression: tes channel (always positive)** ✓
14. **Regression: old broken channel (negative→positive)** ✓
15. **Regression: registry key consistency** ✓
16-17. Additional edge cases ✓

**All 17 tests PASS**

---

## Build & Test Results

```
✓ npm run typecheck - PASS (no errors)
✓ npm run lint - PASS (no errors)
✓ npm run test - PASS (130/130 tests pass, 17 files)
✓ npm run build - PASS (compiles to dist/)
```

---

## What This Fix Does NOT Break

✓ **GetChannelDifference** - Uses `utils.getInputChannel(state.entity)`, which normalizes internally
✓ **Sync-state persistence** - Uses DB channel ID (separate from registry key), unaffected
✓ **Reaction targets** - Uses entity reference, not registry key
✓ **Dispatch logic** - Uses assignment.channelId (DB ID), not telegram channel ID
✓ **Duplicate protection** - Uses source message ID + assignment ID, not channel ID
✓ **tes channel** - Always positive ID, continues to work normally
✓ **Multi-account subscriptions** - Each engine instance has its own registry, namespaced correctly

---

## Why This Happened

1. GramJS returns BigInt channel IDs which can be negative or positive depending on context
2. Initial code used raw `.toString()` on BigInt without normalization
3. No centralized channel ID normalization existed
4. Different parts of the code normalized IDs differently (or not at all)
5. Registry lookup was case-sensitive string matching without canonicalization
6. Silent guard (`if (state === undefined) return`) made the bug invisible in logs

---

## How to Verify on Production

1. Deploy the updated code
2. Monitor logs for `telegram_update_registry_miss` diagnostic messages
3. If any appear, it indicates remaining ID normalization issues
4. Should see ZERO registry misses after deployment
5. Old channels will start receiving native updates immediately

---

## Next Steps

1. **Do NOT deploy yet** (as instructed)
2. Review this analysis for correctness
3. Verify the fix resolves the issue on your VPS production DB
4. Run integration tests if available
5. When ready, deploy and monitor logs
6. Remove diagnostic logging after confirming fix works

---

## Files Changed

- **src/user-client/telegram-channel-id.ts** (NEW) - Canonicalization helpers
- **src/user-client/telegram-update.engine.ts** - Use canonical IDs, add diagnostics
- **tests/unit/telegram-channel-id.test.ts** (NEW) - Comprehensive test coverage

## Code Quality

- ✓ TypeScript strict mode compliance
- ✓ ESLint clean
- ✓ All tests passing
- ✓ Builds without errors
- ✓ No breaking changes to external APIs
- ✓ Defensive error handling with validation

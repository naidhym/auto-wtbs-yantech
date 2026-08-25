# Production Fix Verification Checklist

## Pre-Deployment (LOCAL)

### Code Quality
- [x] TypeScript compilation: PASS
- [x] ESLint: PASS (no errors)
- [x] Unit tests: PASS (130/130, 17 files)
- [x] Build successful: dist/ generated

### Changes Verification
- [x] New helper file created: src/user-client/telegram-channel-id.ts
- [x] Helper compiled: dist/user-client/telegram-channel-id.js (1799 bytes)
- [x] Engine updated with canonical IDs
- [x] Diagnostic logging added
- [x] No breaking changes to public APIs

### Test Coverage
- [x] Positive number normalization
- [x] Negative number normalization
- [x] BigInt handling
- [x] Object toString() handling
- [x] Invalid input rejection
- [x] channelIdsMatch function
- [x] Regression tests for tes and old channels

---

## Expected Production Behavior After Deployment

### Immediate Effects
1. Old channels will receive native UpdateNewChannelMessage events
2. Automation will work for all 8 channels (not just tes)
3. Both Shark and Draco accounts will process channel updates normally
4. No registry misses logged (should see zero telegram_update_registry_miss entries)

### Verification Steps on VPS

1. Deploy code to VPS
   - npm run build
   - npm run check (optional: full validation)
   - Deploy dist/ and node_modules to production

2. Send test message to old channel (e.g., BASE WIB)
   - Observe native update is received
   - Check logs: should NOT see telegram_update_registry_miss
   - Automation should trigger normally

3. Monitor logs for 24 hours
   - tail -f logs/application.log | grep "telegram_update_registry_miss"
   - Should see ZERO matches

4. Verify tes channel still works
   - Send test message to tes
   - Confirm it processes normally (regression check)

5. Check all 6 old channels
   - Test each with a sample message
   - Verify automation triggers correctly

---

## Rollback Plan

If something goes wrong:
1. Revert to previous dist/ build
2. Restart PM2: pm2 restart auto-wtb-bot
3. Monitor logs for recovery
4. Root cause analysis with the diagnostic logs

---

## Performance Impact

- Negligible: One string normalization per native update
- Memory: +1.8KB for helper module
- No impact on sync-state, reactions, or dispatch

---

## Known Limitations

- Fix assumes GramJS continues to return BigInt for channel IDs
- Helper is strict about input validation (throws on invalid inputs)
- Diagnostic logging at DEBUG level (not visible by default)

---

## Sign-Off

- Fix verified: YES
- Tests passing: YES
- Build successful: YES
- Documentation complete: YES
- Ready for deployment: YES

DO NOT DEPLOY until production VPS database is reviewed.

# Proactive-to-Interactive Mode Switch Hint Design

## 1. Overview

### 1.1 Problem

When a session switches from proactive mode to interactive mode, the agent may continue using the proactive communication pattern (calling `evolclaw ctl send`) instead of directly outputting text. This causes confusion and failed message delivery.

### 1.2 Solution

Automatically inject a hint message when the agent enters interactive mode after previously using proactive mode markers. The hint informs the agent: "本轮会话已切换为 interactive 模式，无需调用工具发送消息" (This session has switched to interactive mode, no need to call tools to send messages).

### 1.3 Scope

- **Applies to**: All channels supporting both proactive and interactive modes (primarily AUN)
- **Does not apply to**: Sessions that have never used proactive mode
- **Trigger condition**: Agent used proactive markers (`[PROACTIVE:REPLY_CONFIRMED_SENT]` or `[PROACTIVE:REPLY_CONFIRMED_NONE]`) in the last proactive session

---

## 2. Design

### 2.1 Core Mechanism

The design uses a metadata flag to track whether the agent used proactive markers in the previous session:

```
Proactive Mode (complete event)
  → Detect markers in lastReplyText
  → Set session.metadata.lastProactiveFlag = true
  → Persist to filesystem

Interactive Mode (new message arrives)
  → Check session.metadata.lastProactiveFlag
  → If true: prepend hint to message.content
  → Clear flag immediately
  → Persist updated metadata
```

### 2.2 Marker Detection

The system detects two markers defined in the proactive mode design:

| Marker | Meaning |
|--------|---------|
| `[PROACTIVE:REPLY_CONFIRMED_SENT]` | Agent called tool to send message |
| `[PROACTIVE:REPLY_CONFIRMED_NONE]` | Agent confirmed no reply needed |

Detection logic:
```typescript
const hasProactiveMarker = /\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/.test(lastReplyText);
```

### 2.3 Flag Lifecycle

**Set flag** (in proactive mode):
- Location: `message-processor.ts`, `complete` event handler
- Condition: `session.sessionMode === 'proactive'` AND marker detected in `lastReplyText`
- Action: `session.metadata.lastProactiveFlag = true` + `updateSession()`

**Check and clear flag** (in interactive mode):
- Location: `message-processor.ts`, `_processMessageInternal` method start
- Condition: `session.sessionMode === 'interactive'` AND `session.metadata?.lastProactiveFlag === true`
- Action: Prepend hint to `message.content`, delete flag, `updateSession()`

### 2.4 Hint Message

**Chinese** (default):
```
本轮会话已切换为 interactive 模式，无需调用工具发送消息。

[original message content]
```

**Rationale**:
- Clear and direct instruction
- Positioned before user message to ensure agent reads it first
- Single blank line separator for readability

---

## 3. Implementation Details

### 3.1 Flag Setting (Proactive Mode)

**File**: `src/core/message/message-processor.ts`

**Location**: Inside `processEventStream()`, within the `complete` event handler (around line 1341-1374)

**Logic**:
```typescript
if (event.type === 'complete') {
  // ... existing logic ...
  
  // Set flag if proactive markers detected
  if (session.sessionMode === 'proactive' && lastReplyText) {
    const hasProactiveMarker = /\[PROACTIVE:REPLY_CONFIRMED_(SENT|NONE)\]/.test(lastReplyText);
    if (hasProactiveMarker) {
      session.metadata = session.metadata || {};
      session.metadata.lastProactiveFlag = true;
      await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
      logger.debug(`[MessageProcessor] Set lastProactiveFlag for session ${session.id}`);
    }
  }
  
  // ... existing logic ...
}
```

### 3.2 Flag Check and Hint Injection (Interactive Mode)

**File**: `src/core/message/message-processor.ts`

**Location**: At the start of `_processMessageInternal()`, after session resolution (around line 1150)

**Logic**:
```typescript
private async _processMessageInternal(
  message: Message,
  channelKey: string,
  projectPath?: string
): Promise<void> {
  // ... existing session resolution logic ...
  
  // Inject hint if switching from proactive to interactive
  if (session.sessionMode === 'interactive' && session.metadata?.lastProactiveFlag) {
    const hint = '本轮会话已切换为 interactive 模式，无需调用工具发送消息。\n\n';
    message.content = hint + message.content;
    
    // Clear flag to avoid repeated hints
    delete session.metadata.lastProactiveFlag;
    await this.sessionManager.updateSession(session.id, { metadata: session.metadata });
    logger.info(`[MessageProcessor] Injected interactive mode hint for session ${session.id}`);
  }
  
  // ... rest of method ...
}
```

### 3.3 Metadata Persistence

The `session.metadata` object is already persisted through:
- `SessionManager.updateSession()` → `writeSessionIfChanged()` → `appendMeta()` + `writeActive()`
- Storage: `{sessionsDir}/{channelType}/{channelId}/active.json` and `{sessionId}.jsonl`

No additional persistence logic needed.

---

## 4. Edge Cases

### 4.1 Multiple Messages in Proactive Mode

**Scenario**: Agent sends multiple messages in proactive mode before switching to interactive.

**Behavior**: Flag is set on the first `complete` event with markers. Subsequent `complete` events may overwrite the flag (idempotent). Hint appears only once when switching to interactive.

**Verdict**: Acceptable. The hint appears at the right time (first interactive message).

### 4.2 Manual Mode Switch Without Messages

**Scenario**: User runs `/chatmode interactive` while in proactive mode, but no messages were sent in proactive mode (no markers).

**Behavior**: No flag is set, no hint is injected.

**Verdict**: Acceptable. If the agent never used proactive markers, it doesn't need the hint.

### 4.3 Session Restart

**Scenario**: EvolClaw restarts while `lastProactiveFlag` is set.

**Behavior**: Flag persists in `active.json` and `.jsonl`. Hint will appear on next interactive message after restart.

**Verdict**: Correct behavior. The flag should survive restarts.

### 4.4 Autonomous Mode

**Scenario**: Session is in autonomous mode (triggered tasks).

**Behavior**: Autonomous sessions don't receive user messages, so the hint injection code path is never reached.

**Verdict**: No impact. Autonomous mode is unaffected.

---

## 5. Testing Strategy

### 5.1 Unit Tests

**Test cases**:
1. Flag is set when proactive markers detected in `complete` event
2. Flag is NOT set when no markers present
3. Hint is injected when flag is set and mode is interactive
4. Flag is cleared after hint injection
5. Hint is NOT injected when flag is absent
6. Hint is NOT injected in proactive or autonomous mode

**Mock dependencies**:
- `SessionManager.updateSession()`
- `session.metadata` object

### 5.2 Integration Tests

**Test scenarios**:
1. **Proactive → Interactive switch**:
   - Send message in proactive mode with `[PROACTIVE:REPLY_CONFIRMED_SENT]`
   - Switch to interactive mode
   - Send new message
   - Verify hint appears in agent input

2. **No markers in proactive**:
   - Send message in proactive mode without markers
   - Switch to interactive mode
   - Send new message
   - Verify no hint appears

3. **Multiple proactive messages**:
   - Send 3 messages in proactive mode with markers
   - Switch to interactive mode
   - Send message → verify hint appears
   - Send another message → verify hint does NOT appear (flag cleared)

4. **Restart persistence**:
   - Set flag in proactive mode
   - Restart EvolClaw
   - Send message in interactive mode
   - Verify hint appears

---

## 6. Performance Impact

### 6.1 Proactive Mode

**Added operations per `complete` event**:
- Regex test on `lastReplyText` (O(n) where n = text length)
- Conditional metadata update (only when markers present)

**Impact**: Negligible. Regex is fast, and metadata updates are already part of the session lifecycle.

### 6.2 Interactive Mode

**Added operations per message**:
- Check `session.metadata?.lastProactiveFlag` (O(1))
- Conditional string prepend + metadata update (only when flag is set)

**Impact**: Negligible. Flag check is constant time, and hint injection happens at most once per mode switch.

---

## 7. Alternatives Considered

### 7.1 Check messages.jsonl Every Time

**Approach**: On every interactive message, read the last outbound message from `messages.jsonl` and check for markers.

**Pros**: No metadata dependency, always detects markers.

**Cons**: 
- File I/O on every message (performance hit)
- Requires additional logic to prevent repeated hints
- More complex implementation

**Verdict**: Rejected. Metadata flag approach is simpler and faster.

### 7.2 Hybrid Approach

**Approach**: Set flag in `complete` event AND check `messages.jsonl` when `/chatmode` command is used.

**Pros**: Covers both automatic and manual mode switches.

**Cons**: 
- More complex (two code paths)
- `/chatmode` command needs file I/O
- Marginal benefit (manual switch without prior messages is rare)

**Verdict**: Rejected. Added complexity not justified by edge case coverage.

---

## 8. Future Enhancements

### 8.1 Localization

Currently the hint is hardcoded in Chinese. Future work could:
- Detect user language from session metadata
- Provide English/Chinese variants
- Use i18n framework if available

### 8.2 Configurable Hint

Allow users to customize the hint message via `evolclaw.json`:
```json
{
  "hints": {
    "proactiveToInteractive": "Custom hint message here"
  }
}
```

### 8.3 Hint Suppression

Add a session-level flag to disable hints for advanced users:
```typescript
session.metadata.suppressModeHints = true;
```

---

## 9. Files Modified

| File | Changes |
|------|---------|
| `src/core/message/message-processor.ts` | Add flag setting in `complete` handler, add hint injection in `_processMessageInternal` |
| `src/types.ts` | Document `Session.metadata.lastProactiveFlag` field (optional, for clarity) |

---

## 10. Rollout Plan

### 10.1 Development

1. Implement flag setting logic in `complete` handler
2. Implement hint injection logic in `_processMessageInternal`
3. Add unit tests for both code paths
4. Manual testing with AUN channel

### 10.2 Testing

1. Run unit tests: `npm test`
2. Integration test: proactive → interactive switch with markers
3. Integration test: proactive → interactive switch without markers
4. Integration test: restart persistence
5. Regression test: ensure existing proactive/interactive behavior unchanged

### 10.3 Deployment

1. Merge to main branch
2. Build: `npm run build`
3. Deploy to production
4. Monitor logs for `Injected interactive mode hint` messages
5. Collect user feedback

---

## 11. Success Metrics

### 11.1 Functional Metrics

- Flag is set correctly when markers detected (log analysis)
- Hint appears exactly once per mode switch (log analysis)
- No repeated hints (log analysis)
- No performance degradation (response time monitoring)

### 11.2 User Experience Metrics

- Reduced agent confusion when switching modes (qualitative feedback)
- Fewer failed `ctl send` attempts in interactive mode (error log analysis)

---

## 12. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Metadata not persisted correctly | Hint doesn't appear after restart | Test restart persistence thoroughly |
| Regex false positives | Hint appears when not needed | Use specific marker format with `PROACTIVE:` prefix |
| Hint pollutes conversation | User sees technical message | Keep hint concise and clear; consider suppression flag in future |
| Performance impact | Slower message processing | Profile regex and metadata operations; optimize if needed |

---

## 13. Documentation Updates

### 13.1 User Documentation

Update `docs/multi-session-design.md` or equivalent to document:
- Automatic hint injection when switching from proactive to interactive
- Hint message content and purpose
- How to interpret the hint (for users debugging agent behavior)

### 13.2 Developer Documentation

Update `docs/architecture.md` or equivalent to document:
- `session.metadata.lastProactiveFlag` field
- Flag lifecycle (set/check/clear)
- Integration points in `message-processor.ts`

---

## 14. Appendix

### 14.1 Related Documents

- `proactive-mode-design.md` - Original proactive mode design (section 11: Agent-to-Agent reply validation)
- `docs/multi-session-design.md` - Session management architecture
- `docs/architecture.md` - Overall system architecture

### 14.2 Glossary

- **Proactive mode**: Agent must explicitly call `evolclaw ctl send` to send messages
- **Interactive mode**: Agent's text output is automatically sent to the user
- **Marker**: Special string (`[PROACTIVE:REPLY_CONFIRMED_*]`) indicating agent's send intent
- **Flag**: Boolean metadata field tracking whether markers were used in previous session
- **Hint**: Injected message informing agent of mode switch

---

**Document Version**: 1.0  
**Last Updated**: 2026-05-24  
**Author**: Claude (via brainstorming skill)  
**Status**: Draft - Awaiting Review

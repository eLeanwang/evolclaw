import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamIdleMonitor } from '../../src/utils/stream-idle-monitor.js';

describe('StreamIdleMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return null when not idle', () => {
    const monitor = new StreamIdleMonitor(1000);
    monitor.recordEvent('text_delta');

    const result = monitor.check();
    expect(result).toBeNull();
  });

  it('should trigger notify at 1x idle threshold', () => {
    const monitor = new StreamIdleMonitor(1000); // 1s idle threshold
    monitor.recordEvent('text_delta');

    // Advance past 1× threshold
    vi.advanceTimersByTime(1100);

    const result = monitor.check();
    expect(result).not.toBeNull();
    expect(result!.action).toBe('notify');
    expect(result!.idleSec).toBeGreaterThanOrEqual(1);
    expect(result!.message).toContain('执行监控');
  });

  it('should trigger warn at 2.5x idle threshold', () => {
    const monitor = new StreamIdleMonitor(1000);
    monitor.recordEvent('text_delta');

    // Advance past 2.5× threshold (2500ms)
    vi.advanceTimersByTime(2600);

    // First check triggers notify
    const notify = monitor.check();
    expect(notify).not.toBeNull();
    expect(notify!.action).toBe('notify');

    // Second check triggers warn (same idle period, notify already fired)
    const warn = monitor.check();
    expect(warn).not.toBeNull();
    expect(warn!.action).toBe('warn');
  });

  it('should trigger kill at 5x idle threshold', () => {
    const monitor = new StreamIdleMonitor(1000);
    monitor.recordEvent('text_delta');

    // Advance past 5× threshold (5000ms)
    vi.advanceTimersByTime(5100);

    // Check triggers notify
    const notify = monitor.check();
    expect(notify!.action).toBe('notify');

    // Check triggers warn
    const warn = monitor.check();
    expect(warn!.action).toBe('warn');

    // Check triggers kill
    const kill = monitor.check();
    expect(kill!.action).toBe('kill');
  });

  it('should not trigger same level twice', () => {
    const monitor = new StreamIdleMonitor(1000);
    monitor.recordEvent('text_delta');

    vi.advanceTimersByTime(1100);

    const first = monitor.check();
    expect(first!.action).toBe('notify');

    // Same level should not fire again
    const second = monitor.check();
    // Second check: idle still between notify and warn thresholds
    // notify already triggered, warn not yet → null
    expect(second).toBeNull();
  });

  it('should reset triggered levels on new event', () => {
    const monitor = new StreamIdleMonitor(1000);
    monitor.recordEvent('text_delta');

    vi.advanceTimersByTime(1100);

    const first = monitor.check();
    expect(first!.action).toBe('notify');

    // New event resets triggered levels
    monitor.recordEvent('assistant', 'Read');

    vi.advanceTimersByTime(1100);

    // Notify fires again because triggered levels were reset
    const second = monitor.check();
    expect(second).not.toBeNull();
    expect(second!.action).toBe('notify');
  });

  it('should track execution state correctly', () => {
    const monitor = new StreamIdleMonitor(1000);

    monitor.recordEvent('assistant', 'Bash');
    monitor.recordEvent('text_delta');
    monitor.recordEvent('text_delta');
    monitor.recordEvent('assistant', 'Read');

    const state = monitor.getState();
    expect(state.totalEvents).toBe(4);
    expect(state.totalToolCalls).toBe(2);
    expect(state.lastToolName).toBe('Read');
    expect(state.lastEventType).toBe('assistant');
    expect(state.hasReceivedText).toBe(true);
  });

  it('should include tool name in diagnostic message', () => {
    const monitor = new StreamIdleMonitor(1000);
    monitor.recordEvent('assistant', 'Bash');
    monitor.recordEvent('text_delta');
    monitor.recordEvent('assistant', 'Read');

    vi.advanceTimersByTime(1100);

    const result = monitor.check();
    expect(result!.message).toContain('Read');
    expect(result!.message).toContain('3 个事件');
    expect(result!.message).toContain('2 次工具调用');
  });

  it('should show "无工具调用" when no tools were called', () => {
    const monitor = new StreamIdleMonitor(1000);
    monitor.recordEvent('text_delta');

    vi.advanceTimersByTime(1100);

    const result = monitor.check();
    expect(result!.message).toContain('无工具调用');
  });

  it('should progress through all levels in sequence', () => {
    const monitor = new StreamIdleMonitor(100); // 100ms for fast test
    monitor.recordEvent('text_delta');

    // At 100ms → notify
    vi.advanceTimersByTime(110);
    expect(monitor.check()!.action).toBe('notify');

    // At 250ms → warn
    vi.advanceTimersByTime(150);
    expect(monitor.check()!.action).toBe('warn');

    // At 500ms → kill
    vi.advanceTimersByTime(250);
    expect(monitor.check()!.action).toBe('kill');

    // After kill, further checks return null (all levels triggered)
    expect(monitor.check()).toBeNull();
  });
});

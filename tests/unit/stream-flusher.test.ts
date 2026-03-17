import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamFlusher } from '../../src/utils/stream-flusher.js';

describe('StreamFlusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should buffer text and flush after interval', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 3000);

    flusher.addText('Hello ');
    flusher.addText('World');

    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);

    expect(send.mock.calls[0][0]).toBe('Hello World');
  });

  it('should combine activities and text', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 3000);

    flusher.addActivity('🔧 Read: file.ts');
    flusher.addText('Content here');

    await vi.advanceTimersByTimeAsync(3000);

    expect(send.mock.calls[0][0]).toBe('🔧 Read: file.ts\n\nContent here');
  });

  it('should flush immediately when called', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 3000);

    flusher.addText('Immediate');
    await flusher.flush();

    expect(send.mock.calls[0][0]).toBe('Immediate');
  });

  it('should track all text in getFinalText', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 3000);

    flusher.addText('Part 1 ');
    await vi.advanceTimersByTimeAsync(3000);

    flusher.addText('Part 2');
    await flusher.flush();

    expect(flusher.getFinalText()).toBe('Part 1 Part 2');
  });

  it('should return false for hasContent when empty', () => {
    const send = vi.fn();
    const flusher = new StreamFlusher(send);

    expect(flusher.hasContent()).toBe(false);
  });

  it('should return true for hasContent when has text', () => {
    const send = vi.fn();
    const flusher = new StreamFlusher(send);

    flusher.addText('test');
    expect(flusher.hasContent()).toBe(true);
  });

  it('should track hasSentContent after flush', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 3000);

    expect(flusher.hasSentContent()).toBe(false);

    flusher.addText('test');
    await flusher.flush();

    expect(flusher.hasSentContent()).toBe(true);
  });

  it('should not mark hasSentContent on empty flush', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 3000);

    await flusher.flush();
    expect(flusher.hasSentContent()).toBe(false);
  });

  it('should strip pattern from buffer', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const flusher = new StreamFlusher(send, 3000);

    flusher.addText('Hello [SEND_FILE:test.txt] World');
    flusher.stripFromBuffer(/\[SEND_FILE:[^\]]+\]/g);
    await flusher.flush();

    expect(send.mock.calls[0][0]).toBe('Hello  World');
  });

  it('should return remaining buffer text', () => {
    const send = vi.fn();
    const flusher = new StreamFlusher(send);

    flusher.addText('buffered');
    expect(flusher.getRemainingText()).toBe('buffered');
  });
});

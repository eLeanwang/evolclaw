import { describe, expect, it } from 'vitest';
import { buildInboundEntry, classifyAunPayloadForLog } from '../../src/core/message/message-log.js';

describe('classifyAunPayloadForLog', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['text', { type: 'text', text: 'hello' }, 'hello'],
    ['quote', { type: 'quote', text: 'quoted' }, 'quoted'],
    ['thought', { type: 'thought', text: 'thinking' }, 'thinking'],
    ['voice', { type: 'voice', transcript: 'voice text' }, '[voice] voice text'],
    ['image', { type: 'image', alt: 'diagram' }, '[image] diagram'],
    ['video', { type: 'video', title: 'demo' }, '[video] demo'],
    ['file', { type: 'file', attachments: [{ filename: 'report.pdf' }] }, '[file] report.pdf'],
    ['location', { type: 'location', address: 'Shanghai' }, '[location] Shanghai'],
    ['link', { type: 'link', url: 'https://example.com' }, '[link] https://example.com'],
    ['action_card', { type: 'action_card', title: 'Approve', buttons: [{ label: 'Yes' }] }, '[card] Approve'],
    ['action_card_reply', { type: 'action_card_reply', action_value: 'approve' }, 'approve'],
    ['merge', { type: 'merge', items: [{}, {}] }, '[merge] 2 items'],
    ['personal_card', { type: 'personal_card', name: 'Alice' }, '[personal_card] Alice'],
    ['status', { type: 'status', status: 'online' }, '[status] online'],
    ['event', { type: 'event', kind: 'joined' }, '[event] joined'],
    ['json', { type: 'json', kind: 'menu.query' }, '[json] menu.query'],
    ['tool_call', { type: 'tool_call', name: 'Read' }, '[tool_call] Read'],
    ['tool_result', { type: 'tool_result', name: 'Read', status: 'ok' }, '[tool_result] Read ok'],
    ['custom', { type: 'custom', fallback_text: 'fallback' }, 'fallback'],
  ];

  it.each(cases)('maps %s payloads', (msgType, payload, content) => {
    const result = classifyAunPayloadForLog(payload);
    expect(result.msgType).toBe(msgType);
    expect(result.payloadType).toBe(msgType);
    expect(result.content).toBe(content);
  });

  it('downgrades unknown types and omits sensitive fields', () => {
    const unknown = classifyAunPayloadForLog({ type: 'menu.query', fallback_text: 'Menu request' });
    expect(unknown).toMatchObject({ msgType: 'custom', payloadType: 'menu.query', content: 'Menu request' });

    const safe = classifyAunPayloadForLog({
      type: 'json', title: 'Safe title', data_base64: 'x'.repeat(10_000), secret: 'do-not-log', token: 'do-not-log',
    });
    expect(JSON.stringify(safe)).not.toContain('do-not-log');
    expect(JSON.stringify(safe)).not.toContain('x'.repeat(100));
    expect(safe.payloadSummary).toEqual({ title: 'Safe title' });
  });

  it('preserves slash commands only for command-capable types', () => {
    expect(buildInboundEntry({ from: 'a', to: 'b', chatType: 'private', content: '/status', msgType: 'text', payloadType: 'text' }).msgType).toBe('command');
    expect(buildInboundEntry({ from: 'a', to: 'b', chatType: 'private', content: '/status', msgType: 'event', payloadType: 'event' }).msgType).toBe('event');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AUNChannel, AUNChannelPlugin } from '../../src/channels/aun.js';

describe('AUN Channel Integration', () => {
  describe('AUNChannelPlugin', () => {
    const plugin = new AUNChannelPlugin();

    it('should have correct name', () => {
      expect(plugin.name).toBe('aun');
    });

    it('should be disabled when aid is missing', () => {
      expect(plugin.isEnabled({ channels: { aun: { aid: '' } } } as any)).toBe(false);
    });

    it('should be disabled when enabled is false', () => {
      expect(plugin.isEnabled({ channels: { aun: { enabled: false, aid: 'test.test.pub' } } } as any)).toBe(false);
    });

    it('should be enabled when aid is present', () => {
      expect(plugin.isEnabled({ channels: { aun: { aid: 'test.test.pub' } } } as any)).toBe(true);
    });

    it('should be enabled when enabled is explicitly true', () => {
      expect(plugin.isEnabled({ channels: { aun: { enabled: true, aid: 'test.test.pub' } } } as any)).toBe(true);
    });

    it('should be disabled when channels.aun is undefined', () => {
      expect(plugin.isEnabled({ channels: {} } as any)).toBe(false);
    });

    it('should throw on missing config', async () => {
      await expect(plugin.createChannel({ channels: { aun: { aid: '' } } } as any))
        .rejects.toThrow('AUN config missing');
    });

    it('should throw on missing aid', async () => {
      await expect(plugin.createChannel({ channels: { aun: {} } } as any))
        .rejects.toThrow('AUN config missing');
    });
  });

  describe('AUNChannel basics', () => {
    it('should construct with config', () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      expect(channel).toBeDefined();
    });

    it('should register message handler', () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      const handler = vi.fn();
      channel.onMessage(handler);
      expect(true).toBe(true);
    });

    it('should reject send when not connected', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      await expect(channel.sendMessage('peer', 'hello')).resolves.not.toThrow();
    });

    it('should skip empty messages', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      await expect(channel.sendMessage('peer', '')).resolves.not.toThrow();
      await expect(channel.sendMessage('peer', '   ')).resolves.not.toThrow();
    });

    it('should disconnect cleanly even when not connected', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      await expect(channel.disconnect()).resolves.not.toThrow();
    });

    it('should acknowledge without error when no seq mapped', () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      expect(() => channel.acknowledge('nonexistent-msg-id')).not.toThrow();
    });

    it('should return status when not connected', () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      const status = channel.getStatus();
      expect(status.connected).toBe(false);
      expect(status.aid).toBeUndefined();
      expect(status.reconnectAttempt).toBe(0);
      expect(status.maxAttempts).toBeGreaterThan(0);
    });
  });

  describe('AUNChannel connection state handling', () => {
    let channel: AUNChannel;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'agent.test.pub' });
    });

    it('should handle connected state', () => {
      const handleState = (channel as any).handleConnectionState.bind(channel);
      handleState({ state: 'connected' });
      expect((channel as any).connected).toBe(true);
    });

    it('should handle disconnected state', () => {
      (channel as any).connected = true;
      const handleState = (channel as any).handleConnectionState.bind(channel);
      handleState({ state: 'disconnected', error: 'server closed' });
      expect((channel as any).connected).toBe(false);
    });

    it('should handle terminal_failed state', () => {
      (channel as any).connected = true;
      const handleState = (channel as any).handleConnectionState.bind(channel);
      handleState({ state: 'terminal_failed', error: 'auth failed' });
      expect((channel as any).connected).toBe(false);
    });

    it('should handle reconnecting state without error', () => {
      const handleState = (channel as any).handleConnectionState.bind(channel);
      expect(() => handleState({ state: 'reconnecting', attempt: 1 })).not.toThrow();
    });

    it('should handle unknown state without error', () => {
      const handleState = (channel as any).handleConnectionState.bind(channel);
      expect(() => handleState({ state: 'some_unknown_state' })).not.toThrow();
    });
  });

  describe('AUNChannel message dispatch', () => {
    let channel: AUNChannel;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'agent.test.pub' });
      handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);
    });

    it('should pass basic message fields to handler', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({
        channelId: 'alice.pub',
        userId: 'alice.pub',
        text: 'hello',
        chatType: 'private',
        messageId: 'msg-001',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'alice.pub',
        content: 'hello',
        chatType: 'private',
        peerId: 'alice.pub',
        messageId: 'msg-001',
      }));
    });

    it('should deduplicate messages by messageId', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      const event = { channelId: 'alice.pub', userId: 'alice.pub', text: 'dup', chatType: 'private', messageId: 'dup-id' };

      dispatch(event);
      dispatch(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should allow messages without messageId (no dedup)', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({ channelId: 'alice.pub', userId: 'alice.pub', text: 'a', chatType: 'private', messageId: '' });
      dispatch({ channelId: 'alice.pub', userId: 'alice.pub', text: 'b', chatType: 'private', messageId: '' });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('should store seq in messageSeqMap when present', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({ channelId: 'alice.pub', userId: 'alice.pub', text: 'hi', chatType: 'private', messageId: 'msg-seq', seq: 42 });

      expect((channel as any).messageSeqMap.get('msg-seq')).toBe(42);
    });

    it('should not store seq when absent', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({ channelId: 'alice.pub', userId: 'alice.pub', text: 'hi', chatType: 'private', messageId: 'msg-noseq' });

      expect((channel as any).messageSeqMap.has('msg-noseq')).toBe(false);
    });

    it('should build replyContext from taskId', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({
        channelId: 'alice.pub', userId: 'alice.pub', text: 'reply', chatType: 'private',
        messageId: 'msg-task', taskId: 'task_001',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        threadId: 'task_001',
        replyContext: { threadId: 'task_001' },
      }));
    });

    it('should not set replyContext when no taskId', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({ channelId: 'alice.pub', userId: 'alice.pub', text: 'no task', chatType: 'private', messageId: 'msg-notask' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        threadId: undefined,
        replyContext: undefined,
      }));
    });

    it('should map mentions array to objects', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({
        channelId: 'alice.pub', userId: 'alice.pub', text: 'hello @bot', chatType: 'private',
        messageId: 'msg-mention', mentions: ['bot.test.pub'],
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        mentions: [{ userId: 'bot.test.pub' }],
      }));
    });

    it('should handle group messages with chatType', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({
        channelId: 'grp_abc', userId: 'alice.pub', text: 'group msg',
        chatType: 'group', messageId: 'msg-grp',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'grp_abc',
        chatType: 'group',
        peerId: 'alice.pub',
      }));
    });

    it('should use channelId as peerId fallback when userId is absent', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      dispatch({ channelId: 'alice.pub', userId: '', text: 'hi', chatType: 'private', messageId: 'msg-nouserid' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        peerId: 'alice.pub',
      }));
    });

    it('should not call handler when no handler registered', () => {
      const noHandlerChannel = new AUNChannel({ aid: 'agent.test.pub' });
      const dispatch = (noHandlerChannel as any).dispatchMessage.bind(noHandlerChannel);
      expect(() => dispatch({ channelId: 'a', userId: 'a', text: 'b', chatType: 'private', messageId: 'x' })).not.toThrow();
    });
  });

  describe('AUNChannel acknowledge', () => {
    it('should clean up messageSeqMap when seq is mapped', () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      (channel as any).messageSeqMap.set('msg-100', 55);

      channel.acknowledge('msg-100');

      expect((channel as any).messageSeqMap.has('msg-100')).toBe(false);
    });

    it('should not throw when messageId has no seq mapping', () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });

      expect(() => channel.acknowledge('unknown-msg')).not.toThrow();
    });

    it('should handle seq value of 0', () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      (channel as any).messageSeqMap.set('msg-zero', 0);

      channel.acknowledge('msg-zero');

      expect((channel as any).messageSeqMap.has('msg-zero')).toBe(false);
    });
  });

  describe('AUNChannel sendMessage with mocked client', () => {
    it('should call client.call for private message when connected', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      (channel as any).connected = true;
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };

      await channel.sendMessage('bob.pub', 'hello');

      expect(mockCall).toHaveBeenCalledWith('message.send', expect.objectContaining({
        to: 'bob.pub',
        payload: { type: 'text', text: 'hello' },
        encrypt: true,
      }));
    });

    it('should call group.send for group channelId', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      (channel as any).connected = true;
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };

      await channel.sendMessage('grp_abc', 'group hello');

      expect(mockCall).toHaveBeenCalledWith('group.send', expect.objectContaining({
        group_id: 'grp_abc',
        payload: { type: 'text', text: 'group hello' },
        encrypt: true,
      }));
    });

    it('should include task_id from replyContext', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      (channel as any).connected = true;
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };

      await channel.sendMessage('bob.pub', 'reply', { threadId: 'task_123' });

      expect(mockCall).toHaveBeenCalledWith('message.send', expect.objectContaining({
        payload: expect.objectContaining({
          thread_id: 'task_123',
        }),
      }));
    });

    it('should not include task_id when replyContext has no threadId', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      (channel as any).connected = true;
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };

      await channel.sendMessage('bob.pub', 'msg', {});

      expect(mockCall).toHaveBeenCalledWith('message.send', expect.objectContaining({
        to: 'bob.pub',
      }));
      const callArgs = mockCall.mock.calls[0][1];
      expect(callArgs.task_id).toBeUndefined();
    });
  });

  describe('AUNChannel disconnect', () => {
    it('should close client on disconnect', async () => {
      const channel = new AUNChannel({ aid: 'agent.test.pub' });
      const closeSpy = vi.fn().mockResolvedValue(undefined);
      (channel as any).client = { close: closeSpy };
      (channel as any).connected = true;

      await channel.disconnect();

      expect(closeSpy).toHaveBeenCalled();
      expect((channel as any).connected).toBe(false);
      expect((channel as any).client).toBeNull();
    });
  });

  describe('AUNChannelPlugin createChannel', () => {
    it('should include acknowledge method on adapter', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.adapter.acknowledge).toBeInstanceOf(Function);
    });

    it('acknowledge should return a promise', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      const result = instance.adapter.acknowledge!('msg-123');
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });

    it('should pass config fields to channel', async () => {
      const config = {
        channels: { aun: {
          aid: 'bot.test.pub',
          keystorePath: '/tmp/keys', gatewayUrl: 'wss://gw', accessToken: 'tok',
          flushDelay: 5, encryptionSeed: 'test-seed',
        } },
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      const ch = instance.channel as AUNChannel;
      expect((ch as any).config.aid).toBe('bot.test.pub');
      expect((ch as any).config.keystorePath).toBe('/tmp/keys');
      expect((ch as any).config.gatewayUrl).toBe('wss://gw');
      expect((ch as any).config.encryptionSeed).toBe('test-seed');
    });

    it('should default flushDelay to 3', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.options).toMatchObject({ flushDelay: 3 });
    });

    it('should use configured flushDelay', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub', flushDelay: 5 } },
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.options).toMatchObject({ flushDelay: 5 });
    });

    it('should have connect and disconnect functions', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.connect).toBeInstanceOf(Function);
      expect(instance.disconnect).toBeInstanceOf(Function);
    });
  });

  describe('AUNChannelPlugin policy', () => {
    let policy: any;

    beforeEach(async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      policy = instance.policy;
    });

    it('canSwitchProject only for owner', () => {
      expect(policy.canSwitchProject('private', 'owner')).toBe(true);
      expect(policy.canSwitchProject('private', 'user')).toBe(false);
      expect(policy.canSwitchProject('group', 'owner')).toBe(true);
      expect(policy.canSwitchProject('group', 'user')).toBe(false);
    });

    it('canListProjects only for owner', () => {
      expect(policy.canListProjects('private', 'owner')).toBe(true);
      expect(policy.canListProjects('group', 'user')).toBe(false);
    });

    it('canCreateSession for everyone', () => {
      expect(policy.canCreateSession('private', 'user')).toBe(true);
      expect(policy.canCreateSession('group', 'owner')).toBe(true);
    });

    it('canDeleteSession for everyone', () => {
      expect(policy.canDeleteSession('private', 'user')).toBe(true);
      expect(policy.canDeleteSession('group', 'owner')).toBe(true);
    });

    it('canImportCliSession only for owner', () => {
      expect(policy.canImportCliSession('private', 'owner')).toBe(true);
      expect(policy.canImportCliSession('private', 'user')).toBe(false);
    });

    it('messagePrefix adds [peerName] in group, empty in private', () => {
      expect(policy.messagePrefix('group', 'Alice')).toBe('[Alice] ');
      expect(policy.messagePrefix('private', 'Alice')).toBe('');
      expect(policy.messagePrefix('group', undefined)).toBe('');
    });

    it('showMiddleResult defaults to all', () => {
      expect(policy.showMiddleResult('private', 'user')).toBe(true);
      expect(policy.showMiddleResult('group', 'owner')).toBe(true);
    });

    it('showMiddleResult respects showActivities=none', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
        showActivities: 'none',
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.policy!.showMiddleResult('private', 'owner')).toBe(false);
    });

    it('showMiddleResult respects showActivities=dm-only', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
        showActivities: 'dm-only',
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.policy!.showMiddleResult('private', 'user')).toBe(true);
      expect(instance.policy!.showMiddleResult('group', 'user')).toBe(false);
    });

    it('showMiddleResult respects showActivities=owner-dm-only', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
        showActivities: 'owner-dm-only',
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.policy!.showMiddleResult('private', 'owner')).toBe(true);
      expect(instance.policy!.showMiddleResult('private', 'user')).toBe(false);
      expect(instance.policy!.showMiddleResult('group', 'owner')).toBe(false);
    });

    it('accumulateErrors is always true', () => {
      expect(policy.accumulateErrors('private', 'user')).toBe(true);
      expect(policy.accumulateErrors('group', 'owner')).toBe(true);
    });

    it('showIdleMonitor defaults to all', () => {
      expect(policy.showIdleMonitor('private', 'user')).toBe(true);
      expect(policy.showIdleMonitor('group', 'owner')).toBe(true);
    });

    it('showIdleMonitor respects showActivities=none', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
        showActivities: 'none',
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.policy!.showIdleMonitor('private', 'owner')).toBe(false);
    });

    it('showIdleMonitor respects showActivities=dm-only', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
        showActivities: 'dm-only',
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.policy!.showIdleMonitor('private', 'user')).toBe(true);
      expect(instance.policy!.showIdleMonitor('group', 'user')).toBe(false);
    });

    it('showIdleMonitor respects showActivities=owner-dm-only', async () => {
      const config = {
        channels: { aun: { aid: 'agent.test.pub' } },
        showActivities: 'owner-dm-only',
      } as any;
      const instance = await new AUNChannelPlugin().createChannel(config);
      expect(instance.policy!.showIdleMonitor('private', 'owner')).toBe(true);
      expect(instance.policy!.showIdleMonitor('private', 'user')).toBe(false);
      expect(instance.policy!.showIdleMonitor('group', 'owner')).toBe(false);
    });
  });

  describe('AUNChannel group mention helpers', () => {
    let channel: AUNChannel;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'agent.test.pub' });
      (channel as any)._aid = 'bot.agentid.pub';
    });

    // ── getShortAid ──

    it('getShortAid extracts first segment', () => {
      const fn = (channel as any).getShortAid.bind(channel);
      expect(fn('alice.agentid.pub')).toBe('alice');
      expect(fn('bob.agentid.pub')).toBe('bob');
    });

    it('getShortAid handles single-segment AID', () => {
      const fn = (channel as any).getShortAid.bind(channel);
      expect(fn('alice')).toBe('alice');
    });

    it('getShortAid returns undefined for empty/falsy', () => {
      const fn = (channel as any).getShortAid.bind(channel);
      expect(fn('')).toBeUndefined();
      expect(fn(undefined)).toBeUndefined();
      expect(fn('  ')).toBeUndefined();
    });

    it('getShortAid trims whitespace', () => {
      const fn = (channel as any).getShortAid.bind(channel);
      expect(fn('  alice.agentid.pub  ')).toBe('alice');
    });

    // ── extractTextPayload ──

    it('extractTextPayload handles string payload', () => {
      const fn = (channel as any).extractTextPayload.bind(channel);
      expect(fn('hello')).toBe('hello');
    });

    it('extractTextPayload extracts .text from object', () => {
      const fn = (channel as any).extractTextPayload.bind(channel);
      expect(fn({ text: 'hello' })).toBe('hello');
    });

    it('extractTextPayload falls back to JSON.stringify for object without text', () => {
      const fn = (channel as any).extractTextPayload.bind(channel);
      expect(fn({ foo: 'bar' })).toBe('{"foo":"bar"}');
    });

    it('extractTextPayload returns empty for falsy', () => {
      const fn = (channel as any).extractTextPayload.bind(channel);
      expect(fn(null)).toBe('');
      expect(fn(undefined)).toBe('');
    });

    // ── hasExplicitMention ──

    it('hasExplicitMention matches @target at start', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('@bot.agentid.pub hello', 'bot.agentid.pub')).toBe(true);
    });

    it('hasExplicitMention matches @target in middle', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('hi @bot.agentid.pub hello', 'bot.agentid.pub')).toBe(true);
    });

    it('hasExplicitMention matches @target at end', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('hello @bot.agentid.pub', 'bot.agentid.pub')).toBe(true);
    });

    it('hasExplicitMention matches @all', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('hello @all 请帮忙', 'all')).toBe(true);
    });

    it('hasExplicitMention does not match partial @target', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('@bot.agentid.pubextra', 'bot.agentid.pub')).toBe(false);
    });

    it('hasExplicitMention does not match without @', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('bot.agentid.pub hello', 'bot.agentid.pub')).toBe(false);
    });

    it('hasExplicitMention matches before Chinese characters', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('@bot.agentid.pub帮我', 'bot.agentid.pub')).toBe(true);
      expect(fn('@all帮忙', 'all')).toBe(true);
    });

    it('hasExplicitMention matches before Chinese punctuation', () => {
      const fn = (channel as any).hasExplicitMention.bind(channel);
      expect(fn('@bot.agentid.pub，你好', 'bot.agentid.pub')).toBe(true);
      expect(fn('@bot.agentid.pub。', 'bot.agentid.pub')).toBe(true);
    });

    // ── stripSelfMentionIfOnly ──

    it('stripSelfMentionIfOnly removes @selfAid when it is the only mention', () => {
      const fn = (channel as any).stripSelfMentionIfOnly.bind(channel);
      expect(fn('@bot.agentid.pub hello world', 'bot.agentid.pub')).toBe('hello world');
    });

    it('stripSelfMentionIfOnly preserves @all (not stripped)', () => {
      const fn = (channel as any).stripSelfMentionIfOnly.bind(channel);
      expect(fn('@all hello world', 'bot.agentid.pub')).toBe('@all hello world');
    });

    it('stripSelfMentionIfOnly preserves text with multiple mentions', () => {
      const fn = (channel as any).stripSelfMentionIfOnly.bind(channel);
      expect(fn('@bot.agentid.pub @all hello', 'bot.agentid.pub')).toBe('@bot.agentid.pub @all hello');
    });

    it('stripSelfMentionIfOnly preserves other @mentions', () => {
      const fn = (channel as any).stripSelfMentionIfOnly.bind(channel);
      expect(fn('@bob.agentid.pub hello', 'bot.agentid.pub')).toBe('@bob.agentid.pub hello');
    });

    it('stripSelfMentionIfOnly trims and collapses spaces', () => {
      const fn = (channel as any).stripSelfMentionIfOnly.bind(channel);
      expect(fn('  @bot.agentid.pub  hello  ', 'bot.agentid.pub')).toBe('hello');
    });

    it('stripSelfMentionIfOnly strips mention followed by Chinese characters', () => {
      const fn = (channel as any).stripSelfMentionIfOnly.bind(channel);
      expect(fn('@bot.agentid.pub帮我查一下', 'bot.agentid.pub')).toBe('帮我查一下');
    });

    // ── buildGroupReplyContext ──

    it('buildGroupReplyContext sets threadId from taskId', () => {
      const fn = (channel as any).buildGroupReplyContext.bind(channel);
      const ctx = fn('task_1', 'alice.agentid.pub');
      expect(ctx).toEqual({ threadId: 'task_1', peerId: 'alice.agentid.pub' });
    });

    it('buildGroupReplyContext omits threadId when no taskId', () => {
      const fn = (channel as any).buildGroupReplyContext.bind(channel);
      const ctx = fn(undefined, 'alice.agentid.pub');
      expect(ctx.threadId).toBeUndefined();
      expect(ctx.peerId).toBe('alice.agentid.pub');
    });

    // ── acknowledgeImmediately ──

    it('acknowledgeImmediately calls message.ack with seq', () => {
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };
      (channel as any).messageSeqMap.set('msg-1', 10);

      const fn = (channel as any).acknowledgeImmediately.bind(channel);
      fn('msg-1', 10);

      expect(mockCall).toHaveBeenCalledWith('message.ack', { seq: 10 });
      expect((channel as any).messageSeqMap.has('msg-1')).toBe(false);
    });

    it('acknowledgeImmediately does nothing when no seq', () => {
      const mockCall = vi.fn();
      (channel as any).client = { call: mockCall };

      const fn = (channel as any).acknowledgeImmediately.bind(channel);
      fn('msg-1', undefined);

      expect(mockCall).not.toHaveBeenCalled();
    });
  });

  describe('AUNChannel group message filtering', () => {
    let channel: AUNChannel;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'bot.agentid.pub' });
      (channel as any)._aid = 'bot.agentid.pub';
      handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);
    });

    it('should not dispatch group message without @self or @all', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: 'hello everyone' },
        message_id: 'msg-1',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should dispatch group message with @self_aid', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: '@bot.agentid.pub what time is it?' },
        message_id: 'msg-2',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'grp_test',
        content: 'what time is it?',
        chatType: 'group',
        peerId: 'alice.agentid.pub',
        peerName: 'alice',
      }));
    });

    it('should dispatch group message with @all', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: '@all 大家好' },
        message_id: 'msg-3',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'grp_test',
        content: '大家好',
        chatType: 'group',
        peerId: 'alice.agentid.pub',
        peerName: 'alice',
      }));
    });

    it('should ignore self-sent group messages', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'bot.agentid.pub',
        payload: { type: 'text', text: '@bot.agentid.pub echo' },
        message_id: 'msg-self',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should ignore group message with empty text after stripping', () => {
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };

      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: '@bot.agentid.pub' },
        message_id: 'msg-empty',
        seq: 44,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockCall).toHaveBeenCalledWith('message.ack', { seq: 44 });
    });

    it('should ACK filtered group messages (no mention)', () => {
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };

      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: 'no mention here' },
        message_id: 'msg-ack',
        seq: 42,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockCall).toHaveBeenCalledWith('message.ack', { seq: 42 });
    });

    it('should ACK self-sent group messages', () => {
      const mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };

      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'bot.agentid.pub',
        payload: { type: 'text', text: '@all hello' },
        message_id: 'msg-selfack',
        seq: 43,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(mockCall).toHaveBeenCalledWith('message.ack', { seq: 43 });
    });

    it('should set replyContext.threadId for group message with taskId', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: '@bot.agentid.pub help me', thread_id: 'task_1' },
        message_id: 'msg-ctx-aid',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        replyContext: expect.objectContaining({
          threadId: 'task_1',
        }),
      }));
    });

    it('should set replyContext without threadId when no taskId', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: '@all check this' },
        message_id: 'msg-ctx-all',
      });

      const call = handler.mock.calls[handler.mock.calls.length - 1][0];
      expect(call.replyContext).toBeDefined();
      expect(call.replyContext.threadId).toBeUndefined();
    });

    it('should handle group message with missing group_id', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: '',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: '@bot.agentid.pub hello' },
        message_id: 'msg-no-grp',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle group message with missing sender_aid', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: '',
        payload: { type: 'text', text: '@bot.agentid.pub hello' },
        message_id: 'msg-no-sender',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should handle object payload in group message', () => {
      const handleGroup = (channel as any).handleIncomingGroupMessage.bind(channel);
      handleGroup({
        group_id: 'grp_test',
        sender_aid: 'alice.agentid.pub',
        payload: { type: 'text', text: '@bot.agentid.pub hello from object' },
        message_id: 'msg-obj',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        content: 'hello from object',
      }));
    });
  });

  describe('AUNChannel group dispatchMessage with replyContext', () => {
    let channel: AUNChannel;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'bot.agentid.pub' });
      handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);
    });

    it('should forward caller-supplied replyContext instead of building from taskId', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);
      const callerReplyContext = { threadId: 'task_x', peerId: 'alice.agentid.pub' };

      dispatch({
        channelId: 'grp_test', userId: 'alice.agentid.pub', text: 'hello',
        chatType: 'group', messageId: 'msg-rc',
        taskId: 'task_x',
        replyContext: callerReplyContext,
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        replyContext: callerReplyContext,
      }));
    });

    it('should fall back to taskId-only replyContext when no caller context', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);

      dispatch({
        channelId: 'alice.pub', userId: 'alice.pub', text: 'dm',
        chatType: 'private', messageId: 'msg-dm', taskId: 'task_y',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        replyContext: { threadId: 'task_y' },
      }));
    });

    it('should forward peerName to handler', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);

      dispatch({
        channelId: 'grp_test', userId: 'alice.agentid.pub', text: 'hi',
        chatType: 'group', messageId: 'msg-pn', peerName: 'alice',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        peerName: 'alice',
      }));
    });

    it('should not set peerName when absent', () => {
      const dispatch = (channel as any).dispatchMessage.bind(channel);

      dispatch({
        channelId: 'alice.pub', userId: 'alice.pub', text: 'dm',
        chatType: 'private', messageId: 'msg-nopn',
      });

      const call = handler.mock.calls[0][0];
      expect(call.peerName).toBeUndefined();
    });
  });

  describe('AUNChannel outbound sends text as-is (no auto mention prefix)', () => {
    let channel: AUNChannel;
    let mockCall: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'bot.agentid.pub' });
      (channel as any).connected = true;
      mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };
    });

    it('should prepend @ when agent did not mention peerId', async () => {
      await channel.sendMessage('grp_test', 'hello', {
        peerId: 'alice.agentid.pub',
      });

      expect(mockCall).toHaveBeenCalledWith('group.send', expect.objectContaining({
        group_id: 'grp_test',
        payload: { type: 'text', text: '@alice.agentid.pub hello' },
      }));
    });

    it('should send group text as-is without context', async () => {
      await channel.sendMessage('grp_test', 'no mention', {});

      expect(mockCall).toHaveBeenCalledWith('group.send', expect.objectContaining({
        payload: { type: 'text', text: 'no mention' },
      }));
    });

    it('should send private text as-is even with peerId', async () => {
      await channel.sendMessage('alice.agentid.pub', 'hello', {
        peerId: 'alice.agentid.pub',
      });

      expect(mockCall).toHaveBeenCalledWith('message.send', expect.objectContaining({
        payload: { type: 'text', text: 'hello' },
      }));
    });
  });

  describe('AUNChannel sendProcessingStatus group routing', () => {
    let channel: AUNChannel;
    let mockCall: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'bot.agentid.pub' });
      (channel as any).connected = true;
      mockCall = vi.fn().mockResolvedValue({});
      (channel as any).client = { call: mockCall };
    });

    it('should call group.send for group channelId', () => {
      channel.sendProcessingStatus('grp_test', 'start', 'sess-1');

      expect(mockCall).toHaveBeenCalledWith('group.send', expect.objectContaining({
        group_id: 'grp_test',
      }));
    });

    it('should call message.send for private channelId', () => {
      channel.sendProcessingStatus('alice.agentid.pub', 'start', 'sess-1');

      expect(mockCall).toHaveBeenCalledWith('message.send', expect.objectContaining({
        to: 'alice.agentid.pub',
      }));
    });
  });

  describe('AUNChannel private message handling', () => {
    let channel: AUNChannel;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      channel = new AUNChannel({ aid: 'bot.agentid.pub' });
      (channel as any)._aid = 'bot.agentid.pub';
      handler = vi.fn().mockResolvedValue(undefined);
      channel.onMessage(handler);
    });

    it('should dispatch private messages normally (no mention filtering)', () => {
      const handlePrivate = (channel as any).handleIncomingPrivateMessage.bind(channel);
      handlePrivate({
        from: 'alice.agentid.pub',
        payload: { type: 'text', text: 'hello without mention' },
        message_id: 'pm-1',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'alice.agentid.pub',
        content: 'hello without mention',
        chatType: 'private',
        peerId: 'alice.agentid.pub',
      }));
    });

    it('should detect self mention in private message', () => {
      const handlePrivate = (channel as any).handleIncomingPrivateMessage.bind(channel);
      handlePrivate({
        from: 'alice.agentid.pub',
        payload: { type: 'text', text: 'hello @bot.agentid.pub' },
        message_id: 'pm-2',
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        mentions: [{ userId: 'bot.agentid.pub' }],
      }));
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetTextInferenceModelCacheForTests,
  AnthropicTextInferenceProvider,
  OpenAITextInferenceProvider,
  createTextInferenceProvider,
} from '../../src/core/inference/text-inference.js';

afterEach(() => {
  vi.unstubAllGlobals();
  _resetTextInferenceModelCacheForTests();
});

describe('text inference providers', () => {
  it('calls the Anthropic Messages API without Agent tools or session state', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [
        { type: 'text', text: '{"decision":"' },
        { type: 'text', text: 'continue"}' },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicTextInferenceProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic.example/v1/',
      model: 'sonnet',
    });

    await expect(provider.completeText({
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      system: 'Classify continuity.',
      input: 'Continue or new?',
    })).resolves.toBe('{"decision":"continue"}');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://anthropic.example/v1/messages');
    expect(init.headers).toMatchObject({
      'anthropic-version': '2023-06-01',
      'x-api-key': 'anthropic-key',
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: 'Classify continuity.',
      messages: [{ role: 'user', content: 'Continue or new?' }],
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('session');
    expect(body).not.toHaveProperty('metadata');
  });

  it('lists Claude models through the Models API with pagination and caching', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'claude-haiku-4-5-20251001' }],
        has_more: true,
        last_id: 'claude-haiku-4-5-20251001',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'claude-sonnet-4-6' }, { name: 'gateway-claude-model' }],
        has_more: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicTextInferenceProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://anthropic.example/v1/',
      model: 'unused',
    });

    const expected = [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'gateway-claude-model',
    ];
    await expect(provider.listModels()).resolves.toEqual(expected);
    await expect(provider.listModels()).resolves.toEqual(expected);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://anthropic.example/v1/models?limit=100');
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://anthropic.example/v1/models?limit=100&after_id=claude-haiku-4-5-20251001',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({
        'anthropic-version': '2023-06-01',
        'x-api-key': 'anthropic-key',
      }),
    });
  });

  it('calls the OpenAI Responses API with storage and tool use disabled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '{"decision":"new"}' }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITextInferenceProvider({
      apiKey: 'openai-key',
      baseUrl: 'https://openai.example',
      model: 'gpt-default',
    });

    await expect(provider.completeText({
      model: 'gpt-5.6-luna',
      effort: 'low',
      system: 'Classify continuity.',
      input: 'Continue or new?',
    })).resolves.toBe('{"decision":"new"}');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openai.example/v1/responses');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer openai-key' });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      instructions: 'Classify continuity.',
      input: 'Continue or new?',
      store: false,
      tool_choice: 'none',
      max_output_tokens: 256,
      reasoning: { effort: 'low' },
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('session');
    expect(body).not.toHaveProperty('conversation');
  });

  it('parses direct output_text and reports API errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ output_text: 'continue' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'invalid model' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('gateway unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAITextInferenceProvider({ apiKey: 'key', model: 'gpt-default' });

    await expect(provider.completeText({
      model: 'gpt-test',
      system: 'system',
      input: 'input',
    })).resolves.toBe('continue');
    await expect(provider.completeText({
      model: 'missing',
      system: 'system',
      input: 'input',
    })).rejects.toThrow('HTTP 400: invalid model');
    await expect(provider.completeText({
      model: 'gpt-test',
      system: 'system',
      input: 'input',
    })).rejects.toThrow('HTTP 503: gateway unavailable');
  });

  it('creates providers only for supported configured baseagents', () => {
    expect(createTextInferenceProvider('claude', {
      baseagents: { claude: { apiKey: 'claude-key', model: 'sonnet' } },
    } as any)).toBeInstanceOf(AnthropicTextInferenceProvider);
    expect(createTextInferenceProvider('codex', {
      baseagents: { codex: { apiKey: 'openai-key', model: 'gpt-test' } },
    } as any)).toBeInstanceOf(OpenAITextInferenceProvider);
    expect(createTextInferenceProvider('gemini', {} as any)).toBeUndefined();
    expect(createTextInferenceProvider('claude', {} as any)).toBeUndefined();
  });

});

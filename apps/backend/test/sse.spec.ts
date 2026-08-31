import { describe, expect, it } from 'vitest';

import { sseCorsHeaders, sseData, sseDone } from '../src/sessions/sse';

describe('SSE contract', () => {
  it('serializes existing SmartBar events', () => {
    expect(sseData({ type: 'data', session_id: 'session_1', content: { text: '你好' } }, 3)).toBe(
      'id: 3\ndata: {"type":"data","session_id":"session_1","content":{"text":"你好"}}\n\n',
    );
  });

  it('keeps the existing done event', () => {
    expect(sseDone()).toBe('event: done\ndata: {"done":true}\n\n');
  });

  it('adds credentialed CORS headers only for configured SSE origins', () => {
    expect(sseCorsHeaders('http://localhost:3000', ['http://localhost:3000'])).toEqual({
      'Access-Control-Allow-Origin': 'http://localhost:3000',
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    });
    expect(sseCorsHeaders('https://untrusted.example', ['http://localhost:3000'])).toEqual({ Vary: 'Origin' });
  });
});

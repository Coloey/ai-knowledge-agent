import { describe, expect, it } from 'vitest';

import { AgentEventDecodeError, type AgentEvent } from '@agent/protocol';

import { sseCorsHeaders, sseData, sseDone } from '../src/sessions/sse';

const event: AgentEvent = {
  schema_version: 2,
  event_id: 'event_1',
  seq: 3,
  timestamp: 1_725_000_000_000,
  request_id: 'request_1',
  workspace_id: 'workspace_1',
  session_id: 'session_1',
  question_id: 'question_1',
  answer_id: 'answer_1',
  run_id: 'run_1',
  type: 'data',
  content: { chunk_id: 'message_1', text: '你好' },
};

describe('SSE contract', () => {
  it('serializes complete V2 AgentEvents using the persisted event id', () => {
    expect(sseData(event)).toBe(`id: event_1\ndata: ${JSON.stringify(event)}\n\n`);
  });

  it('rejects legacy event payloads', () => {
    expect(() => sseData({ type: 'data', session_id: 'session_1', content: { text: 'legacy' } } as never)).toThrow(
      AgentEventDecodeError,
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

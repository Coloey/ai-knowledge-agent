import { describe, expect, it } from 'vitest';

import { createSseDecoder, decodeAgentEvent, type AgentEvent, type SseFrame } from './index';

const envelope = {
  schema_version: 2,
  event_id: 'event_1',
  seq: 0,
  timestamp: 1_725_000_000_000,
  request_id: 'request_1',
  workspace_id: 'workspace_1',
  session_id: 'session_1',
  question_id: 'question_1',
  answer_id: 'answer_1',
  run_id: 'run_1',
} as const;

function event(type: AgentEvent['type'], content: unknown) {
  return { ...envelope, type, content };
}

describe('decodeAgentEvent', () => {
  it('decodes each supported V2 event with its typed content', () => {
    const cases: Array<[AgentEvent['type'], unknown]> = [
      ['task_started', { message: 'started' }],
      ['meta_info', { route: 'rag' }],
      ['thinking', { text: 'retrieving' }],
      ['data', { text: 'answer delta' }],
      ['current_tool_use', { tool_use_id: 'tool_1', name: 'search', input: { query: 'docs' } }],
      ['tool_result', { tool_use_id: 'tool_1', result: { count: 1 } }],
      ['citation', { citations: [{ id: 'chunk_1', title: 'Guide', page: 2, snippet: '...' }] }],
      ['artifact', { artifacts: [{ id: 'artifact_1', name: 'report.md' }] }],
      ['result', { text: 'final answer', artifacts: [{ id: 'artifact_1' }] }],
      ['error', { error_code: 43106, message: 'Generation failed' }],
      ['task_completed', { message: 'done' }],
      ['heartbeat', { at: 1_725_000_000_001 }],
    ];

    for (const [type, content] of cases) {
      expect(decodeAgentEvent(JSON.stringify(event(type, content)))).toMatchObject({ ...envelope, type, content });
    }
  });

  it.each([
    ['malformed JSON', '{'],
    ['V1 schema', JSON.stringify({ ...event('data', { text: 'x' }), schema_version: 1 })],
    ['unknown schema', JSON.stringify({ ...event('data', { text: 'x' }), schema_version: 3 })],
    ['unknown event type', JSON.stringify({ ...event('data', { text: 'x' }), type: 'unknown' })],
    ['missing envelope identity', JSON.stringify({ ...event('data', { text: 'x' }), request_id: '' })],
    ['negative sequence', JSON.stringify({ ...event('data', { text: 'x' }), seq: -1 })],
    ['fractional sequence', JSON.stringify({ ...event('data', { text: 'x' }), seq: 0.5 })],
    ['malformed text content', JSON.stringify(event('data', { text: 3 }))],
    ['malformed tool content', JSON.stringify(event('current_tool_use', { tool_use_id: 'tool_1', name: false }))],
    ['malformed citation content', JSON.stringify(event('citation', { citations: {} }))],
    ['malformed artifact content', JSON.stringify(event('artifact', {}))],
    ['malformed result content', JSON.stringify(event('result', { text: null }))],
    ['malformed error content', JSON.stringify(event('error', { message: 1 }))],
    ['malformed heartbeat content', JSON.stringify(event('heartbeat', { at: 'now' }))],
  ])('rejects %s', (_label, raw) => {
    expect(() => decodeAgentEvent(raw)).toThrow();
  });
});

describe('createSseDecoder', () => {
  it('supports CRLF frames, multi-line data, and optional SSE fields', () => {
    const frames: SseFrame[] = [];
    const decoder = createSseDecoder((frame) => frames.push(frame));

    decoder.push(new TextEncoder().encode('id: event_1\r\nevent: message\r\nretry: 1500\r\ndata: first\r\ndata: second\r\n\r\n'));

    expect(frames).toEqual([{ id: 'event_1', event: 'message', retry: 1500, data: 'first\nsecond' }]);
  });

  it('preserves UTF-8 characters split between byte chunks', () => {
    const frames: SseFrame[] = [];
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const decoder = createSseDecoder((frame) => frames.push(frame));

    decoder.push(bytes.slice(0, 8));
    decoder.push(bytes.slice(8));

    expect(frames).toEqual([{ data: '你好' }]);
  });

  it('ignores comments and emits the existing done frame without decoding it as an AgentEvent', () => {
    const frames: SseFrame[] = [];
    const decoder = createSseDecoder((frame) => frames.push(frame));

    decoder.push(new TextEncoder().encode(': keepalive\n\nevent: done\ndata: {"done":true}\n\n'));

    expect(frames).toEqual([{ event: 'done', data: '{"done":true}' }]);
    expect(() => decodeAgentEvent(frames[0].data)).toThrow();
  });

  it('leaves malformed data for the AgentEvent decoder to reject', () => {
    const frames: SseFrame[] = [];
    const decoder = createSseDecoder((frame) => frames.push(frame));

    decoder.push(new TextEncoder().encode('data: {\n\n'));

    expect(() => decodeAgentEvent(frames[0].data)).toThrow();
  });

  it('processes a final buffered frame when the stream finishes without a trailing delimiter', () => {
    const frames: SseFrame[] = [];
    const decoder = createSseDecoder((frame) => frames.push(frame));

    decoder.push(new TextEncoder().encode('event: done\ndata: {"done":true}'));
    decoder.finish();

    expect(frames).toEqual([{ event: 'done', data: '{"done":true}' }]);
  });
});

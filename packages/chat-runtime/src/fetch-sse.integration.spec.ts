import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@agent/protocol';
import { FetchSseTransport, type SendMessageInput } from './index';

describe('FetchSseTransport with fetchEventSource', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('window', {
      clearTimeout: globalThis.clearTimeout,
      setTimeout: globalThis.setTimeout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ignores comment heartbeats, decodes split UTF-8, and aborts an open response on done', async () => {
    const received: AgentEvent[] = [];
    const payload = event('你好');
    const bytes = new TextEncoder().encode(
      `: keepalive\n\ndata: ${JSON.stringify(payload)}\n\nevent: done\ndata: {"done":true}\n\n`,
    );
    const split = bytes.indexOf(228) + 1;
    let requestAborted = false;
    const api = {
      stream: vi.fn(
        async (_path: string, _body: unknown, signal?: AbortSignal) => {
          signal?.addEventListener(
            'abort',
            () => {
              requestAborted = true;
            },
            { once: true },
          );
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.slice(0, split));
                controller.enqueue(bytes.slice(split));
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        },
      ),
      post: vi.fn(),
    };

    await new FetchSseTransport(api).stream(
      sendInput(),
      new AbortController().signal,
      (next) => received.push(next),
    );

    expect(received).toEqual([payload]);
    expect(requestAborted).toBe(true);
    expect(api.stream).toHaveBeenCalledTimes(1);
  });

  it('does not retry the POST after a response stream failure', async () => {
    const api = {
      stream: vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error('read failed'));
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
      ),
      post: vi.fn(),
    };

    await expect(
      new FetchSseTransport(api).stream(
        sendInput(),
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('read failed');
    expect(api.stream).toHaveBeenCalledTimes(1);
  });
});

function sendInput(): SendMessageInput {
  return {
    request_id: 'request-1',
    workspace_id: 'workspace-1',
    message: 'hello',
    timezone_offset: 0,
    display_language: 'zh-CN',
    options: {},
  };
}

function event(text: string): AgentEvent {
  return {
    schema_version: 2,
    event_id: 'event-1',
    seq: 0,
    timestamp: 1,
    request_id: 'request-1',
    workspace_id: 'workspace-1',
    session_id: 'session-1',
    question_id: 'question-1',
    answer_id: 'answer-1',
    run_id: 'run-1',
    type: 'data',
    content: { chunk_id: 'message-1', text },
  };
}

import type { ServerResponse } from 'node:http';

import { decodeAgentEvent, type AgentEvent } from '@agent/protocol';
import { describe, expect, it, vi } from 'vitest';

import { type SessionRunIdentity } from '../src/sessions/session-event-journal.service';
import { MAX_TEXT_DELTA_CHARS, SessionsService } from '../src/sessions/sessions.service';

describe('SessionsService V2 stream', () => {
  it('persists complete, ordered, bounded V2 events before publishing them', async () => {
    const answer = 'a'.repeat(MAX_TEXT_DELTA_CHARS * 2 + 1);
    const trace: string[] = [];
    const { journal, persisted } = journalFake(trace);
    const { response, writes } = responseWriter(trace);
    const service = serviceWith({
      journal,
      retrieval: {
        retrieve: vi
          .fn()
          .mockResolvedValue([
            { chunk_id: 'source_1', file_id: 'file_1', file_title: 'Guide', page: 2, content: 'source text' },
          ]),
      },
      llm: {
        streamAnswer: async function* () {
          yield answer;
        },
      },
      control: { clear: vi.fn(), isInterrupted: vi.fn().mockResolvedValue(false) },
    });

    await service.stream({ identity: identity(), question: 'question' }, response, new AbortController());

    expect(persisted.map((event) => event.type)).toEqual([
      'task_started',
      'meta_info',
      'thinking',
      'citation',
      'data',
      'data',
      'data',
      'result',
      'task_completed',
    ]);
    expect(persisted[0]).toMatchObject({ seq: 0, content: { message: 'question' }, ...v2Identity() });
    const data = persisted.filter((event): event is Extract<AgentEvent, { type: 'data' }> => event.type === 'data');
    expect(data.every((event) => event.content.text.length <= MAX_TEXT_DELTA_CHARS)).toBe(true);
    expect(data.map((event) => event.content.text).join('')).toBe(answer);
    expect(new Set(data.map((event) => event.content.chunk_id))).toEqual(new Set(['message_answer_1']));
    expect(persisted.find((event) => event.type === 'citation')).toMatchObject({
      content: { message_chunk_id: 'message_answer_1' },
    });
    expect(persisted.find((event) => event.type === 'result')).toMatchObject({
      content: { final_message_chunk_id: 'message_answer_1', text: answer },
    });
    for (const event of persisted) {
      expect(trace.indexOf(`persist:${event.event_id}`)).toBeLessThan(trace.indexOf(`publish:${event.event_id}`));
    }

    const streamedEvents = writes
      .filter((frame) => frame.startsWith('id: '))
      .map((frame) => decodeAgentEvent(frame.split('\ndata: ')[1].trim()));
    expect(streamedEvents).toEqual(persisted);
    expect(writes.at(-1)).toBe('event: done\ndata: {"done":true}\n\n');
  });

  it('marks interrupted generation terminal without emitting a result', async () => {
    const { journal, persisted, complete } = journalFake([]);
    const { response } = responseWriter([]);
    const service = serviceWith({
      journal,
      retrieval: { retrieve: vi.fn().mockResolvedValue([]) },
      llm: {
        streamAnswer: async function* () {
          yield 'ignored';
        },
      },
      control: { clear: vi.fn(), isInterrupted: vi.fn().mockResolvedValue(true) },
    });

    await service.stream({ identity: identity(), question: 'question' }, response, new AbortController());

    expect(persisted.some((event) => event.type === 'result')).toBe(false);
    expect(complete).toHaveBeenCalledWith(identity(), {
      status: 'interrupted',
      terminalReason: 'interrupted',
      message: 'interrupted',
    });
    expect(persisted.at(-1)?.type).toBe('task_completed');
  });

  it('emits error and task_completed as separate events and marks a failed run terminal', async () => {
    const { journal, persisted, fail } = journalFake([]);
    const { response } = responseWriter([]);
    const service = serviceWith({
      journal,
      retrieval: { retrieve: vi.fn().mockResolvedValue([]) },
      llm: {
        streamAnswer: async function* () {
          throw new Error('provider failed');
        },
      },
      control: { clear: vi.fn(), isInterrupted: vi.fn().mockResolvedValue(false) },
    });

    await service.stream({ identity: identity(), question: 'question' }, response, new AbortController());

    expect(persisted.slice(-2).map((event) => event.type)).toEqual(['error', 'task_completed']);
    expect(fail).toHaveBeenCalledWith(identity(), {
      error_code: 43106,
      message: 'provider failed',
    });
  });
});

function serviceWith({
  journal,
  retrieval,
  llm,
  control,
}: {
  journal: object;
  retrieval: object;
  llm: object;
  control: object;
}): SessionsService {
  return new SessionsService(
    {} as never,
    journal as never,
    {} as never,
    retrieval as never,
    llm as never,
    control as never,
    { get: () => 3_600 } as never,
  );
}

function journalFake(trace: string[]) {
  const persisted: AgentEvent[] = [];
  const persist = (identityValue: SessionRunIdentity, type: AgentEvent['type'], content: AgentEvent['content']) => {
    const event = {
      schema_version: 2,
      event_id: `event_${persisted.length}`,
      seq: persisted.length,
      timestamp: 1_725_000_000_000 + persisted.length,
      request_id: identityValue.requestId,
      workspace_id: identityValue.workspaceId,
      session_id: identityValue.sessionId,
      question_id: identityValue.questionId,
      answer_id: identityValue.answerId,
      run_id: identityValue.runId,
      type,
      content,
    } as AgentEvent;
    trace.push(`persist:${event.event_id}`);
    persisted.push(event);
    return event;
  };
  const append = vi.fn(async (identityValue, type, content) => persist(identityValue, type, content));
  const succeed = vi.fn(async (identityValue, content) => ({
    signal: { event: persist(identityValue, 'result', content), appended: true },
    completion: {
      event: persist(identityValue, 'task_completed', { message: 'done' }),
      appended: true,
    },
  }));
  const fail = vi.fn(async (identityValue, content) => ({
    signal: { event: persist(identityValue, 'error', content), appended: true },
    completion: {
      event: persist(identityValue, 'task_completed', { message: 'failed' }),
      appended: true,
    },
  }));
  const complete = vi.fn(async (identityValue, terminal) => ({
    event: persist(identityValue, 'task_completed', { message: terminal.message }),
    appended: true,
  }));
  return { journal: { append, succeed, fail, complete }, persisted, complete, fail };
}

function identity(): SessionRunIdentity {
  return {
    requestId: 'request_1',
    workspaceId: 'workspace_1',
    sessionId: 'session_1',
    questionId: 'question_1',
    answerId: 'answer_1',
    runId: 'run_1',
  };
}

function v2Identity() {
  return {
    schema_version: 2,
    request_id: 'request_1',
    workspace_id: 'workspace_1',
    session_id: 'session_1',
    question_id: 'question_1',
    answer_id: 'answer_1',
    run_id: 'run_1',
  };
}

function responseWriter(trace: string[]): { response: ServerResponse; writes: string[] } {
  let ended = false;
  const writes: string[] = [];
  const response = {
    destroyed: false,
    get writableEnded() {
      return ended;
    },
    write: vi.fn((data: string) => {
      writes.push(data);
      if (data.startsWith('id: ')) trace.push(`publish:${decodeAgentEvent(data.split('\ndata: ')[1].trim()).event_id}`);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
    }),
  } as unknown as ServerResponse;
  return { response, writes };
}

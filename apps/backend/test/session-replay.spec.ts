import type { ServerResponse } from 'node:http';

import { decodeAgentEvent, type AgentEvent } from '@agent/protocol';
import { describe, expect, it, vi } from 'vitest';

import { SessionsService } from '../src/sessions/sessions.service';

const replayEvent: AgentEvent = {
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
  type: 'task_started',
  content: { message: 'hello' },
};

describe('SessionsService replay', () => {
  it('replays complete V2 envelopes in journal order without starting a second generation', async () => {
    const llm = { streamAnswer: vi.fn() };
    const { response, writes, end } = responseWriter();
    const artifacts = { requestFromAnswer: vi.fn() };
    const service = serviceWith({ llm, artifacts });

    await service.stream(
      { identity: identity(), question: 'hello', outputArtifact: 'document', replay: [replayEvent] },
      response,
      new AbortController(),
    );

    expect(llm.streamAnswer).not.toHaveBeenCalled();
    expect(artifacts.requestFromAnswer).not.toHaveBeenCalled();
    expect(decodeAgentEvent(writes[0].split('\ndata: ')[1].trim())).toEqual(replayEvent);
    expect(writes).toContain('event: done\ndata: {"done":true}\n\n');
    expect(end).toHaveBeenCalledOnce();
  });

  it('finishes an empty replay without starting a second generation', async () => {
    const llm = { streamAnswer: vi.fn() };
    const { response, writes, end } = responseWriter();
    const service = serviceWith({ llm });

    await service.stream({ identity: identity(), question: 'hello', replay: [] }, response, new AbortController());

    expect(llm.streamAnswer).not.toHaveBeenCalled();
    expect(writes).toEqual(['event: done\ndata: {"done":true}\n\n']);
    expect(end).toHaveBeenCalledOnce();
  });
});

function serviceWith({
  llm,
  artifacts = {},
}: {
  llm: { streamAnswer: ReturnType<typeof vi.fn> };
  artifacts?: object;
}): SessionsService {
  return new SessionsService(
    {} as never,
    { read: vi.fn() } as never,
    artifacts as never,
    {} as never,
    {} as never,
    llm as never,
    {} as never,
    { get: () => 3_600 } as never,
  );
}

function identity() {
  return {
    requestId: 'request_1',
    workspaceId: 'workspace_1',
    sessionId: 'session_1',
    questionId: 'question_1',
    answerId: 'answer_1',
    runId: 'run_1',
  };
}

function responseWriter(): { response: ServerResponse; writes: string[]; end: ReturnType<typeof vi.fn> } {
  let ended = false;
  const writes: string[] = [];
  const end = vi.fn(() => {
    ended = true;
  });
  const response = {
    destroyed: false,
    get writableEnded() {
      return ended;
    },
    write: vi.fn((data: string) => {
      writes.push(data);
      return true;
    }),
    end,
  } as unknown as ServerResponse;
  return { response, writes, end };
}

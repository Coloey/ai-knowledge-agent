import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '@agent/protocol';
import {
  appendLocalUserMessage,
  createChatState,
  recordTransportError,
  reduceAgentEvent,
  reduceAgentEventBatch,
  selectOrderedChunks,
  selectOrderedParts,
  stopRunLocally,
} from './index';

function event<T extends AgentEvent['type']>(
  type: T,
  content: Extract<AgentEvent, { type: T }>['content'],
  overrides: Partial<AgentEvent> = {},
): Extract<AgentEvent, { type: T }> {
  return {
    schema_version: 2,
    event_id: `${type}-${overrides.run_id ?? 'run-1'}-${overrides.seq ?? 0}`,
    seq: 0,
    timestamp: 1,
    request_id: 'request-1',
    workspace_id: 'workspace-1',
    session_id: 'session-1',
    question_id: 'question-1',
    answer_id: 'answer-1',
    run_id: 'run-1',
    type,
    content,
    ...overrides,
  } as Extract<AgentEvent, { type: T }>;
}

function reduce(state: ReturnType<typeof createChatState>, events: AgentEvent[]) {
  return events.reduce(reduceAgentEvent, state);
}

describe('normalized chat reducer', () => {
  it('correlates local turns by request ID and keeps an unknown background session isolated', () => {
    let state = appendLocalUserMessage(createChatState('foreground'), 'foreground question', {
      requestId: 'request-local',
      localPartId: 'local-question',
    });
    state = reduceAgentEvent(
      state,
      event('task_started', { message: 'background question' }, {
        event_id: 'background-start', request_id: 'request-background', session_id: 'session-background', question_id: 'question-background', answer_id: 'answer-background', run_id: 'run-background',
      }),
    );
    expect(selectOrderedParts(state, 'foreground')).toMatchObject([{ id: 'local-question', text: 'foreground question' }]);
    expect(selectOrderedParts(state, 'session-background')).toMatchObject([
      { id: 'question-background', kind: 'user_message', text: 'background question' },
      { id: 'answer:answer-background', kind: 'assistant_answer' },
    ]);

    state = reduceAgentEvent(
      state,
      event('task_started', { message: 'foreground question' }, { event_id: 'foreground-start', request_id: 'request-local', session_id: 'session-foreground', question_id: 'question-foreground', answer_id: 'answer-foreground', run_id: 'run-foreground' }),
    );
    expect(selectOrderedParts(state, 'foreground')).toMatchObject([
      { id: 'question-foreground', kind: 'user_message' },
      { id: 'answer:answer-foreground', kind: 'assistant_answer' },
    ]);
  });

  it('materializes a two-turn session history to the same semantic state as live reduction', () => {
    const firstTurn = [
      event('task_started', { message: 'first question' }, { event_id: 'start-1', request_id: 'request-1', question_id: 'question-1', answer_id: 'answer-1', run_id: 'run-1', seq: 0 }),
      event('data', { chunk_id: 'message-1', text: 'first answer' }, { event_id: 'data-1', run_id: 'run-1', seq: 1 }),
      event('result', { final_message_chunk_id: 'message-1', text: 'first answer' }, { event_id: 'result-1', run_id: 'run-1', seq: 2 }),
      event('task_completed', { terminal_reason: 'completed' }, { event_id: 'complete-1', run_id: 'run-1', seq: 3 }),
    ];
    const secondTurn = [
      event('task_started', { message: 'second question' }, { event_id: 'start-2', request_id: 'request-2', question_id: 'question-2', answer_id: 'answer-2', run_id: 'run-2', seq: 0 }),
      event('thinking', { chunk_id: 'thinking-2', text: 'thinking' }, { event_id: 'thinking-2', run_id: 'run-2', answer_id: 'answer-2', question_id: 'question-2', seq: 1 }),
      event('data', { chunk_id: 'message-2', text: 'second answer' }, { event_id: 'data-2', run_id: 'run-2', answer_id: 'answer-2', question_id: 'question-2', seq: 2 }),
      event('result', { final_message_chunk_id: 'message-2', text: 'second answer' }, { event_id: 'result-2', run_id: 'run-2', answer_id: 'answer-2', question_id: 'question-2', seq: 3 }),
      event('task_completed', { terminal_reason: 'completed' }, { event_id: 'complete-2', run_id: 'run-2', answer_id: 'answer-2', question_id: 'question-2', seq: 4 }),
    ];
    const history = reduceAgentEventBatch(createChatState('session-1'), [...firstTurn, ...secondTurn]);

    let live = appendLocalUserMessage(createChatState('session-1'), 'first question', { requestId: 'request-1' });
    live = reduce(live, firstTurn);
    live = appendLocalUserMessage(live, 'second question', { requestId: 'request-2' });
    live = reduce(live, secondTurn);

    expect(selectOrderedParts(history, 'session-1')).toMatchObject([
      { id: 'question-1', kind: 'user_message' },
      { id: 'answer:answer-1', kind: 'assistant_answer' },
      { id: 'question-2', kind: 'user_message' },
      { id: 'answer:answer-2', kind: 'assistant_answer' },
    ]);
    expect(history).toEqual(live);
  });

  it('uses explicit chunk IDs, settles tools, and enriches completed output with late citations', () => {
    const started = event('task_started', { message: 'question' }, { event_id: 'start', seq: 0 });
    let state = reduce(createChatState('session-1'), [started]);
    state = reduceAgentEvent(state, event('thinking', { chunk_id: 'thinking-id', text: 'think' }, { event_id: 'thinking', seq: 1 }));
    state = reduceAgentEvent(state, event('data', { chunk_id: 'message-id', text: 'draft' }, { event_id: 'data', seq: 2 }));
    state = reduceAgentEvent(state, event('current_tool_use', { tool_use_id: 'tool-id', name: 'search' }, { event_id: 'tool', seq: 3 }));
    state = reduceAgentEvent(state, event('tool_result', { tool_use_id: 'tool-id', is_error: true, result: 'failed' }, { event_id: 'tool-result', seq: 4 }));
    const answerId = selectOrderedParts(state, 'session-1')[1].id;
    expect(selectOrderedChunks(state, answerId)).toMatchObject([
      { id: 'thinking-id', status: 'streaming' },
      { id: 'message-id', status: 'streaming' },
      { kind: 'tool', toolUseId: 'tool-id', status: 'error' },
    ]);

    state = reduceAgentEvent(state, event('result', { final_message_chunk_id: 'message-id', text: 'final' }, { event_id: 'result', seq: 5 }));
    state = reduceAgentEvent(state, event('task_completed', { terminal_reason: 'completed' }, { event_id: 'complete', seq: 6 }));
    state = reduceAgentEvent(state, event('citation', { message_chunk_id: 'message-id', citations: [{ title: 'Source' }] }, { event_id: 'late-citation', seq: 7 }));
    expect(state.threads['session-1'].lifecycle).toBe('completed');
    expect(state.chunks['message-id']).toMatchObject({ status: 'completed', text: 'final', citations: [{ title: 'Source' }] });

    let artifacts = reduce(createChatState('session-artifacts'), [event('task_started', { message: 'artifact question' }, { event_id: 'artifact-start', session_id: 'session-artifacts', run_id: 'run-artifacts', seq: 0 })]);
    artifacts = reduceAgentEvent(artifacts, event('artifact', { artifact: { name: 'one' } }, { event_id: 'artifact-one', session_id: 'session-artifacts', run_id: 'run-artifacts', seq: 1 }));
    artifacts = reduceAgentEvent(artifacts, event('artifact', { artifact: { name: 'two' } }, { event_id: 'artifact-two', session_id: 'session-artifacts', run_id: 'run-artifacts', seq: 2 }));
    expect(Object.keys(artifacts.artifacts)).toEqual(['artifact:artifact-one:0', 'artifact:artifact-two:0']);
  });

  it('clears the previous active answer for a new local turn and preserves stopped/error terminals', () => {
    let state = reduce(createChatState('session-1'), [
      event('task_started', { message: 'one' }, { event_id: 'start-1', seq: 0 }),
      event('result', { final_message_chunk_id: 'message-1', text: 'one' }, { event_id: 'result-1', seq: 1 }),
      event('task_completed', { terminal_reason: 'completed' }, { event_id: 'complete-1', seq: 2 }),
    ]);
    state = appendLocalUserMessage(state, 'two', { requestId: 'request-2' });
    const failed = recordTransportError(state, 'offline');
    expect(selectOrderedParts(failed, 'session-1')).toMatchObject([
      { id: 'question-1' }, { id: 'answer:answer-1', status: 'completed' }, { kind: 'user_message', text: 'two' },
      { kind: 'assistant_answer', status: 'error' }, { kind: 'system_notice', text: 'offline' },
    ]);

    let stopped = reduce(createChatState('session-stop'), [event('task_started', { message: 'stop' }, { event_id: 'start-stop', session_id: 'session-stop', run_id: 'run-stop', seq: 0 })]);
    stopped = stopRunLocally(stopped, 'session-stop');
    stopped = reduceAgentEvent(stopped, event('task_completed', { terminal_reason: 'interrupted' }, { event_id: 'complete-stop', session_id: 'session-stop', run_id: 'run-stop', seq: 1 }));
    expect(stopped.threads['session-stop'].lifecycle).toBe('stopped');
    const errored = reduce(createChatState('session-error'), [
      event('task_started', { message: 'error' }, { event_id: 'start-error', session_id: 'session-error', run_id: 'run-error', seq: 0 }),
      event('error', { message: 'failed' }, { event_id: 'error', session_id: 'session-error', run_id: 'run-error', seq: 1 }),
      event('task_completed', { terminal_reason: 'failed' }, { event_id: 'complete-error', session_id: 'session-error', run_id: 'run-error', seq: 2 }),
    ]);
    expect(errored.threads['session-error'].lifecycle).toBe('error');
    const repeated = recordTransportError(failed, 'offline again', 'session-1');
    const notices = selectOrderedParts(repeated, 'session-1').filter((part) => part.kind === 'system_notice');
    expect(repeated).toBe(failed);
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(1);
  });

  it('does not turn terminal runs back into transport failures or restart a closed run ID', () => {
    const completed = reduce(createChatState('session-completed'), [
      event('task_started', { message: 'completed' }, { event_id: 'start-completed', session_id: 'session-completed', run_id: 'run-completed', seq: 0 }),
      event('result', { final_message_chunk_id: 'message-completed', text: 'done' }, { event_id: 'result-completed', session_id: 'session-completed', run_id: 'run-completed', seq: 1 }),
      event('task_completed', { terminal_reason: 'completed' }, { event_id: 'complete-completed', session_id: 'session-completed', run_id: 'run-completed', seq: 2 }),
    ]);
    const repeatedStart = reduceAgentEvent(completed, event('task_started', { message: 'completed' }, { event_id: 'repeat-completed', session_id: 'session-completed', run_id: 'run-completed', seq: 3 }));
    expect(recordTransportError(completed, 'late transport', 'session-completed')).toBe(completed);
    expect(repeatedStart.threads['session-completed'].lifecycle).toBe('completed');
    expect(selectOrderedParts(repeatedStart, 'session-completed')).toHaveLength(2);

    let stopped = reduce(createChatState('session-stopped'), [event('task_started', { message: 'stopped' }, { event_id: 'start-stopped', session_id: 'session-stopped', run_id: 'run-stopped', seq: 0 })]);
    stopped = stopRunLocally(stopped, 'session-stopped');
    const errored = reduce(createChatState('session-errored'), [
      event('task_started', { message: 'errored' }, { event_id: 'start-errored', session_id: 'session-errored', run_id: 'run-errored', seq: 0 }),
      event('error', { message: 'failed' }, { event_id: 'error-errored', session_id: 'session-errored', run_id: 'run-errored', seq: 1 }),
    ]);
    expect(recordTransportError(stopped, 'late transport', 'session-stopped')).toBe(stopped);
    expect(recordTransportError(errored, 'late transport', 'session-errored')).toBe(errored);
  });
});

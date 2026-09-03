import { describe, expect, it } from 'vitest';

import {
  appendLocalUserMessage,
  createChatState,
  createChatThread,
  recordTransportError,
  reduceAgentEvent,
  reduceAgentEventBatch,
  selectOrderedChunks,
  selectOrderedParts,
  stopRunLocally,
} from './index';
import type { AgentEvent } from '@agent/protocol';

function event<T extends AgentEvent['type']>(
  type: T,
  content: Extract<AgentEvent, { type: T }>['content'],
  overrides: Partial<AgentEvent> = {},
): Extract<AgentEvent, { type: T }> {
  return {
    schema_version: 2,
    event_id: `${type}-${overrides.seq ?? 0}`,
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

describe('normalized chat reducer', () => {
  it('binds a local user part and reduces an answer without duplicate visible parts', () => {
    let state = appendLocalUserMessage(createChatState('local-thread'), 'What is the answer?', 'local-question');
    state = reduceAgentEvent(state, event('task_started', {}, { seq: 0 }));
    state = reduceAgentEvent(state, event('thinking', { text: 'Looking it up' }, { seq: 1 }));
    state = reduceAgentEvent(state, event('data', { text: 'The answer is ' }, { seq: 2 }));
    state = reduceAgentEvent(
      state,
      event('current_tool_use', { tool_use_id: 'tool-1', name: 'search', input: { query: 'answer' } }, { seq: 3 }),
    );
    state = reduceAgentEvent(state, event('tool_result', { tool_use_id: 'tool-1', result: { hits: 1 } }, { seq: 4 }));
    state = reduceAgentEvent(state, event('citation', { citations: [{ title: 'Source' }] }, { seq: 5 }));
    state = reduceAgentEvent(state, event('result', { text: 'The answer is 42' }, { seq: 6 }));
    state = reduceAgentEvent(state, event('task_completed', {}, { seq: 7 }));

    const parts = selectOrderedParts(state);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ id: 'question-1', kind: 'user_message', text: 'What is the answer?' });
    expect(parts[1]).toMatchObject({ kind: 'assistant_answer', status: 'completed' });

    const chunks = selectOrderedChunks(state, parts[1].id);
    expect(chunks).toMatchObject([
      { kind: 'thinking', text: 'Looking it up', status: 'completed' },
      { kind: 'message', text: 'The answer is 42', status: 'completed', citations: [{ title: 'Source' }] },
      { kind: 'tool', toolUseId: 'tool-1', name: 'search', result: { hits: 1 }, status: 'completed' },
    ]);
    expect(state.threads['local-thread']).toMatchObject({ questionId: 'question-1', lifecycle: 'completed' });
  });

  it('records duplicate, sequence and orphan diagnostics without corrupting another thread', () => {
    let state = createChatState('foreground');
    state = {
      ...state,
      threads: {
        ...state.threads,
        background: { ...createChatThread('background'), questionId: 'question-background' },
      },
    };

    state = reduceAgentEvent(state, event('task_started', {}, { event_id: 'background-start', question_id: 'question-background', seq: 0 }));
    state = reduceAgentEvent(
      state,
      event('tool_result', { tool_use_id: 'missing-tool', result: 'missing' }, { event_id: 'orphan', question_id: 'question-background', seq: 2 }),
    );
    const afterDuplicate = reduceAgentEvent(state, event('heartbeat', {}, { event_id: 'orphan', question_id: 'question-background', seq: 2 }));
    expect(afterDuplicate).toBe(state);
    state = reduceAgentEvent(state, event('data', { text: 'stale' }, { event_id: 'stale', question_id: 'question-background', seq: 1 }));

    expect(selectOrderedParts(state, 'foreground')).toEqual([]);
    expect(state.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(['sequence_gap', 'orphan_tool_result', 'stale_sequence']);
  });

  it('has equal semantic state for streaming and ordered history batches', () => {
    const events = [
      event('task_started', {}, { seq: 0 }),
      event('thinking', { text: 'one' }, { seq: 1 }),
      event('data', { text: 'two' }, { seq: 2 }),
      event('result', { text: 'two' }, { seq: 3 }),
      event('task_completed', {}, { seq: 4 }),
    ];
    const initial = appendLocalUserMessage(createChatState('thread-1'), 'question', 'local-question');
    const realtime = events.reduce(reduceAgentEvent, initial);
    const history = reduceAgentEventBatch(initial, events);

    expect(history).toEqual(realtime);
  });

  it('stops a run locally and records a transport error on its active answer', () => {
    let state = appendLocalUserMessage(createChatState('thread-1'), 'question', 'local-question');
    state = reduceAgentEvent(state, event('task_started', {}, { seq: 0 }));

    const stopped = stopRunLocally(state);
    expect(selectOrderedParts(stopped)[1]).toMatchObject({ kind: 'assistant_answer', status: 'stopped' });
    expect(stopped.threads['thread-1'].lifecycle).toBe('stopped');

    const failed = recordTransportError(state, 'Connection lost');
    expect(selectOrderedParts(failed)).toMatchObject([
      { kind: 'user_message' },
      { kind: 'assistant_answer', status: 'error' },
      { kind: 'system_notice', level: 'error', text: 'Connection lost' },
    ]);
    expect(failed.threads['thread-1'].lifecycle).toBe('error');
  });
});

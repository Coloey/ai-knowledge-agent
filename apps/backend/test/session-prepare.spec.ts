import type { AgentEvent } from '@agent/protocol';
import { describe, expect, it, vi } from 'vitest';

import { SessionsService } from '../src/sessions/sessions.service';

describe('SessionsService prepare', () => {
  it('generates and persists the required request and run identities', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const transaction = vi.fn(async (operation: (tx: object) => Promise<unknown>) =>
      operation({
        insert: () => ({
          values: async (value: Record<string, unknown>) => {
            inserted.push(value);
          },
        }),
      }),
    );
    const workspaces = { assertMember: vi.fn() };
    const service = createService({ database: { db: { transaction } }, workspaces });

    const context = await service.prepare(
      { id: 'user_1', email: 'user@example.com', name: 'User', avatar: '' },
      {
        workspace_id: 'workspace_1',
        message: 'question',
        options: {},
        timezone_offset: 0,
        display_language: 'zh-CN',
      },
    );

    expect(workspaces.assertMember).toHaveBeenCalledWith('user_1', 'workspace_1');
    expect(context.identity.requestId).toMatch(/^request_/);
    expect(context.identity.runId).toMatch(/^run_/);
    expect(inserted[1]).toMatchObject({ requestId: context.identity.requestId, id: context.identity.questionId });
    expect(inserted[2]).toMatchObject({
      id: context.identity.answerId,
      runId: context.identity.runId,
      status: 'streaming',
      startedAt: expect.any(Date),
    });
  });

  it('loads duplicate request replay from the V2 journal in sequence order', async () => {
    const event = taskStartedEvent();
    const existing = {
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      questionId: 'question_1',
      requestId: 'request_1',
      question: 'question',
      answerId: 'answer_1',
      runId: 'run_1',
      answerStatus: 'finished',
    };
    const limit = vi.fn().mockResolvedValue([existing]);
    const database = {
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              innerJoin: () => ({ where: () => ({ limit }) }),
            }),
          }),
        }),
      },
    };
    const journal = { read: vi.fn().mockResolvedValue([event]) };
    const service = createService({ database, journal });

    await expect(
      service.prepare(
        { id: 'user_1', email: 'user@example.com', name: 'User', avatar: '' },
        {
          request_id: 'request_1',
          workspace_id: 'workspace_1',
          message: 'retry',
          options: {},
          timezone_offset: 0,
          display_language: 'zh-CN',
        },
      ),
    ).resolves.toEqual({
      identity: {
        requestId: 'request_1',
        workspaceId: 'workspace_1',
        sessionId: 'session_1',
        questionId: 'question_1',
        answerId: 'answer_1',
        runId: 'run_1',
      },
      question: 'question',
      replay: [event],
    });
    expect(journal.read).toHaveBeenCalledWith('answer_1');
  });

  it('recovers a durable result whose task completion was interrupted before replay', async () => {
    const started = taskStartedEvent();
    const result: AgentEvent = {
      ...started,
      event_id: 'event_result',
      seq: 1,
      type: 'result',
      content: { final_message_chunk_id: 'message_answer_1', text: 'answer' },
    };
    const completed: AgentEvent = {
      ...started,
      event_id: 'event_completed',
      seq: 2,
      type: 'task_completed',
      content: { terminal_reason: 'completed', message: 'done' },
    };
    const existing = {
      sessionId: 'session_1',
      workspaceId: 'workspace_1',
      questionId: 'question_1',
      requestId: 'request_1',
      question: 'question',
      answerId: 'answer_1',
      runId: 'run_1',
      answerStatus: 'streaming',
    };
    const database = duplicateRequestDatabase(existing);
    const journal = {
      read: vi.fn().mockResolvedValueOnce([started, result]).mockResolvedValueOnce([started, result, completed]),
      succeed: vi.fn().mockResolvedValue(undefined),
    };
    const service = createService({ database, journal });

    const context = await service.prepare(
      { id: 'user_1', email: 'user@example.com', name: 'User', avatar: '' },
      {
        request_id: 'request_1',
        workspace_id: 'workspace_1',
        message: 'retry',
        options: {},
        timezone_offset: 0,
        display_language: 'zh-CN',
      },
    );

    expect(journal.succeed).toHaveBeenCalledWith(
      expect.objectContaining({ answerId: 'answer_1', runId: 'run_1' }),
      result.content,
    );
    expect(context.replay).toEqual([started, result, completed]);
  });
});

function createService({
  database = {},
  journal = {},
  workspaces = { assertMember: vi.fn() },
}: {
  database?: object;
  journal?: object;
  workspaces?: object;
}): SessionsService {
  return new SessionsService(
    database as never,
    journal as never,
    workspaces as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function taskStartedEvent(): AgentEvent {
  return {
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
    content: { message: 'question' },
  };
}

function duplicateRequestDatabase(existing: object) {
  return {
    db: {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({ where: () => ({ limit: async () => [existing] }) }),
          }),
        }),
      }),
    },
  };
}

import { AgentEventDecodeError, type AgentEvent } from '@agent/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeStoredAgentEvent,
  SessionEventJournal,
  type SessionRunIdentity,
} from '../src/sessions/session-event-journal.service';

const storedEvent = {
  eventId: 'event_row_1',
  schemaVersion: 2,
  seq: 4,
  type: 'data',
  contentJson: { chunk_id: 'message_1', text: 'bounded delta' },
  createdAt: new Date('2026-09-03T00:00:00.000Z'),
  requestId: 'request_1',
  workspaceId: 'workspace_1',
  sessionId: 'session_1',
  questionId: 'question_1',
  answerId: 'answer_1',
  runId: 'run_1',
};

describe('SessionEventJournal stored event decoding', () => {
  it('uses the existing row id and relationships to restore a complete V2 envelope', () => {
    expect(decodeStoredAgentEvent(storedEvent)).toEqual({
      schema_version: 2,
      event_id: 'event_row_1',
      seq: 4,
      timestamp: storedEvent.createdAt.getTime(),
      request_id: 'request_1',
      workspace_id: 'workspace_1',
      session_id: 'session_1',
      question_id: 'question_1',
      answer_id: 'answer_1',
      run_id: 'run_1',
      type: 'data',
      content: { chunk_id: 'message_1', text: 'bounded delta' },
    });
  });

  it('rejects persisted V1 rows instead of replaying a legacy shape', () => {
    expect(() => decodeStoredAgentEvent({ ...storedEvent, schemaVersion: 1 })).toThrow(AgentEventDecodeError);
  });

  it('reserves the next answer sequence and stores schema V2 before returning the event', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const transaction = vi.fn(async (operation: (tx: object) => Promise<unknown>) =>
      operation({
        update: () => ({
          set: () => ({
            where: () => ({ returning: async () => [{ seq: 0 }] }),
          }),
        }),
        insert: () => ({
          values: async (row: Record<string, unknown>) => {
            inserted.push(row);
          },
        }),
      }),
    );
    const journal = new SessionEventJournal({ db: { transaction } } as never);

    const event = await journal.append(identity, 'task_started', { message: 'question' });

    expect(transaction).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      id: event.event_id,
      answerId: identity.answerId,
      schemaVersion: 2,
      type: 'task_started',
      contentJson: { message: 'question' },
      seq: 0,
    });
    expect(event).toMatchObject({ ...v2Identity, event_id: inserted[0].id, seq: 0, type: 'task_started' });
  });

  it('persists result, task_completed, and answer terminal state in one transaction', async () => {
    const { database, inserted, updated, transaction } = terminalDatabase({ lastEventSeq: 4, completedAt: null }, []);
    const journal = new SessionEventJournal(database as never);

    const terminal = await journal.succeed(identity, {
      final_message_chunk_id: 'message_1',
      text: 'answer',
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(inserted).toMatchObject([
      { type: 'result', seq: 5, contentJson: { final_message_chunk_id: 'message_1', text: 'answer' } },
      { type: 'task_completed', seq: 6, contentJson: { message: 'done' } },
    ]);
    expect(updated).toMatchObject([
      { lastEventSeq: 6, status: 'finished', terminalReason: 'completed', completedAt: expect.any(Date) },
    ]);
    expect(terminal.signal.appended).toBe(true);
    expect(terminal.completion.appended).toBe(true);
  });

  it('refuses to terminalize an empty journal before task_started is durable', async () => {
    const { database, inserted, updated } = terminalDatabase({ lastEventSeq: -1, completedAt: null }, []);
    const journal = new SessionEventJournal(database as never);

    await expect(journal.fail(identity, { error_code: 43106, message: 'task_started insert failed' })).rejects.toThrow(
      'has no task_started event',
    );
    expect(inserted).toEqual([]);
    expect(updated).toEqual([]);
  });

  it('does not insert or update when retrying a completed result pair', async () => {
    const completedAt = new Date('2026-09-03T00:00:06.000Z');
    const { database, inserted, updated } = terminalDatabase({ lastEventSeq: 6, completedAt }, [
      storedResult(),
      storedCompletion(),
    ]);
    const journal = new SessionEventJournal(database as never);

    const terminal = await journal.succeed(identity, {
      final_message_chunk_id: 'message_1',
      text: 'answer',
    });

    expect(inserted).toEqual([]);
    expect(updated).toEqual([]);
    expect(terminal.signal).toMatchObject({ appended: false, event: { event_id: 'event_result', seq: 5 } });
    expect(terminal.completion).toMatchObject({
      appended: false,
      event: { event_id: 'event_completed', seq: 6 },
    });
  });

  it('repairs a durable result that is missing task_completed', async () => {
    const { database, inserted, updated } = terminalDatabase({ lastEventSeq: 5, completedAt: null }, [storedResult()]);
    const journal = new SessionEventJournal(database as never);

    const terminal = await journal.succeed(identity, {
      final_message_chunk_id: 'message_1',
      text: 'answer',
    });

    expect(inserted).toMatchObject([{ type: 'task_completed', seq: 6, contentJson: { message: 'done' } }]);
    expect(updated).toMatchObject([{ lastEventSeq: 6, status: 'finished', terminalReason: 'completed' }]);
    expect(terminal.signal.appended).toBe(false);
    expect(terminal.completion.appended).toBe(true);
  });

  it('reads stored rows in database sequence order', async () => {
    const orderBy = vi
      .fn()
      .mockResolvedValue([
        { ...storedEvent, eventId: 'event_0', seq: 0, type: 'task_started', contentJson: { message: 'question' } },
        storedEvent,
      ]);
    const journal = new SessionEventJournal({
      db: {
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                innerJoin: () => ({ where: () => ({ orderBy }) }),
              }),
            }),
          }),
        }),
      },
    } as never);

    await expect(journal.read('answer_1')).resolves.toMatchObject([
      { event_id: 'event_0', seq: 0, type: 'task_started' },
      { event_id: 'event_row_1', seq: 4, type: 'data' },
    ]);
    expect(orderBy).toHaveBeenCalledOnce();
  });

  it('reuses an existing task_completed event when the answer is already terminal', async () => {
    const existing = completedEvent();
    const journal = new SessionEventJournal({
      db: {
        transaction: vi.fn(async (operation: (tx: object) => Promise<unknown>) =>
          operation({
            select: () => ({
              from: () => ({
                where: () => ({ limit: async () => [{ id: 'event_started' }] }),
              }),
            }),
            update: () => ({
              set: () => ({ where: () => ({ returning: async () => [] }) }),
            }),
          }),
        ),
      },
    } as never);
    vi.spyOn(journal, 'read').mockResolvedValue([existing]);

    await expect(
      journal.complete(identity, { status: 'finished', terminalReason: 'completed', message: 'done' }),
    ).resolves.toEqual({ event: existing, appended: false });
  });
});

const identity: SessionRunIdentity = {
  requestId: 'request_1',
  workspaceId: 'workspace_1',
  sessionId: 'session_1',
  questionId: 'question_1',
  answerId: 'answer_1',
  runId: 'run_1',
};

const v2Identity = {
  schema_version: 2 as const,
  request_id: identity.requestId,
  workspace_id: identity.workspaceId,
  session_id: identity.sessionId,
  question_id: identity.questionId,
  answer_id: identity.answerId,
  run_id: identity.runId,
};

function completedEvent(): Extract<AgentEvent, { type: 'task_completed' }> {
  return {
    ...v2Identity,
    event_id: 'event_completed',
    seq: 6,
    timestamp: 1_725_000_000_006,
    type: 'task_completed',
    content: { message: 'done' },
  };
}

function storedResult() {
  return {
    eventId: 'event_result',
    schemaVersion: 2,
    seq: 5,
    type: 'result',
    contentJson: { final_message_chunk_id: 'message_1', text: 'answer' },
    createdAt: new Date('2026-09-03T00:00:05.000Z'),
  };
}

function storedCompletion() {
  return {
    eventId: 'event_completed',
    schemaVersion: 2,
    seq: 6,
    type: 'task_completed',
    contentJson: { message: 'done' },
    createdAt: new Date('2026-09-03T00:00:06.000Z'),
  };
}

function terminalDatabase(answer: { lastEventSeq: number; completedAt: Date | null }, stored: object[]) {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  let selectCount = 0;
  const transaction = vi.fn(async (operation: (tx: object) => Promise<unknown>) =>
    operation({
      select: () => {
        selectCount += 1;
        if (selectCount === 1) {
          return {
            from: () => ({
              where: () => ({
                for: () => ({ limit: async () => [answer] }),
              }),
            }),
          };
        }
        return {
          from: () => ({
            where: () => ({
              orderBy: async () =>
                answer.lastEventSeq >= 0
                  ? [
                      {
                        eventId: 'event_started',
                        schemaVersion: 2,
                        seq: 0,
                        type: 'task_started',
                        contentJson: { message: 'question' },
                        createdAt: new Date('2026-09-03T00:00:00.000Z'),
                      },
                      ...stored,
                    ]
                  : stored,
            }),
          }),
        };
      },
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          inserted.push(value);
        },
      }),
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: async () => {
            updated.push(value);
          },
        }),
      }),
    }),
  );
  return { database: { db: { transaction } }, inserted, updated, transaction };
}

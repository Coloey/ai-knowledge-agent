import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { decodeAgentEvent, type AgentEvent } from '@agent/protocol';

import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { chatAnswerEvents, chatAnswers, chatQuestions, chatSessions } from '../database/schema';

export interface SessionRunIdentity {
  requestId: string;
  workspaceId: string;
  sessionId: string;
  questionId: string;
  answerId: string;
  runId: string;
}

export interface StoredAgentEvent {
  eventId: string;
  schemaVersion: number;
  seq: number;
  type: string;
  contentJson: Record<string, unknown>;
  createdAt: Date;
  requestId: string;
  workspaceId: string;
  sessionId: string;
  questionId: string;
  answerId: string;
  runId: string;
}

export interface TerminalRunInput {
  status: 'finished' | 'failed' | 'interrupted';
  terminalReason: 'completed' | 'failed' | 'interrupted';
  message: string;
}

export interface JournalAppendResult<TEvent extends AgentEvent = AgentEvent> {
  event: TEvent;
  appended: boolean;
}

export interface JournalTerminalPair<TSignal extends AgentEvent> {
  signal: JournalAppendResult<TSignal>;
  completion: JournalAppendResult<EventOf<'task_completed'>>;
}

type EventType = AgentEvent['type'];
type EventOf<TType extends EventType> = Extract<AgentEvent, { type: TType }>;
type EventContent<TType extends EventType> = EventOf<TType>['content'];

@Injectable()
export class SessionEventJournal {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async append<TType extends EventType>(
    identity: SessionRunIdentity,
    type: TType,
    content: EventContent<TType>,
  ): Promise<EventOf<TType>> {
    const eventId = newId('event');
    const createdAt = new Date();
    return this.database.db.transaction(async (tx) => {
      const updated = await tx
        .update(chatAnswers)
        .set({ lastEventSeq: sql`${chatAnswers.lastEventSeq} + 1`, updatedAt: createdAt })
        .where(
          and(
            eq(chatAnswers.id, identity.answerId),
            eq(chatAnswers.runId, identity.runId),
            isNull(chatAnswers.completedAt),
          ),
        )
        .returning({ seq: chatAnswers.lastEventSeq });
      if (!updated[0]) throw new NotFoundException('Active answer run not found');
      if ((type === 'task_started') !== (updated[0].seq === 0)) {
        throw new Error('task_started must be the first event in a run');
      }

      const row = this.storedEvent(identity, eventId, updated[0].seq, type, content, createdAt);
      await tx.insert(chatAnswerEvents).values({
        id: row.eventId,
        answerId: row.answerId,
        schemaVersion: row.schemaVersion,
        type: row.type,
        contentJson: row.contentJson,
        seq: row.seq,
        createdAt,
        updatedAt: createdAt,
      });
      return decodeStoredAgentEvent(row) as EventOf<TType>;
    });
  }

  async succeed(
    identity: SessionRunIdentity,
    content: EventContent<'result'>,
  ): Promise<JournalTerminalPair<EventOf<'result'>>> {
    return this.finishWithSignal(identity, 'result', content, {
      status: 'finished',
      terminalReason: 'completed',
      message: 'done',
    });
  }

  async fail(
    identity: SessionRunIdentity,
    content: EventContent<'error'>,
  ): Promise<JournalTerminalPair<EventOf<'error'>>> {
    return this.finishWithSignal(identity, 'error', content, {
      status: 'failed',
      terminalReason: 'failed',
      message: 'failed',
    });
  }

  async complete(
    identity: SessionRunIdentity,
    terminal: TerminalRunInput,
  ): Promise<JournalAppendResult<EventOf<'task_completed'>> | null> {
    const eventId = newId('event');
    const completedAt = new Date();
    const appended = await this.database.db.transaction(async (tx) => {
      const starts = await tx
        .select({ id: chatAnswerEvents.id })
        .from(chatAnswerEvents)
        .where(
          and(
            eq(chatAnswerEvents.answerId, identity.answerId),
            eq(chatAnswerEvents.type, 'task_started'),
            eq(chatAnswerEvents.seq, 0),
          ),
        )
        .limit(1);
      if (!starts[0]) throw new Error(`Answer ${identity.answerId} has no task_started event`);

      const updated = await tx
        .update(chatAnswers)
        .set({
          lastEventSeq: sql`${chatAnswers.lastEventSeq} + 1`,
          status: terminal.status,
          terminalReason: terminal.terminalReason,
          completedAt,
          updatedAt: completedAt,
        })
        .where(
          and(
            eq(chatAnswers.id, identity.answerId),
            eq(chatAnswers.runId, identity.runId),
            isNull(chatAnswers.completedAt),
          ),
        )
        .returning({ seq: chatAnswers.lastEventSeq });
      if (!updated[0]) return null;

      const row = this.storedEvent(
        identity,
        eventId,
        updated[0].seq,
        'task_completed',
        { terminal_reason: terminal.terminalReason, message: terminal.message },
        completedAt,
      );
      await tx.insert(chatAnswerEvents).values({
        id: row.eventId,
        answerId: row.answerId,
        schemaVersion: row.schemaVersion,
        type: row.type,
        contentJson: row.contentJson,
        seq: row.seq,
        createdAt: completedAt,
        updatedAt: completedAt,
      });
      return decodeStoredAgentEvent(row) as EventOf<'task_completed'>;
    });
    if (appended) return { event: appended, appended: true };
    const existing = (await this.read(identity.answerId)).find(
      (event): event is EventOf<'task_completed'> => event.type === 'task_completed',
    );
    return existing ? { event: existing, appended: false } : null;
  }

  async read(answerId: string): Promise<AgentEvent[]> {
    const rows = await this.database.db
      .select({
        eventId: chatAnswerEvents.id,
        schemaVersion: chatAnswerEvents.schemaVersion,
        seq: chatAnswerEvents.seq,
        type: chatAnswerEvents.type,
        contentJson: chatAnswerEvents.contentJson,
        createdAt: chatAnswerEvents.createdAt,
        requestId: chatQuestions.requestId,
        workspaceId: chatSessions.workspaceId,
        sessionId: chatAnswers.sessionId,
        questionId: chatAnswers.questionId,
        answerId: chatAnswers.id,
        runId: chatAnswers.runId,
      })
      .from(chatAnswerEvents)
      .innerJoin(chatAnswers, eq(chatAnswers.id, chatAnswerEvents.answerId))
      .innerJoin(chatQuestions, eq(chatQuestions.id, chatAnswers.questionId))
      .innerJoin(chatSessions, eq(chatSessions.id, chatAnswers.sessionId))
      .where(eq(chatAnswerEvents.answerId, answerId))
      .orderBy(asc(chatAnswerEvents.seq));
    return rows.map(decodeStoredAgentEvent);
  }

  private async finishWithSignal<TType extends 'result' | 'error'>(
    identity: SessionRunIdentity,
    type: TType,
    content: EventContent<TType>,
    terminal: TerminalRunInput,
  ): Promise<JournalTerminalPair<EventOf<TType>>> {
    return this.database.db.transaction(async (tx) => {
      const answers = await tx
        .select({ lastEventSeq: chatAnswers.lastEventSeq, completedAt: chatAnswers.completedAt })
        .from(chatAnswers)
        .where(and(eq(chatAnswers.id, identity.answerId), eq(chatAnswers.runId, identity.runId)))
        .for('update')
        .limit(1);
      const answer = answers[0];
      if (!answer) throw new NotFoundException('Answer run not found');

      const stored = await tx
        .select({
          eventId: chatAnswerEvents.id,
          schemaVersion: chatAnswerEvents.schemaVersion,
          seq: chatAnswerEvents.seq,
          type: chatAnswerEvents.type,
          contentJson: chatAnswerEvents.contentJson,
          createdAt: chatAnswerEvents.createdAt,
        })
        .from(chatAnswerEvents)
        .where(
          and(
            eq(chatAnswerEvents.answerId, identity.answerId),
            inArray(chatAnswerEvents.type, ['task_started', type, 'task_completed']),
          ),
        )
        .orderBy(asc(chatAnswerEvents.seq));
      const existingStart = stored.find((event) => event.type === 'task_started' && event.seq === 0);
      if (!existingStart) throw new Error(`Answer ${identity.answerId} has no task_started event`);
      const existingSignal = stored.find((event) => event.type === type);
      const existingCompletion = stored.find((event) => event.type === 'task_completed');
      if (existingCompletion && !existingSignal) {
        throw new Error(`Answer ${identity.answerId} completed without a ${type} event`);
      }
      if (answer.completedAt && (!existingSignal || !existingCompletion)) {
        throw new Error(`Answer ${identity.answerId} has incomplete terminal journal state`);
      }

      let nextSeq = Math.max(answer.lastEventSeq, ...stored.map((event) => event.seq));
      let signalEvent: EventOf<TType>;
      let signalAppended = false;
      if (existingSignal) {
        signalEvent = decodeStoredAgentEvent(this.withIdentity(identity, existingSignal)) as EventOf<TType>;
      } else {
        nextSeq += 1;
        const row = this.storedEvent(identity, newId('event'), nextSeq, type, content, new Date());
        await tx.insert(chatAnswerEvents).values({
          id: row.eventId,
          answerId: row.answerId,
          schemaVersion: row.schemaVersion,
          type: row.type,
          contentJson: row.contentJson,
          seq: row.seq,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        signalEvent = decodeStoredAgentEvent(row) as EventOf<TType>;
        signalAppended = true;
      }

      let completionEvent: EventOf<'task_completed'>;
      let completionAppended = false;
      if (existingCompletion) {
        completionEvent = decodeStoredAgentEvent(
          this.withIdentity(identity, existingCompletion),
        ) as EventOf<'task_completed'>;
      } else {
        nextSeq += 1;
        const row = this.storedEvent(
          identity,
          newId('event'),
          nextSeq,
          'task_completed',
          { terminal_reason: terminal.terminalReason, message: terminal.message },
          new Date(),
        );
        await tx.insert(chatAnswerEvents).values({
          id: row.eventId,
          answerId: row.answerId,
          schemaVersion: row.schemaVersion,
          type: row.type,
          contentJson: row.contentJson,
          seq: row.seq,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        completionEvent = decodeStoredAgentEvent(row) as EventOf<'task_completed'>;
        completionAppended = true;
      }

      if (!answer.completedAt) {
        const completedAt = new Date(completionEvent.timestamp);
        await tx
          .update(chatAnswers)
          .set({
            lastEventSeq: nextSeq,
            status: terminal.status,
            terminalReason: terminal.terminalReason,
            completedAt,
            updatedAt: completedAt,
          })
          .where(and(eq(chatAnswers.id, identity.answerId), eq(chatAnswers.runId, identity.runId)));
      }
      return {
        signal: { event: signalEvent, appended: signalAppended },
        completion: { event: completionEvent, appended: completionAppended },
      };
    });
  }

  private storedEvent<TType extends EventType>(
    identity: SessionRunIdentity,
    eventId: string,
    seq: number,
    type: TType,
    content: EventContent<TType>,
    createdAt: Date,
  ): StoredAgentEvent {
    return {
      eventId,
      schemaVersion: 2,
      seq,
      type,
      contentJson: content as Record<string, unknown>,
      createdAt,
      requestId: identity.requestId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      questionId: identity.questionId,
      answerId: identity.answerId,
      runId: identity.runId,
    };
  }

  private withIdentity(
    identity: SessionRunIdentity,
    row: Omit<
      StoredAgentEvent,
      keyof SessionRunIdentity | 'workspaceId' | 'sessionId' | 'questionId' | 'answerId' | 'runId' | 'requestId'
    >,
  ): StoredAgentEvent {
    return {
      ...row,
      requestId: identity.requestId,
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      questionId: identity.questionId,
      answerId: identity.answerId,
      runId: identity.runId,
    };
  }
}

export function decodeStoredAgentEvent(row: StoredAgentEvent): AgentEvent {
  return decodeAgentEvent(
    JSON.stringify({
      schema_version: row.schemaVersion,
      event_id: row.eventId,
      seq: row.seq,
      timestamp: row.createdAt.getTime(),
      request_id: row.requestId,
      workspace_id: row.workspaceId,
      session_id: row.sessionId,
      question_id: row.questionId,
      answer_id: row.answerId,
      run_id: row.runId,
      type: row.type,
      content: row.contentJson,
    }),
  );
}

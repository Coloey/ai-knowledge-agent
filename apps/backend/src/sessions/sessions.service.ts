import type { ServerResponse } from 'node:http';

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq } from 'drizzle-orm';

import type { AuthenticatedUser } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { chatAnswerEvents, chatAnswers, chatQuestions, chatSessions, users } from '../database/schema';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type {
  RateAnswerRequestDto,
  SendMessageRequestDto,
  SessionDetailRequestDto,
  SessionHistoryRequestDto,
} from './session.dto';
import { LlmService } from './llm.service';
import { RetrievalService } from './retrieval.service';
import { SessionControlService } from './session-control.service';
import { sseData, sseDone, timestampMs, type SessionEvent } from './sse';

interface StreamContext {
  sessionId: string;
  answerId: string;
  question: string;
  requestId?: string;
  replay?: Array<{ type: string; contentJson: Record<string, unknown>; seq: number }>;
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(SessionControlService) private readonly control: SessionControlService,
    @Inject(ConfigService) private readonly config: ConfigService<Environment, true>,
  ) {}

  async prepare(user: AuthenticatedUser, input: SendMessageRequestDto): Promise<StreamContext> {
    await this.workspaces.assertMember(user.id, input.workspace_id);
    if (input.request_id) {
      const existing = await this.database.db
        .select({
          sessionId: chatSessions.id,
          answerId: chatAnswers.id,
          question: chatQuestions.message,
          answerStatus: chatAnswers.status,
        })
        .from(chatQuestions)
        .innerJoin(chatSessions, eq(chatSessions.id, chatQuestions.sessionId))
        .innerJoin(chatAnswers, eq(chatAnswers.questionId, chatQuestions.id))
        .where(and(eq(chatQuestions.requestId, input.request_id), eq(chatSessions.workspaceId, input.workspace_id)))
        .limit(1);
      if (existing[0]) {
        if (existing[0].answerStatus === 'streaming') {
          throw new ConflictException('A response for this request is still being generated');
        }
        const replay = await this.database.db
          .select({ type: chatAnswerEvents.type, contentJson: chatAnswerEvents.contentJson, seq: chatAnswerEvents.seq })
          .from(chatAnswerEvents)
          .where(eq(chatAnswerEvents.answerId, existing[0].answerId))
          .orderBy(asc(chatAnswerEvents.seq));
        return {
          sessionId: existing[0].sessionId,
          answerId: existing[0].answerId,
          question: existing[0].question,
          requestId: input.request_id,
          replay,
        };
      }
    }

    return this.database.db.transaction(async (tx) => {
      let sessionId = input.session_id;
      if (sessionId) {
        const session = await tx.query.chatSessions.findFirst({
          where: and(eq(chatSessions.id, sessionId), eq(chatSessions.workspaceId, input.workspace_id)),
        });
        if (!session) throw new NotFoundException('Session not found');
      } else {
        sessionId = newId('session');
        await tx.insert(chatSessions).values({
          id: sessionId,
          workspaceId: input.workspace_id,
          creatorId: user.id,
          title: input.message.slice(0, 40) || 'New chat',
        });
      }
      const questionId = newId('question');
      const answerId = newId('answer');
      await tx.insert(chatQuestions).values({
        id: questionId,
        sessionId,
        requestId: input.request_id,
        message: input.message,
        optionsJson: input.options,
        timezoneOffset: input.timezone_offset,
      });
      await tx.insert(chatAnswers).values({ id: answerId, sessionId, questionId, status: 'streaming' });
      return { sessionId, answerId, question: input.message, requestId: input.request_id };
    });
  }

  async stream(context: StreamContext, response: ServerResponse, abort: AbortController): Promise<void> {
    if (context.replay !== undefined) {
      for (const event of context.replay) {
        this.write(
          response,
          sseData({ type: event.type, session_id: context.sessionId, content: event.contentJson }, event.seq),
        );
      }
      this.write(response, sseDone());
      response.end();
      return;
    }

    let sequence = 0;
    const heartbeat = setInterval(
      () => this.write(response, `: heartbeat ${Date.now()}\n\n`),
      this.config.get('SSE_HEARTBEAT_SECONDS', { infer: true }) * 1_000,
    );
    const emit = async (type: string, content: Record<string, unknown>, persist = true): Promise<void> => {
      sequence += 1;
      const event: SessionEvent = { type, session_id: context.sessionId, content };
      if (persist) {
        await this.database.db.insert(chatAnswerEvents).values({
          id: newId('event'),
          answerId: context.answerId,
          type,
          contentJson: content,
          seq: sequence,
        });
      }
      this.write(response, sseData(event, sequence));
    };

    await this.control.clear(context.sessionId);
    let fullText = '';
    try {
      await emit('meta_info', { route: 'rag', request_id: context.requestId });
      await emit('thinking', { text: '正在检索知识库...' });
      const contexts = await this.retrieval.retrieve(await this.workspaceId(context.sessionId), context.question);
      if (contexts.length) {
        await emit('citation', {
          citations: contexts.map((item) => ({
            id: item.chunk_id,
            file_id: item.file_id,
            title: item.file_title,
            page: item.page,
            snippet: item.content.slice(0, 240),
          })),
        });
      } else {
        await emit('thinking', { text: '当前知识库没有命中内容，将基于通用能力回答。' });
      }

      for await (const token of this.llm.streamAnswer(context.question, contexts, abort.signal)) {
        if (abort.signal.aborted || (await this.control.isInterrupted(context.sessionId))) {
          abort.abort();
          await this.updateAnswerStatus(context.answerId, 'interrupted');
          await emit('task_completed', { message: 'interrupted' });
          this.write(response, sseDone());
          return;
        }
        fullText += token;
        await emit('data', { text: token }, false);
      }

      // Persist one aggregate data event for replay instead of one row per token.
      await this.persistEvent(context.answerId, 'data', { text: fullText }, ++sequence);
      await this.updateAnswerStatus(context.answerId, 'finished');
      await emit('result', { text: fullText });
      await emit('task_completed', { message: 'done' });
      this.write(response, sseDone());
    } catch (error) {
      await this.updateAnswerStatus(context.answerId, abort.signal.aborted ? 'interrupted' : 'failed');
      if (!response.writableEnded && !abort.signal.aborted) {
        await emit('error', {
          error_code: 43106,
          message: error instanceof Error ? error.message : 'Generation failed',
        });
        this.write(response, sseDone());
      }
    } finally {
      clearInterval(heartbeat);
      if (!response.writableEnded) response.end();
    }
  }

  async interrupt(userId: string, input: { workspace_id: string; session_id: string }): Promise<string> {
    await this.workspaces.assertMember(userId, input.workspace_id);
    await this.requireSession(input.workspace_id, input.session_id);
    await this.control.interrupt(input.session_id);
    return `interrupt_${newId('request').slice(8)}`;
  }

  async detail(userId: string, input: SessionDetailRequestDto) {
    await this.workspaces.assertMember(userId, input.workspace_id);
    const session = await this.requireSession(input.workspace_id, input.session_id);
    const creator = await this.database.db.query.users.findFirst({ where: eq(users.id, session.creatorId) });
    const questions = await this.database.db
      .select()
      .from(chatQuestions)
      .where(eq(chatQuestions.sessionId, session.id))
      .orderBy(asc(chatQuestions.createdAt));
    const messages = [];
    for (const question of questions) {
      const answer = await this.database.db.query.chatAnswers.findFirst({
        where: eq(chatAnswers.questionId, question.id),
      });
      const events = answer
        ? await this.database.db
            .select()
            .from(chatAnswerEvents)
            .where(eq(chatAnswerEvents.answerId, answer.id))
            .orderBy(asc(chatAnswerEvents.seq))
        : [];
      messages.push({
        question: {
          question_id: question.id,
          message: question.message,
          attachments: [],
          inline_mentions: [],
          temp_files: [],
          timezone_offset: question.timezoneOffset,
          created_time: timestampMs(question.createdAt),
          updated_time: timestampMs(question.updatedAt),
          options: question.optionsJson,
        },
        answer: {
          session_id: session.id,
          answer_id: answer?.id || '',
          message: events.map((event) => ({ type: event.type, session_id: session.id, content: event.contentJson })),
          status: answer?.status || 'missing',
          rating: answer?.rating ?? null,
          created_time: timestampMs(answer?.createdAt),
          updated_time: timestampMs(answer?.updatedAt),
        },
      });
    }
    return {
      session_id: session.id,
      title: session.title,
      creator: { uid: creator?.id || '', name: creator?.name || '', avatar: creator?.avatar || '' },
      share_config: {},
      source: 'manual',
      messages,
      followups: [],
      workspace_id: session.workspaceId,
      created_time: timestampMs(session.createdAt),
      updated_time: timestampMs(session.updatedAt),
    };
  }

  async history(userId: string, input: SessionHistoryRequestDto) {
    await this.workspaces.assertMember(userId, input.workspace_id);
    const sessions = await this.database.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.workspaceId, input.workspace_id))
      .orderBy(desc(chatSessions.updatedAt))
      .offset((input.page - 1) * input.page_size)
      .limit(input.page_size);
    return sessions.map((session) => ({
      session_id: session.id,
      title: session.title,
      status: session.status,
      workspace_id: session.workspaceId,
      created_time: timestampMs(session.createdAt),
      updated_time: timestampMs(session.updatedAt),
    }));
  }

  async rate(userId: string, input: RateAnswerRequestDto) {
    await this.workspaces.assertMember(userId, input.workspace_id);
    await this.requireSession(input.workspace_id, input.session_id);
    const answer = await this.database.db.query.chatAnswers.findFirst({
      where: and(eq(chatAnswers.id, input.answer_id), eq(chatAnswers.sessionId, input.session_id)),
    });
    if (!answer) throw new NotFoundException('Answer not found');
    await this.database.db
      .update(chatAnswers)
      .set({ rating: input.rating ?? null, updatedAt: new Date() })
      .where(eq(chatAnswers.id, answer.id));
    return { answer_id: answer.id, rating: input.rating ?? null };
  }

  private async workspaceId(sessionId: string): Promise<string> {
    const session = await this.database.db.query.chatSessions.findFirst({ where: eq(chatSessions.id, sessionId) });
    if (!session) throw new NotFoundException('Session not found');
    return session.workspaceId;
  }

  private async requireSession(workspaceId: string, sessionId: string) {
    const session = await this.database.db.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, sessionId), eq(chatSessions.workspaceId, workspaceId)),
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  private async persistEvent(
    answerId: string,
    type: string,
    content: Record<string, unknown>,
    seq: number,
  ): Promise<void> {
    await this.database.db
      .insert(chatAnswerEvents)
      .values({ id: newId('event'), answerId, type, contentJson: content, seq });
  }

  private async updateAnswerStatus(answerId: string, status: string): Promise<void> {
    await this.database.db
      .update(chatAnswers)
      .set({ status, updatedAt: new Date() })
      .where(eq(chatAnswers.id, answerId));
  }

  private write(response: ServerResponse, data: string): void {
    if (!response.writableEnded && !response.destroyed) response.write(data);
  }
}

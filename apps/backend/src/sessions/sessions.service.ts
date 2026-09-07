import type { ServerResponse } from 'node:http';

import type { AgentEvent } from '@agent/protocol';
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq } from 'drizzle-orm';

import type { AuthenticatedUser } from '../auth/auth.types';
import { ArtifactApplication } from '../artifacts/artifact.application';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { newId } from '../database/id';
import { chatAnswers, chatQuestions, chatSessions, users } from '../database/schema';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { LlmService } from './llm.service';
import { RetrievalService } from './retrieval.service';
import { SessionControlService } from './session-control.service';
import type { SessionRunIdentity, TerminalRunInput } from './session-event-journal.service';
import { SessionEventJournal } from './session-event-journal.service';
import type {
  RateAnswerRequestDto,
  SendMessageRequestDto,
  SessionDetailRequestDto,
  SessionHistoryRequestDto,
} from './session.dto';
import { sseData, sseDone, timestampMs } from './sse';

export const MAX_TEXT_DELTA_CHARS = 1_024;

type EventType = AgentEvent['type'];
type EventOf<TType extends EventType> = Extract<AgentEvent, { type: TType }>;

export interface StreamContext {
  identity: SessionRunIdentity;
  question: string;
  outputArtifact?: 'document';
  replay?: AgentEvent[];
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SessionEventJournal) private readonly journal: SessionEventJournal,
    @Inject(ArtifactApplication) private readonly artifacts: ArtifactApplication,
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
          workspaceId: chatSessions.workspaceId,
          questionId: chatQuestions.id,
          requestId: chatQuestions.requestId,
          question: chatQuestions.message,
          answerId: chatAnswers.id,
          runId: chatAnswers.runId,
          answerStatus: chatAnswers.status,
        })
        .from(chatQuestions)
        .innerJoin(chatSessions, eq(chatSessions.id, chatQuestions.sessionId))
        .innerJoin(chatAnswers, eq(chatAnswers.questionId, chatQuestions.id))
        .where(and(eq(chatQuestions.requestId, input.request_id), eq(chatSessions.workspaceId, input.workspace_id)))
        .limit(1);
      if (existing[0]) {
        const identity = {
          requestId: existing[0].requestId || input.request_id,
          workspaceId: existing[0].workspaceId,
          sessionId: existing[0].sessionId,
          questionId: existing[0].questionId,
          answerId: existing[0].answerId,
          runId: existing[0].runId,
        };
        let replay = await this.journal.read(existing[0].answerId);
        if (existing[0].answerStatus === 'streaming') {
          const result = replay.find((event): event is EventOf<'result'> => event.type === 'result');
          const error = replay.find((event): event is EventOf<'error'> => event.type === 'error');
          if (result) await this.journal.succeed(identity, result.content);
          else if (error) await this.journal.fail(identity, error.content);
          else throw new ConflictException('A response for this request is still being generated');
          replay = await this.journal.read(existing[0].answerId);
        }
        return {
          identity,
          question: existing[0].question,
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
      const requestId = input.request_id || newId('request');
      const questionId = newId('question');
      const answerId = newId('answer');
      const runId = newId('run');
      const startedAt = new Date();
      await tx.insert(chatQuestions).values({
        id: questionId,
        sessionId,
        requestId,
        message: input.message,
        optionsJson: input.options,
        timezoneOffset: input.timezone_offset,
      });
      await tx.insert(chatAnswers).values({
        id: answerId,
        sessionId,
        questionId,
        runId,
        status: 'streaming',
        startedAt,
      });
      return {
        identity: {
          requestId,
          workspaceId: input.workspace_id,
          sessionId,
          questionId,
          answerId,
          runId,
        },
        question: input.message,
        ...(input.options.output_artifact === undefined ? {} : { outputArtifact: input.options.output_artifact }),
      };
    });
  }

  async stream(context: StreamContext, response: ServerResponse, abort: AbortController): Promise<void> {
    if (context.replay !== undefined) {
      for (const event of context.replay) this.write(response, sseData(event));
      this.write(response, sseDone());
      response.end();
      return;
    }

    const heartbeat = setInterval(
      () => this.write(response, `: heartbeat ${Date.now()}\n\n`),
      this.config.get('SSE_HEARTBEAT_SECONDS', { infer: true }) * 1_000,
    );
    const messageChunkId = `message_${context.identity.answerId}`;
    let fullText = '';
    let pendingText = '';
    let completed = false;
    let started = false;

    const emit = async <TType extends EventType>(
      type: TType,
      content: EventOf<TType>['content'],
    ): Promise<EventOf<TType>> => {
      const event = await this.journal.append<TType>(context.identity, type, content as never);
      this.write(response, sseData(event));
      return event;
    };
    const flushText = async (): Promise<void> => {
      while (pendingText.length) {
        const delta = pendingText.slice(0, MAX_TEXT_DELTA_CHARS);
        pendingText = pendingText.slice(delta.length);
        await emit('data', { chunk_id: messageChunkId, text: delta });
      }
    };
    const complete = async (terminal: TerminalRunInput): Promise<void> => {
      const outcome = await this.journal.complete(context.identity, terminal);
      completed = true;
      if (outcome?.appended) this.write(response, sseData(outcome.event));
    };
    const interrupted = async (): Promise<boolean> =>
      abort.signal.aborted || (await this.control.isInterrupted(context.identity.sessionId));

    try {
      await this.control.clear(context.identity.sessionId);
      await emit('task_started', { message: context.question });
      started = true;
      await emit('meta_info', { route: 'rag' });
      await emit('thinking', {
        chunk_id: `thinking_${context.identity.answerId}_retrieval`,
        text: '正在检索知识库...',
      });
      const contexts = await this.retrieval.retrieve(context.identity.workspaceId, context.question);
      if (contexts.length) {
        await emit('citation', {
          message_chunk_id: messageChunkId,
          citations: contexts.map((item) => ({
            id: item.chunk_id,
            file_id: item.file_id,
            title: item.file_title,
            page: item.page ?? undefined,
            snippet: item.content.slice(0, 240),
          })),
        });
      } else {
        await emit('thinking', {
          chunk_id: `thinking_${context.identity.answerId}_fallback`,
          text: '当前知识库没有命中内容，将基于通用能力回答。',
        });
      }

      for await (const token of this.llm.streamAnswer(context.question, contexts, abort.signal)) {
        if (await interrupted()) {
          abort.abort();
          await flushText();
          await complete({ status: 'interrupted', terminalReason: 'interrupted', message: 'interrupted' });
          this.write(response, sseDone());
          return;
        }
        fullText += token;
        pendingText += token;
        while (pendingText.length >= MAX_TEXT_DELTA_CHARS) {
          const delta = pendingText.slice(0, MAX_TEXT_DELTA_CHARS);
          pendingText = pendingText.slice(MAX_TEXT_DELTA_CHARS);
          await emit('data', { chunk_id: messageChunkId, text: delta });
        }
      }

      if (await interrupted()) {
        abort.abort();
        await flushText();
        await complete({ status: 'interrupted', terminalReason: 'interrupted', message: 'interrupted' });
        this.write(response, sseDone());
        return;
      }

      await flushText();
      if (await interrupted()) {
        abort.abort();
        await complete({ status: 'interrupted', terminalReason: 'interrupted', message: 'interrupted' });
        this.write(response, sseDone());
        return;
      }
      const artifactRequest =
        context.outputArtifact === undefined
          ? undefined
          : await this.artifacts.requestFromAnswer({
              workspaceId: context.identity.workspaceId,
              sessionId: context.identity.sessionId,
              answerId: context.identity.answerId,
              kind: context.outputArtifact,
              title: reportTitle(context.question),
            });
      if (await interrupted()) {
        abort.abort();
        if (artifactRequest) await artifactRequest.cancel();
        await complete({ status: 'interrupted', terminalReason: 'interrupted', message: 'interrupted' });
        this.write(response, sseDone());
        return;
      }
      const terminal = await this.journal.succeed(context.identity, {
        final_message_chunk_id: messageChunkId,
        text: fullText,
        ...(artifactRequest === undefined ? {} : { artifacts: [artifactRequest.artifact] }),
      });
      completed = true;
      if (terminal.signal.appended) this.write(response, sseData(terminal.signal.event));
      if (terminal.completion.appended) this.write(response, sseData(terminal.completion.event));
      this.write(response, sseDone());
    } catch (error) {
      if (!completed) {
        if (!started) {
          const durable = await this.journal.read(context.identity.answerId);
          const durableStart = durable.find((event): event is EventOf<'task_started'> => event.type === 'task_started');
          if (durableStart) this.write(response, sseData(durableStart));
          else await emit('task_started', { message: context.question });
          started = true;
        }
        await flushText();
        if (abort.signal.aborted) {
          await complete({ status: 'interrupted', terminalReason: 'interrupted', message: 'interrupted' });
        } else {
          this.logger.error(
            `Agent generation failed for run ${context.identity.runId}`,
            error instanceof Error ? error.stack : String(error),
          );
          const terminal = await this.journal.fail(context.identity, {
            error_code: 43106,
            message: 'Generation failed. Please try again.',
          });
          completed = true;
          if (terminal.signal.appended) this.write(response, sseData(terminal.signal.event));
          if (terminal.completion.appended) this.write(response, sseData(terminal.completion.event));
        }
      }
      this.write(response, sseDone());
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
      const events = answer ? await this.journal.read(answer.id) : [];
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
          message: events,
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

  private async requireSession(workspaceId: string, sessionId: string) {
    const session = await this.database.db.query.chatSessions.findFirst({
      where: and(eq(chatSessions.id, sessionId), eq(chatSessions.workspaceId, workspaceId)),
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  private write(response: ServerResponse, data: string): void {
    if (response.writableEnded || response.destroyed) return;
    try {
      response.write(data);
    } catch {
      // The journal is authoritative; a disconnected SSE consumer can replay later.
    }
  }
}

function reportTitle(question: string): string {
  const title = question
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return title || 'Generated report';
}

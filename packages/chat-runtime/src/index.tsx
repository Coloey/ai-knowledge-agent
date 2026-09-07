import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';

import { useApiClient } from '@agent/api';
import {
  appendLocalUserMessage,
  type ChatState,
  type Chunk,
  createChatState,
  openChatThread,
  type NormalizedPart,
  recordTransportError,
  reduceAgentEvent,
  reduceAgentEventBatch,
  selectOrderedChunks,
  selectOrderedParts,
  selectAnswerArtifacts,
  selectThreadArtifacts,
  stopRunLocally,
  type Thread,
} from '@agent/domain';
import {
  createSseDecoder,
  decodeAgentEvent,
  type AgentEvent,
  type ArtifactRef,
} from '@agent/protocol';

export interface SendMessageInput {
  session_id?: string;
  request_id: string;
  workspace_id: string;
  message: string;
  timezone_offset: number;
  display_language: string;
  options: Record<string, unknown>;
}

export interface ChatSendOptions {
  outputArtifact?: 'document';
}

export interface SessionDetailInput {
  workspace_id: string;
  session_id: string;
}

export interface ChatTransport {
  stream(
    input: SendMessageInput,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void>;
  loadDetail(input: SessionDetailInput, signal?: AbortSignal): Promise<unknown>;
  interrupt(input: SessionDetailInput, signal: AbortSignal): Promise<void>;
}

interface ApiTransportClient {
  stream(path: string, body: unknown, signal?: AbortSignal): Promise<Response>;
  post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

export class FetchSseTransport implements ChatTransport {
  constructor(private readonly api: ApiTransportClient) {}

  async stream(
    input: SendMessageInput,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void> {
    const response = await this.api.stream(
      '/notta-brain/session/send-message',
      input,
      signal,
    );
    if (!response.ok) {
      throw new Error(
        `SSE request failed: ${response.status} ${response.statusText || 'Unknown error'}`,
      );
    }
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      throw new Error(
        `SSE response must use text/event-stream, received ${contentType || 'no Content-Type'}`,
      );
    }
    if (!response.body) throw new Error('SSE response body is empty');

    let doneReceived = false;
    const decoder = createSseDecoder((frame) => {
      if (doneReceived) return;
      if (frame.event === 'done') {
        doneReceived = true;
        return;
      }
      onEvent(decodeAgentEvent(frame.data));
    });
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        decoder.push(value);
        if (doneReceived) {
          await reader.cancel();
          break;
        }
      }
      if (!doneReceived) decoder.finish();
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  loadDetail(
    input: SessionDetailInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.api.post('/notta-brain/session/detail', input, signal);
  }

  async interrupt(
    input: SessionDetailInput,
    signal: AbortSignal,
  ): Promise<void> {
    await this.api.post('/notta-brain/session/interrupt', input, signal);
  }
}

interface ActiveGeneration {
  controller: AbortController;
  token: number;
  identity?: RunIdentity;
}

type RunIdentity = Pick<
  AgentEvent,
  | 'workspace_id'
  | 'request_id'
  | 'session_id'
  | 'question_id'
  | 'answer_id'
  | 'run_id'
>;

export interface ChatRuntimeOptions {
  workspaceId: string;
  transport: ChatTransport;
  initialThreadId?: string;
  idFactory?: () => string;
  interruptTimeoutMs?: number;
}

export class ChatRuntime {
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private readonly generations = new Map<string, ActiveGeneration>();
  private nextGeneration = 0;
  private readonly idFactory: () => string;
  private readonly interruptTimeoutMs: number;

  constructor(private readonly options: ChatRuntimeOptions) {
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 2_000;
    this.state = createChatState(
      options.initialThreadId || `thread_${this.idFactory()}`,
    );
  }

  readonly getState = (): ChatState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getCurrentThread(): Thread {
    return this.state.threads[this.state.currentThreadId];
  }

  getParts(threadId = this.state.currentThreadId): NormalizedPart[] {
    return selectOrderedParts(this.state, threadId);
  }

  getChunks(partId: string): Chunk[] {
    return selectOrderedChunks(this.state, partId);
  }

  getAnswerArtifacts(answerPartId: string): ArtifactRef[] {
    return selectAnswerArtifacts(this.state, answerPartId);
  }

  getThreadArtifacts(threadId = this.state.currentThreadId): ArtifactRef[] {
    return selectThreadArtifacts(this.state, threadId);
  }

  openThread(threadId: string): void {
    this.publish(openChatThread(this.state, threadId));
  }

  async send(
    message: string,
    threadId = this.state.currentThreadId,
    sendOptions?: ChatSendOptions,
  ): Promise<void> {
    const text = message.trim();
    if (!text) return;
    const existingThread = this.state.threads[threadId];
    if (
      this.generations.has(threadId) ||
      (existingThread &&
        ['streaming', 'result'].includes(existingThread.lifecycle))
    )
      throw new Error(`Thread ${threadId} is already streaming`);

    let next = openChatThreadWithoutSelection(this.state, threadId);
    const thread = next.threads[threadId];
    const requestId = this.idFactory();
    next = appendLocalUserMessage(next, text, {
      requestId,
      localPartId: `local:${requestId}`,
      threadId,
    });
    this.publish(next);

    const generation: ActiveGeneration = {
      controller: new AbortController(),
      token: ++this.nextGeneration,
    };
    this.generations.set(threadId, generation);
    const input: SendMessageInput = {
      ...(thread.sessionId ? { session_id: thread.sessionId } : {}),
      request_id: requestId,
      workspace_id: this.options.workspaceId,
      message: text,
      timezone_offset: new Date().getTimezoneOffset(),
      display_language: 'zh-CN',
      options:
        sendOptions?.outputArtifact === 'document'
          ? { output_artifact: 'document' }
          : {},
    };

    try {
      await this.options.transport.stream(
        input,
        generation.controller.signal,
        (event) => {
          if (!this.isCurrentGeneration(threadId, generation)) return;
          if (
            event.workspace_id !== this.options.workspaceId ||
            event.request_id !== requestId
          ) {
            throw new Error(
              'SSE AgentEvent identity does not match the active request',
            );
          }
          this.bindOrAssertRunIdentity(threadId, generation, event);
          this.publish(reduceAgentEvent(this.state, event));
        },
      );
      if (!this.isCurrentGeneration(threadId, generation)) return;
      const lifecycle = this.state.threads[threadId]?.lifecycle;
      if (!['completed', 'stopped', 'error'].includes(lifecycle || '')) {
        this.publish(
          recordTransportError(
            this.state,
            'Stream ended before task_completed',
            threadId,
          ),
        );
      }
    } catch (error) {
      if (
        !this.isCurrentGeneration(threadId, generation) ||
        generation.controller.signal.aborted
      )
        return;
      this.publish(
        recordTransportError(
          this.state,
          errorMessage(error, 'Send failed'),
          threadId,
        ),
      );
    } finally {
      if (this.isCurrentGeneration(threadId, generation))
        this.generations.delete(threadId);
    }
  }

  stop(threadId = this.state.currentThreadId): void {
    const thread = this.state.threads[threadId];
    const wasRunning =
      thread && ['streaming', 'result'].includes(thread.lifecycle);
    const generation = this.generations.get(threadId);
    this.publish(stopRunLocally(this.state, threadId));
    if (generation) {
      generation.controller.abort();
      this.generations.delete(threadId);
    }
    if (!wasRunning) return;
    const sessionId = this.state.threads[threadId]?.sessionId;
    if (!sessionId) return;

    const interruptController = new AbortController();
    const timeout = globalThis.setTimeout(
      () => interruptController.abort(),
      this.interruptTimeoutMs,
    );
    let request: Promise<void>;
    try {
      request = this.options.transport.interrupt(
        { workspace_id: this.options.workspaceId, session_id: sessionId },
        interruptController.signal,
      );
    } catch {
      globalThis.clearTimeout(timeout);
      return;
    }
    void request
      .catch(() => undefined)
      .finally(() => globalThis.clearTimeout(timeout));
  }

  async loadThreadDetail(sessionId: string): Promise<void> {
    const threadId = findThreadIdBySession(this.state, sessionId) || sessionId;
    if (this.generations.has(threadId))
      throw new Error(`Thread ${threadId} is already streaming`);
    const raw = await this.options.transport.loadDetail({
      workspace_id: this.options.workspaceId,
      session_id: sessionId,
    });
    const events = decodeSessionDetail(raw);
    if (
      events.some(
        (event) =>
          event.workspace_id !== this.options.workspaceId ||
          event.session_id !== sessionId,
      )
    ) {
      throw new Error(
        'Session Detail AgentEvent identity does not match the requested thread',
      );
    }
    const initial = createChatState(threadId);
    const seeded = {
      ...initial,
      threads: {
        ...initial.threads,
        [threadId]: { ...initial.threads[threadId], sessionId },
      },
    };
    const materialized = reduceAgentEventBatch(seeded, events);
    this.publish(replaceThreadState(this.state, threadId, materialized));
  }

  dispose(): void {
    for (const generation of this.generations.values())
      generation.controller.abort();
    this.generations.clear();
    this.listeners.clear();
  }

  private isCurrentGeneration(
    threadId: string,
    generation: ActiveGeneration,
  ): boolean {
    return this.generations.get(threadId)?.token === generation.token;
  }

  private bindOrAssertRunIdentity(
    threadId: string,
    generation: ActiveGeneration,
    event: AgentEvent,
  ): void {
    if (!generation.identity) {
      if (event.type !== 'task_started' || event.seq !== 0) {
        throw new Error(
          'The first AgentEvent for a run must be task_started at sequence 0',
        );
      }
      const knownSessionId = this.state.threads[threadId]?.sessionId;
      if (knownSessionId && knownSessionId !== event.session_id) {
        throw new Error(
          'SSE AgentEvent session does not match the active thread',
        );
      }
      generation.identity = pickRunIdentity(event);
      return;
    }
    const identity = generation.identity;
    if (
      event.session_id !== identity.session_id ||
      event.question_id !== identity.question_id ||
      event.answer_id !== identity.answer_id ||
      event.run_id !== identity.run_id
    ) {
      throw new Error(
        'SSE AgentEvent run identity changed within the active stream',
      );
    }
  }

  private publish(next: ChatState): void {
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export function decodeSessionDetail(raw: unknown): AgentEvent[] {
  const detail = requireRecord(raw, 'Session Detail');
  if (!Array.isArray(detail.messages))
    throw new Error('Session Detail messages must be an array');
  return detail.messages.flatMap((message, index) => {
    const entry = requireRecord(message, `Session Detail messages[${index}]`);
    const question = requireRecord(
      entry.question,
      `Session Detail messages[${index}].question`,
    );
    const answer = requireRecord(
      entry.answer,
      `Session Detail messages[${index}].answer`,
    );
    if (!Array.isArray(answer.message)) {
      throw new Error(
        `Session Detail messages[${index}].answer.message must be an array`,
      );
    }
    return decodeDetailAnswerEvents(
      answer.message,
      {
        status: requireString(
          answer.status,
          `Session Detail messages[${index}].answer.status`,
        ),
        sessionId: optionalString(answer.session_id),
        questionId: optionalString(question.question_id),
        answerId: optionalString(answer.answer_id),
      },
      index,
    );
  });
}

function decodeDetailAnswerEvents(
  rawEvents: unknown[],
  expected: {
    status: string;
    sessionId?: string;
    questionId?: string;
    answerId?: string;
  },
  messageIndex: number,
): AgentEvent[] {
  const path = `Session Detail messages[${messageIndex}].answer`;
  if (
    !['streaming', 'finished', 'failed', 'interrupted', 'missing'].includes(
      expected.status,
    )
  ) {
    throw new Error(`${path}.status is unsupported`);
  }
  if (!rawEvents.length) {
    if (expected.status !== 'missing')
      throw new Error(`${path} has no task_started event`);
    return [];
  }
  if (expected.status === 'missing')
    throw new Error(`${path} is missing but contains events`);
  if (!expected.sessionId || !expected.questionId || !expected.answerId) {
    throw new Error(`${path} is missing its outer identity`);
  }

  const events = rawEvents
    .map((event) => decodeAgentEvent(JSON.stringify(event)))
    .sort((left, right) => left.seq - right.seq);
  const identity = pickRunIdentity(events[0]);
  events.forEach((event, eventIndex) => {
    if (event.seq !== eventIndex)
      throw new Error(`${path} has a missing or duplicate sequence`);
    if (!sameRunIdentity(identity, event))
      throw new Error(`${path} mixes multiple run identities`);
  });
  if (events[0].type !== 'task_started')
    throw new Error(`${path} must start with task_started`);
  if (expected.sessionId && expected.sessionId !== identity.session_id) {
    throw new Error(`${path}.session_id does not match its events`);
  }
  if (expected.questionId && expected.questionId !== identity.question_id) {
    throw new Error(`${path}.question_id does not match its events`);
  }
  if (expected.answerId && expected.answerId !== identity.answer_id) {
    throw new Error(`${path}.answer_id does not match its events`);
  }

  const last = events.at(-1);
  const terminal = ['finished', 'failed', 'interrupted'].includes(
    expected.status,
  );
  if (terminal && last?.type !== 'task_completed') {
    throw new Error(`${path} is terminal without task_completed`);
  }
  if (last?.type === 'task_completed') {
    const expectedReason = {
      finished: 'completed',
      failed: 'failed',
      interrupted: 'interrupted',
    }[expected.status];
    if (expectedReason && last.content.terminal_reason !== expectedReason) {
      throw new Error(
        `${path}.status does not match task_completed terminal_reason`,
      );
    }
  }
  if (
    expected.status === 'streaming' &&
    events.some((event) => event.type === 'task_completed')
  ) {
    throw new Error(`${path} is streaming with task_completed`);
  }
  if (
    expected.status === 'finished' &&
    !events.some((event) => event.type === 'result')
  ) {
    throw new Error(`${path} is finished without result`);
  }
  if (
    expected.status === 'failed' &&
    !events.some((event) => event.type === 'error')
  ) {
    throw new Error(`${path} is failed without error`);
  }
  return events;
}

function replaceThreadState(
  current: ChatState,
  threadId: string,
  materialized: ChatState,
): ChatState {
  const parts = { ...current.parts };
  const chunks = { ...current.chunks };
  const artifacts = { ...current.artifacts };
  const previous = current.threads[threadId];
  for (const partId of previous?.partIds || []) {
    const part = parts[partId];
    if (part?.kind === 'assistant_answer') {
      for (const chunkId of part.chunkIds) delete chunks[chunkId];
    }
    delete parts[partId];
  }
  for (const artifactId of previous?.artifactIds || [])
    delete artifacts[artifactId];

  return {
    ...current,
    currentThreadId: threadId,
    threads: { ...current.threads, [threadId]: materialized.threads[threadId] },
    parts: { ...parts, ...materialized.parts },
    chunks: { ...chunks, ...materialized.chunks },
    artifacts: { ...artifacts, ...materialized.artifacts },
    diagnostics: [...current.diagnostics, ...materialized.diagnostics],
    processedEventIds: {
      ...current.processedEventIds,
      ...materialized.processedEventIds,
    },
    lastSeqByRun: { ...current.lastSeqByRun, ...materialized.lastSeqByRun },
  };
}

function openChatThreadWithoutSelection(
  state: ChatState,
  threadId: string,
): ChatState {
  if (state.threads[threadId]) return state;
  const opened = openChatThread(state, threadId);
  return { ...opened, currentThreadId: state.currentThreadId };
}

function findThreadIdBySession(
  state: ChatState,
  sessionId: string,
): string | undefined {
  return Object.values(state.threads).find(
    (thread) => thread.id === sessionId || thread.sessionId === sessionId,
  )?.id;
}

function pickRunIdentity(event: AgentEvent): RunIdentity {
  return {
    workspace_id: event.workspace_id,
    request_id: event.request_id,
    session_id: event.session_id,
    question_id: event.question_id,
    answer_id: event.answer_id,
    run_id: event.run_id,
  };
}

function sameRunIdentity(identity: RunIdentity, event: AgentEvent): boolean {
  return (
    event.workspace_id === identity.workspace_id &&
    event.request_id === identity.request_id &&
    event.session_id === identity.session_id &&
    event.question_id === identity.question_id &&
    event.answer_id === identity.answer_id &&
    event.run_id === identity.run_id
  );
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export interface ChatRuntimeProviderProps extends React.PropsWithChildren {
  workspaceId: string;
  initialThreadId?: string;
}

const ChatRuntimeContext = createContext<ChatRuntime | null>(null);

export function ChatRuntimeProvider(props: ChatRuntimeProviderProps) {
  const api = useApiClient();
  const runtime = useMemo(
    () =>
      new ChatRuntime({
        workspaceId: props.workspaceId,
        transport: new FetchSseTransport(api),
        ...(props.initialThreadId
          ? { initialThreadId: props.initialThreadId }
          : {}),
      }),
    [api, props.initialThreadId, props.workspaceId],
  );

  React.useEffect(() => () => runtime.dispose(), [runtime]);
  return (
    <ChatRuntimeContext.Provider value={runtime}>
      {props.children}
    </ChatRuntimeContext.Provider>
  );
}

export function useChatRuntime(): ChatRuntime {
  const runtime = useContext(ChatRuntimeContext);
  if (!runtime) throw new Error('ChatRuntimeProvider is missing');
  return runtime;
}

export interface ChatRuntimeCommands {
  send(
    message: string,
    threadId?: string,
    options?: ChatSendOptions,
  ): Promise<void>;
  stop(threadId?: string): void;
  openThread(threadId: string): void;
  loadThreadDetail(sessionId: string): Promise<void>;
}

export function useChatCommands(): ChatRuntimeCommands {
  const runtime = useChatRuntime();
  return useMemo(
    () => ({
      send: (
        message: string,
        threadId?: string,
        options?: ChatSendOptions,
      ) => runtime.send(message, threadId, options),
      stop: (threadId?: string) => runtime.stop(threadId),
      openThread: (threadId: string) => runtime.openThread(threadId),
      loadThreadDetail: (sessionId: string) =>
        runtime.loadThreadDetail(sessionId),
    }),
    [runtime],
  );
}

function useChatSelector<T>(selector: (state: ChatState) => T): T {
  const runtime = useChatRuntime();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{
    selector?: (state: ChatState) => T;
    state?: ChatState;
    value?: T;
  }>({});
  const getSnapshot = useCallback(() => {
    const state = runtime.getState();
    if (
      cacheRef.current.state !== state ||
      cacheRef.current.selector !== selectorRef.current
    ) {
      cacheRef.current = {
        selector: selectorRef.current,
        state,
        value: selectorRef.current(state),
      };
    }
    return cacheRef.current.value as T;
  }, [runtime]);
  return useSyncExternalStore(runtime.subscribe, getSnapshot, getSnapshot);
}

export function useCurrentThread(): Thread {
  return useChatSelector(selectCurrentThread);
}

export function useOrderedParts(threadId: string): NormalizedPart[] {
  const selector = useCallback(
    (state: ChatState) => selectOrderedParts(state, threadId),
    [threadId],
  );
  return useChatSelector(selector);
}

export function useOrderedChunks(partId: string): Chunk[] {
  const selector = useCallback(
    (state: ChatState) => selectOrderedChunks(state, partId),
    [partId],
  );
  return useChatSelector(selector);
}

export function useAnswerArtifacts(answerPartId: string): ArtifactRef[] {
  const selector = useCallback(
    (state: ChatState) => selectAnswerArtifacts(state, answerPartId),
    [answerPartId],
  );
  return useChatSelector(selector);
}

export function useThreadArtifacts(
  threadId?: string,
): ArtifactRef[] {
  const selector = useCallback(
    (state: ChatState) => selectThreadArtifacts(state, threadId),
    [threadId],
  );
  return useChatSelector(selector);
}

function selectCurrentThread(state: ChatState): Thread {
  return state.threads[state.currentThreadId];
}

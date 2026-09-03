import { create } from 'zustand';

import type { AgentEvent, Artifact, Citation, JsonValue } from '@agent/protocol';

export type ChunkStatus = 'streaming' | 'completed' | 'stopped' | 'error';
export type ChatLifecycle = 'idle' | 'streaming' | 'result' | 'completed' | 'stopped' | 'error';

export interface UserMessagePart {
  id: string;
  kind: 'user_message';
  text: string;
  questionId?: string;
}

export interface AssistantAnswerPart {
  id: string;
  kind: 'assistant_answer';
  answerId: string;
  chunkIds: string[];
  status: ChunkStatus;
}

export interface SystemNoticePart {
  id: string;
  kind: 'system_notice';
  text: string;
  level: 'info' | 'error';
}

export type NormalizedPart = UserMessagePart | AssistantAnswerPart | SystemNoticePart;

interface BaseChunk {
  id: string;
  partId: string;
  status: ChunkStatus;
}

export interface ThinkingChunk extends BaseChunk {
  kind: 'thinking';
  text: string;
}

export interface MessageChunk extends BaseChunk {
  kind: 'message';
  text: string;
  citations: Citation[];
}

export interface ToolChunk extends BaseChunk {
  kind: 'tool';
  toolUseId: string;
  name: string;
  input?: JsonValue;
  result?: JsonValue;
  isError?: boolean;
}

export type Chunk = ThinkingChunk | MessageChunk | ToolChunk;

export interface Thread {
  id: string;
  questionId?: string;
  sessionId?: string;
  runId?: string;
  answerPartId?: string;
  pendingUserPartId?: string;
  partIds: string[];
  artifactIds: string[];
  lifecycle: ChatLifecycle;
}

export interface Diagnostic {
  kind: 'sequence_gap' | 'stale_sequence' | 'stale_transition' | 'orphan_tool_result';
  eventId: string;
  threadId?: string;
  message: string;
}

export interface ChatState {
  currentThreadId: string;
  threads: Record<string, Thread>;
  parts: Record<string, NormalizedPart>;
  chunks: Record<string, Chunk>;
  artifacts: Record<string, Artifact>;
  diagnostics: Diagnostic[];
  processedEventIds: Record<string, true>;
  lastSeqByRun: Record<string, number>;
}

export function createChatThread(id: string): Thread {
  return { id, partIds: [], artifactIds: [], lifecycle: 'idle' };
}

export function createChatState(currentThreadId = 'thread-1'): ChatState {
  return {
    currentThreadId,
    threads: { [currentThreadId]: createChatThread(currentThreadId) },
    parts: {},
    chunks: {},
    artifacts: {},
    diagnostics: [],
    processedEventIds: {},
    lastSeqByRun: {},
  };
}

export function appendLocalUserMessage(state: ChatState, text: string, localPartId?: string): ChatState {
  const thread = requireThread(state, state.currentThreadId);
  const id = localPartId || `local:${thread.id}:${thread.partIds.length}`;
  const part: UserMessagePart = { id, kind: 'user_message', text };
  return {
    ...state,
    parts: { ...state.parts, [id]: part },
    threads: { ...state.threads, [thread.id]: { ...thread, partIds: [...thread.partIds, id], pendingUserPartId: id } },
  };
}

export function reduceAgentEvent(state: ChatState, event: AgentEvent): ChatState {
  if (state.processedEventIds[event.event_id]) return state;
  const prepared = prepareEvent(state, event);
  if (prepared.stale) return prepared.state;
  let next = prepared.state;
  let thread = findThread(next, event.question_id);

  if (event.type === 'task_started') {
    if (!thread) {
      const currentThread = requireThread(next, next.currentThreadId);
      if (currentThread.pendingUserPartId) {
        thread = currentThread;
      } else {
        thread = createChatThread(`thread:${event.question_id}`);
        next = { ...next, threads: { ...next.threads, [thread.id]: thread } };
      }
    }
    if (thread.lifecycle === 'streaming' || (thread.runId === event.run_id && thread.lifecycle !== 'idle')) {
      return addDiagnostic(next, event, 'stale_transition', `Run ${event.run_id} is already closed or active`, thread.id);
    }
    return startRun(next, thread, event);
  }
  if (!thread) return addDiagnostic(next, event, 'stale_transition', `No thread is bound to question ${event.question_id}`);
  if (thread.runId !== event.run_id) {
    return addDiagnostic(next, event, 'stale_transition', `Run ${event.run_id} is not streaming`, thread.id);
  }
  if (event.type === 'task_completed') {
    if (!['streaming', 'result', 'error', 'stopped'].includes(thread.lifecycle)) {
      return addDiagnostic(next, event, 'stale_transition', `Run ${event.run_id} is not streaming`, thread.id);
    }
    return completeRun(next, thread);
  }
  if (thread.lifecycle !== 'streaming') return addDiagnostic(next, event, 'stale_transition', `Run ${event.run_id} is not streaming`, thread.id);

  switch (event.type) {
    case 'thinking': return upsertTextChunk(next, thread, event, 'thinking', event.content.text);
    case 'data': return upsertTextChunk(next, thread, event, 'message', event.content.text);
    case 'current_tool_use': return upsertToolChunk(next, thread, event);
    case 'tool_result': return mergeToolResult(next, thread, event);
    case 'citation': return addCitations(next, thread, event);
    case 'artifact': return addArtifacts(next, thread, event.content.artifacts || (event.content.artifact ? [event.content.artifact] : []), event.answer_id);
    case 'result': return finalizeResult(next, thread, event);
    case 'error': return failRun(next, thread, event.content.message);
    case 'meta_info':
    case 'heartbeat': return next;
  }
}

export function reduceAgentEventBatch(state: ChatState, events: readonly AgentEvent[]): ChatState {
  return events.reduce(reduceAgentEvent, state);
}

export function selectOrderedParts(state: ChatState, threadId = state.currentThreadId): NormalizedPart[] {
  const thread = state.threads[threadId];
  return thread ? thread.partIds.flatMap((id) => (state.parts[id] ? [state.parts[id]] : [])) : [];
}

export function selectOrderedChunks(state: ChatState, partId: string): Chunk[] {
  const part = state.parts[partId];
  return part?.kind === 'assistant_answer' ? part.chunkIds.flatMap((id) => (state.chunks[id] ? [state.chunks[id]] : [])) : [];
}

export function stopRunLocally(state: ChatState, threadId = state.currentThreadId): ChatState {
  const thread = state.threads[threadId];
  return !thread || thread.lifecycle !== 'streaming' ? state : updateThreadAndAnswer(state, thread, 'stopped');
}

export function recordTransportError(state: ChatState, message: string, threadId = state.currentThreadId): ChatState {
  const thread = state.threads[threadId];
  if (!thread) return state;
  const next = thread.answerPartId ? state : ensureAnswer(state, thread, `transport:${thread.id}`);
  return failRun(next, requireThread(next, threadId), message);
}

function prepareEvent(state: ChatState, event: AgentEvent): { state: ChatState; stale: boolean } {
  const previous = state.lastSeqByRun[event.run_id];
  let next: ChatState = { ...state, processedEventIds: { ...state.processedEventIds, [event.event_id]: true } };
  if (previous !== undefined && event.seq <= previous) {
    return { state: addDiagnostic(next, event, 'stale_sequence', `Sequence ${event.seq} is not newer than ${previous}`), stale: true };
  }
  if (previous !== undefined && event.seq > previous + 1) {
    next = addDiagnostic(next, event, 'sequence_gap', `Sequence jumped from ${previous} to ${event.seq}`);
  }
  return { state: { ...next, lastSeqByRun: { ...next.lastSeqByRun, [event.run_id]: event.seq } }, stale: false };
}

function startRun(state: ChatState, originalThread: Thread, event: Extract<AgentEvent, { type: 'task_started' }>): ChatState {
  let next = state;
  let thread = originalThread;
  if (thread.pendingUserPartId) {
    const pending = next.parts[thread.pendingUserPartId];
    if (pending?.kind === 'user_message') {
      const formal: UserMessagePart = { ...pending, id: event.question_id, questionId: event.question_id };
      const parts = { ...next.parts, [event.question_id]: formal };
      delete parts[pending.id];
      thread = { ...thread, questionId: event.question_id, pendingUserPartId: undefined, partIds: thread.partIds.map((id) => id === pending.id ? event.question_id : id) };
      next = { ...next, parts, threads: { ...next.threads, [thread.id]: thread } };
    }
  }
  const withAnswer = ensureAnswer(next, thread, event.answer_id);
  const updated = requireThread(withAnswer, thread.id);
  return {
    ...withAnswer,
    threads: { ...withAnswer.threads, [updated.id]: { ...updated, questionId: event.question_id, sessionId: event.session_id, runId: event.run_id, lifecycle: 'streaming' } },
  };
}

function ensureAnswer(state: ChatState, thread: Thread, answerId: string): ChatState {
  const existing = thread.answerPartId ? state.parts[thread.answerPartId] : undefined;
  if (existing?.kind === 'assistant_answer' && existing.answerId === answerId) return state;
  const partId = `answer:${answerId}`;
  const part: AssistantAnswerPart = { id: partId, kind: 'assistant_answer', answerId, chunkIds: [], status: 'streaming' };
  return {
    ...state,
    parts: { ...state.parts, [partId]: part },
    threads: { ...state.threads, [thread.id]: { ...thread, answerPartId: partId, partIds: [...thread.partIds, partId] } },
  };
}

function upsertTextChunk(state: ChatState, thread: Thread, event: Extract<AgentEvent, { type: 'thinking' | 'data' }>, kind: 'thinking' | 'message', text: string): ChatState {
  const answer = requireAnswer(state, thread);
  const id = `${kind}:${event.answer_id}`;
  const existing = state.chunks[id];
  const chunk: Chunk = kind === 'thinking'
    ? { id, partId: answer.id, kind, text: `${existing?.kind === 'thinking' ? existing.text : ''}${text}`, status: 'streaming' }
    : { id, partId: answer.id, kind, text: `${existing?.kind === 'message' ? existing.text : ''}${text}`, citations: existing?.kind === 'message' ? existing.citations : [], status: 'streaming' };
  return putChunk(state, answer, chunk);
}

function upsertToolChunk(state: ChatState, thread: Thread, event: Extract<AgentEvent, { type: 'current_tool_use' }>): ChatState {
  const answer = requireAnswer(state, thread);
  const id = `tool:${event.answer_id}:${event.content.tool_use_id}`;
  const existing = state.chunks[id];
  const chunk: ToolChunk = {
    id, partId: answer.id, kind: 'tool', toolUseId: event.content.tool_use_id, name: event.content.name,
    ...(event.content.input === undefined ? {} : { input: event.content.input }),
    ...(existing?.kind === 'tool' && existing.result !== undefined ? { result: existing.result } : {}),
    ...(existing?.kind === 'tool' && existing.isError !== undefined ? { isError: existing.isError } : {}), status: 'streaming',
  };
  return putChunk(state, answer, chunk);
}

function mergeToolResult(state: ChatState, thread: Thread, event: Extract<AgentEvent, { type: 'tool_result' }>): ChatState {
  const answer = requireAnswer(state, thread);
  const id = `tool:${event.answer_id}:${event.content.tool_use_id}`;
  const existing = state.chunks[id];
  if (existing?.kind !== 'tool') return addDiagnostic(state, event, 'orphan_tool_result', `No tool chunk for ${event.content.tool_use_id}`, thread.id);
  return putChunk(state, answer, { ...existing, ...(event.content.result === undefined ? {} : { result: event.content.result }), ...(event.content.is_error === undefined ? {} : { isError: event.content.is_error }) });
}

function addCitations(state: ChatState, thread: Thread, event: Extract<AgentEvent, { type: 'citation' }>): ChatState {
  const answer = requireAnswer(state, thread);
  const id = `message:${event.answer_id}`;
  const existing = state.chunks[id];
  return putChunk(state, answer, { id, partId: answer.id, kind: 'message', text: existing?.kind === 'message' ? existing.text : '', citations: [...(existing?.kind === 'message' ? existing.citations : []), ...event.content.citations], status: 'streaming' });
}

function addArtifacts(state: ChatState, thread: Thread, artifacts: Artifact[], answerId: string): ChatState {
  const entries = artifacts.map((artifact, index) => [artifact.id || `artifact:${answerId}:${index}`, artifact] as const);
  const ids = entries.map(([id]) => id);
  return {
    ...state,
    artifacts: { ...state.artifacts, ...Object.fromEntries(entries) },
    threads: { ...state.threads, [thread.id]: { ...thread, artifactIds: [...new Set([...thread.artifactIds, ...ids])] } },
  };
}

function finalizeResult(state: ChatState, thread: Thread, event: Extract<AgentEvent, { type: 'result' }>): ChatState {
  const answer = requireAnswer(state, thread);
  const id = `message:${event.answer_id}`;
  const existing = state.chunks[id];
  let next = putChunk(state, answer, { id, partId: answer.id, kind: 'message', text: event.content.text, citations: existing?.kind === 'message' ? existing.citations : [], status: 'completed' });
  if (event.content.artifacts?.length) next = addArtifacts(next, requireThread(next, thread.id), event.content.artifacts, event.answer_id);
  return updateThreadAndAnswer(next, requireThread(next, thread.id), 'completed', 'result');
}

function completeRun(state: ChatState, thread: Thread): ChatState {
  return thread.lifecycle === 'error' || thread.lifecycle === 'stopped'
    ? { ...state, threads: { ...state.threads, [thread.id]: { ...thread, lifecycle: 'completed' } } }
    : updateThreadAndAnswer(state, thread, 'completed', 'completed');
}

function failRun(state: ChatState, thread: Thread, message: string): ChatState {
  const answer = requireAnswer(state, thread);
  const noticeId = `notice:${thread.id}:${state.diagnostics.length}`;
  const withNotice = {
    ...state,
    parts: { ...state.parts, [noticeId]: { id: noticeId, kind: 'system_notice' as const, text: message, level: 'error' as const } },
    threads: { ...state.threads, [thread.id]: { ...thread, partIds: [...thread.partIds, noticeId] } },
  };
  return updateThreadAndAnswer(withNotice, { ...thread, answerPartId: answer.id, partIds: [...thread.partIds, noticeId] }, 'error');
}

function updateThreadAndAnswer(state: ChatState, thread: Thread, status: ChunkStatus, lifecycle: ChatLifecycle = status): ChatState {
  const answer = thread.answerPartId ? state.parts[thread.answerPartId] : undefined;
  const chunks = Object.fromEntries(Object.entries(state.chunks).map(([id, chunk]) => [id, chunk.partId === thread.answerPartId && chunk.status === 'streaming' ? { ...chunk, status } : chunk])) as Record<string, Chunk>;
  return {
    ...state, chunks,
    parts: answer?.kind === 'assistant_answer' ? { ...state.parts, [answer.id]: { ...answer, status } } : state.parts,
    threads: { ...state.threads, [thread.id]: { ...thread, lifecycle } },
  };
}

function putChunk(state: ChatState, answer: AssistantAnswerPart, chunk: Chunk): ChatState {
  const hasChunk = answer.chunkIds.includes(chunk.id);
  return { ...state, chunks: { ...state.chunks, [chunk.id]: chunk }, parts: { ...state.parts, [answer.id]: { ...answer, chunkIds: hasChunk ? answer.chunkIds : [...answer.chunkIds, chunk.id] } } };
}

function requireThread(state: ChatState, id: string): Thread {
  const thread = state.threads[id];
  if (!thread) throw new Error(`Missing thread ${id}`);
  return thread;
}

function findThread(state: ChatState, questionId: string): Thread | undefined { return Object.values(state.threads).find((thread) => thread.questionId === questionId); }

function requireAnswer(state: ChatState, thread: Thread): AssistantAnswerPart {
  const answer = thread.answerPartId ? state.parts[thread.answerPartId] : undefined;
  if (answer?.kind !== 'assistant_answer') throw new Error(`Missing answer for thread ${thread.id}`);
  return answer;
}

function addDiagnostic(state: ChatState, event: AgentEvent, kind: Diagnostic['kind'], message: string, threadId?: string): ChatState {
  return { ...state, diagnostics: [...state.diagnostics, { kind, eventId: event.event_id, ...(threadId ? { threadId } : {}), message }] };
}

// Temporary SmartBar compatibility. Task 4 replaces this store with the reducer-driven runtime.
export type StreamStatus = 'idle' | 'streaming' | 'interrupted' | 'finished' | 'error';
export interface ChatPart { id: string; role: 'user' | 'assistant' | 'system'; type: 'message' | 'thinking' | 'citation' | 'error' | 'status'; text?: string; payload?: unknown; }
export interface ChatThread { localId: string; sessionId?: string; parts: ChatPart[]; streamStatus: StreamStatus; }
interface SessionState { activeThread: ChatThread; appendPart: (part: ChatPart) => void; appendAssistantDelta: (text: string) => void; setSessionId: (sessionId: string) => void; setStreamStatus: (status: StreamStatus) => void; }
export const useSessionStore = create<SessionState>((set) => ({
  activeThread: { localId: `thread_${crypto.randomUUID()}`, parts: [], streamStatus: 'idle' },
  appendPart: (part) => set((state) => ({ activeThread: { ...state.activeThread, parts: [...state.activeThread.parts, part] } })),
  appendAssistantDelta: (text) => set((state) => {
    const parts = [...state.activeThread.parts];
    const lastPart = parts.at(-1);
    if (lastPart?.role === 'assistant' && lastPart.type === 'message') parts[parts.length - 1] = { ...lastPart, text: `${lastPart.text || ''}${text}` };
    else parts.push({ id: crypto.randomUUID(), role: 'assistant', type: 'message', text });
    return { activeThread: { ...state.activeThread, parts } };
  }),
  setSessionId: (sessionId) => set((state) => ({ activeThread: { ...state.activeThread, sessionId } })),
  setStreamStatus: (streamStatus) => set((state) => ({ activeThread: { ...state.activeThread, streamStatus } })),
}));

import type { FetchEventSourceInit } from '@microsoft/fetch-event-source';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchEventSourceMock } = vi.hoisted(() => ({
  fetchEventSourceMock: vi.fn(),
}));

vi.mock('@microsoft/fetch-event-source', () => ({
  fetchEventSource: fetchEventSourceMock,
}));

import type { AgentEvent } from '@agent/protocol';
import {
  ChatRuntime,
  FetchSseTransport,
  type ChatTransport,
  type SendMessageInput,
  type SessionDetailInput,
} from './index';

interface PendingStream {
  input: SendMessageInput;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
}

class ControlledTransport implements ChatTransport {
  readonly streams: PendingStream[] = [];
  readonly interrupts: Array<{
    input: SessionDetailInput;
    signal: AbortSignal;
  }> = [];
  detail: unknown = { messages: [] };
  interruptPromise: Promise<void> = Promise.resolve();

  stream(
    input: SendMessageInput,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.streams.push({ input, signal, emit: onEvent, resolve, reject });
    });
  }

  loadDetail(): Promise<unknown> {
    return Promise.resolve(this.detail);
  }

  interrupt(input: SessionDetailInput, signal: AbortSignal): Promise<void> {
    this.interrupts.push({ input, signal });
    return this.interruptPromise;
  }
}

function eventSourceOptions(): FetchEventSourceInit {
  return fetchEventSourceMock.mock.calls[0][1] as FetchEventSourceInit;
}

function sseResponse(): Response {
  return new Response('', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

describe('FetchSseTransport', () => {
  beforeEach(() => {
    fetchEventSourceMock.mockReset();
  });

  it('decodes events, stops on done, and sends the existing endpoint payload', async () => {
    const received: AgentEvent[] = [];
    const payload = event(
      'data',
      { chunk_id: 'message-1', text: '你好' },
      { seq: 1 },
    );
    const response = sseResponse();
    const api = {
      stream: vi.fn().mockResolvedValue(response),
      post: vi.fn(),
    };
    const internalSignal = new AbortController().signal;
    fetchEventSourceMock.mockImplementationOnce(
      async (_input: RequestInfo, options: FetchEventSourceInit) => {
        await options.onopen?.(
          await options.fetch!('/ignored', { signal: internalSignal }),
        );
        options.onmessage?.({
          id: 'event-1',
          event: '',
          data: JSON.stringify(payload),
        });
        options.onmessage?.({
          id: 'done-1',
          event: 'done',
          data: '{"done":true}',
        });
      },
    );

    await new FetchSseTransport(api).stream(
      sendInput(),
      new AbortController().signal,
      (next) => received.push(next),
    );

    expect(received).toEqual([payload]);
    expect(api.stream).toHaveBeenCalledWith(
      '/notta-brain/session/send-message',
      sendInput(),
      expect.any(AbortSignal),
    );
    expect(fetchEventSourceMock).toHaveBeenCalledWith(
      '/notta-brain/session/send-message',
      expect.objectContaining({
        method: 'POST',
        openWhenHidden: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(api.stream.mock.calls[0][2]).toBe(internalSignal);
    expect(eventSourceOptions().signal?.aborted).toBe(true);
  });

  it('forwards caller cancellation to fetchEventSource', async () => {
    const caller = new AbortController();
    let resolveStream: (() => void) | undefined;
    fetchEventSourceMock.mockImplementationOnce(
      (_input: RequestInfo, options: FetchEventSourceInit) =>
        new Promise<void>((resolve) => {
          resolveStream = resolve;
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }),
    );
    const transport = new FetchSseTransport({
      stream: vi.fn(),
      post: vi.fn(),
    });

    const streaming = transport.stream(sendInput(), caller.signal, vi.fn());
    caller.abort();
    await streaming;

    expect(eventSourceOptions().signal?.aborted).toBe(true);
    expect(resolveStream).toBeTypeOf('function');
  });

  it('does not open a stream for an already-aborted request', async () => {
    const caller = new AbortController();
    const api = { stream: vi.fn(), post: vi.fn() };
    caller.abort();

    await new FetchSseTransport(api).stream(
      sendInput(),
      caller.signal,
      vi.fn(),
    );

    expect(fetchEventSourceMock).not.toHaveBeenCalled();
    expect(api.stream).not.toHaveBeenCalled();
  });

  it.each([
    [
      new Response('unavailable', { status: 503, statusText: 'Unavailable' }),
      'Unavailable',
    ],
    [
      new Response(
        JSON.stringify({
          code: 500,
          msg: 'Internal server error',
          data: null,
        }),
        {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'Content-Type': 'application/json' },
        },
      ),
      'Internal server error',
    ],
    [
      new Response('not sse', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
      'text/event-stream',
    ],
    [
      {
        ok: true,
        status: 200,
        statusText: '',
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: null,
      },
      'body is empty',
    ],
  ])('rejects invalid SSE responses', async (response, expected) => {
    fetchEventSourceMock.mockImplementationOnce(
      async (_input: RequestInfo, options: FetchEventSourceInit) => {
        await options.onopen?.(response as Response);
      },
    );
    const transport = new FetchSseTransport({
      stream: vi.fn(),
      post: vi.fn(),
    });
    await expect(
      transport.stream(sendInput(), new AbortController().signal, vi.fn()),
    ).rejects.toThrow(expected);
  });

  it('surfaces malformed V2 events', async () => {
    fetchEventSourceMock.mockImplementationOnce(
      async (_input: RequestInfo, options: FetchEventSourceInit) => {
        options.onmessage?.({
          id: '',
          event: '',
          data: '{"schema_version":1}',
        });
      },
    );
    const transport = new FetchSseTransport({
      stream: vi.fn(),
      post: vi.fn(),
    });
    await expect(
      transport.stream(sendInput(), new AbortController().signal, vi.fn()),
    ).rejects.toThrow('Unsupported agent event schema version');
  });

  it('makes fetchEventSource errors fatal instead of retrying the POST', async () => {
    fetchEventSourceMock.mockImplementationOnce(
      async (_input: RequestInfo, options: FetchEventSourceInit) => {
        options.onerror?.(new Error('read failed'));
      },
    );
    const transport = new FetchSseTransport({
      stream: vi.fn(),
      post: vi.fn(),
    });

    await expect(
      transport.stream(sendInput(), new AbortController().signal, vi.fn()),
    ).rejects.toThrow('read failed');
    expect(fetchEventSourceMock).toHaveBeenCalledTimes(1);
  });
});

describe('ChatRuntime', () => {
  it('passes a document artifact request as per-send options only', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    const sending = runtime.send('create a report', 'thread-1', {
      outputArtifact: 'document',
    });

    expect(transport.streams[0].input.options).toEqual({
      output_artifact: 'document',
    });
    transport.streams[0].reject(new Error('transport stopped'));
    await sending;
  });

  it('isolates interleaved streams for two threads and refuses a concurrent same-thread send', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    runtime.openThread('thread-2');
    runtime.openThread('thread-1');

    const first = runtime.send('one', 'thread-1');
    const second = runtime.send('two', 'thread-2');
    await expect(runtime.send('duplicate', 'thread-1')).rejects.toThrow(
      'already streaming',
    );

    const [firstStream, secondStream] = transport.streams;
    firstStream.emit(
      runEvent(
        firstStream.input,
        'task_started',
        { message: 'one' },
        'session-1',
        'run-1',
        0,
      ),
    );
    secondStream.emit(
      runEvent(
        secondStream.input,
        'task_started',
        { message: 'two' },
        'session-2',
        'run-2',
        0,
      ),
    );
    secondStream.emit(
      runEvent(
        secondStream.input,
        'data',
        { chunk_id: 'message-2', text: 'answer two' },
        'session-2',
        'run-2',
        1,
      ),
    );
    firstStream.emit(
      runEvent(
        firstStream.input,
        'data',
        { chunk_id: 'message-1', text: 'answer one' },
        'session-1',
        'run-1',
        1,
      ),
    );

    expect(runtime.getParts('thread-1')).toMatchObject([
      { text: 'one' },
      { kind: 'assistant_answer' },
    ]);
    expect(runtime.getChunks('answer:answer-run-1')).toMatchObject([
      { id: 'message-1', text: 'answer one' },
    ]);
    expect(runtime.getParts('thread-2')).toMatchObject([
      { text: 'two' },
      { kind: 'assistant_answer' },
    ]);
    expect(runtime.getChunks('answer:answer-run-2')).toMatchObject([
      { id: 'message-2', text: 'answer two' },
    ]);

    finish(firstStream, 'session-1', 'run-1', 'message-1', 'answer one');
    finish(secondStream, 'session-2', 'run-2', 'message-2', 'answer two');
    firstStream.resolve();
    secondStream.resolve();
    await Promise.all([first, second]);
  });

  it('rejects a crossed run envelope before it can mutate another active thread', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    runtime.openThread('thread-2');
    runtime.openThread('thread-1');
    const first = runtime.send('one', 'thread-1');
    const second = runtime.send('two', 'thread-2');
    const [firstStream, secondStream] = transport.streams;
    firstStream.emit(
      runEvent(
        firstStream.input,
        'task_started',
        { message: 'one' },
        'session-1',
        'run-1',
        0,
      ),
    );
    secondStream.emit(
      runEvent(
        secondStream.input,
        'task_started',
        { message: 'two' },
        'session-2',
        'run-2',
        0,
      ),
    );

    expect(() =>
      firstStream.emit(
        runEvent(
          firstStream.input,
          'data',
          { chunk_id: 'crossed', text: 'wrong' },
          'session-2',
          'run-2',
          1,
        ),
      ),
    ).toThrow('run identity changed');
    expect(runtime.getChunks('answer:answer-run-2')).toEqual([]);

    firstStream.reject(new Error('crossed stream rejected'));
    finish(secondStream, 'session-2', 'run-2', 'message-2', 'two');
    secondStream.resolve();
    await Promise.all([first, second]);
  });

  it('stops synchronously, aborts immediately, and suppresses late events and rejection', async () => {
    const transport = new ControlledTransport();
    let resolveInterrupt!: () => void;
    transport.interruptPromise = new Promise((resolve) => {
      resolveInterrupt = resolve;
    });
    const runtime = createRuntime(transport);
    const sending = runtime.send('stop me');
    const stream = transport.streams[0];
    stream.emit(
      runEvent(
        stream.input,
        'task_started',
        { message: 'stop me' },
        'session-1',
        'run-1',
        0,
      ),
    );
    stream.emit(
      runEvent(
        stream.input,
        'data',
        { chunk_id: 'message-1', text: 'partial' },
        'session-1',
        'run-1',
        1,
      ),
    );

    runtime.stop('thread-1');

    expect(runtime.getState().threads['thread-1'].lifecycle).toBe('stopped');
    expect(stream.signal.aborted).toBe(true);
    expect(transport.interrupts).toHaveLength(1);
    expect(runtime.getChunks('answer:answer-run-1')).toMatchObject([
      { text: 'partial', status: 'stopped' },
    ]);
    stream.emit(
      runEvent(
        stream.input,
        'data',
        { chunk_id: 'message-1', text: ' late' },
        'session-1',
        'run-1',
        2,
      ),
    );
    stream.reject(new Error('late read failure'));
    await sending;
    expect(runtime.getChunks('answer:answer-run-1')).toMatchObject([
      { text: 'partial', status: 'stopped' },
    ]);
    expect(
      runtime
        .getParts('thread-1')
        .filter((part) => part.kind === 'system_notice'),
    ).toHaveLength(0);
    resolveInterrupt();
  });

  it('stops before task_started without waiting for a server identity', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    const sending = runtime.send('stop before start');
    const stream = transport.streams[0];

    runtime.stop('thread-1');

    expect(runtime.getState().threads['thread-1'].lifecycle).toBe('stopped');
    expect(stream.signal.aborted).toBe(true);
    expect(transport.interrupts).toHaveLength(0);
    stream.emit(
      runEvent(
        stream.input,
        'task_started',
        { message: 'late' },
        'session-1',
        'run-1',
        0,
      ),
    );
    stream.reject(new Error('late abort'));
    await sending;
    expect(runtime.getParts('thread-1')).toMatchObject([
      { kind: 'user_message', text: 'stop before start' },
    ]);
  });

  it('records one active transport error, preserves chunks, and never downgrades a terminal run', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    const failed = runtime.send('fail');
    const stream = transport.streams[0];
    stream.emit(
      runEvent(
        stream.input,
        'task_started',
        { message: 'fail' },
        'session-1',
        'run-1',
        0,
      ),
    );
    stream.emit(
      runEvent(
        stream.input,
        'data',
        { chunk_id: 'message-1', text: 'partial' },
        'session-1',
        'run-1',
        1,
      ),
    );
    stream.reject(new Error('network failed'));
    await failed;

    expect(runtime.getState().threads['thread-1'].lifecycle).toBe('error');
    expect(runtime.getChunks('answer:answer-run-1')).toMatchObject([
      { text: 'partial', status: 'error' },
    ]);
    expect(
      runtime
        .getParts('thread-1')
        .filter((part) => part.kind === 'system_notice'),
    ).toMatchObject([{ text: 'network failed', level: 'error' }]);

    runtime.openThread('thread-2');
    const completed = runtime.send('complete', 'thread-2');
    const completedStream = transport.streams[1];
    completedStream.emit(
      runEvent(
        completedStream.input,
        'task_started',
        { message: 'complete' },
        'session-2',
        'run-2',
        0,
      ),
    );
    completedStream.emit(
      runEvent(
        completedStream.input,
        'data',
        { chunk_id: 'message-2', text: 'done' },
        'session-2',
        'run-2',
        1,
      ),
    );
    finish(completedStream, 'session-2', 'run-2', 'message-2', 'done');
    completedStream.reject(new Error('late failure'));
    await completed;
    expect(runtime.getState().threads['thread-2'].lifecycle).toBe('completed');
    expect(
      runtime
        .getParts('thread-2')
        .filter((part) => part.kind === 'system_notice'),
    ).toHaveLength(0);
  });

  it('marks a stream ending without task_completed as an error', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    const sending = runtime.send('incomplete');
    const stream = transport.streams[0];
    stream.emit(
      runEvent(
        stream.input,
        'task_started',
        { message: 'incomplete' },
        'session-1',
        'run-1',
        0,
      ),
    );
    stream.emit(
      runEvent(
        stream.input,
        'result',
        { final_message_chunk_id: 'message-1', text: 'visible' },
        'session-1',
        'run-1',
        1,
      ),
    );
    stream.resolve();
    await sending;
    expect(runtime.getState().threads['thread-1'].lifecycle).toBe('error');
    expect(runtime.getChunks('answer:answer-run-1')).toMatchObject([
      { text: 'visible' },
    ]);
  });

  it('can stop after result but before task_completed', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    const sending = runtime.send('finish slowly');
    const stream = transport.streams[0];
    stream.emit(
      runEvent(
        stream.input,
        'task_started',
        { message: 'finish slowly' },
        'session-1',
        'run-1',
        0,
      ),
    );
    stream.emit(
      runEvent(
        stream.input,
        'result',
        { final_message_chunk_id: 'message-1', text: 'visible' },
        'session-1',
        'run-1',
        1,
      ),
    );

    runtime.stop('thread-1');
    stream.reject(new Error('aborted after result'));
    await sending;

    expect(runtime.getState().threads['thread-1'].lifecycle).toBe('stopped');
    expect(runtime.getChunks('answer:answer-run-1')).toMatchObject([
      { text: 'visible', status: 'completed' },
    ]);
    expect(transport.interrupts).toHaveLength(1);
  });

  it('materializes Session Detail through the same reducer as live streaming', async () => {
    const transport = new ControlledTransport();
    const events = completeEvents(
      sendInput(),
      'session-history',
      'run-history',
      'history answer',
    );
    transport.detail = detailFromEvents([...events].reverse());
    const historyRuntime = createRuntime(transport);
    await historyRuntime.loadThreadDetail('session-history');

    const liveTransport = new ControlledTransport();
    const liveRuntime = createRuntime(liveTransport, 'session-history');
    const sending = liveRuntime.send('question', 'session-history');
    const stream = liveTransport.streams[0];
    completeEvents(
      stream.input,
      'session-history',
      'run-history',
      'history answer',
    ).forEach(stream.emit);
    stream.resolve();
    await sending;

    expect(historyRuntime.getParts('session-history')).toEqual(
      liveRuntime.getParts('session-history'),
    );
    expect(historyRuntime.getChunks('answer:answer-run-history')).toEqual(
      liveRuntime.getChunks('answer:answer-run-history'),
    );
    expect(historyRuntime.getAnswerArtifacts('answer:answer-run-history')).toEqual(
      liveRuntime.getAnswerArtifacts('answer:answer-run-history'),
    );
  });

  it('restores an interrupted Session Detail with the same stopped semantics as live streaming', async () => {
    const input = sendInput();
    const events = [
      runEvent(
        input,
        'task_started',
        { message: 'question' },
        'session-interrupted',
        'run-interrupted',
        0,
      ),
      runEvent(
        input,
        'data',
        { chunk_id: 'message-interrupted', text: 'partial' },
        'session-interrupted',
        'run-interrupted',
        1,
      ),
      runEvent(
        input,
        'task_completed',
        { terminal_reason: 'interrupted', message: 'interrupted' },
        'session-interrupted',
        'run-interrupted',
        2,
      ),
    ];
    const historyTransport = new ControlledTransport();
    historyTransport.detail = detailFromEvents(events, 'interrupted');
    const historyRuntime = createRuntime(
      historyTransport,
      'session-interrupted',
    );
    await historyRuntime.loadThreadDetail('session-interrupted');

    const liveTransport = new ControlledTransport();
    const liveRuntime = createRuntime(liveTransport, 'session-interrupted');
    const sending = liveRuntime.send('question', 'session-interrupted');
    events
      .map((event) => ({
        ...event,
        request_id: liveTransport.streams[0].input.request_id,
      }))
      .forEach(liveTransport.streams[0].emit);
    liveTransport.streams[0].resolve();
    await sending;

    expect(
      historyRuntime.getState().threads['session-interrupted'].lifecycle,
    ).toBe('stopped');
    expect(historyRuntime.getParts('session-interrupted')).toEqual(
      liveRuntime.getParts('session-interrupted'),
    );
    expect(historyRuntime.getChunks('answer:answer-run-interrupted')).toEqual(
      liveRuntime.getChunks('answer:answer-run-interrupted'),
    );
  });

  it('rejects malformed Session Detail instead of casting it', async () => {
    const transport = new ControlledTransport();
    transport.detail = detailFromEvents([{ schema_version: 1 }]);
    await expect(
      createRuntime(transport).loadThreadDetail('session-1'),
    ).rejects.toThrow('Unsupported agent event schema version');
  });

  it('does not start a second run for a thread restored as streaming', async () => {
    const transport = new ControlledTransport();
    const events = completeEvents(
      sendInput(),
      'session-streaming',
      'run-streaming',
      'partial answer',
    ).slice(0, -2);
    transport.detail = detailFromEvents(events, 'streaming');
    const runtime = createRuntime(transport, 'session-streaming');
    await runtime.loadThreadDetail('session-streaming');

    expect(runtime.getState().threads['session-streaming'].lifecycle).toBe(
      'streaming',
    );
    await expect(
      runtime.send('second run', 'session-streaming'),
    ).rejects.toThrow('already streaming');
    expect(transport.streams).toHaveLength(0);
  });

  it('reloads an existing local thread by its formal session id without creating a duplicate thread', async () => {
    const transport = new ControlledTransport();
    const runtime = createRuntime(transport);
    const sending = runtime.send('question');
    const stream = transport.streams[0];
    completeEvents(
      stream.input,
      'session-history',
      'run-live',
      'live answer',
    ).forEach(stream.emit);
    stream.resolve();
    await sending;

    const historyEvents = completeEvents(
      sendInput(),
      'session-history',
      'run-history',
      'history answer',
    );
    transport.detail = detailFromEvents(historyEvents);
    await runtime.loadThreadDetail('session-history');

    expect(runtime.getState().currentThreadId).toBe('thread-1');
    expect(runtime.getState().threads['session-history']).toBeUndefined();
    expect(runtime.getState().threads['thread-1'].sessionId).toBe(
      'session-history',
    );
    expect(runtime.getParts('thread-1')).toMatchObject([
      { text: 'question' },
      { kind: 'assistant_answer', answerId: 'answer-run-history' },
    ]);
  });

  it.each([
    [
      'duplicate sequence',
      (events: AgentEvent[]) => [{ ...events[0] }, { ...events[1], seq: 0 }],
    ],
    [
      'mixed run identity',
      (events: AgentEvent[]) => [
        { ...events[0] },
        { ...events[1], run_id: 'other-run' },
      ],
    ],
  ])('rejects Session Detail with %s', async (_label, mutate) => {
    const transport = new ControlledTransport();
    const events = completeEvents(
      sendInput(),
      'session-history',
      'run-history',
      'history answer',
    );
    transport.detail = detailFromEvents(mutate(events), 'streaming');

    await expect(
      createRuntime(transport).loadThreadDetail('session-history'),
    ).rejects.toThrow();
  });

  it('rejects terminal Session Detail without task_completed', async () => {
    const transport = new ControlledTransport();
    const events = completeEvents(
      sendInput(),
      'session-history',
      'run-history',
      'history answer',
    );
    transport.detail = detailFromEvents(events.slice(0, -1));

    await expect(
      createRuntime(transport).loadThreadDetail('session-history'),
    ).rejects.toThrow('terminal without task_completed');
  });

  it('rejects Session Detail whose status disagrees with terminal_reason', async () => {
    const transport = new ControlledTransport();
    transport.detail = detailFromEvents(
      completeEvents(
        sendInput(),
        'session-history',
        'run-history',
        'history answer',
      ),
      'interrupted',
    );

    await expect(
      createRuntime(transport).loadThreadDetail('session-history'),
    ).rejects.toThrow('does not match task_completed terminal_reason');
  });
});

function createRuntime(transport: ChatTransport, initialThreadId = 'thread-1') {
  let id = 0;
  return new ChatRuntime({
    workspaceId: 'workspace-1',
    transport,
    initialThreadId,
    idFactory: () => `local-${++id}`,
    interruptTimeoutMs: 10_000,
  });
}

function sendInput(): SendMessageInput {
  return {
    workspace_id: 'workspace-1',
    request_id: 'request-1',
    message: 'question',
    timezone_offset: 0,
    display_language: 'zh-CN',
    options: {},
  };
}

function runEvent<T extends AgentEvent['type']>(
  input: SendMessageInput,
  type: T,
  content: Extract<AgentEvent, { type: T }>['content'],
  sessionId: string,
  runId: string,
  seq: number,
): Extract<AgentEvent, { type: T }> {
  return {
    schema_version: 2,
    event_id: `${runId}-${seq}`,
    seq,
    timestamp: 1,
    request_id: input.request_id,
    workspace_id: input.workspace_id,
    session_id: sessionId,
    question_id: `question-${runId}`,
    answer_id: `answer-${runId}`,
    run_id: runId,
    type,
    content,
  } as Extract<AgentEvent, { type: T }>;
}

function event<T extends AgentEvent['type']>(
  type: T,
  content: Extract<AgentEvent, { type: T }>['content'],
  overrides: Partial<AgentEvent> = {},
): Extract<AgentEvent, { type: T }> {
  return {
    schema_version: 2,
    event_id: `${type}-1`,
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

function completeEvents(
  input: SendMessageInput,
  sessionId: string,
  runId: string,
  answer: string,
): AgentEvent[] {
  return [
    runEvent(
      input,
      'task_started',
      { message: input.message },
      sessionId,
      runId,
      0,
    ),
    runEvent(
      input,
      'thinking',
      { chunk_id: `thinking-${runId}`, text: 'thinking' },
      sessionId,
      runId,
      1,
    ),
    runEvent(
      input,
      'current_tool_use',
      { tool_use_id: 'tool-1', name: 'unknown_tool', input: { q: 'x' } },
      sessionId,
      runId,
      2,
    ),
    runEvent(
      input,
      'tool_result',
      { tool_use_id: 'tool-1', result: { ok: true } },
      sessionId,
      runId,
      3,
    ),
    runEvent(
      input,
      'data',
      { chunk_id: `message-${runId}`, text: answer },
      sessionId,
      runId,
      4,
    ),
    runEvent(
      input,
      'citation',
      {
        message_chunk_id: `message-${runId}`,
        citations: [{ id: 'citation-1', title: 'Source', snippet: 'Evidence' }],
      },
      sessionId,
      runId,
      5,
    ),
    runEvent(
      input,
      'result',
      {
        final_message_chunk_id: `message-${runId}`,
        text: answer,
        artifacts: [
          {
            id: `artifact-${runId}`,
            kind: 'document',
            title: 'Report',
            status: 'queued',
          },
        ],
      },
      sessionId,
      runId,
      6,
    ),
    runEvent(
      input,
      'task_completed',
      { terminal_reason: 'completed' },
      sessionId,
      runId,
      7,
    ),
  ];
}

function finish(
  stream: PendingStream,
  sessionId: string,
  runId: string,
  chunkId: string,
  text: string,
) {
  stream.emit(
    runEvent(
      stream.input,
      'result',
      { final_message_chunk_id: chunkId, text },
      sessionId,
      runId,
      2,
    ),
  );
  stream.emit(
    runEvent(
      stream.input,
      'task_completed',
      { terminal_reason: 'completed' },
      sessionId,
      runId,
      3,
    ),
  );
}

function detailFromEvents(events: unknown[], status = 'finished') {
  const first = events[0] as Partial<AgentEvent> | undefined;
  return {
    messages: [
      {
        question: { question_id: first?.question_id || 'question-history' },
        answer: {
          session_id: first?.session_id || 'session-history',
          answer_id: first?.answer_id || 'answer-history',
          status,
          message: events,
        },
      },
    ],
  };
}

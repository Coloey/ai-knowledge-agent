export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface TaskStartedContent {
  message: string;
}

export interface MetaInfoContent {
  route?: string;
}

export interface TextContent {
  chunk_id: string;
  text: string;
}

export interface CurrentToolUseContent {
  tool_use_id: string;
  name: string;
  input?: JsonValue;
}

export interface ToolResultContent {
  tool_use_id: string;
  result?: JsonValue;
  is_error?: boolean;
}

export interface Citation {
  id?: string;
  file_id?: string;
  title?: string;
  page?: number;
  snippet?: string;
}

export interface CitationContent {
  message_chunk_id: string;
  citations: Citation[];
}

export interface Artifact {
  id?: string;
  name?: string;
}

export interface ArtifactContent {
  artifact?: Artifact;
  artifacts?: Artifact[];
}

export interface ResultContent {
  final_message_chunk_id: string;
  text: string;
  artifacts?: Artifact[];
}

export interface ErrorContent {
  message: string;
  error_code?: number | string;
}

export interface TaskCompletedContent {
  message?: string;
}

export interface HeartbeatContent {
  at?: number;
}

interface AgentEventEnvelope<TType extends string, TContent> {
  schema_version: 2;
  event_id: string;
  seq: number;
  timestamp: number;
  request_id: string;
  workspace_id: string;
  session_id: string;
  question_id: string;
  answer_id: string;
  run_id: string;
  type: TType;
  content: TContent;
}

export type AgentEvent =
  | AgentEventEnvelope<'task_started', TaskStartedContent>
  | AgentEventEnvelope<'meta_info', MetaInfoContent>
  | AgentEventEnvelope<'thinking', TextContent>
  | AgentEventEnvelope<'data', TextContent>
  | AgentEventEnvelope<'current_tool_use', CurrentToolUseContent>
  | AgentEventEnvelope<'tool_result', ToolResultContent>
  | AgentEventEnvelope<'citation', CitationContent>
  | AgentEventEnvelope<'artifact', ArtifactContent>
  | AgentEventEnvelope<'result', ResultContent>
  | AgentEventEnvelope<'error', ErrorContent>
  | AgentEventEnvelope<'task_completed', TaskCompletedContent>
  | AgentEventEnvelope<'heartbeat', HeartbeatContent>;

export class AgentEventDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEventDecodeError';
  }
}

const eventTypes = new Set<AgentEvent['type']>([
  'task_started',
  'meta_info',
  'thinking',
  'data',
  'current_tool_use',
  'tool_result',
  'citation',
  'artifact',
  'result',
  'error',
  'task_completed',
  'heartbeat',
]);

export function decodeAgentEvent(raw: string): AgentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentEventDecodeError('Agent event is not valid JSON');
  }

  const event = requireRecord(parsed, 'Agent event');
  if (event.schema_version !== 2) {
    throw new AgentEventDecodeError('Unsupported agent event schema version');
  }

  const type = requireEventType(event.type);
  const envelope = {
    schema_version: 2 as const,
    event_id: requireIdentity(event.event_id, 'event_id'),
    seq: requireSequence(event.seq),
    timestamp: requireTimestamp(event.timestamp),
    request_id: requireIdentity(event.request_id, 'request_id'),
    workspace_id: requireIdentity(event.workspace_id, 'workspace_id'),
    session_id: requireIdentity(event.session_id, 'session_id'),
    question_id: requireIdentity(event.question_id, 'question_id'),
    answer_id: requireIdentity(event.answer_id, 'answer_id'),
    run_id: requireIdentity(event.run_id, 'run_id'),
    type,
  };

  return { ...envelope, content: decodeContent(type, event.content) } as AgentEvent;
}

export interface SseFrame {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export interface SseDecoder {
  push(chunk: Uint8Array): void;
  finish(): void;
}

export function createSseDecoder(onFrame: (frame: SseFrame) => void): SseDecoder {
  const textDecoder = new TextDecoder();
  let buffer = '';

  const processFrame = (frame: string) => {
    if (!frame) return;

    let id: string | undefined;
    let event: string | undefined;
    let retry: number | undefined;
    const data: string[] = [];

    for (const line of frame.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colonIndex = line.indexOf(':');
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      const value = colonIndex === -1 ? '' : line.slice(colonIndex + 1).replace(/^ /, '');

      if (field === 'data') data.push(value);
      if (field === 'id') id = value;
      if (field === 'event') event = value;
      if (field === 'retry' && /^\d+$/.test(value)) {
        const parsedRetry = Number(value);
        if (Number.isSafeInteger(parsedRetry) && parsedRetry >= 0) retry = parsedRetry;
      }
    }

    if (!data.length) return;
    onFrame({ ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), ...(retry === undefined ? {} : { retry }), data: data.join('\n') });
  };

  const processBufferedFrames = (final = false) => {
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match || match.index === undefined) break;
      processFrame(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    if (final && buffer) {
      processFrame(buffer);
      buffer = '';
    }
  };

  return {
    push(chunk) {
      buffer += textDecoder.decode(chunk, { stream: true });
      processBufferedFrames();
    },
    finish() {
      buffer += textDecoder.decode();
      processBufferedFrames(true);
    },
  };
}

function decodeContent(type: AgentEvent['type'], value: unknown): AgentEvent['content'] {
  const content = requireRecord(value, `${type}.content`);

  switch (type) {
    case 'task_started':
      return { message: requireString(content.message, 'task_started.content.message') };
    case 'meta_info':
      requireOptionalString(content.route, 'meta_info.content.route');
      return content as MetaInfoContent;
    case 'thinking':
    case 'data':
      return {
        chunk_id: requireIdentity(content.chunk_id, `${type}.content.chunk_id`),
        text: requireString(content.text, `${type}.content.text`),
      };
    case 'current_tool_use':
      return {
        tool_use_id: requireIdentity(content.tool_use_id, 'current_tool_use.content.tool_use_id'),
        name: requireIdentity(content.name, 'current_tool_use.content.name'),
        ...(content.input === undefined ? {} : { input: content.input as JsonValue }),
      };
    case 'tool_result':
      const isError = requireOptionalBoolean(content.is_error, 'tool_result.content.is_error');
      return {
        tool_use_id: requireIdentity(content.tool_use_id, 'tool_result.content.tool_use_id'),
        ...(content.result === undefined ? {} : { result: content.result as JsonValue }),
        ...(isError === undefined ? {} : { is_error: isError }),
      };
    case 'citation':
      return {
        message_chunk_id: requireIdentity(content.message_chunk_id, 'citation.content.message_chunk_id'),
        citations: requireCitationArray(content.citations),
      };
    case 'artifact':
      return requireArtifactContent(content);
    case 'result':
      return {
        final_message_chunk_id: requireIdentity(content.final_message_chunk_id, 'result.content.final_message_chunk_id'),
        text: requireString(content.text, 'result.content.text'),
        ...(content.artifacts === undefined ? {} : { artifacts: requireArtifactArray(content.artifacts) }),
      };
    case 'error':
      return {
        message: requireString(content.message, 'error.content.message'),
        ...(content.error_code === undefined ? {} : { error_code: requireErrorCode(content.error_code) }),
      };
    case 'task_completed':
      requireOptionalString(content.message, 'task_completed.content.message');
      return content as TaskCompletedContent;
    case 'heartbeat':
      if (content.at !== undefined && (typeof content.at !== 'number' || !Number.isFinite(content.at))) {
        throw new AgentEventDecodeError('heartbeat.content.at must be a finite number');
      }
      return content as HeartbeatContent;
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentEventDecodeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEventType(value: unknown): AgentEvent['type'] {
  if (typeof value !== 'string' || !eventTypes.has(value as AgentEvent['type'])) {
    throw new AgentEventDecodeError('Unknown agent event type');
  }
  return value as AgentEvent['type'];
}

function requireIdentity(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentEventDecodeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new AgentEventDecodeError('seq must be a non-negative integer');
  }
  return value;
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AgentEventDecodeError('timestamp must be a finite number');
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new AgentEventDecodeError(`${name} must be a string`);
  }
  return value;
}

function requireOptionalString(value: unknown, name: string): void {
  if (value !== undefined) requireString(value, name);
}

function requireOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AgentEventDecodeError(`${name} must be a boolean`);
  }
  return value;
}

function requireCitationArray(value: unknown): Citation[] {
  if (!Array.isArray(value)) {
    throw new AgentEventDecodeError('citation.content.citations must be an array');
  }
  return value.map((citation, index) => {
    const record = requireRecord(citation, `citation.content.citations[${index}]`);
    requireOptionalString(record.id, `citation.content.citations[${index}].id`);
    requireOptionalString(record.file_id, `citation.content.citations[${index}].file_id`);
    requireOptionalString(record.title, `citation.content.citations[${index}].title`);
    requireOptionalString(record.snippet, `citation.content.citations[${index}].snippet`);
    if (record.page !== undefined && (typeof record.page !== 'number' || !Number.isFinite(record.page))) {
      throw new AgentEventDecodeError(`citation.content.citations[${index}].page must be a finite number`);
    }
    return record as Citation;
  });
}

function requireArtifactContent(content: Record<string, unknown>): ArtifactContent {
  if (content.artifact === undefined && content.artifacts === undefined) {
    throw new AgentEventDecodeError('artifact.content must include artifact or artifacts');
  }
  return {
    ...(content.artifact === undefined ? {} : { artifact: requireArtifact(content.artifact, 'artifact.content.artifact') }),
    ...(content.artifacts === undefined ? {} : { artifacts: requireArtifactArray(content.artifacts) }),
  };
}

function requireArtifactArray(value: unknown): Artifact[] {
  if (!Array.isArray(value)) {
    throw new AgentEventDecodeError('artifacts must be an array');
  }
  return value.map((artifact, index) => requireArtifact(artifact, `artifacts[${index}]`));
}

function requireArtifact(value: unknown, name: string): Artifact {
  const artifact = requireRecord(value, name);
  requireOptionalString(artifact.id, `${name}.id`);
  requireOptionalString(artifact.name, `${name}.name`);
  return artifact as Artifact;
}

function requireErrorCode(value: unknown): number | string {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new AgentEventDecodeError('error.content.error_code must be a number or string');
  }
  return value;
}

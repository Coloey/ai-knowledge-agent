import React, { useState } from 'react';
import { Button, Empty, Input, Space, Tag } from 'antd';

import {
  useChatCommands,
  useCurrentThread,
  useOrderedChunks,
  useOrderedParts,
} from '@agent/chat-runtime';
import type {
  AssistantAnswerPart,
  Chunk,
  MessageChunk,
  NormalizedPart,
  SystemNoticePart,
  ToolChunk,
} from '@agent/domain';
import type { Citation, JsonValue } from '@agent/protocol';

const EXAMPLE_PROMPTS = [
  '总结我的知识库',
  '提炼这批文档的行动项',
  '列出资料里的风险点',
];
const TOOL_LABELS: Record<string, string> = {
  search: 'Knowledge search',
  retrieval: 'Knowledge retrieval',
};

export function SmartBar() {
  const commands = useChatCommands();
  const thread = useCurrentThread();
  const parts = useOrderedParts(thread.id);
  const [message, setMessage] = useState('');
  const isRunning =
    thread.lifecycle === 'streaming' || thread.lifecycle === 'result';

  function send(nextMessage = message) {
    const text = nextMessage.trim();
    if (!text || isRunning) return;
    setMessage('');
    void commands.send(text, thread.id).catch(() => undefined);
  }

  return (
    <div className="smartbar">
      <header className="smartbar-header">
        <div>
          <strong>SmartBar</strong>
          <span>Session {thread.sessionId || thread.id}</span>
        </div>
        <Tag color={statusColor(thread.lifecycle)}>{thread.lifecycle}</Tag>
      </header>

      <section className="smartbar-messages">
        {parts.length ? (
          parts.map((part) => <PartView key={part.id} part={part} />)
        ) : (
          <Empty description="Ask a question after uploading documents." />
        )}
      </section>

      <Space wrap>
        {EXAMPLE_PROMPTS.map((prompt) => (
          <Button key={prompt} size="small" onClick={() => send(prompt)}>
            {prompt}
          </Button>
        ))}
      </Space>

      <footer className="smartbar-input">
        <Input.TextArea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onPressEnter={(event) => {
            if (!event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder="Ask anything about your knowledge base..."
          autoSize={{ minRows: 2, maxRows: 6 }}
        />
        <Button type="primary" onClick={() => send()} disabled={isRunning}>
          Send
        </Button>
        <Button onClick={() => commands.stop(thread.id)} disabled={!isRunning}>
          Stop
        </Button>
      </footer>
    </div>
  );
}

function PartView(props: { part: NormalizedPart }) {
  if (props.part.kind === 'assistant_answer')
    return <AssistantPartView part={props.part} />;
  if (props.part.kind === 'system_notice')
    return <SystemNoticeView notice={props.part} />;
  return (
    <article className="message-row user message">
      <div className="message-role">user</div>
      <div className="message-bubble">{props.part.text}</div>
    </article>
  );
}

function AssistantPartView(props: { part: AssistantAnswerPart }) {
  const chunks = useOrderedChunks(props.part.id);
  return (
    <article className={`message-row assistant ${props.part.status}`}>
      <div className="message-role">assistant</div>
      <div className="assistant-chunks">
        {chunks.map((chunk) => (
          <ChunkView key={chunk.id} chunk={chunk} />
        ))}
        {!chunks.length && props.part.status === 'streaming' ? (
          <div className="message-bubble thinking">Preparing response...</div>
        ) : null}
      </div>
    </article>
  );
}

function ChunkView(props: { chunk: Chunk }) {
  if (props.chunk.kind === 'thinking') {
    return (
      <section
        className={`message-bubble chunk-thinking ${props.chunk.status}`}
      >
        <small>thinking</small>
        <div>{props.chunk.text}</div>
      </section>
    );
  }
  if (props.chunk.kind === 'tool') return <ToolView tool={props.chunk} />;
  return <MessageView message={props.chunk} />;
}

function MessageView(props: { message: MessageChunk }) {
  return (
    <section className={`message-bubble chunk-message ${props.message.status}`}>
      <div>{props.message.text}</div>
      {props.message.citations.length ? (
        <CitationList citations={props.message.citations} />
      ) : null}
    </section>
  );
}

function ToolView(props: { tool: ToolChunk }) {
  const knownLabel = TOOL_LABELS[props.tool.name];
  return (
    <section className={`message-bubble tool-card ${props.tool.status}`}>
      <div className="tool-card-header">
        <strong>{knownLabel || 'Tool call'}</strong>
        <Tag color={props.tool.isError ? 'error' : 'default'}>
          {props.tool.status}
        </Tag>
      </div>
      <span className="tool-name">{props.tool.name}</span>
      {props.tool.input === undefined ? null : (
        <JsonBlock label="Input" value={props.tool.input} />
      )}
      {props.tool.result === undefined ? null : (
        <JsonBlock label="Result" value={props.tool.result} />
      )}
    </section>
  );
}

function JsonBlock(props: { label: string; value: JsonValue }) {
  return (
    <div className="tool-payload">
      <small>{props.label}</small>
      <pre>{formatJson(props.value)}</pre>
    </div>
  );
}

function CitationList(props: { citations: Citation[] }) {
  return (
    <div className="citation-list">
      {props.citations.map((citation, index) => (
        <div
          key={
            citation.id ||
            `${citation.file_id || citation.title || 'citation'}-${index}`
          }
          className="citation-item"
        >
          <strong>{citation.title || `Citation ${index + 1}`}</strong>
          <span>
            {citation.page === undefined ? 'no page' : `p.${citation.page}`}
          </span>
          {citation.snippet ? <p>{citation.snippet}</p> : null}
        </div>
      ))}
    </div>
  );
}

function SystemNoticeView(props: { notice: SystemNoticePart }) {
  return (
    <article className={`message-row system ${props.notice.level}`}>
      <div className="message-role">system</div>
      <div className="message-bubble">{props.notice.text}</div>
    </article>
  );
}

function formatJson(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function statusColor(status: string) {
  if (status === 'streaming') return 'processing';
  if (status === 'completed' || status === 'result') return 'success';
  if (status === 'error') return 'error';
  return 'default';
}

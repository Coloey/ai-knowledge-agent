import React, { useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Space, Tag } from 'antd';

import { useApiClient } from '@agent/api';
import { useSessionStore } from '@agent/domain';

interface SmartBarEvent {
  type: string;
  session_id: string;
  content: Record<string, unknown>;
}

const EXAMPLE_PROMPTS = ['总结我的知识库', '提炼这批文档的行动项', '列出资料里的风险点'];

export function SmartBar(props: { workspaceId: string }) {
  const api = useApiClient();
  const abortRef = useRef<AbortController | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const { activeThread, appendAssistantDelta, appendPart, setSessionId, setStreamStatus } = useSessionStore();

  async function send(nextMessage = message) {
    const text = nextMessage.trim();
    if (!text || activeThread.streamStatus === 'streaming') return;

    const controller = new AbortController();
    abortRef.current = controller;
    setMessage('');
    setError('');
    setStreamStatus('streaming');
    appendPart({ id: crypto.randomUUID(), role: 'user', type: 'message', text });

    try {
      const response = await api.stream(
        '/notta-brain/session/send-message',
        {
          session_id: activeThread.sessionId,
          request_id: crypto.randomUUID(),
          workspace_id: props.workspaceId,
          message: text,
          timezone_offset: new Date().getTimezoneOffset(),
          display_language: 'zh-CN',
          options: {},
        },
        controller.signal,
      );

      if (!response.ok) {
        throw new Error(response.statusText || 'SSE request failed');
      }
      if (!response.body) {
        throw new Error('SSE response body is empty');
      }

      await readSSE(response.body.getReader(), (event) => {
        setSessionId(event.session_id);
        if (event.type === 'data') {
          appendAssistantDelta(String(event.content.text || ''));
        }
        if (event.type === 'thinking') {
          appendPart({ id: crypto.randomUUID(), role: 'assistant', type: 'thinking', text: String(event.content.text || '') });
        }
        if (event.type === 'citation') {
          appendPart({ id: crypto.randomUUID(), role: 'assistant', type: 'citation', payload: event.content });
        }
        if (event.type === 'error') {
          setStreamStatus('error');
          appendPart({ id: crypto.randomUUID(), role: 'assistant', type: 'error', text: String(event.content.message || '') });
        }
        if (event.type === 'task_completed') {
          setStreamStatus('finished');
        }
      });
      setStreamStatus('finished');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setStreamStatus('interrupted');
        return;
      }
      const errorMessage = err instanceof Error ? err.message : 'Send failed';
      setError(errorMessage);
      setStreamStatus('error');
      appendPart({ id: crypto.randomUUID(), role: 'assistant', type: 'error', text: errorMessage });
    }
  }

  async function stop() {
    if (activeThread.sessionId) {
      await api.post('/notta-brain/session/interrupt', {
        workspace_id: props.workspaceId,
        session_id: activeThread.sessionId,
      });
    }
    abortRef.current?.abort();
    setStreamStatus('interrupted');
  }

  return (
    <div className="smartbar">
      <header className="smartbar-header">
        <div>
          <strong>SmartBar</strong>
          <span>Session {activeThread.sessionId || activeThread.localId}</span>
        </div>
        <Tag color={statusColor(activeThread.streamStatus)}>{activeThread.streamStatus}</Tag>
      </header>

      <section className="smartbar-messages">
        {activeThread.parts.length ? (
          activeThread.parts.map((part) => (
            <article key={part.id} className={`message-row ${part.role} ${part.type}`}>
              <div className="message-role">{part.type === 'thinking' ? 'thinking' : part.role}</div>
              <div className="message-bubble">{part.text || renderPayload(part.payload)}</div>
            </article>
          ))
        ) : (
          <Empty description="Ask a question after uploading documents." />
        )}
      </section>

      {error ? <Alert type="error" message={error} showIcon /> : null}

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
              void send();
            }
          }}
          placeholder="Ask anything about your knowledge base..."
          autoSize={{ minRows: 2, maxRows: 6 }}
        />
        <Button type="primary" onClick={() => send()} disabled={activeThread.streamStatus === 'streaming'}>
          Send
        </Button>
        <Button onClick={stop} disabled={activeThread.streamStatus !== 'streaming'}>
          Stop
        </Button>
      </footer>
    </div>
  );
}

function renderPayload(payload: unknown) {
  if (!payload) return '';
  if (typeof payload !== 'object') return String(payload);
  const citations = (payload as { citations?: Array<{ title?: string; page?: number; snippet?: string }> }).citations;
  if (!citations) return JSON.stringify(payload);
  return (
    <div className="citation-list">
      {citations.map((citation, index) => (
        <div key={`${citation.title}-${index}`} className="citation-item">
          <strong>{citation.title || `Citation ${index + 1}`}</strong>
          <span>{citation.page ? `p.${citation.page}` : 'no page'}</span>
          <p>{citation.snippet}</p>
        </div>
      ))}
    </div>
  );
}

function statusColor(status: string) {
  if (status === 'streaming') return 'processing';
  if (status === 'finished') return 'success';
  if (status === 'error') return 'error';
  return 'default';
}

async function readSSE(reader: ReadableStreamDefaultReader<Uint8Array>, onEvent: (event: SmartBarEvent) => void) {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';

    for (const block of blocks) {
      const dataLine = block
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.replace('data: ', '');
      if (!dataLine || dataLine === '{"done":true}') continue;
      onEvent(JSON.parse(dataLine) as SmartBarEvent);
    }
  }
}

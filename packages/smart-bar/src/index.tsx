import React, { useState } from 'react';
import {
  Button,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Progress,
  Space,
  Tag,
} from 'antd';

import {
  useApiClient,
  useArtifactDetail,
  useRetryArtifact,
} from '@agent/api';

import {
  useChatCommands,
  useCurrentThread,
  useAnswerArtifacts,
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
import type { ArtifactRef, Citation, JsonValue } from '@agent/protocol';

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
  const [shouldGenerateReport, setShouldGenerateReport] = useState(false);
  const isRunning =
    thread.lifecycle === 'streaming' || thread.lifecycle === 'result';

  function send(nextMessage = message) {
    const text = nextMessage.trim();
    if (!text || isRunning) return;
    const sending = commands.send(
      text,
      thread.id,
      shouldGenerateReport ? { outputArtifact: 'document' } : undefined,
    );
    setMessage('');
    void sending
      .then(() => setShouldGenerateReport(false))
      .catch(() => undefined);
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
        <Checkbox
          checked={shouldGenerateReport}
          disabled={isRunning}
          onChange={(event) => setShouldGenerateReport(event.target.checked)}
        >
          生成报告
        </Checkbox>
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
  const artifacts = useAnswerArtifacts(props.part.id);
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
        <ArtifactList artifacts={artifacts} />
      </div>
    </article>
  );
}

function ArtifactList(props: { artifacts: ArtifactRef[] }) {
  return props.artifacts.length ? (
    <section className="artifact-list" aria-label="Generated artifacts">
      {props.artifacts.map((artifact) => (
        <ArtifactCard key={artifact.id} artifact={artifact} />
      ))}
    </section>
  ) : null;
}

interface PreviewState {
  open: boolean;
  loading: boolean;
  content?: string;
  error?: string;
}

function ArtifactCard(props: { artifact: ArtifactRef }) {
  const client = useApiClient();
  const detailQuery = useArtifactDetail(props.artifact.id);
  const retry = useRetryArtifact(props.artifact.id);
  const [preview, setPreview] = useState<PreviewState>({
    open: false,
    loading: false,
  });
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const artifact = detailQuery.data || props.artifact;

  async function openPreview() {
    setPreview({ open: true, loading: true });
    try {
      const blob = await client.getBlob(
        artifactContentPath(props.artifact.id, 'inline'),
      );
      setPreview({ open: true, loading: false, content: await blob.text() });
    } catch (error) {
      setPreview({
        open: true,
        loading: false,
        error: errorMessage(error, 'Artifact preview could not be loaded.'),
      });
    }
  }

  async function download() {
    setDownloadError('');
    setDownloading(true);
    try {
      const blob = await client.getBlob(
        artifactContentPath(props.artifact.id, 'attachment'),
      );
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = artifactFilename(artifact.title);
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      setDownloadError(errorMessage(error, 'Artifact download could not start.'));
    } finally {
      setDownloading(false);
    }
  }

  if (detailQuery.isLoading) {
    return (
      <section className="artifact-card" aria-busy="true">
        Loading artifact status...
      </section>
    );
  }

  if (detailQuery.isError) {
    return (
      <section className="artifact-card artifact-error" role="alert">
        Artifact status could not be loaded. Try refreshing this session.
      </section>
    );
  }

  return (
    <section className="artifact-card" aria-label={`Artifact ${artifact.title}`}>
      <div className="artifact-card-header">
        <div>
          <strong>{artifact.title}</strong>
          <span>Markdown report</span>
        </div>
        <Tag color={artifactStatusColor(artifact.status)}>
          {artifactStatusLabel(artifact.status)}
        </Tag>
      </div>
      {artifactStateContent(
        artifact,
        retry.isPending,
        downloading,
        downloadError,
        openPreview,
        download,
        () => retry.mutate(),
      )}
      <Drawer
        destroyOnClose
        open={preview.open}
        title={`Preview: ${artifact.title}`}
        onClose={() => setPreview((current) => ({ ...current, open: false }))}
      >
        {preview.loading ? (
          <div role="status">Loading preview...</div>
        ) : preview.error ? (
          <div role="alert">
            {preview.error}
            <Button type="link" onClick={() => void openPreview()}>
              Retry preview
            </Button>
          </div>
        ) : (
          <pre className="artifact-preview-content">{preview.content}</pre>
        )}
      </Drawer>
    </section>
  );
}

function artifactStateContent(
  artifact: ArtifactRef & { progress?: number; error_message?: string },
  retrying: boolean,
  downloading: boolean,
  downloadError: string,
  openPreview: () => void,
  download: () => void,
  retry: () => void,
) {
  switch (artifact.status) {
    case 'queued':
    case 'processing':
      return (
        <div className="artifact-progress" role="status">
          <span>{artifactStatusLabel(artifact.status)}</span>
          <Progress percent={artifact.progress ?? 0} size="small" />
        </div>
      );
    case 'completed':
      return (
        <div className="artifact-actions">
          <Button onClick={() => void openPreview()}>
            Preview {artifact.title}
          </Button>
          <Button loading={downloading} onClick={() => void download()}>
            Download {artifact.title}
          </Button>
          {downloadError ? <div role="alert">{downloadError}</div> : null}
        </div>
      );
    case 'failed':
      return (
        <div className="artifact-actions artifact-failed" role="alert">
          <span>{artifact.error_message || 'Artifact generation failed.'}</span>
          <Button loading={retrying} disabled={retrying} onClick={retry}>
            Retry {artifact.title}
          </Button>
        </div>
      );
  }
}

export function artifactContentPath(
  artifactId: string,
  disposition: 'inline' | 'attachment',
): string {
  return `/artifacts/${encodeURIComponent(artifactId)}/content?disposition=${disposition}`;
}

export function artifactFilename(title: string): string {
  const safeTitle = title
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  const filename = safeTitle || 'report';
  return /\.md$/i.test(filename) ? filename : `${filename}.md`;
}

function artifactStatusLabel(status: ArtifactRef['status']) {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'processing':
      return 'Generating';
    case 'completed':
      return 'Ready';
    case 'failed':
      return 'Failed';
  }
}

function artifactStatusColor(status: ArtifactRef['status']) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return 'processing';
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
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

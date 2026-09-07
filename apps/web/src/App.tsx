import React, { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Empty,
  Form,
  Input,
  List,
  Progress,
  Segmented,
  Space,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { UploadProps } from 'antd';

import {
  ApiProvider,
  ArtifactQueryProvider,
  AuthExpiredError,
  AuthResult,
  LibraryFileDTO,
  useApiClient,
  WorkspaceDTO,
} from '@agent/api';
import { ChatRuntimeProvider } from '@agent/chat-runtime';
import { SmartBar } from '@agent/smart-bar';
import { AppShell } from '@agent/ui';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000';
const AUTH_STORAGE_KEY = 'agent_auth';

type ViewKey = 'chat' | 'library' | 'settings';

export function App() {
  const [auth, setAuth] = useState<AuthResult | null>(() => {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthResult) : null;
  });

  function handleAuth(nextAuth: AuthResult) {
    setAuth(nextAuth);
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextAuth));
  }

  function logout() {
    setAuth(null);
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }

  return (
    <ApiProvider baseURL={API_BASE_URL} token={auth?.access_token}>
      {!auth ? (
        <AuthPanel onAuth={handleAuth} />
      ) : (
        <ArtifactQueryProvider identityKey={auth.user.uid}>
          <AppShell title="AI Knowledge Agent">
            <WorkspacePanel auth={auth} onLogout={logout} />
          </AppShell>
        </ArtifactQueryProvider>
      )}
    </ApiProvider>
  );
}

function AuthPanel(props: { onAuth: (auth: AuthResult) => void }) {
  const client = useApiClient();
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(values: {
    email: string;
    password: string;
    name?: string;
  }) {
    setError('');
    setSubmitting(true);
    try {
      const auth = await client.post<AuthResult>(
        mode === 'register' ? '/auth/register' : '/auth/login',
        {
          email: values.email,
          password: values.password,
          name: values.name || 'User',
        },
      );
      props.onAuth(auth);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Auth failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-copy">
        <Tag color="blue">Full-stack AI Agent</Tag>
        <Typography.Title>
          Knowledge workspace for private documents
        </Typography.Title>
        <Typography.Paragraph>
          Upload source files, index them into a vector knowledge base, and ask
          SmartBar for cited answers over SSE.
        </Typography.Paragraph>
        <div className="auth-metrics">
          <Metric label="Core flow" value="RAG + SSE" />
          <Metric label="Backend" value="NestJS" />
          <Metric label="Deploy" value="Docker" />
        </div>
      </section>

      <Card
        className="auth-card"
        title={mode === 'register' ? 'Create account' : 'Login'}
      >
        <Space direction="vertical" className="full-width" size={16}>
          {error ? <Alert type="error" message={error} /> : null}
          <Form layout="vertical" onFinish={submit}>
            {mode === 'register' ? (
              <Form.Item name="name" label="Name" initialValue="User">
                <Input size="large" />
              </Form.Item>
            ) : null}
            <Form.Item
              name="email"
              label="Email"
              rules={[{ required: true, type: 'email' }]}
            >
              <Input size="large" placeholder="you@example.com" />
            </Form.Item>
            <Form.Item
              name="password"
              label="Password"
              rules={[{ required: true, min: 8 }]}
            >
              <Input.Password
                size="large"
                placeholder="At least 8 characters"
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={submitting}
              block
              size="large"
            >
              {mode === 'register' ? 'Register' : 'Login'}
            </Button>
          </Form>
          <Button
            type="link"
            onClick={() => setMode(mode === 'register' ? 'login' : 'register')}
            block
          >
            {mode === 'register'
              ? 'Already have an account?'
              : 'Create a new account'}
          </Button>
        </Space>
      </Card>
    </main>
  );
}

function WorkspacePanel(props: {
  auth: AuthResult;
  onLogout: () => void;
}) {
  const client = useApiClient();
  const [view, setView] = useState<ViewKey>('chat');
  const [workspace, setWorkspace] = useState<WorkspaceDTO | null>(null);
  const [files, setFiles] = useState<LibraryFileDTO[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  async function refresh() {
    setError('');
    const workspaces = await client.get<WorkspaceDTO[]>('/workspaces');
    const current =
      workspaces.find(
        (item) => item.workspace_id === props.auth.default_workspace_id,
      ) || workspaces[0];
    setWorkspace(current || null);
    if (current) {
      setFiles(
        await client.get<LibraryFileDTO[]>(
          `/library/files?workspace_id=${current.workspace_id}`,
        ),
      );
    }
  }

  function handleError(err: unknown, fallback: string) {
    if (err instanceof AuthExpiredError) {
      props.onLogout();
      return;
    }
    setError(err instanceof Error ? err.message : fallback);
  }

  useEffect(() => {
    refresh()
      .catch((err) => handleError(err, 'Load workspace failed'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (
      !workspace ||
      !files.some((file) => ['pending', 'parsing'].includes(file.parse_status))
    )
      return;
    const timer = window.setInterval(() => {
      refresh().catch((err) => handleError(err, 'Refresh files failed'));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [workspace?.workspace_id, files]);

  const readyCount = files.filter(
    (file) => file.parse_status === 'ready',
  ).length;
  const parsingCount = files.filter((file) =>
    ['pending', 'parsing'].includes(file.parse_status),
  ).length;
  const failedCount = files.filter(
    (file) => file.parse_status === 'failed',
  ).length;

  const uploadProps: UploadProps = {
    multiple: true,
    showUploadList: false,
    beforeUpload: async (file) => {
      if (!workspace) return false;
      setUploading(true);
      setError('');
      try {
        const formData = new FormData();
        formData.append('file', file);
        await client.upload<LibraryFileDTO>(
          `/library/files/upload?workspace_id=${workspace.workspace_id}`,
          formData,
        );
        await refresh();
      } catch (err) {
        handleError(err, 'Upload failed');
      } finally {
        setUploading(false);
      }
      return false;
    },
  };

  if (loading) {
    return <Alert type="info" message="Loading workspace..." />;
  }

  if (!workspace) {
    return <Alert type="error" message={error || 'Workspace not found'} />;
  }

  return (
    <div className="workspace-layout">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          <div className="workspace-logo">AI</div>
          <div>
            <strong>{workspace.name}</strong>
            <span>{props.auth.user.email}</span>
          </div>
        </div>

        <nav className="workspace-nav">
          <button
            className={view === 'chat' ? 'active' : ''}
            onClick={() => setView('chat')}
          >
            SmartBar
          </button>
          <button
            className={view === 'library' ? 'active' : ''}
            onClick={() => setView('library')}
          >
            Library
          </button>
          <button
            className={view === 'settings' ? 'active' : ''}
            onClick={() => setView('settings')}
          >
            Settings
          </button>
        </nav>

        <Divider />

        <div className="sidebar-stats">
          <Metric label="Files" value={String(files.length)} />
          <Metric label="Ready" value={String(readyCount)} />
          <Metric label="Parsing" value={String(parsingCount)} />
        </div>

        <Button onClick={props.onLogout} block>
          Logout
        </Button>
      </aside>

      <section className="workspace-main">
        <header className="workspace-toolbar">
          <div>
            <Typography.Title level={3}>
              {view === 'chat'
                ? 'Ask your knowledge base'
                : view === 'library'
                  ? 'Document library'
                  : 'Workspace settings'}
            </Typography.Title>
            <Typography.Text type="secondary">
              {view === 'chat'
                ? 'Answers stream from NestJS SSE and are persisted as replayable events.'
                : view === 'library'
                  ? 'Files are parsed asynchronously and embedded into PostgreSQL pgvector.'
                  : 'Environment, model and workspace defaults for this personal project.'}
            </Typography.Text>
          </div>
          <Space>
            <Upload {...uploadProps}>
              <Button type="primary" loading={uploading}>
                Upload documents
              </Button>
            </Upload>
            <Button onClick={() => refresh()} disabled={uploading}>
              Refresh
            </Button>
          </Space>
        </header>

        {error ? <Alert type="error" message={error} showIcon /> : null}

        <ChatRuntimeProvider workspaceId={workspace.workspace_id}>
          <div className="workspace-content">
            {view === 'chat' ? (
              <ChatView files={files} />
            ) : view === 'library' ? (
              <LibraryView
                files={files}
                readyCount={readyCount}
                failedCount={failedCount}
              />
            ) : (
              <SettingsView apiBaseURL={API_BASE_URL} workspace={workspace} />
            )}
          </div>
        </ChatRuntimeProvider>
      </section>
    </div>
  );
}

function ChatView(props: { files: LibraryFileDTO[] }) {
  const readyFiles = props.files.filter(
    (file) => file.parse_status === 'ready',
  );

  return (
    <div className="chat-grid">
      <section className="chat-panel">
        <SmartBar />
      </section>
      <aside className="context-panel">
        <Typography.Title level={5}>Knowledge context</Typography.Title>
        <Typography.Text type="secondary">
          Ready documents are used as retrieval sources.
        </Typography.Text>
        <List
          className="compact-list"
          dataSource={readyFiles.slice(0, 8)}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No ready files yet"
              />
            ),
          }}
          renderItem={(file) => (
            <List.Item>
              <List.Item.Meta
                title={file.title}
                description={`${Math.round(file.size / 1024)} KB`}
              />
              <Badge status="success" />
            </List.Item>
          )}
        />
      </aside>
    </div>
  );
}

function LibraryView(props: {
  files: LibraryFileDTO[];
  readyCount: number;
  failedCount: number;
}) {
  const progress = props.files.length
    ? Math.round((props.readyCount / props.files.length) * 100)
    : 0;

  return (
    <div className="library-grid">
      <Card>
        <Typography.Title level={5}>Indexing progress</Typography.Title>
        <Progress percent={progress} />
        <Space>
          <Tag color="green">{props.readyCount} ready</Tag>
          <Tag color={props.failedCount ? 'red' : 'default'}>
            {props.failedCount} failed
          </Tag>
        </Space>
      </Card>
      <Card className="library-list-card">
        <List
          dataSource={props.files}
          locale={{
            emptyText: (
              <Empty description="Upload PDF / DOCX / PPTX / TXT / MD files first." />
            ),
          }}
          renderItem={(file) => (
            <List.Item>
              <List.Item.Meta
                title={file.title}
                description={`${file.file_type} · ${Math.round(file.size / 1024)} KB · ${file.error_message || 'No error'}`}
              />
              <StatusTag status={file.parse_status} />
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
}

function SettingsView(props: { apiBaseURL: string; workspace: WorkspaceDTO }) {
  return (
    <Card>
      <Typography.Title level={5}>Runtime</Typography.Title>
      <div className="settings-list">
        <span>API Base URL</span>
        <code>{props.apiBaseURL}</code>
        <span>Workspace ID</span>
        <code>{props.workspace.workspace_id}</code>
        <span>Role</span>
        <code>{props.workspace.role}</code>
      </div>
      <Divider />
      <Segmented
        block
        options={['DashScope', 'OpenAI-compatible', 'Ollama local']}
        value="DashScope"
      />
    </Card>
  );
}

function StatusTag(props: { status: string }) {
  const color =
    props.status === 'ready'
      ? 'green'
      : props.status === 'failed'
        ? 'red'
        : 'blue';
  return <Tag color={color}>{props.status}</Tag>;
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

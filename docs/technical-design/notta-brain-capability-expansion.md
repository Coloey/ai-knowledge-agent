# AI Knowledge Agent 能力扩展技术方案

> 状态：P0 v1.0 已实现，P1-P4 待评审
>
> 日期：2026-09-03
>
> 目标项目：`/Users/coloey/ai-knowledge-agent`
>
> 参考项目：`/Users/coloey/notta_brain_web`，快照 `dev/xiaochun/brain-credit-35@71ea24b54`
>
> 本文定义技术方案、演进顺序与验收边界；P0 的实际落地差异见 1.1。

## 1. 结论

本项目不应直接复制 Notta Brain 的全部页面和商业模块，而应优先吸收其中最有复用价值的三层能力：

1. **对话运行时**：把 SSE、线程、历史、停止、错误与事件归并隐藏在一个高 Depth 的 `ChatRuntime` Module 内。
2. **Agent 能力层**：在现有 RAG 上加入 Tool Registry、模型工具调用循环、可追踪引用和 Artifact 任务。
3. **产品工作台**：补齐会话历史、知识源选择、Prompt Tools、产物中心，再按需要扩展定时任务与第三方集成。

推荐目标主链路为：

```text
POST SSE / Session Detail / Replay
  → StreamProtocol Decoder
  → ChatRuntime Event Reducer
  → Thread + Part + Chunk 归一化 Store
  → SmartBar Renderer Registry
  → Thinking / Message / Tool / Citation / Artifact UI
```

这不是旧式 Virtual DOM Tree。参考当前 Notta Brain 的真实实现，本项目采用更直接的“外层 Part + 内层扁平 Chunk”View Model，以稳定 ID 原位更新节点。

### 1.1 P0 实现结果（2026-09-04）

P0 已按 Protocol → Reducer → Backend Journal → ChatRuntime/SmartBar 顺序完成：

- `@agent/protocol` 是前后端唯一 V2 contract；V1 直接拒绝。
- `@agent/domain` 提供归一化 Thread/Part/Chunk 和纯 Reducer。
- `SessionEventJournal` 先持久化再发布 SSE，并通过 Drizzle 迁移现有事件。
- `@agent/chat-runtime` 统一实时流、Session Detail、停止、错误和多线程状态。
- `@agent/smart-bar` 只使用 commands/selectors 渲染，不再解析 wire event。

落地时做了两项收敛：`ChatTransport` 同时承载 stream/detail/interrupt，P0 暂不增加只有一个实现的
`SessionRepository`；`task_completed.content.terminal_reason` 被设为必填，确保 `completed / failed /
interrupted` 在实时与回放后语义一致。历史页面、游标分页和透明断线 replay 仍属于 P1。

## 2. 范围和取舍

### 2.1 本方案要解决

- 实时 SSE、刷新后的 Session Detail、断线续播使用同一套渲染语义。
- `thinking / data / tool_use / tool_result / citation / result / error` 被转换为稳定、可测试的 Part/Chunk 状态机。
- 切换会话后，后台流仍更新正确 Thread，不污染当前页面。
- 停止操作立即结束本地 loading，同时尽力通知服务端中止推理。
- 在当前知识库 RAG 上逐步增加知识源选择、工具调用、产物生成和任务自动化。
- 新增工具或渲染卡片时，不需要修改消息列表、连接管理和线程状态主流程。

### 2.2 暂不复制

- Brain Credit、订阅、Billing 等商业化能力。
- Meeting Remote、H5、免登录、Module Federation 等多宿主分发形态。
- Notta Brain 中与客服路由、邮件草稿等特定业务绑定的 Part。
- 文件系统写入、Shell 等高风险 Agent 工具。
- 旧 `VirtualDOMTree` 及其兼容逻辑。

这些能力与当前“个人/团队知识 Agent”核心价值距离较远，会明显扩大权限、部署和维护成本。后续若出现明确业务需求，再通过已有 Seam 接入。

## 3. 当前项目基线

### 3.1 已有能力

| 能力域 | 当前实现 | 判断 |
| --- | --- | --- |
| 用户与 Workspace | 注册、登录、Access JWT、一次性 Refresh Token 轮换、Workspace 成员校验 | 后端基础完整，前端令牌续期与安全存储仍需完善 |
| Library | PDF/DOCX/PPTX/TXT/Markdown 上传、列表、详情、删除、解析状态 | 已有可用骨架，缺少搜索、重命名、目录、预览和选择性检索 |
| 文档处理 | Outbox → BullMQ → Tika → 切块 → Embedding → pgvector | 架构正确，可作为后续知识源能力底座 |
| AI 问答 | pgvector Top-K 检索、OpenAI-compatible 流式输出、本地 fallback | 当前是单轮 RAG 生成，不是工具驱动 Agent Loop |
| SSE | `meta_info / thinking / citation / data / result / task_completed / error` | 能跑通基础流，但协议身份、版本和终态语义不足 |
| 会话持久化 | Session、Question、Answer、Answer Events、History、Detail、Rating | 后端已有数据基础，前端没有会话历史和离线物化运行时 |
| 中断 | Redis/进程内中断标记、AbortSignal | 服务端具备基础能力；前端当前等待 interrupt 返回后才 abort |
| Web UI | Chat、Library、Settings 三个视图 | `App.tsx` 和 SmartBar 承担过多职责，缺少路由与 feature 边界 |

当前架构决策应继续保留：模块化 NestJS 单体、PostgreSQL + pgvector、BullMQ + Transactional Outbox、Tika 隔离和 Drizzle 显式迁移。扩展应在现有模块边界内进行，不引入微服务拆分。

### 3.2 关键结构性缺口

1. `@agent/domain` 只有单个 `activeThread.parts[]`，无法表达多 Thread、后台流、分页和恢复。
2. SmartBar 组件直接创建请求、解析 SSE、更新 Store 和渲染 UI，传输协议已经侵入展示层。
3. 当前 SSE parser 未完整处理 CRLF、多行 `data:`、comment、未知 event、断帧和重复 event。
4. 事件 envelope 只有 `type/session_id/content`，缺少 `schema_version/request_id/question_id/answer_id/event_id/seq/timestamp`。
5. `thinking` 被逐条追加，`tool_use/tool_result` 尚无统一模型，也没有按稳定 ID 原位更新。
6. Session Detail 有后端接口，但前端没有将持久化 Answer Events 转换为同一 View Model。
7. LLM Service 只做文本生成，没有工具选择、参数校验、执行、结果回灌和最大步数控制。
8. Library 检索默认面向整个 Workspace，用户无法限定文件或理解引用与原文的关系。

## 4. 设计原则

### 4.1 Deep Module 优先

`ChatRuntime` 是本次最重要的 Module。它的 Interface 只暴露聊天用例和只读 View Model；SSE parser、重连、事件归并、Store、历史转换、错误映射均属于 Implementation。

UI 不应看到以下概念：

- 原始 SSE event；
- AbortController；
- HTTP 重试和 replay API；
- 服务端 Answer 状态映射；
- tool 参数 delta 拼接；
- citation 延迟匹配。

### 4.2 只在有真实替代实现时创建 Seam

| Seam | 生产 Adapter | 测试/替代 Adapter | 必要性 |
| --- | --- | --- | --- |
| `StreamTransport` | Fetch POST SSE | Fixture/InMemory stream | 需要确定性测试断流、乱序、重复和错误 |
| `SessionRepository` | HTTP API | InMemory repository | 需要测试历史分页、离线物化和 replay |
| `ModelPort` | OpenAI-compatible provider | Deterministic local model | 当前已存在真实 provider 与 local fallback |
| `AgentTool` | Library search/read 等工具 | Fake tool | 需要测试 Agent Loop 与失败策略 |
| `ObjectStoragePort` | S3/本地实现 | InMemory storage | 当前 Storage Module 已具备替代需求 |

不为普通 helper、格式化函数或单一数据库查询额外创建 Interface，避免浅层抽象。

### 4.3 单一协议、两种物化路径

实时链路与历史链路可以有不同 Adapter，但必须进入同一个 Reducer：

```text
Realtime: FetchSseAdapter → decode events ┐
                                         ├→ reduceEvent(state, event) → View Model
History:  SessionRepository → read events┘
```

由此把 Reducer Interface 作为核心测试面：同一套事件夹具经实时分片和历史批量输入后，必须得到语义等价的状态。

## 5. 目标架构

```text
┌──────────────────────────── Web Application ────────────────────────────┐
│ Route Features: Chat / History / Library / Prompt Tools / Artifacts     │
│                         │ commands + selectors                          │
│                    @agent/smart-bar                                     │
│                PartRenderer / ChunkRenderer Registry                    │
│                         │ read-only View Model                          │
│                    @agent/chat-runtime                                  │
│  Controller │ Thread Store │ Event Reducer │ History Materializer       │
│                         │                                               │
│             StreamTransport        SessionRepository                    │
└───────────────────────┬───────────────────────┬─────────────────────────┘
                        │ SSE/API               │ Detail/History/Replay
┌───────────────────────▼───────────────────────▼─────────────────────────┐
│                    NestJS Modular Monolith                              │
│  Session Application │ Event Journal │ Agent Run │ Tool Registry        │
│          │                  │              │           │                │
│   PostgreSQL/Drizzle   SSE Presenter   ModelPort   Library/Artifact Tool │
│                                             │           │               │
│                                      LLM Provider   BullMQ/Outbox        │
└─────────────────────────────────────────────────────────────────────────┘
```

建议新增或重构后的代码边界：

```text
packages/
  protocol/                 # 前后端共享的 versioned event contract
  domain/                   # Thread/Part/Chunk 纯领域类型与 reducer
  chat-runtime/             # 用例、连接、历史、错误和多线程状态
  smart-bar/                # 纯交互与渲染，不解析 wire event
  ui/                       # 无业务语义的基础组件

apps/web/src/features/
  auth/
  chat/
  chat-history/
  library/
  prompt-tools/
  artifacts/
  settings/

apps/backend/src/
  sessions/                 # 命令、查询、事件日志、SSE presenter
  agent/                    # Agent orchestrator、model port、tool registry
  tools/                    # 内建工具 Adapter
  artifacts/                # 产物元数据、任务、下载授权
```

`packages/domain` 可原地演进；不要为了目录整齐一次性迁移所有 import。建议先把纯模型和 Reducer 做深，再提取 `protocol/chat-runtime`。

## 6. 统一领域模型

### 6.1 Thread 与 Part

```ts
type ThreadStatus = 'idle' | 'connecting' | 'streaming' | 'stopping' | 'completed' | 'error';

interface ThreadView {
  id: string;
  title: string;
  partIds: string[];
  status: ThreadStatus;
  pageInfo: { hasPreviousPage: boolean; cursor?: string };
  activeRunId?: string;
  error?: RuntimeError;
}

type ChatPart =
  | UserMessagePart
  | AssistantAnswerPart
  | SystemNoticePart;

interface AssistantAnswerPart {
  id: string;                  // answer_id
  type: 'assistant_answer';
  questionId: string;
  runId: string;
  status: ChunkStatus;
  chunkIds: string[];
  artifactIds: string[];
  finalMessageChunkId?: string;
  rating?: 'up' | 'down';
}
```

Store 使用归一化实体：

```ts
interface ChatState {
  currentThreadId?: string;
  threads: Record<string, ThreadView>;
  parts: Record<string, ChatPart>;
  chunks: Record<string, ChatChunk>;
  artifacts: Record<string, ArtifactView>;
}
```

`partIds/chunkIds` 决定稳定顺序，实体 Map 支持原位 upsert。这样后台 Thread 的更新不会重建当前消息列表。

### 6.2 Chunk

```ts
type ChunkStatus = 'streaming' | 'completed' | 'stopped' | 'error';

type ChatChunk =
  | ThinkingChunk
  | MessageChunk
  | ToolChunk;

interface ThinkingChunk {
  id: string;
  type: 'thinking';
  status: ChunkStatus;
  text: string;
  startedAt: string;
  completedAt?: string;
}

interface MessageChunk {
  id: string;
  type: 'message';
  status: ChunkStatus;
  markdown: string;
  references: CitationRef[];
  isFinal: boolean;
}

interface ToolChunk {
  id: string;                  // tool_use_id
  type: 'tool';
  status: ChunkStatus;
  toolName: string;
  publicInput?: unknown;
  result?: ToolResultView;
}
```

`citation` 是 Message 的渐进增强数据，不单独占用时间线 Part；`error` 是 Thread/Part/Chunk 的状态与错误元数据，不额外制造一个重复消息节点。

### 6.3 状态约束

- 同一 Thread 同时最多一个前台 run；不同 Thread 可并行。
- 同一 `answer_id` 对应一个 Assistant Part。
- 同一 `tool_use_id` 对应一个 Tool Chunk；参数 delta 与结果只更新该 Chunk。
- `result` 完成答案内容，`task_completed` 完成 run/连接生命周期；两者允许异常缺失时互相兜底，但语义不混用。
- 终态 `completed/stopped/error` 不得回退为 `streaming`。
- 重复 `event_id` 必须幂等忽略；`seq` 倒退或缺口需要记录诊断指标。

## 7. Versioned Stream Protocol

### 7.1 Envelope

V2 直接替换当前 wire contract。事件可沿用已经清晰的业务名称，但所有事件统一增加 `schema_version: 2` 和稳定身份：

```ts
interface AgentEventEnvelope<TType, TContent> {
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
```

协议事件：

| Event | 必需字段 | Reducer 行为 |
| --- | --- | --- |
| `task_started` | 正式 question/answer/run identity | 将本地 pending question 原子绑定到服务端 ID |
| `thinking` | `chunk_id`, `text` | 创建或追加 Thinking Chunk |
| `data` | `chunk_id`, `text` | 创建或追加 Message Chunk |
| `current_tool_use` | `tool_use_id`, `name`, `input?` | upsert Tool Chunk |
| `tool_result` | `tool_use_id`, `result?`, `is_error?` | 原位完成 Tool Chunk |
| `citation` | `message_chunk_id`, citation metadata | 合并到目标 Message references |
| `artifact` | `artifact?` 或 `artifacts?`（至少一个） | upsert Artifact metadata；二进制不进入 SSE |
| `result` | `final_message_chunk_id`, `text`, `artifacts?` | 完成所有活跃 Chunk 和 Answer Part |
| `error` | `message`, `error_code?` | 用安全文案将活跃状态收敛到 error |
| `task_completed` | `terminal_reason`, `message?` | 按 completed/failed/interrupted 关闭 run |
| `heartbeat` | `at?` | 仅更新连接活性，不进入 UI |

### 7.2 直接切换策略

已确认当前项目没有外部消费者，也没有已部署的旧前端，因此采用前后端原子切换 V2：

- 前端 Decoder 只接受 V2，不实现 V1 wire Adapter。
- 后端直接发送 V2 envelope，不保留双协议分支和 feature flag。
- 前后端共同依赖 `packages/protocol`，协议不一致在编译或 contract test 阶段失败。
- 当前 V1 SSE contract tests 直接替换为 V2 tests，不长期维护两套 fixture。
- 如果开发数据库已有 V1 `chat_answer_events`，通过一次性迁移脚本转换；不可转换的数据在开发环境显式清理，不把历史兼容带进 ChatRuntime。
- 新建 ADR-0007 明确该决策覆盖 ADR-0006 中针对迁移阶段的 SmartBar SSE 兼容约束；ADR-0006 的路由归属结论继续有效。

部署上要求 Web 与 Backend 作为同一 release unit 发布。若部署平台无法保证原子发布，则先停写/维护窗口发布 Backend 与 Web，而不是重新引入长期双协议。

### 7.3 SSE Transport 可靠性

P0 已实现的 `FetchSseTransport` 支持：

- `\n\n` 与 `\r\n\r\n`；
- 多行 `data:` 合并；
- `id/event/retry/comment` 字段；
- UTF-8 跨 chunk 解码；
- malformed V2 event 转为对应 Thread 的 transport error，不让异常穿透展示组件；
- `Content-Type` 校验和非 SSE 错误 envelope；
- Abort 后丢弃迟到数据；
- 重复 event 幂等忽略和 seq 缺口诊断。

P0 不自动续接正在执行的 run；通过 Session Detail 恢复已持久化状态，重复 `request_id` 由后端读取 Event
Journal 重放。待协议支持明确的 cursor/lease 后，再在 P1 增加透明断线续播。

## 8. 前端方案

### 8.1 ChatRuntime Interface

页面和 SmartBar 只调用：

```ts
interface ChatRuntimeCommands {
  openThread(threadId: string): void;
  send(message: string, threadId?: string): Promise<void>;
  stop(threadId?: string): void;
  loadThreadDetail(sessionId: string): Promise<void>;
}
```

React 侧提供 `ChatRuntimeProvider`、`useChatCommands()`、`useCurrentThread()`、`useOrderedParts(threadId)` 和
`useOrderedChunks(partId)`。P1 的 create/retry/pagination/rate 用例出现时再扩展 Commands；不暴露内部 Store。

### 8.2 Runtime 内部职责

| 内部组件 | 职责 |
| --- | --- |
| `ChatRuntime` | 编排 send/open/stop/loadThreadDetail 用例 |
| `generations` | 按 threadId 保存连接与 AbortController，阻止同 Thread 重复 run |
| `EventReducer` | 唯一的 event → state 映射入口 |
| `decodeSessionDetail` | 校验 identity/status/seq 后将持久化 events 输入同一个 Reducer |
| `ChatState` | 归一化 Thread/Part/Chunk/Artifact 状态 |
| `recordTransportError` | transport/client 异常转当前 Thread 的安全错误状态 |
| `startRun` | 本地 question ID 到服务端 question ID 的原子替换 |

### 8.3 停止语义

用户点击停止时按以下顺序执行：

1. 本地同步把 Stream Registry 标记 soft-closed，并 `abort()`。
2. Reducer 将当前 Answer 与所有 streaming Chunk 标记为 `stopped`。
3. UI 在 100 ms 内停止 loading，保留已生成内容。
4. 后台调用 interrupt API，设置 2 秒超时；失败只记录日志，不回滚 UI。
5. 服务端晚到事件因 run 已 soft-closed 被丢弃。

停止不能依赖 interrupt API 成功。这一规则同时规避了 Notta Brain 当前实现中已识别的 stop 等待风险。

### 8.4 历史和回放

进入 Thread：

```text
GET/POST session/detail
  → 验证 event envelope
  → 按 answer 分组、按 seq 排序
  → 对每个 answer 初始化空 Part
  → EventReducer 批量 reduce
  → 一次提交 RuntimeStore
```

若最后一个 Answer 是 `pending/processing`：

- 请求 `session/replay`，携带 `session_id/run_id/after_seq`；
- 服务端从 Event Journal 补发缺失事件，并继续订阅活跃 run；
- 前端继续使用同一 Decoder/Reducer；
- 若服务端已失去活跃 run，则发送可重试的 `RUN_LOST` terminal error。

历史分页以 QA 游标为边界，不允许一次性加载完整大 Session。前插旧消息时保存滚动锚点，避免列表跳动。

### 8.5 SmartBar 渲染

`@agent/smart-bar` 只负责：

- Composer 和知识源选择；
- Thread/Part/Chunk 渲染；
- 停止、重试、复制、评分等用户操作；
- 通用工具卡与特定 Tool Renderer 注册；
- 引用抽屉和 Artifact 卡片。

```ts
interface ToolRendererAdapter {
  canRender(toolName: string): boolean;
  render(chunk: ToolChunk): ReactNode;
}
```

无专用 Adapter 的工具使用通用卡片，不阻断答案。HTML Artifact 必须放在 sandboxed iframe，配置独立 CSP，禁止继承主站权限。

## 9. 后端方案

### 9.1 Session Application Module

沿用当前 `/notta-brain/session/*` 路由路径，避免混入无关的 API 重命名；同时把 `SessionsService` 拆成三个更深的内部 Module：

| Module | Interface | 隐藏的 Implementation |
| --- | --- | --- |
| `SessionCommandService` | send/interrupt/rate | 权限、幂等、事务、run 状态 |
| `SessionQueryService` | history/detail/replay | 分页、event 读取、DTO 转换 |
| `SessionEventJournal` | append/read/markTerminal | seq 分配、幂等、DB 事务、清理策略 |

Controller 只做 DTO 校验、认证和 HTTP/SSE presentation，不承载业务状态机。

### 9.2 Agent Run Module

```ts
interface AgentOrchestrator {
  run(input: AgentRunInput, sink: AgentEventSink, signal: AbortSignal): Promise<AgentRunResult>;
}

interface AgentEventSink {
  emit(event: AgentDomainEvent): Promise<void>;
}
```

`AgentOrchestrator` 隐藏以下流程：

```text
build context
  → model decision
  → optional tool call
  → validate tool input
  → execute tool
  → append safe result to model context
  → repeat (bounded)
  → final answer
```

必须配置：最大步骤数、每个工具 timeout、单轮总 timeout、上下文 token budget、最大工具结果大小和 AbortSignal。Tool Loop 默认顺序执行，确认真实并行收益后再开放并行调用。

### 9.3 Tool Registry

```ts
interface AgentTool<TInput, TOutput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  authorize(context: ToolContext): Promise<void>;
  execute(input: TInput, context: ToolContext, signal: AbortSignal): Promise<TOutput>;
  toPublicResult(output: TOutput): ToolResultView;
  toModelResult(output: TOutput): unknown;
}
```

首批工具：

1. `search_library`：按 workspace、selected file IDs、query、topK 检索。
2. `read_document_chunks`：根据已授权 citation/chunk ID 读取上下文。
3. `list_library_files`：供模型理解用户可用知识源，但限制返回数量。

第二批工具：

- `web_search`：需要单独 provider 与引用规范；
- `create_document`、`create_presentation`：只创建 Artifact Job，不直接生成大文件；
- 第三方 Drive/Calendar 等 integration tools。

工具必须经过 Workspace 授权，模型传入的 `workspace_id/file_id` 不可信。日志和 SSE 只发送 `toPublicResult`，密钥、内部 URL、完整原文和敏感参数不得进入前端。

### 9.4 Event Journal 与 SSE Presenter

Agent domain event 先写 Event Journal，再由 SSE Presenter 发送：

```text
AgentOrchestrator
  → journal.append(domain event)  [source of truth]
  → presenter.write(SSE envelope)
```

建议采用“持久化成功后再发送”。这会增加一次数据库写延迟，但确保 Session Detail/Replay 不会缺少用户已经看到的事件。文本 delta 可按 30–80 ms 或字符阈值合并批量写，避免逐 token 写库。

Event Journal 需要：

- `(answer_id, seq)` 唯一约束；
- `event_id` 唯一约束；
- 单 Answer 单 writer，或事务内原子分配 seq；
- terminal event 幂等；
- content JSON schema version；
- 可按 answer/session 顺序读取；
- 对流式正文做批量持久化，不丢最终聚合文本。

### 9.5 Replay

新增 Replay 路由：

```http
POST /notta-brain/session/sse-replay
Content-Type: application/json

{
  "workspace_id": "...",
  "session_id": "...",
  "run_id": "...",
  "after_seq": 17
}
```

行为：

1. 校验 Workspace 成员与 Session 归属。
2. 从 Event Journal 补发 `seq > after_seq` 的事件。
3. 若 run 仍活跃，订阅后续事件；先建立订阅水位，再补历史，避免交界处漏事件。
4. 若 run 已终止，补发 terminal event 后关闭。
5. 若 run 丢失且无 terminal event，写入并返回 `RUN_LOST` error。

第一版若实现“历史补发 + 轮询活跃状态”更简单，也可以先上线；但对外 Interface 保持上述语义。

## 10. 数据模型演进

### 10.1 第一阶段迁移

在现有 `chat_answer_events` 上增量增加：

| 字段 | 用途 |
| --- | --- |
| `event_id` | 全局幂等键 |
| `schema_version` | event content 版本 |
| `run_id` | 一次执行身份 |
| `request_id` | 客户端幂等请求身份 |
| `created_at` | 回放和诊断时间 |

现有 `answer_id/type/content_json/seq` 保留。Question、Session、Workspace 可通过 Answer 关联，避免每个事件重复存所有外键；SSE envelope 在读取时补齐。

`chat_answers` 增加或规范：

- `run_id`；
- `status: pending | processing | finished | failed | interrupted`；
- `last_event_seq`；
- `terminal_reason`；
- `started_at/completed_at`。

### 10.2 后续表

Artifact 阶段：

```text
artifacts
  id, workspace_id, session_id, answer_id, type, title,
  status, storage_key, mime_type, size, version, metadata_json

artifact_jobs
  id, artifact_id, status, progress, error_code, created_at, updated_at
```

自动化阶段：

```text
scheduled_tasks
scheduled_task_runs
integration_connections
```

所有变更通过 reviewed Drizzle SQL migration，保持 ADR-0002，不使用生产 schema push。

## 11. API 演进

### 11.1 P0 保留并增强

- `POST /notta-brain/session/send-message`
- `POST /notta-brain/session/interrupt`
- `POST /notta-brain/session/detail`
- `POST /notta-brain/session/history`
- `POST /notta-brain/session/rate`
- `POST /notta-brain/session/sse-replay`（新增）

`send-message` 请求增加可选字段：

```ts
interface SendMessageOptions {
  selected_file_ids?: string[];
  web_search?: boolean;
  prompt_tool_id?: string;
  output_artifact?: 'document' | 'presentation' | 'image';
}
```

### 11.2 Library

优先补充：

- `PATCH /library/files/:fileId`：重命名；
- `GET /library/files?query=&status=&cursor=`：搜索和分页；
- `POST /library/search`：带 selected file IDs 的语义检索预览；
- 文档预览使用短期签名 URL 或服务端代理，禁止公开原始 storage key。

文件夹只在用户确有规模需求时加入；当前可先用标签/搜索和多选降低复杂度。

## 12. 产品能力落地顺序

| 阶段 | 能力 | 主要交付物 | 退出标准 |
| --- | --- | --- | --- |
| P0 运行时地基（已完成） | Versioned protocol、ChatRuntime、多 Thread、Part/Chunk、稳定 stop/error | protocol、domain reducer、runtime、SmartBar 解耦、event journal | 已通过实时/历史等价、立即 stop、线程隔离及全仓验证 |
| P1 会话与知识体验 | History、Detail 分页、Replay、知识源多选、引用抽屉、Library 搜索/重命名 | History page、source picker、citation UI、replay API | 刷新恢复一致；引用能定位文件/页；断流后不重复生成 |
| P2 Agent 工具 | Tool Registry、Agent Loop、Library tools、通用 Tool Card、Prompt Tools | orchestrator、3 个内建工具、prompt catalog | 工具 use/result 可追踪；超时/取消/失败可恢复；未知工具不阻断答案 |
| P3 Artifact | 文档/PPT/图片任务、进度、预览、下载、Artifact Center | artifact tables、worker jobs、renderer | 大文件不进 SSE；权限正确；失败可重试；历史可恢复 |
| P4 自动化与集成 | Scheduled Tasks、Web Search、Drive/Calendar 等 | scheduler、integration adapters、run history | 授权隔离、幂等执行、审计与撤销完整 |

不建议并行启动 P2/P3/P4。它们都依赖 P0 的身份、事件、终态和历史语义；先做功能会把协议债务扩散到每个页面。

## 13. 安全设计

- Access Token 只短时存内存；Refresh Token 优先迁移到 `HttpOnly + Secure + SameSite` Cookie。若暂时保留 localStorage，必须记录为已知风险并限制 CSP/XSS 面。
- 所有 Session、File、Chunk、Artifact、Tool 调用都在服务端重新校验 Workspace membership。
- Tool 输入使用 JSON Schema 严格校验并限制大小；输出分别生成 model-safe 与 UI-safe 视图。
- Web 页面、文档与工具内容均视为不可信，防止 prompt injection；不能让文档文本提升工具权限。
- Markdown 禁止危险 HTML；外链增加安全属性；HTML Artifact 使用 sandbox iframe 与独立 origin/CSP。
- 日志不记录 token、完整 prompt、完整文档原文、签名 URL 和敏感 tool 参数。
- 第三方 Integration Token 加密存储并支持撤销；P4 前不预埋空泛 Connector abstraction。

## 14. 可观测性

统一上下文字段：

```text
request_id / run_id / workspace_id / session_id /
question_id / answer_id / event_id / event_type / seq / failure_phase
```

核心指标：

- 首事件耗时、首正文耗时、完整回答耗时；
- stream completion/stop/error/replay success rate；
- malformed/unknown/duplicate/out-of-order event 数；
- history materialization failure 和 live/history diff 数；
- tool success/timeout/authorization failure；
- retrieval 无结果率、引用点击率；
- artifact 排队、生成、失败耗时。

现有 `analytics_events` 可承接产品事件；运行时指标与结构化日志应进入独立 observability 管道，避免把高频 token delta 写为产品埋点。

## 15. 测试方案

### 15.1 核心测试面

| 层级 | 测试 |
| --- | --- |
| Protocol | CRLF、多行 data、UTF-8 断帧、malformed、V2 schema validation、duplicate seq |
| Domain Reducer | 每个事件的状态迁移、终态不可回退、tool/citation 关联、未知事件 |
| Differential | 同一 fixture 分片实时输入与批量历史输入得到等价 View Model |
| Runtime | 多 Thread 并行、切换、stop、late event、transport error、retry |
| Backend Unit | Agent Loop 步数、tool timeout、AbortSignal、error mapping |
| DB Integration | journal seq/idempotency、terminal transaction、分页/replay 水位 |
| API Contract | V2 envelope、鉴权、Session ownership、未知版本拒绝策略 |
| Browser E2E | 发送→思考→工具→回答→引用；刷新；历史分页；中断；断网恢复 |

### 15.2 Golden Fixtures

至少维护这些事件序列：

1. 纯文本成功。
2. thinking → data → result。
3. thinking → tool_use 多 delta → tool_result → data。
4. citation 晚于正文到达。
5. stop 后收到迟到 data/result。
6. transport error 没有业务 error event。
7. task_completed 先于或缺失 result。
8. duplicate event、seq gap、孤立 tool_result。
9. pending Session Detail + replay。
10. Artifact processing → completed/failed。

`EventReducer` 的 fixture 测试应成为新工具和新事件上线的门禁。

## 16. 迁移步骤

### Step 1：冻结 V2 语义，补测试

- 用 V2 contract tests 替换当前 V1 SSE tests，并补充 Session replay contract。
- 建立 P0 golden fixtures。
- 新建协议 ADR，明确 `result`、`task_completed`、stop 与 replay 语义。

### Step 2：引入 V2 Protocol 与 Reducer

- 新增共享 protocol types/decoder。
- 在 `packages/domain` 建立 Thread/Part/Chunk 归一化模型与纯 Reducer。
- 先让现有 UI 消费 V2 Reducer 输出，暂不调整视觉样式。

### Step 3：形成 ChatRuntime

- 将请求、SSE、Abort、线程注册、错误映射从 SmartBar 移入 Runtime。
- SmartBar 改为 commands + selectors。
- 同步实现立即本地 stop 和多 Thread 状态。

### Step 4：后端 Event Journal V2

- 数据库增量迁移。
- SessionsService 内部分离 command/query/journal/orchestrator。
- 服务端直接发送 V2 envelope；Web 与 Backend 同一发布单元切换。

### Step 5：History/Detail/Replay

- Web 增加路由和历史页面。
- Detail 改为游标分页并通过 Reducer 离线物化。
- 增加 replay，完成刷新与断线恢复闭环。

### Step 6：按 P1→P4 扩展

- 先做知识源和引用，再做工具，再做 Artifact，最后做自动化与集成。
- 每个新增工具仅增加 Tool Adapter/Renderer 和 fixture，不修改 Runtime 主流程。

## 17. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 同时改协议、Store、UI，范围过大 | 难回滚、难定位回归 | 在同一分支中按 Protocol→Reducer→Backend→Runtime→UI 顺序提交，每步都有 contract test |
| Event Journal 高频写入 | DB 放大 | 合并文本 delta；关键状态立即写，正文按时间/大小批量写 |
| replay 交界漏事件 | 历史与实时不连续 | 订阅水位 + after_seq；event_id/seq 幂等 |
| 工具输出过大或含敏感内容 | 泄漏、上下文爆炸 | public/model 双视图、大小限制、摘要与对象存储 |
| Agent Loop 无限执行 | 成本和稳定性风险 | 最大步数、总 timeout、每工具 timeout、预算与取消 |
| 前端一次性重构 | 开发停滞 | 保持现有 UI，先替换内部运行时，再拆 feature routes |
| 盲目照搬 Notta Brain | 复杂度超过项目目标 | 用 P0–P4 价值顺序评审，每阶段独立退出标准 |

## 18. 建议新增 ADR

- ADR-0007：Versioned Agent Event Protocol。
- ADR-0008：Unified Chat Runtime and Part/Chunk Model。
- ADR-0009：Persist-before-publish Session Event Journal。
- ADR-0010：Bounded Agent Tool Loop and Tool Security Boundary。
- ADR-0011：Artifact Jobs via BullMQ and Object Storage。

## 19. 评审需要确认的决策

技术评审建议只聚焦以下五项，确认后即可拆实施计划：

1. P0 是否接受“外层 Part + 内层扁平 Chunk”，明确不使用 Virtual DOM Tree。
2. 是否接受 Event Journal 作为实时与历史共同 source of truth，并采用 persist-before-publish。
3. **已确认：无外部消费者、无已部署旧前端，前后端直接切换 V2，不保留 V1 wire compatibility。**
4. P1 是否优先“会话历史 + 知识源选择”，再开始 Tool Loop。
5. 首批 Agent 工具是否限定为只读 Library 工具，Artifact 写操作放到 P3。

第 3 项已经定案，其余四项默认推荐答案均为“是”。这条路径能先解决目前最影响扩展性的运行时缺口，并让后续工具、引用、Artifact 和自动化保持局部修改。

## 20. 参考证据

- 当前项目架构：[README.md](/Users/coloey/ai-knowledge-agent/README.md)、[ADR-0001](/Users/coloey/ai-knowledge-agent/docs/adr/0001-modular-monolith.md)、[ADR-0002](/Users/coloey/ai-knowledge-agent/docs/adr/0002-drizzle-pgvector.md)、[ADR-0003](/Users/coloey/ai-knowledge-agent/docs/adr/0003-bullmq-outbox.md)、[ADR-0006](/Users/coloey/ai-knowledge-agent/docs/adr/0006-strangler-migration.md)
- 当前前端状态：[domain store](/Users/coloey/ai-knowledge-agent/packages/domain/src/index.ts)、[SmartBar](/Users/coloey/ai-knowledge-agent/packages/smart-bar/src/index.tsx)、[Web App](/Users/coloey/ai-knowledge-agent/apps/web/src/App.tsx)
- 当前后端状态：[Sessions controller](/Users/coloey/ai-knowledge-agent/apps/backend/src/sessions/sessions.controller.ts)、[Sessions service](/Users/coloey/ai-knowledge-agent/apps/backend/src/sessions/sessions.service.ts)、[SSE contract](/Users/coloey/ai-knowledge-agent/apps/backend/src/sessions/sse.ts)、[Database schema](/Users/coloey/ai-knowledge-agent/apps/backend/src/database/schema.ts)
- Notta Brain 逆向调研：[streaming runtime research](/Users/coloey/ai-knowledge-agent/docs/research/notta-brain-streaming-runtime-research.md)、[runtime PRD](/Users/coloey/ai-knowledge-agent/docs/research/notta-brain-streaming-runtime-prd.md)

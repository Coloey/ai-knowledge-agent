# Artifact 生成、预览与下载技术方案

> 状态：已批准，实施中
>
> 日期：2026-09-07
>
> 目标项目：`/Users/coloey/ai-knowledge-agent`
>
> 对照项目：`/Users/coloey/notta_brain_web`，快照 `dev/xiaochun/brain-credit-35@71ea24b54a51`
>
> 上位方案：[AI Knowledge Agent 能力扩展技术方案](/Users/coloey/ai-knowledge-agent/docs/technical-design/notta-brain-capability-expansion.md)
>
> 源码研究：[Notta Brain Artifact 全链路源码研究](/Users/coloey/ai-knowledge-agent/docs/research/notta-brain-artifact-runtime-research.md)

## 1. 结论

下一阶段建议交付一个 Artifact 垂直切片，而不是一次复制 Notta Brain 的 PPT、图片、Word、Excel、HTML
五套能力：

1. 后端根据最终回答真正生成一个 Markdown Report Artifact；
2. Artifact 经 PostgreSQL、Transactional Outbox、BullMQ Worker 和对象存储持久化；
3. `result.artifacts` 只把稳定 Artifact 引用挂到当前 Answer；
4. Artifact 的异步状态进入 Query Cache，不进入 React Context，也不继续污染已结束的 Chat Runtime；
5. SmartBar 显示 `queued / processing / completed / failed` 卡片，支持安全预览、下载和失败重试；
6. Session Detail 仍通过同一批 V2 events 恢复 Artifact 引用，再按 Artifact ID 获取最新资源状态。

首版只支持：

```text
kind: document
format: markdown
mime_type: text/markdown
```

后续在同一 Artifact Module 内增加 DOCX、PPTX、XLSX、Image；HTML 最后实现，因为它需要独立的
sandbox、CSP、版本与发布模型。

## 2. 范围与非目标

### 2.1 本阶段解决

- 后端实际生成并保存 Artifact，而不是只接收前端伪造元数据；
- Answer 与 Artifact 的稳定关联；
- 异步任务状态、幂等、失败重试；
- SmartBar Artifact 卡片、文本预览和下载；
- 登录用户、Workspace、Session、Answer、Artifact 的权限闭环；
- 实时回答和 Session Detail 回放后得到相同 Artifact 入口；
- 本地文件存储和 S3-compatible 存储使用同一个下载 Interface。

### 2.2 本阶段不做

- 不迁移现有 Workspace、文件列表和文件解析轮询到 Query Cache；
- 不实现完整 Agent Tool Loop；首版用显式 `output_artifact` 请求触发；
- 不实现 Artifact Center、跨会话搜索和批量管理；
- 不实现在线编辑、协同编辑、版本回滚和发布；
- 不实现 HTML Artifact；
- 不把文件二进制、base64 或长期有效下载 URL 放入 SSE/Event Journal；
- 不照搬 Brain 中与 Credit、埋点、Feature Gate、Meeting Host 绑定的行为。

## 3. Notta Brain 对照结论

### 3.1 值得复用的模式

Notta Brain 使用判别联合表达 PPT、Image、Word、Excel、HTML，并为共同字段保留 Artifact
身份、标题、Session 和存储路径；HTML 额外包含 template、working version、deployment 和 preview/published
信息：[Artifact 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:273)。

实时流在 `result` 到达时从 `extra_data.artifacts` 提取产物，再随 Answer 完成一起写入 Store：
[实时提取](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:213)、
[Result 归并](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:543)。

UI 使用共同卡片外壳，再按 PPT、Image、Word、Excel、HTML 分派预览/下载实现：
[DownloadItem](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:20)、
[ArtifactCard](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/artifact-card/index.tsx:72)。

本项目应复用：

- 判别联合而不是 `type + any`；
- Artifact 在 Answer 完成时出现；
- 通用卡片外壳与按类型分离的预览实现；
- 签名 URL/受权下载，而不是公开存储地址；
- 实时和历史都能还原 Artifact。

### 3.2 不直接复制的实现

| Brain 做法 | 本项目处理 |
| --- | --- |
| 从 `extra_data` 使用 `any` 和类型断言提取 | 在 `@agent/protocol` 做运行时校验，非法 payload 直接拒绝 |
| Answer 内持有完整、持续变化的 Artifact 对象 | ChatRuntime 只持有稳定引用；最新任务状态由 Query Cache 管理 |
| 前端根据存储 path 获取签名 URL | 前端只传 Artifact ID；后端校验 Workspace membership 后返回内容 |
| 一个集中 switch 同时负责多类型下载 | 首版使用通用 Card + Markdown Preview；达到第三种类型时再引入 Renderer Registry |
| HTML 预览与发布能力一起进入主流程 | HTML 延后，单独评审 sandbox、独立 CSP、版本和发布权限 |

## 4. 当前项目基线与缺口

### 4.1 已有底座

- V2 协议已经声明 `artifact` event 和 `result.artifacts`，但 Artifact 只有 `id/name`：
  [protocol](/Users/coloey/ai-knowledge-agent/packages/protocol/src/index.ts:43)。
- Domain Store 已有 `artifacts` 归一化表和 `Thread.artifactIds`：
  [domain model](/Users/coloey/ai-knowledge-agent/packages/domain/src/index.ts:58)。
- Reducer 能消费独立 `artifact` event 和 `result.artifacts`：
  [artifact reducer](/Users/coloey/ai-knowledge-agent/packages/domain/src/index.ts:239)、
  [result reducer](/Users/coloey/ai-knowledge-agent/packages/domain/src/index.ts:595)。
- Event Journal 已保证事件先持久化再发布，并能通过 Session Detail 读取：
  [journal append](/Users/coloey/ai-knowledge-agent/apps/backend/src/sessions/session-event-journal.service.ts:53)、
  [session detail](/Users/coloey/ai-knowledge-agent/apps/backend/src/sessions/sessions.service.ts:291)。
- 后端已有 BullMQ、Transactional Outbox 和本地/S3 对象存储：
  [queue](/Users/coloey/ai-knowledge-agent/apps/backend/src/queue/queue.module.ts:8)、
  [outbox relay](/Users/coloey/ai-knowledge-agent/apps/backend/src/library/outbox-relay.service.ts:10)、
  [object storage](/Users/coloey/ai-knowledge-agent/apps/backend/src/storage/object-storage.service.ts:28)。

### 4.2 实际缺口

1. `Artifact` 没有类型、状态、MIME、大小、时间和失败信息；
2. 数据库没有 Artifact 与 Artifact Job 表；
3. `LlmService` 只返回文本 token，不会触发产物任务；
4. `SessionsService` 的 `result` 没有写入 artifacts；
5. `ObjectStorageService` 只支持用户上传和整块读取，不支持生成文件的版本化 key 与流式响应；
6. ChatRuntime 没有 Artifact selector；
7. SmartBar 没有 Artifact 卡片、状态查询、预览和下载；
8. 当前 Outbox Relay 只认识 Library 事件，直接写入 Artifact event 会被当成 unsupported event。

## 5. 核心设计决策

### 5.1 两种状态分开管理

```text
ChatRuntime Store
  - ArtifactRef 是否属于这个 Answer/Thread
  - 流式事件顺序与历史回放
  - 不轮询，不保存二进制，不维护 Worker 进度

Artifact Query Cache
  - ArtifactDetail 最新状态和进度
  - preview/download 可用性
  - queued/processing 时短周期 refetch
  - completed/failed 后停止 refetch
```

Artifact 任务可能在 `task_completed` 之后才完成。若 Worker 再向已关闭的 Chat Event Journal 追加状态事件，会破坏
当前 `seq`、terminal 和 replay 约束。因此：

- `result.artifacts` 是不可变的 Artifact 引用快照；
- `artifacts` 表是 Artifact 生命周期的 source of truth；
- Worker 完成后只更新 Artifact 资源状态；
- SmartBar 通过 Artifact Query Cache 获取最新状态；
- Session Detail 回放出同一个 Artifact ID 后，也会得到最新状态。

这不违背“流式 Agent 状态继续使用独立 Runtime Store”：Artifact 与 Answer 的关联仍由 Runtime 管理；Worker
任务进度属于普通服务端状态，进入 Query Cache。

### 5.2 首版不使用独立 `artifact` event

首版 Artifact 依赖最终回答正文，因此在正文持久化完成后创建任务，并通过 `result.artifacts` 一次挂载。已有独立
`artifact` event 保留给后续 Tool Loop：当工具在回答中途创建产物时，可提前显示 queued 卡片。

这样首版事件顺序稳定为：

```text
task_started
→ thinking/citation/data...
→ flush all data events
→ create artifact + job + outbox
→ result(text, artifacts: [ArtifactRef])
→ task_completed
→ done
```

### 5.3 首版生成 Markdown Report

首版选择 Markdown，而不是立即生成 PPTX/DOCX：

- 不需要引入 Office renderer 或第三方生成服务；
- 可以确定性地由最终 Answer 文本生成，便于测试；
- 支持真正的对象存储、权限、预览、下载和历史恢复；
- 后续 DOCX/PPTX renderer 可以复用相同任务和交付链路。

用户入口使用现有请求字段：

```ts
options: {
  output_artifact?: 'document';
}
```

UI 首版可在 Composer 增加“生成报告”开关；未设置时保持当前纯问答流程。

## 6. 协议与领域模型

### 6.1 Wire contract

`@agent/protocol` 将当前松散 Artifact 改为可判别、可校验的引用：

```ts
export type ArtifactKind =
  | 'document'
  | 'presentation'
  | 'spreadsheet'
  | 'image'
  | 'html';

export type ArtifactStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

export interface ArtifactRef {
  id: string;
  kind: ArtifactKind;
  title: string;
  status: ArtifactStatus; // result 产生时的快照，通常是 queued
}

export interface ArtifactDetail extends ArtifactRef {
  workspace_id: string;
  session_id: string;
  answer_id: string;
  mime_type?: string;
  size?: number;
  progress: number;
  version: number;
  error_code?: string;
  error_message?: string;
  created_at: number;
  updated_at: number;
}
```

规则：

- SSE/Event Journal 只使用 `ArtifactRef`；
- Artifact HTTP API 返回 `ArtifactDetail`；
- URL、storage key、bucket、内部 job ID 不进入公共 contract；
- Decoder 严格校验 `kind/status/progress`，不使用 `as Artifact` 绕过输入验证；
- `result.artifacts` 按 `id` 幂等 upsert。

### 6.2 Runtime View Model

Domain Store 保留当前归一化结构，但公开名称收敛为：

```ts
interface ChatState {
  artifacts: Record<string, ArtifactRef>;
}

interface AssistantAnswerPart {
  artifactIds: string[];
}

interface Thread {
  artifactIds: string[];
}
```

新增纯 selector：

```ts
selectAnswerArtifacts(state, answerPartId): ArtifactRef[]
selectThreadArtifacts(state, threadId): ArtifactRef[]
```

ChatRuntime 只新增：

```ts
useAnswerArtifacts(answerPartId): ArtifactRef[]
useThreadArtifacts(threadId): ArtifactRef[]
```

`AssistantAnswerPart.artifactIds` 决定卡片渲染在哪一条回答下；`Thread.artifactIds` 是 Header 或未来 Artifact
Center 的聚合索引。两者都按 ID 去重。不在 Context value 中放 Artifact 状态，也不让 SmartBar 读取 Runtime
内部 Map。

## 7. 后端设计

### 7.1 Artifact Module

```text
apps/backend/src/artifacts/
  artifact-api.module.ts
  artifact-worker.module.ts
  artifact.controller.ts
  artifact.application.ts
  artifact.processor.ts
  artifact.renderer.ts
  artifact.dto.ts
  artifact.repository.ts       # 模块内部实现，不作为公共 seam
```

`ArtifactApplication` 是高 Depth Module，对 Sessions 和 Controller 暴露小 Interface：

```ts
interface ArtifactApplication {
  requestFromAnswer(input: {
    workspaceId: string;
    sessionId: string;
    answerId: string;
    kind: 'document';
    title: string;
  }): Promise<ArtifactRef>;

  getAuthorized(userId: string, artifactId: string): Promise<ArtifactDetail>;
  openAuthorized(userId: string, artifactId: string): Promise<ArtifactContent>;
  retryAuthorized(userId: string, artifactId: string): Promise<ArtifactDetail>;
}
```

Module 内隐藏数据库、Outbox、BullMQ job ID、storage key、重试和 MIME 处理。

### 7.2 Renderer seam

Artifact 生成有真实的生产实现和确定性测试实现，因此定义内部 Renderer seam：

```ts
interface ArtifactRenderer {
  render(input: ArtifactRenderInput, signal: AbortSignal): Promise<RenderedArtifact>;
}

interface RenderedArtifact {
  filename: string;
  contentType: string;
  body: NodeJS.ReadableStream;
}
```

首版生产 Adapter 是 `MarkdownReportRenderer`，测试使用 `InMemoryArtifactRenderer`。增加 DOCX/PPTX 时由
Artifact Module 内部按 kind 选择 Adapter，不把 renderer 细节暴露给 Sessions。

Markdown Renderer 从已经持久化的 Answer `data/result` events 重建正文，生成包含标题、生成时间和正文的
UTF-8 Markdown。Outbox payload 只放 `artifactId/jobId/version`，不复制完整回答和文档原文。

### 7.3 数据模型

新增：

```text
artifacts
  id                  varchar PK
  workspace_id        FK workspaces
  session_id          FK chat_sessions
  answer_id           FK chat_answers
  kind                varchar
  title               varchar
  status              queued|processing|completed|failed
  mime_type           varchar nullable
  size                bigint nullable
  storage_key         varchar nullable       # 永不进入 DTO/event/log
  version             integer default 1
  error_code          varchar nullable
  error_message       text default ''
  created_at
  updated_at

artifact_jobs
  id                  varchar PK
  artifact_id         FK artifacts
  version             integer
  status              pending|processing|completed|failed
  progress            integer default 0
  attempts            integer default 0
  error_code          varchar nullable
  error_message       text default ''
  started_at          timestamp nullable
  completed_at        timestamp nullable
  created_at
  updated_at
```

约束：

- `(answer_id, kind, version)` 唯一，保证同一请求重放不会重复创建；
- `(artifact_id, version)` 在 jobs 中唯一；
- progress 限制在 `0..100`；
- completed 必须有 `storage_key/mime_type/size`；
- failed 不删除旧版本文件；retry 增加 version，成功后原子切换 canonical storage key。

当前通用 `jobs` 表没有 Artifact FK、进度和版本幂等语义，而且尚无使用方：
[jobs schema](/Users/coloey/ai-knowledge-agent/apps/backend/src/database/schema.ts:221)。本阶段不强行把它扩展成
万能任务表；使用 `artifact_jobs` 保持 Artifact Module 的 Locality，通用 `jobs` 的去留另行清理。

### 7.4 Outbox 与 Worker

`requestFromAnswer` 在一个数据库事务中：

1. 按唯一键读取或创建 Artifact；
2. 创建 Artifact Job；
3. 创建 `artifact.generation.requested` Outbox event；
4. 返回稳定 `ArtifactRef`。

随后 Sessions 写入 `result.artifacts`。回答正文已经在此前 `flushText()` 持久化，因此 Worker 可以只凭
`answer_id` 重建输入。

当前 Library Outbox Relay 必须扩展或下沉为公共 Queue Outbox Relay，至少分派：

```text
library.file.uploaded          → library-parse queue
library.file.deleted           → library-parse queue
artifact.generation.requested  → artifact-generation queue
```

BullMQ job ID 使用 `artifact:${artifactId}:v${version}`，保证 Relay 重试不产生重复任务。Worker 状态迁移：

```text
queued
→ processing(progress=10)
→ render
→ objectStorage.saveGenerated(versioned key)
→ completed(progress=100, metadata)

任何阶段异常
→ failed(error_code, safe error_message)
```

Worker 失败不得删除上一个已完成版本；未被数据库引用的临时对象通过补偿删除或定期清理。

### 7.5 对象存储

扩展 `ObjectStorageService`，避免用现有 `readBuffer()` 把大文件完整读入内存：

```ts
saveGenerated(input): Promise<{ storageKey; size; contentType }>
openStream(storageKey): Promise<{ body; size?; contentType? }>
```

生成文件 key：

```text
{workspaceId}/artifacts/{artifactId}/v{version}/{safeFilename}
```

本地与 S3 Adapter 都由后端返回流。首版不向前端公开 S3 key，也不要求前端知道实际存储后端。

### 7.6 Sessions 集成

`SessionsService.stream()` 在 `flushText()` 后执行：

```ts
const artifacts = input.options.output_artifact === 'document'
  ? [await artifactApplication.requestFromAnswer(...)]
  : [];

await journal.succeed(identity, {
  final_message_chunk_id: messageChunkId,
  text: fullText,
  artifacts,
});
```

Artifact request 数据库事务若失败，说明用户明确请求的交付物尚未获得稳定 ID，首版将本轮收敛为 run-level
`error`，不返回指向不存在资源的伪 ArtifactRef。Artifact 和 Job 已成功创建、但 Worker 后续生成失败时，Answer
保持 completed，Artifact 进入 failed，卡片提供 retry。这两个失败阶段必须区分。

## 8. HTTP API

```http
GET /artifacts/:artifactId
Authorization: Bearer ...

GET /artifacts/:artifactId/content?disposition=inline|attachment
Authorization: Bearer ...

POST /artifacts/:artifactId/retry
Authorization: Bearer ...
```

行为：

- 所有路由从 Artifact 关联反查 Workspace，并调用 `assertMember`；
- 不信任客户端提交的 workspace/session/answer ID；
- 不存在和无权限统一返回 404，减少资源枚举；
- queued/processing/failed 请求 content 返回 409；
- `inline` 仅允许 MIME allowlist；其他类型强制 `attachment`；
- `Content-Disposition` 文件名经过 CR/LF、路径字符和长度清洗；
- 支持 `ETag`/`Cache-Control: private`，但不缓存 Authorization 响应到共享代理；
- 首版由 Backend 代理文件流；容量增大后可在鉴权后返回分钟级签名 URL。

`@agent/api` 增加 raw response/blob 方法，但仍由现有 Api Context 注入唯一稳定客户端。Context 不持有 Artifact
数据，也不因进度更新改变 value。

## 9. SmartBar 设计

### 9.1 组件结构

```text
AssistantPartView
  ├── existing Chunk views
  └── ArtifactList
        └── ArtifactCard
              ├── ArtifactStatus
              ├── MarkdownPreviewDrawer
              ├── DownloadButton
              └── RetryButton
```

Brain 的共同卡片外壳值得参考，但首版不建立空泛 Renderer Registry。等第三种 Artifact 类型进入后，再抽取：

```ts
interface ArtifactRendererAdapter {
  canRender(kind: ArtifactKind): boolean;
  render(detail: ArtifactDetail): ReactNode;
}
```

### 9.2 Query Cache

本阶段首次引入 TanStack Query，但只用于新的 Artifact 资源，不迁移 Workspace 和 Library：

```ts
queryKey: ['artifact', artifactId]
refetchInterval: detail.status === 'queued' || detail.status === 'processing'
  ? 1_500
  : false
```

Provider 只注入稳定 `QueryClient`；Artifact data 保存在 Query Cache。规则：

- 卡片进入视口或随 Answer 出现时查询；
- processing 时轮询；
- terminal 后自动停止；
- retry mutation 成功后更新/失效对应 key；
- 下载不写入 Query Cache，使用受权 fetch → Blob → object URL，并及时 revoke；
- 预览文本可以使用独立 query，Drawer 打开后再请求；
- 不把 Blob、object URL 或签名 URL持久化到 ChatRuntime。

### 9.3 UI 状态

| 状态 | 卡片行为 |
| --- | --- |
| queued | 显示“等待生成”，禁用预览/下载 |
| processing | 显示进度，禁用下载，可取消留到后续 |
| completed | 显示文件类型、大小；开放预览/下载 |
| failed | 显示安全错误文案和 Retry |

Markdown 预览首版按纯文本或禁用 raw HTML 的 Markdown 渲染；外链统一加 `rel="noopener noreferrer"`。

## 10. 实时与历史恢复

### 10.1 实时

1. `result.artifacts` 进入现有 Reducer；
2. Domain 按 Artifact ID upsert，并把 ID 同时加入当前 Answer Part 和 Thread；
3. `useAnswerArtifacts()` 返回当前回答的稳定引用；
4. SmartBar ArtifactCard 查询 HTTP API 获得当前状态；
5. Worker 完成后 Query Cache 轮询得到 completed，开放预览/下载。

### 10.2 Session Detail

1. Session Detail 返回原始 Answer events；
2. `decodeSessionDetail()` 继续通过同一 Reducer 物化 `result.artifacts`；
3. 恢复出的 Artifact ID 与实时链路一致；
4. ArtifactCard 重新查询 canonical ArtifactDetail，因此即使 result 中的快照是 queued，也显示最新 completed/failed；
5. 不合成 terminal 之后的伪 AgentEvent，不破坏 run seq。

这使 Chat 事件保持 append-only，同时保证刷新后的 Artifact 状态不会倒退。

## 11. 安全与资源限制

- Artifact 创建时服务端从 Answer 关系确定 Workspace，模型/客户端提供的 workspace ID 不可信；
- Artifact 读取、预览、下载、重试均重新校验 Workspace membership；
- storage key、bucket、内部错误堆栈、模型 prompt 不进入 SSE、DTO 或日志；
- 标题和文件名清洗，禁止路径穿越和 Header injection；
- 限制单 Artifact 最大字节数、单 Answer Artifact 数量、Worker timeout 和 retry 次数；
- 下载使用 MIME allowlist 与 `X-Content-Type-Options: nosniff`；
- Markdown 禁用 raw HTML；HTML Artifact 未完成独立 origin/sandbox/CSP 前不得开放；
- Worker 使用结构化错误码，前端只显示安全文案；
- 删除 Session/Workspace 时通过 Outbox 清理对象文件，数据库 FK 负责元数据级联。

## 12. 实施顺序

### Task 1：Protocol 与 Domain

- 扩展 `ArtifactRef/ArtifactKind/ArtifactStatus`；
- 增加严格 decoder tests；
- 修改 reducer 按 ID upsert；
- 增加 `selectAnswerArtifacts/useAnswerArtifacts`，并保留 Thread 聚合 selector；
- 保证实时 fixture 与 Session Detail fixture 物化等价。

退出标准：已有文本、citation、tool、stop 测试不回归；Artifact 重复事件不产生重复卡片。

### Task 2：数据库、Storage 与 Artifact Module

- 新增 reviewed Drizzle migration；
- 实现 ArtifactApplication、Repository、Markdown Renderer；
- ObjectStorage 增加生成文件写入和流式读取；
- 补充跨 Workspace 拒绝、路径隔离和大文件测试。

退出标准：同一 answer/kind 重试只产生一个逻辑 Artifact；storage key 不外泄。

### Task 3：Outbox 与 Worker

- 新增 Artifact queue/job constants；
- Outbox Relay 支持 artifact event；
- Worker 实现状态迁移、进度和失败记录；
- Worker 只从 Artifact ID 加载输入，不在 queue payload 放正文。

退出标准：重复 dispatch 幂等；进程重启后任务继续；失败可重试。

### Task 4：Sessions 集成

- `SendMessageOptions` 校验 `output_artifact`；
- flush 正文后创建 Artifact request；
- `result.artifacts` 写入 Event Journal；
- Session Detail 无特殊转换即可恢复相同引用。

退出标准：纯问答事件序列不变；启用生成报告时 result 含稳定 Artifact ID。

### Task 5：Artifact API 与 Query Cache

- 新增 detail/content/retry 路由；
- `@agent/api` 支持受权 Blob 下载；
- Web 根部注入稳定 QueryClient；
- 只新增 Artifact query/mutation，不迁移 Workspace 和 Library。

退出标准：无权用户无法读取元数据或文件；processing 自动轮询，terminal 自动停止。

### Task 6：SmartBar UI

- 增加 Composer“生成报告”选项；
- 增加 ArtifactList/Card、状态、Preview Drawer、Download 和 Retry；
- 增加 loading/error/empty/accessibility 状态；
- 卡片消费 Runtime selector + Artifact query，不解析 SSE。

退出标准：实时回答和刷新后 Session Detail 均可预览/下载同一文件。

### Task 7：扩展类型（后续里程碑）

按业务价值逐个增加，不并行铺开：

1. DOCX：Markdown/structured document → DOCX renderer；
2. PPTX：独立 presentation renderer，并补页级 preview；
3. Image：图像模型 Adapter、缩略图和原图下载；
4. XLSX：结构化表格输入与公式注入防护；
5. HTML：独立 origin、sandbox、CSP、版本与发布模型。

## 13. 测试矩阵

| 层级 | 必测场景 |
| --- | --- |
| Protocol | kind/status 非法、缺 ID、重复 Artifact、result 带 Artifact |
| Domain | upsert、Thread 关联、多 Thread 隔离、实时/Detail 等价 |
| Renderer | UTF-8、空回答、标题清洗、最大尺寸、AbortSignal |
| DB | 唯一约束、Artifact+Job+Outbox 原子创建、retry version |
| Worker | queued→processing→completed、失败、重复 job、进程重启 |
| Storage | 本地/S3 key 隔离、流式读取、补偿删除、路径穿越 |
| HTTP | 401/404/409、跨 Workspace、Content-Disposition、MIME |
| Query | 仅 processing 轮询、terminal 停止、retry invalidation |
| SmartBar | 四状态卡片、Preview、Download、Retry、多个 Artifact |
| E2E | 生成报告→完成→预览→下载→刷新 Session Detail 后再次下载 |

全仓门禁：

```bash
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

数据库和对象存储链路还需在 PostgreSQL + Redis + MinIO 环境运行集成测试，纯 TypeScript/Vitest 通过不能代替该验证。

## 14. 可观测性

统一字段：

```text
workspace_id, session_id, answer_id, artifact_id, artifact_kind,
artifact_version, artifact_job_id, queue_job_id, status, duration_ms,
output_size, error_code
```

指标：

- artifact requested/completed/failed 数；
- queued、render、storage 各阶段耗时；
- retry 次数与最终成功率；
- preview/download 成功率与 401/404/409 分布；
- dangling DB row、orphan storage object 和 stuck processing 数量。

## 15. 评审项与推荐答案

1. **首版 Artifact 类型是否只做 Markdown Report？** 推荐是，先验证完整交付链路。
2. **Artifact 任务状态是否与 Chat Runtime 分离并进入 Query Cache？** 推荐是，避免向已关闭 run 追加事件。
3. **是否只在 `result.artifacts` 挂稳定引用？** 首版推荐是；独立 artifact event 留给后续 Tool Loop。
4. **下载是否首版统一走受权 Backend stream？** 推荐是；规模增长后再换短期签名 URL。
5. **是否暂缓 HTML Artifact？** 推荐是，必须等独立 sandbox/CSP/发布权限方案完成。

以上五项确认后，可按 Task 1 → Task 6 顺序实施。每一步都在既有 V2 contract 和 Runtime 上增量扩展，不需要重写
SSE、Session Detail 或 Context 架构。

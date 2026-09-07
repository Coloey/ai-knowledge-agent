# Notta Brain Artifact 全链路源码研究

> 调研仓库：`/Users/coloey/notta_brain_web`
>
> 调研分支：`dev/xiaochun/brain-credit-35`
>
> 调研提交：`71ea24b54a519a32f2f872d4400485aefb0ccad0`
>
> 调研方式：只读源码追踪；未访问服务端仓库、接口文档或线上环境

## 1. 结论摘要

1. Brain 将用户可交付产物统一建模为 `AgentArtifact`，当前包含 PPT、Image、Word、Excel、HTML 五类；公共字段包括产物 ID、标题、类型、Session、Workspace、时间和存储路径，各类型再扩展预览或版本字段。[类型定义](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:273)
2. Artifact 不是独立 SSE 事件。实时链路在 `result` 事件结束时，从 `content.extra_data.artifacts` 提取产物，然后随 `finalizeV2Answer` 一次性写入答案 Part。[SSE 事件集合](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:720) [实时提取](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:543)
3. Store 只对 Thread 和 Part 做实体归一化；Artifact 没有独立的 `artifactsById`，而是嵌在 `V2AnswerPart.data.artifacts` 中。线程级产物通过遍历 `thread.partIds → parts → data.artifacts` 临时派生。[V2 Answer 数据](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/types.ts:93) [Store 结构](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:554) [线程切换派生](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:349)
4. 实时 SSE 与 Session Detail 使用相同的 `AgentArtifact`/`V2AnswerPart` 渲染模型，但使用了两套独立提取函数。历史转换同时兼容 V2 `result.extra_data` 和 legacy `final_answer → tool_result.extra_data`。[历史格式分流](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:420) [V2 历史提取](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:647) [Legacy 历史提取](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:811)
5. UI 在回答完成后统一渲染 `DownloadItem`，再按类型分派到 PPT、Image、Document、HTML 的卡片及预览/下载能力；流式阶段只显示 Chunk，不提前显示 Artifact 卡片。[答案渲染](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/index.tsx:13) [类型分派](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:20)
6. HTML Artifact 已超出“下载文件”范畴：它有独立控制面 API，支持临时预览 URL 刷新、版本列表、恢复、发布、取消发布、分享和 CDN invalidation 状态查询。[HTML Artifact API](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/html-artifact/html-artifact-api.ts:1)

## 2. 概念与范围

本文的 Artifact 指 Agent 面向用户生成的可交付产物，不是 CI/CD 的 build artifact。Brain 的 `ToolType` 已包含 `create_ppt`、`edit_ppt`、`create_image`、`create_word`、`create_excel`，以及 HTML 网站的 create/read/write/edit/add-images/deploy 工具族。[工具枚举](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:44)

调研仓库是前端 monorepo，因此可以确认浏览器可见的请求契约、SSE 事件处理、Session Detail 恢复和 UI 行为，但不能从该仓库证明服务端 Worker 如何执行生成、如何写对象存储或如何把 Artifact 持久化到 Session。前端明确把 Artifact Service 与 Session/SSE Service 视为不同服务：HTML 控制面请求使用 `AI_ARTIFACT_SERVICE`，会话详情使用 `SESSION_SERVICE`，未完成任务回放使用 `AI_SSE_SERVICE`。[HTML 服务入口](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/html-artifact/html-artifact-api.ts:10) [Session Detail 服务入口](/Users/coloey/notta_brain_web/packages/smart-bar/src/services/session.ts:14) [SSE Replay 入口](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1140)

## 3. Artifact 领域模型

### 3.1 公共模型

`AgentArtifactBase` 定义公共元数据：

| 字段 | 含义 |
| --- | --- |
| `id` | Artifact 稳定 ID |
| `title` | UI 标题及默认下载文件名来源 |
| `artifactType` | PPT/Image/Word/Excel/HTML 判别字段 |
| `sessionId` | 所属会话 |
| `spaceId?` | 所属 Workspace，用于构造下载路径 |
| `createdAt` / `updatedAt` | 展示生成时间和版本时间 |
| `path?` | 产物对象存储路径 |

字段来源见 [AgentArtifactBase](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:281)。

### 3.2 类型扩展

- PPT 增加 `slideIndex` 与 PDF `previewPath`，用于打开 PDF 预览和区分 PPTX/PDF 下载。[PPTArtifact](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:301)
- Image 增加带水印和无水印路径 `image_path`、`image_path_clean`。[ImageArtifact](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:293)
- Word/Excel 当前没有额外元数据，下载主要依赖公共 `path`。[DocumentArtifact](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:307)
- HTML 增加模板、工作版本、部署版本、预览 URL 和公开 URL；注释明确预览 URL 是会过期的 presigned URL，重新打开时应刷新。[HtmlArtifact](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:315)

### 3.3 在回答模型中的归属

一次 Agent 回答是一个 `V2AnswerPart`，其中 `data` 包含有序 `chunks`、`artifacts`、完成标记和最终消息 ID；因此 Artifact 的所有权首先归属于 Answer，而不是独立顶层消息。[V2AnswerData](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/types.ts:93) [V2AnswerPart](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:339)

## 4. 生成请求与浏览器可见协议

### 4.1 生成意图输入

普通 Word/Excel 模板通过 `question.options.template` 传入；HTML 生成使用版本化的 `question.options.html_artifact` 意图。HTML intent 保留用户原消息，把结构化 mode/template 信息交给 Worker 解释，同时供前端历史恢复和重试复用。[Session question options](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:175) [HTML intent 契约](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/html-artifact.ts:1)

发送请求构建器在有模板或 HTML intent 时强制 `agent_mode`，并把 `template`、`html_artifact` 放入 `options`；`client_surface` 由 Controller 控制，避免调用者伪造产品表面。[请求构建](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/send-request-builder.ts:126)

### 4.2 SSE 输入

实时传输使用 `@microsoft/fetch-event-source` 发起 POST SSE，以 `session/threadId` 作为多路复用键，并为每条连接持有独立 `AbortController`；重复 streamId 会先终止旧连接，软停止后忽略迟到事件。[SSEMux](/Users/coloey/notta_brain_web/packages/smart-bar/src/SSEMux.ts:29)

SSE 事件类型包含 `task_started / data / thinking / current_tool_use / tool_result / result / error / citation / task_completed / heartbeat / meta_info / auth_required`，没有 `artifact` 事件。[SSEEventType](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:720)

事件 Dispatcher 把 `current_tool_use`、`tool_result`、`result`、`citation` 等交给同一 `V2ContentProcessor`；UI 不直接解析 SSE wire event。[事件分发](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/sseHelpers.ts:18)

### 4.3 Artifact 输出契约

实时 Artifact 只在 `result.content.extra_data.artifacts` 中读取。数组元素的浏览器可见字段包括：

```ts
{
  type: 'ppt' | 'image' | 'word' | 'excel' | 'html' | string;
  id: string;
  title: string;
  path?: string;
  path_clean?: string;
  preview_path?: string;
  template_id?: string;
  template_version?: string;
  working_version?: string;
  version_id?: string | null;
  deployment_id?: string | null;
  preview_url?: string | null;
  published_url?: string | null;
}
```

该形状来自 [实时 Artifact 提取器](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:213)。PPT 映射 `preview_path → previewPath`，Image 映射 `path/path_clean → image_path/image_path_clean`，HTML 映射模板和部署版本字段，其余类型直接把 wire `type` 断言为前端 `artifactType`。[实时类型映射](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:250)

当前静态 SSE 类型没有给 `result.content` 声明 `extra_data`，但处理器使用 `any` 读取它；这意味着 Artifact 的关键 wire contract 尚未获得 TypeScript 的端到端约束。[result 静态类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:734) [result 动态读取](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:550)

### 4.4 独立导出接口

除 Agent 工具生成外，Brain 还有“根据已有 Answer 再导出”的 Artifact Service API：Image/PPT/Word export 都接收 `answer_id`、`session_id`、`answer_content`、`task_id` 和可选水印参数；这条链路与 SSE 最终 `extra_data.artifacts` 不应混为同一触发方式。[Image export](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/export/services/export-api.ts:58) [PPT export](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/export/services/export-api.ts:120) [Word export](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/export/services/export-api.ts:234)

## 5. 实时链路

```text
发送 Agent 请求
  → SSEMux 按 threadId 建立 POST SSE
  → current_tool_use/tool_result 更新 ToolChunk 进度
  → result.content.extra_data.artifacts 提取 AgentArtifact[]
  → finalizeV2Answer(answerId, finalMessageId, artifacts)
  → V2AnswerPart 完成
  → V2AnswerView 渲染 DownloadItem
```

`current_tool_use` 以 `tool_use_id` 累积流式参数，`tool_result` 再补齐结果、状态和 PPT 分页进度；Artifact 本体仍等到 `result` 才落入 Answer。[Tool use 累积](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:382) [Tool result 更新](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:487)

`processResult` 结束活跃 thinking/message、提取 Artifact、标记最后一个 MessageChunk 为最终答案，再调用 Store 的 `finalizeV2Answer`。[processResult](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:543)

`finalizeV2Answer` 原子写入完成状态、finalMessageId 和 artifacts，然后汇总当前 Thread 所有 Answer 的产物，通过 `THREAD_PPT_ARTIFACT_UPDATED` 广播。[Store finalize](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:870)

Artifact 卡片不会边生成边展示：`V2AnswerView` 在 `status === streaming` 时只遍历 Chunk，只有完成分支才渲染 `DownloadItem`。[V2AnswerView](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/index.tsx:27)

## 6. Store 归一化与线程同步

Store 的顶层实体是：

```text
threads: Record<threadId, ThreadState>
parts: Record<partId, AnyPart>
activityParts: Record<partId, AnyPart>

ThreadState.partIds[]
  → parts[partId]
    → V2AnswerPart.data.artifacts[]
```

该结构可由 [ChatState](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:554) 和 [ThreadState](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:420) 确认。Artifact 没有独立实体表，也没有 `artifactIds`；因此同一个 Artifact 若多次出现在不同 Answer 中，Store 本身不按 ID 去重。

V2 Answer 创建时初始化空的 `chunks/artifacts`，Chunk 通过 ID upsert，Artifact 则在回答结束时整体替换。[createV2AnswerPart](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:823) [upsertV2Chunk](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:850) [finalizeV2Answer](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:870)

Thread 切换、历史消息 prepend 和回答完成都会重新汇总产物并广播；虽然事件名仍叫 `THREAD_PPT_ARTIFACT_UPDATED`，payload 实际是全部 `AgentArtifact[]`。[Thread 切换](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:349) [历史 prepend](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:586) [事件 payload](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:897)

Embedded Header 也没有订阅独立 Artifact Store，而是从稳定的 `partIds` 和 `parts` 引用中派生当前 Thread 的全部产物。[Embedded 派生](/Users/coloey/notta_brain_web/apps/notta-brain/src/features/brain-chat/hooks/useEmbeddedBrainChatSession.ts:169)

## 7. Session Detail 离线恢复

### 7.1 加载与写入

历史数据来自 `/notta-brain/session/detail`，默认每页 10 条、倒序返回；Loader 调用 Converter 生成与实时链路相同的 Part，然后 prepend 到 Thread。[Session Detail 请求](/Users/coloey/notta_brain_web/packages/smart-bar/src/services/session.ts:16) [Session Loader](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:29)

Converter 先反转服务端的 QA 列表，再将 question、answer、附件和特殊卡片写成统一 Part；Answer 最终仍是 `V2AnswerPart`。[Session 转换入口](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:196) [Answer Part 构造](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:336)

### 7.2 V2 与 Legacy Artifact 恢复

- V2 历史：当 Answer message 出现 `thinking` 或 `data` 时按 V2 解析；遇到 `result`，从 `content.extra_data` 恢复 Artifact。[格式判断](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:413) [V2 result](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:647)
- Legacy 历史：`final_answer` 的 tool use 负责恢复最终正文；随后匹配该 `tool_use_id` 的 `tool_result.text`，JSON 解析出 `extra_data` 并恢复 Artifact。[Legacy final answer](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:744) [Legacy artifact](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:811)
- Legacy 还兼容旧的顶层 `extra.ppt_id` 和 `extra.image_id`；V2 则只认 `extra.artifacts[]`，避免同一结果重复插入。[兼容提取](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:898)

### 7.3 未完成 Session 回放

Session Detail 首屏若最后一条 QA 没有 Answer，或 Answer 仍是 `pending/processing`，Loader 会触发 SSE replay。[回放判断](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:122)

Replay 调用 `/notta-brain/session/sse-replay`，删除最后一个用户问题之后的旧 Assistant Part，再把回放事件交给与实时请求相同的 SSE Dispatcher/Processor；因此回放结束时 Artifact 仍通过 `result.extra_data.artifacts → finalizeV2Answer` 落库。[Replay 实现](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1140)

## 8. 卡片、预览与下载

### 8.1 统一分派

完成后的 `V2AnswerView` 将 `data.artifacts` 传给 `DownloadItem`；`DownloadItem` 按类型分派到 `PPTPreview`、`ImageArtifactPreview`、`DocumentArtifactPreview` 和 `HtmlArtifactPreview`。[回答完成渲染](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/index.tsx:38) [Artifact 分派](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:20)

当前列表只使用 `.find` 取第一个 PPT 和第一个 Image，而 Word/Excel/HTML 使用 `.filter().map()` 渲染全部，因此同一 Answer 的多个 PPT 或多个 Image 不会全部显示。[PPT/Image 选择](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:22) [Document/HTML 列表](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:30)

通用 `ArtifactCard` 负责图标、标题、副标题、点击和下载槽位，并由 `disableDownloadArtifact` 统一隐藏下载操作；它原生覆盖 PPT/Image/Word/Excel，HTML 使用专用卡片。[ArtifactCard](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/artifact-card/index.tsx:32) [下载开关](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/artifact-card/index.tsx:147)

### 8.2 PPT

点击 PPT 卡片打开全屏 PDF Previewer；预览优先使用后端 `previewPath`，缺失时才根据 workspace/session/pptId 拼历史路径，再获取 S3 signed URL 交给 PDF Viewer。[PPT 卡片](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/ppt-artifact-preview.tsx:13) [PPT 预览路径](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/PptPreviewer/ppt-preview-content.tsx:26)

下载菜单支持 PPTX 与 PDF，并可按集成开关导出到 Google Drive、OneDrive、SharePoint；SmartBar 只发出 `PPT_DOWNLOAD_CLICK` 意图，由宿主处理真实下载和成功埋点。[PPT 下载菜单](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/ppt-download-button/index.tsx:83) [宿主下载处理](/Users/coloey/notta_brain_web/apps/notta-brain/src/features/brain-chat/hooks/useBrainChatEvents.ts:244)

### 8.3 Image

Image 卡片先根据对象存储 path 获取 signed URL，包含 30 秒超时、失败状态和手动重试；单图使用大图卡，多产物时使用紧凑列表卡。[Image URL 加载](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:45) [Image 卡片模式](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/image-artifact-preview.tsx:134)

点击图片打开全屏预览；下载根据权益选择带水印或 clean path，并可导出到三方网盘。非分享页且上传/编辑能力开放时，卡片和预览还提供“继续编辑图片”入口。[Image 预览与编辑](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/image-artifact-preview.tsx:46) [Image 下载](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/image-download-button/index.tsx:37)

### 8.4 Word / Excel

Word/Excel 当前显示通用文件卡片和生成时间，但卡片被设置为 disabled，没有文档内容预览；下载使用 `artifact.path` 获取 S3 signed URL，并可保存到 Google Drive、OneDrive、SharePoint。[Document 卡片](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/document-artifact-preview.tsx:12) [Document 下载](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/document-download-button/index.tsx:27)

### 8.5 HTML

HTML 使用独立浏览器样式卡片：卡片内可嵌入沙箱 iframe，点击 Preview/Share 通过 EventBus 打开 Workspace Panel。[HTML 卡片](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/html-artifact-preview.tsx:22)

Standalone Brain 将 HTML Panel 放在与对话并排的可调整 Splitter 中；打开不同 Artifact 时使用 Artifact ID 作为 React key，避免旧版本请求覆盖新产物状态。[Splitter 接入](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/tasks/views/AttachmentPreviewSplitter/index.tsx:188) [Panel 渲染](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/tasks/views/AttachmentPreviewSplitter/index.tsx:294)

HTML Panel 打开时并行请求版本历史和新的 preview URL，不直接信任可能过期的 SSE URL；恢复版本后也用服务端返回的新 URL 更新预览。[打开时刷新](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/html-artifact/HtmlArtifactPreviewPanel.tsx:1092) [恢复版本](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/html-artifact/HtmlArtifactPreviewPanel.tsx:1302)

HTML 控制面完整接口包括版本列表、发布、invalidation 状态、恢复、取消发布、刷新预览、创建分享、模板列表、Artifact 列表和模板预览。[HTML API 函数](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/html-artifact/html-artifact-api.ts:207)

预览 URL 被当作私有、短期 bearer link，只有发布后的 public URL 才允许复制、分享和新标签打开；这是预览与分发权限分离的关键边界。[公开 URL 限制](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/html-artifact/HtmlArtifactPreviewPanel.tsx:1329)

## 9. 对当前项目技术方案的直接启示

以下是基于 Brain 源码得出的迁移建议，不代表 Brain 当前实现本身。

### 9.1 第一阶段应复制“协议边界”，不复制全部产品复杂度

建议先实现：

```text
result.artifacts[]
  → 单一 decodeArtifactDescriptor()
  → Runtime Store 归档
  → Answer 完成后 ArtifactList
  → download endpoint / signed URL
  → Session Detail 使用同一 decoder 恢复
```

Brain 已证明“最终 result 携带 Artifact 描述符，文件内容走对象存储/独立下载链路”可以把大文件与 SSE 解耦。[实时 result 提取](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:543) [S3 下载](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/download.ts:61)

首期不必立即复制 HTML 的发布、版本、分享和 CDN invalidation 控制面；这些能力需要独立服务契约和明显更多状态协调，Brain 也将它们从 Agent 流拆到了 Artifact Service。[HTML 控制面边界](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/html-artifact/html-artifact-api.ts:1)

### 9.2 实时与历史必须共用同一个 Artifact decoder

Brain 的实时提取器和历史提取器分别位于两个文件：[实时提取器](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:213) [历史提取器](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:906)。两者已出现字段漂移迹象：实时 Image 使用 `path_clean`，历史提取类型未声明 `path_clean`，并把 `image_path_clean` 设置成 `item.path`。[实时 Image 映射](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:258) [历史 Image 映射](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:939)

当前项目应只有一个协议 decoder，同时被 SSE `result` 和 Session Detail converter 调用；这样才能保证实时完成、刷新页面、历史分页和 replay 得到完全一致的 Artifact。

### 9.3 明确 Artifact 是否需要独立归一化

Brain 选择把 Artifact 嵌入 Answer，适合“产物只随答案展示”的场景；但它在 Header、线程切换和 HTML Panel 更新时需要反复扫描所有 Part，再通过一个历史命名为 PPT 的 EventBus 广播全部 Artifact。[线程级汇总](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:897) [Header 派生](/Users/coloey/notta_brain_web/apps/notta-brain/src/features/brain-chat/hooks/useEmbeddedBrainChatSession.ts:169)

如果当前项目只做答案下方卡片，可先保留 `AnswerPart.artifacts[]`；如果规划独立 Artifact 面板、跨答案编辑、状态更新或按 ID 刷新，则应使用：

```text
artifactsById: Record<artifactId, Artifact>
AnswerPart.artifactIds: string[]
Thread.artifactIds: string[]
```

### 9.4 契约必须覆盖运行时字段

不要照搬 Brain 当前 `result` 类型与运行时代码之间的 `any` 缺口。`result.content.extra_data.artifacts` 应进入正式判别联合，并在边界做运行时校验；未知 `type` 应进入 `unsupported` 或被拒绝，不能直接断言为已支持的 UI 类型。[静态类型缺口](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:734) [未知类型断言](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:278)

### 9.5 多产物与能力矩阵应在需求中明确

Brain 的 `AgentArtifact[]` 契约允许多个产物，但 UI 对 PPT/Image 各只显示第一个。[Artifact 数组](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/types.ts:93) [UI 选择](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:22)。当前项目应在 PRD 中明确：一条 Answer 是否允许同类型多个 Artifact、展示顺序、重复 ID 的覆盖规则，以及每种类型支持 `preview/download/retry` 中的哪些能力。

## 10. 已确认限制与风险清单

| 项目 | 源码现状 | 当前项目应采取的策略 |
| --- | --- | --- |
| Artifact 出现时机 | 只在最终 `result` 提取，流式期间只有 Tool Chunk 进度。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:487) | 首期保持最终一致性；若未来需要产物进度，再增加 `artifact_created/updated` 事件。 |
| Wire type | `result.extra_data` 通过 `any` 读取。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:550) | 建立 schema/decoder，拒绝非法 ID、type、URL/path。 |
| 实时/历史一致性 | 两套 Artifact 提取函数，Image clean path 已有差异。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:976) | 共享一个纯函数 decoder，并用同一 fixture 验证 SSE 与 Session Detail。 |
| Store 模型 | Artifact 嵌在 Answer 内，没有独立按 ID 更新。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:339) | 根据是否有跨 Answer/独立面板需求选择嵌套或实体归一化。 |
| 多产物 | 同类型多个 PPT/Image 只展示第一个。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:22) | ArtifactList 全量 map，按服务器顺序展示并以 ID 作为 key。 |
| 下载安全 | 普通文件/图片先换 signed URL；HTML 私有 preview URL 不可用于公开分享。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/download.ts:61) [HTML 权限边界](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/html-artifact/HtmlArtifactPreviewPanel.tsx:1329) | SSE/历史只保存对象 key 或 artifactId；下载 URL 短期签发，预览与公开 URL 分离。 |
| 文档预览 | Word/Excel 卡片 disabled，仅下载。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/document-artifact-preview.tsx:20) | 首期明确“文件卡 + 下载”，不要把尚未实现的 Office 在线预览写成验收项。 |
| HTML 复杂度 | 独立版本、发布、恢复、分享和 invalidation 状态机。[源码](/Users/coloey/notta_brain_web/packages/smart-bar/src/features/html-artifact/html-artifact-api.ts:22) | 放到独立里程碑，不与通用文件 Artifact 首期耦合。 |

## 11. 推荐的最小验收闭环

结合 Brain 的双链路模型，当前项目后续实现至少应验证：

1. 后端生成一个真实文件并在最终 `result.artifacts[]` 返回稳定 `artifactId/type/name/path-or-download-handle`；Brain 对应的收口点是 [processResult](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:543)。
2. Runtime 使用同一 decoder 写入 Answer/Artifact Store，完成后卡片出现且不会因重复 `result` 产生重复项；Brain 对应的写入点是 [finalizeV2Answer](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:870)。
3. 卡片能够展示文件名、类型、生成状态，并通过受控下载接口拿到真实文件；Brain 对应的通用卡片和下载边界是 [ArtifactCard](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/artifact-card/index.tsx:72) 与 [downloadArtifactS3File](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/download.ts:61)。
4. 刷新后通过 Session Detail 恢复完全相同的 Artifact，复用同一张卡片；Brain 对应的恢复入口是 [convertAnswerToV2Data](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:420)。
5. 未完成 Session 触发 replay 后，最终 Artifact 只出现一次；Brain 的触发与复用链路见 [Session Loader replay 判断](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:122) 和 [SSE replay](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1140)。
6. 无权限、文件不存在、signed URL 过期和下载失败时展示可恢复错误，不把私有预览 URL 当公开分享 URL；Brain 的 Image retry 和 HTML URL 边界见 [Image retry](/Users/coloey/notta_brain_web/packages/smart-bar/src/components/download-item/index.tsx:65) 与 [HTML shareUrl](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/html-artifact/HtmlArtifactPreviewPanel.tsx:1329)。

## 12. 调研边界

- 未读取 Artifact/SSE/Session 服务端仓库，因此不对生成引擎、数据库表、对象存储桶、鉴权实现和服务端幂等机制作事实判断。
- 未运行 `notta_brain_web`、未发起真实 SSE/Session Detail/下载请求，以上结论是当前提交源码的静态证据。
- 未把 CI 配置中的 `artifacts` 当作 Agent Artifact；两者只是同名概念。

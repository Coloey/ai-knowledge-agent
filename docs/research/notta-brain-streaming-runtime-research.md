# Notta Brain 当前功能与 AI 流式交互运行时调研

> 调研对象：`/Users/coloey/notta_brain_web`
>
> 调研快照：分支 `dev/xiaochun/brain-credit-35`，提交 `71ea24b54`
>
> 调研日期：2026-09-03
> 方法：只读源码追踪；未修改 `notta_brain_web`，未连接后端、未启动浏览器、未做线上可用性验证。

## 1. 结论先行

1. **当前主链路不是 `ContentProcessor → VirtualDOMProcessor → Virtual DOM Tree`。** 当前实现是：

   ```text
   SSE POST
     → SSEMux（每个 thread 一条连接）
     → ChatController / SseEventDispatcher
     → V2ContentProcessor
     → V2AnswerPart.data.chunks（扁平 ChunkPart[]）
     → Zustand ChatStore（parts + threads + activityParts）
     → React PartItem / V2AnswerView / ChunkPartRenderer
   ```

   `VirtualDOMTree` 属于已废弃的 V1 类型，源码已经明确要求新版使用 `ChunkPart`；当前仓库不存在 `VirtualDOMProcessor` 的定义或引用。旧 `virtualDOMHelpers.ts` 仍保留树操作代码，但现行 V2 处理器仅复用其中的 `parseToolAttachments`。[V1 deprecated 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/virtualdom.ts:1) [V2 处理器说明](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:47) [V2 对旧 helper 的引用](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:8)

2. **“统一 Part”实际有两层。** 外层 `AnyPart` 是会话时间线单元，包括用户文本、准备态、路由选择、`V2AnswerPart`、授权卡、邮件草稿卡；AI 回答内部才是 `thinking | message | tool` 三种 `ChunkPart`。`error` 不会生成独立 Part，而是把 Chunk/Part 状态改成 `error`，并在 thread/stream 上记录错误。[AnyPart 定义](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:194) [V2AnswerPart 与 AnyPart](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:339) [ChunkPart 定义](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/types.ts:4)

3. **实时与离线确实形成双数据链路，但会在同一 View Model 汇合。** 新消息通过 SSE 增量写入 `V2AnswerPart`；历史消息通过 `/notta-brain/session/detail` 一次性转换为相同的 `AnyPart[] / V2AnswerData`。若 Session Detail 首屏最后一轮仍是 `pending/processing`，会再连接 `/notta-brain/session/sse-replay`，并复用同一个 SSE dispatcher/processor 继续增量恢复。[Session Detail 服务](/Users/coloey/notta_brain_web/packages/smart-bar/src/services/session.ts:16) [历史加载与 replay 判定](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:81) [SSE replay](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1140)

4. **UI 与复杂 Agent 状态已经有明显隔离。** Controller 管连接和用例编排，Processor 管事件归并，Zustand 管 thread/part 归一化状态，React 只消费 Part/Chunk union；`ChatRuntimeProvider` 还允许每个宿主注入独立 store/controller。不过 UI 仍直接理解 `thinking/message/tool`、artifact、citation、授权卡等领域类型，因此是“降低侵入”，不是完全无感。[Runtime 注入边界](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/chat-runtime-context.tsx:7) [渲染分派](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/chunk-part-renderer.tsx:12)

5. **静态阅读发现若干应写入 PRD/技术需求的可靠性缺口：** transport error 传入 Processor 时没有受契约保证的 `answer_id`；用户 stop 缺少 interrupt 失败/超时兜底；后台 thread 的错误未写入 thread cache；`task_completed` 假定 `result` 已先到；replay 的 `setForcedCreatedAt` 实际为 no-op；`interest_verify_error` 被处理但未进入 SSE 类型联合。

## 2. 当前主要产品功能模块

以下是“当前源码存在的能力”，不等于所有环境、套餐、角色或宿主表面都已开放；功能受 feature config、权限、集成 allow list 和环境配置影响。

| 模块 | 当前代码能力 | 一手证据 |
| --- | --- | --- |
| AI Agent 对话 | 独立 Brain 页面、会议详情 Remote、Dashboard Remote 三种 surface 共用 SmartBar；支持多轮会话、流式思考、工具执行、最终回答、推荐问题、重试与停止 | [三种 surface 定义](/Users/coloey/notta_brain_web/apps/notta-brain/src/features/brain-chat/BrainChatFeature.tsx:180) [SmartBar 共用装配](/Users/coloey/notta_brain_web/apps/notta-brain/src/features/brain-chat/BrainChatFeature.tsx:1100) |
| 多来源上下文 | Composer 请求支持临时上传文件、第三方云盘文件、`@` mention、Reference Block、Web Search、模板和展示语言 | [发送草稿收集来源](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/send-request-builder.ts:64) [SSE 请求 options](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/send-request-builder.ts:154) |
| 知识库 Library | Library/Folder 路由，文档筛选、文件夹导航、上传解析状态回写、列表管理；模块内另有删除、重命名、预览 hooks | [Library 路由](/Users/coloey/notta_brain_web/apps/notta-brain/src/router/router-config.tsx:170) [Library 页面行为](/Users/coloey/notta_brain_web/apps/notta-brain/src/pages/library/index.tsx:1) |
| Agent 工具与知识检索 | Web 搜索、企业知识库搜索、文件/文件夹读取、摘要、文件系统与 shell、Google Calendar、Gmail、MCP 管理等工具类型 | [ToolType 清单](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:44) |
| 内容生成与 Artifact | PPT、图片、Word、Excel、HTML 网站产物；支持预览/下载，HTML artifact 还包含模板、版本、部署和发布 URL 数据 | [Artifact 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:273) [result 提取 artifacts](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:213) |
| Prompt Tools 工具目录 | 100+ 工具目录，按 Recommended、Writing、Marketing、Sales、Management、HR、Training、General 分类；按套餐上传文件数过滤 | [工具目录与分类](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/prompt-tools/lib/sections.ts:20) |
| 会话历史与恢复 | Task History 跳入 Session；Session Detail 分页、上拉加载、历史问答/附件/引用/评分/credit/artifact 还原；未完成回答触发 SSE replay | [历史页](/Users/coloey/notta_brain_web/apps/notta-brain/src/pages/chat-history/index.tsx:23) [Session Loader](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:29) |
| 会话分享 | 公开分享页；分享配置包含公开访问、密码、过期时间、搜索引擎索引，并支持多社交渠道/二维码 | [分享路由](/Users/coloey/notta_brain_web/apps/notta-brain/src/router/router-config.tsx:121) [分享状态结构](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:396) |
| 定时任务 | 定时任务列表/详情、创建、更新、删除、主动执行、执行历史查询，并有执行结果推送模块 | [定时任务路由](/Users/coloey/notta_brain_web/apps/notta-brain/src/router/router-config.tsx:178) [任务 API 用例](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/scheduled-tasks/hooks/useTaskAPI.ts:32) |
| 第三方集成市场 | Google/Outlook Calendar、Gmail、Microsoft Teams、Slack、LINE、Box、Google Drive、OneDrive、SharePoint | [集成分类清单](/Users/coloey/notta_brain_web/apps/notta-brain/src/modules/third-party-integrations/common/constant.ts:16) |
| 账号、Workspace、订阅与 Brain Credit | 账号偏好、Workspace 管理、Workspace 偏好、订阅计划、Billing、Balance/成员消耗详情；部分入口有 Owner/Admin guard | [Settings 路由与权限](/Users/coloey/notta_brain_web/apps/notta-brain/src/router/router-config.tsx:189) |
| 登录与分发形态 | 登录/注册免登录体验、SSO、Google One Tap、邮箱验证、Onboarding，以及 Module Federation 的 Meeting Host 嵌入形态 | [入口路由](/Users/coloey/notta_brain_web/apps/notta-brain/src/router/router-config.tsx:98) [三 surface 装配](/Users/coloey/notta_brain_web/apps/notta-brain/src/features/brain-chat/BrainChatFeature.tsx:180) |

## 3. 真实运行时数据模型

### 3.1 外层：会话时间线 Part

Store 采用“归一化实体 + 顺序 ID”的结构：

- `parts: Record<partId, AnyPart>` 保存所有消息实体；
- `threads[threadId].partIds` 保存单个 thread 的显示顺序；
- `activityParts` 是当前 thread 的可订阅镜像；
- `stream` 是当前活动 thread 的 UI 流状态；
- `SSEMux` 则维护所有 thread 的真实连接集合。

`ThreadState` 还保存标题、followups、上传文件、分页状态、分享配置、线程级错误和权益错误。[ThreadState](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:420) [Store 初始结构](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:48)

外层 `AnyPart` 的真实 union 为：

```ts
TextPart
| PreparingPart
| RouterChoicePart
| V2AnswerPart
| AuthCardPart
| EmailDraftCardPart
```

其中：

- 用户问题是 `TextPart`；发送前先用本地临时 ID，`task_started` 到达后原子替换成正式 `question_id`；
- 一轮 AI 输出总体是一个 `V2AnswerPart`，其 `id` 与 `answer_id` 对齐；
- 授权和邮件草稿因交互性较强，被提升为独立 assistant card Part；
- `router_choice` 用于 CS Support 分流。

证据：[Part 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/store.ts:194) [身份绑定](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:512) [Processor 处理 task_started](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:294)

### 3.2 内层：V2AnswerPart 的扁平 ChunkPart

`V2AnswerPart.data` 包含：

- `chunks: AnyChunkPart[]`；
- `artifacts: AgentArtifact[]`；
- `isCompleted`；
- `finalMessageId`；
- 可选 `needContactSupport`。

Chunk 只有三种：

| Chunk 类型 | 内容 | 状态 |
| --- | --- | --- |
| `ThinkingChunkPart` | 累积思考文本、思考耗时 | `streaming/completed/stopped/error` |
| `MessageChunkPart` | 增量 Markdown 文本、references、是否最终答案 | 同上 |
| `ToolChunkPart` | tool name/use id、修复后的参数、原始参数、结果、附件、PPT 进度等 | 同上 |

证据：[ChunkPart 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/types.ts:4) [V2AnswerData](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/types.ts:93)

### 3.3 Virtual DOM Tree 的真实状态

用户给出的描述中“Virtual DOM Tree”在当前代码应改写为“扁平 ChunkPart View Model”：

- `types/virtualdom.ts` 顶部明确标记 V1 deprecated，并指向 `v2-event-processor/types.ts`；
- `VirtualDOMTree` 仍定义 `nodes/currentStepNode/planContext`，旧 helper 也仍有 `addNodeToTree/startNextStep/handleUpdatePlan`；
- 但仓库当前没有 `VirtualDOMProcessor`；仓库级检索显示这些树操作只在 helper 文件内部互相调用；V2 只复用 `parseToolAttachments`。

因此，若 PRD/简历继续写“Virtual DOM Tree”，会与当前 HEAD 不一致。更准确的表述是：

> 将 Agent SSE 事件归一化为外层 Part 与内层有序 ChunkPart，构建可增量更新、可离线重建的统一消息 View Model。

证据：[deprecated 声明](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/virtualdom.ts:1) [旧 VirtualDOMTree](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/virtualdom.ts:109) [旧树 helper](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/common/virtualDOMHelpers.ts:177)

## 4. SSE 事件如何归一化与增量渲染

### 4.1 连接与分发

普通发送流程先创建用户 Part，设置 `stream.isStreaming=true`，清理上轮错误，再用 `SSEMux.start` 发起 POST SSE。收到的每条 `event.data` 先做 JSON 校验，再交给 `SseEventDispatcher → handleSSEEventLogic → V2ContentProcessor`。[发送与启动 SSE](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:688) [SSE JSON 解析](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1219) [Dispatcher](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/sse-event-dispatcher.ts:12)

`SSEMux` 以 `threadId` 为 `streamId` 管理连接：同 thread 新连接会软关闭并 abort 旧连接；软关闭后默认丢弃后续消息，避免旧流脏写；不同 thread 可以并行，发送 guard 默认限制最多 3 条连接、同 thread 只允许 1 条。[SSEMux](/Users/coloey/notta_brain_web/packages/smart-bar/src/SSEMux.ts:29) [并发 guard](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/session-limit-guard.ts:25)

### 4.2 事件映射

注意：当前后端事件名并没有 `tool_use` 或 `answer`；实际是 `current_tool_use` 与 `data/result`。

| SSE 事件 | Processor 行为 | Store/UI 结果 |
| --- | --- | --- |
| `task_started` | 建立 `answer_id → question_id` 映射，并将临时用户 Part ID 原子换成正式 `question_id` | 用户问题与回答身份稳定关联 |
| `thinking` | 创建或追加当前 `ThinkingChunkPart` | 思考过程实时展开并计时 |
| `data` | 结束当前 thinking；创建或追加 `MessageChunkPart`；对可能包含 citation 的流式文本做容错解析 | Markdown 正文逐字/逐段增长 |
| `current_tool_use` | 结束当前 thinking/message；按 `tool_use_id` 累积参数 delta，并用 `repairStreamingJson` 尝试修复未闭合 JSON | 工具卡参数和状态增量更新 |
| `tool_result` | 按 `tool_use_id` 回填 result/status/attachments；PPT 单独解析分页进度；内嵌 `auth_required` 可生成授权卡 | 工具卡从 using 切到 success/error |
| `citation` | 将后置 citation 元数据合并到最近一个 message 的 references | 角标可获得 source/url/原文片段/时间点 |
| `result` | 结束活跃 chunk；提取 artifacts；把最后一个 message 标为最终答案；完成所有 chunk 和 `V2AnswerPart` | 流式布局切换为“折叠过程 + 最终答案 + 下载产物” |
| `error` | 将正在 streaming 的 chunk 和回答 Part 标为 error，随后记录 stream error | 回答/工具呈错误态，线程底部显示错误 Alert |
| `task_completed` | 发出完成埋点事件，并 reset processor | 不负责产生最终答案，依赖 `result` 已完成收尾 |
| `heartbeat` | no-op | 保活 |
| `meta_info` | `route=cs_support` 时创建 `RouterChoicePart` | 展示客服分流选择 |
| `auth_required` | 去重后创建授权卡 | 引导第三方授权 |
| `interest_verify_error` | 更新权益错误状态 | 渲染 quota banner；但当前 SSE 类型联合漏了该事件，见缺口 |

证据：[事件 dispatcher switch](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/sseHelpers.ts:48) [当前 SSEEventType](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:720)

### 4.3 Processor 内部的增量合并

`V2ContentProcessor` 为每个 thread 保存一套内存态：`chunkList/chunkMap/toolChunkMap/rawParamsMap/activeThinkingId/activeMessageId/activeAnswerId`。Processor Registry 按 thread 懒创建实例，因此不同 thread 的流不会共用 active chunk；CSBot 每轮强制创建新实例，避免上一轮残留。[Processor 内存态](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:51) [按 thread 注册](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/v2-processor-registry.ts:13)

每次 `upsertChunk` 同时更新 Processor 自己的 list/map，并调用 Store 的 `upsertV2Chunk`。Store 按 chunk ID 替换或 append，然后同时更新 `parts` 与当前 thread 的 `activityParts` 镜像，触发 React selector 重渲染。[Processor upsert](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:160) [Store upsert](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:850)

### 4.4 UI 增量渲染

`ChatThread` 用 `thread.partIds → activityParts` 得到有序消息，并在顶部触发历史分页、在 streaming 时自动跟随到底部。`PartItem` 根据外层 Part 类型分派；`V2AnswerView` 在 streaming 时扁平展示全部 chunks，完成后把非最终 chunks 折叠到 `ProcessContainer`，最终 message 与 artifact 下载入口保持在外面。[ChatThread](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/chat-thread/index.tsx:54) [PartItem](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/index.tsx:24) [V2AnswerView](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/index.tsx:13)

`ChunkPartRenderer` 再分派到思考、Markdown 消息、工具卡。Thinking streaming 时自动展开并显示实时计时；结束后自动折叠。Markdown 渲染器按段落做轻量 reconciliation，复用 block ID 并只给新增块加动画。[Chunk 分派](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/chunk-part-renderer.tsx:12) [Thinking UI](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/thinking-chunk-view.tsx:19) [Markdown 增量块](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/markdown.tsx:423)

## 5. “实时 SSE + Session Detail 离线回放”双链路

### 5.1 实时链路

```text
用户发送
  → create User TextPart（临时 ID）
  → POST SSE
  → task_started 绑定 question_id
  → thinking/data/tool/citation 增量 upsert
  → result finalize V2AnswerPart
  → task_completed 发出完成事件
  → onClose 结束 stream lifecycle
```

身份设计的关键点是：请求发出时前端还不知道正式 `question_id`，因此 `sourceUserPartId` 随 SSE context 保留；`task_started` 到达后同时替换 `parts` key、thread 的 `partIds` 和当前 `activityParts` key，避免临时/正式消息重复。[SSE context 携带临时 ID](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:738) [原子绑定实现](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:512)

### 5.2 Session Detail 离线物化

Session Detail 返回 QA 结构：Question 包含 message、attachments、inline mentions、temp files、third-drive files 和 options；Answer 包含持久化事件数组、status、rating、initial response；单轮还可带 `credit_consumer`。[QA 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:175) [Answer 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:320) [Session Detail 类型](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:356)

Converter 做以下还原：

1. 因接口按 desc 返回，先 reverse 为 UI 正序；
2. Question 转成用户 TextPart，并恢复本地/第三方文件到 upload store；
3. Answer 转成 `PreparingPart + V2AnswerPart`；
4. 有 `thinking/data` 时按 V2 事件解析；否则按旧 `final_answer tool_use` 结构兼容解析；
5. 还原 citations、artifacts、router choice、auth card、email draft card、rating、question/answer identity、credit；
6. 映射持久化状态：`pending/processing → streaming`、`finished → completed`、`failed → error`、`interrupted/task_interrupted → stopped`。

证据：[Session 到 Parts](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:196) [V2/Legacy 分流](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:413) [状态映射](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionErrorProcessor.ts:11)

Loader 把转换出的 Parts 前插到 thread，并只在第一页写入 title、source、followups、creator、share config、历史错误；当最后一轮缺 answer 或 answer 为 `pending/processing` 时触发 replay。[历史前插与元数据](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:75)

### 5.3 未完成 Session 的 SSE replay

replay 前会保留最后一个用户 Part，移除其后的 assistant partIds，再对 `/notta-brain/session/sse-replay` 建立同 thread 的 SSE。replay 事件走和实时消息完全相同的 `parseSSEEvent → handleSSEEvent → dispatcher → processor`，因此 UI View Model 一致。[清理未完成 assistant](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1159) [Replay SSE](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1180)

这比“Session Detail 离线回放”更准确的术语是：

- **历史物化链路**：Session Detail 的持久化事件数组一次性转换为 Part/Chunk；
- **未完成任务续播链路**：对 pending/processing 的最后一轮再执行 SSE replay。

## 6. 中断、错误恢复与线程状态同步

### 6.1 主动中断

用户 stop 的正常路径是：

1. `stopCurrent()` 把 thread 放入 `stoppingThreads`；
2. 调 `/notta-brain/session/interrupt` 通知服务端停工；
3. 等 SSE `onClose`；
4. `completeIfStopping()` 调 Processor `handleStop()`；
5. 所有 streaming chunks 与回答 Part 变为 `stopped`，再关闭本地流并广播 thread end。

当 `completeStoppedThread` 执行并调用 `SSEMux.stop` 后，软关闭会忽略晚到事件，避免脏写；但有 uid/workspace 的用户 stop 在服务端关流前不会立即走到这一步，这也是下文“interrupt 失败/超时兜底”缺口的根源。[Interrupt API](/Users/coloey/notta_brain_web/packages/smart-bar/src/services/session.ts:82) [Stop coordinator](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/stream-stop-coordinator.ts:22) [Processor stop](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:644)

CSBot 临时会话不通知服务端，直接完成本地 stopped 收尾；`abort(threadId)` 则只是关闭 UI streaming 和连接，不会中断服务端，也不会把 Part 标记 stopped。它与用户 stop 语义不同。[stop/abort 差异](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/stream-stop-coordinator.ts:22)

### 6.2 错误处理与恢复

错误被分成三个阶段：`stream_business`、`stream_transport`、`client_exception`。业务 `error` 事件先让 Processor 标记回答失败，再由 `StreamLifecycle` 做错误码/i18n 映射、埋点和 Store 更新；transport/onmessage 解析异常也进入同一 lifecycle。[分发错误阶段](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/sseHelpers.ts:98) [StreamLifecycle](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/stream-lifecycle.ts:29)

错误 UI 位于 ChatThread 底部：网络错误提供刷新；PDF 解析错误可跳 Library；一般错误提供“重试上一条用户消息”；权益错误使用独立 overlay banner。Retry 会把目标用户 Part 及其后的显示序列截断，再以 `resend: true` 和原附件/reference/template 重发。[错误 UI](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/chat-thread/index.tsx:148) [Retry](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1004)

Session Detail 也能从持久化 answer 中恢复 runtime error 与 `interest_verify_error`，并把后者标记为 `restored`，防止宿主把旧权益错误误认成当前发送触发。[历史错误恢复](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionErrorProcessor.ts:84) [Loader 写入 restored](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:92)

### 6.3 Thread/Session 同步

- 切换 thread 时，Store 从对应 `ThreadState` 恢复 `activityParts`、lastError、权益错误与 artifacts；Controller 再用 `sseMux.isRunning(threadId)` 修正 `stream.isStreaming`。[Store 切换](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:349) [Controller 切换](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1242)
- 回答完成或历史 Parts 插入后，会重新计算 thread 已完成回答数量；达到 100 次后把 `sessionStatus` 置为 `limit_reached`，阻止继续发送。[Session 上限同步](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:428)
- Brain Credit 扣费可能晚于答案完成，独立 Notify push 会校验 uid/workspace/session/answer 归属后回写对应 V2AnswerPart。[Credit push](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/hooks/useCreditConsumerPush.ts:10)

## 7. 引用来源如何增量处理与渲染

引用有“两段式”数据：

1. 回答 `data` 文本内嵌 `<citations>{json}</citations>`；`parseCitations` 将其抽取为 `Reference[]`，并把正文替换成 `<citation-tag ...>`。流式标签未闭合时，会暂时截掉不完整尾部，避免半截 JSON/标签进入 Markdown。
2. 后置 `citation` SSE 事件补齐 `new_type/source/url/size/start_line/start_time/content/status/error`，按 `source + id`（历史缺 source 时降级 id）合并，并构建按 `start_line` 索引的 `content_chunks`。

证据：[引用解析](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/citation.ts:206) [后置元数据合并](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/citation.ts:182) [Processor citation](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:577)

Markdown 使用 `rehypeRaw`，将自定义 `citation-tag` 映射到 `CitationBadge`。Badge 通过当前回答的 `answerId` 定位其 final message references，避免后续回答中同文件引用覆盖旧回答；对 Record/PDF 可继续拉取资源详情并进入预览，对第三方来源使用 URL/来源元数据。[Markdown 组件映射](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/markdown.tsx:408) [按当前回答解析引用](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/citation-badge/citation-reference.ts:47) [Badge 元数据与预览](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/citation-badge/index.tsx:135)

## 8. 现有实现缺口与不确定性

下表中的“缺口”是当前静态源码推导，未通过真实后端事件序列验证；其中涉及事件先后顺序的项需要服务端契约确认。

| 优先级 | 缺口/风险 | 源码依据与影响 | 建议 PRD 要求 |
| --- | --- | --- | --- |
| P0 | **Transport error 可能无法把真实回答 Part 持久化为 error** | `onError(err)` 把普通 fetch error 直接传给 `processError`；Processor 从 `eventData.answer_id` 取 partId。普通 transport error 没有契约保证携带 `answer_id`，随后 `upsertV2Chunk(undefined, ...)` 不会更新真实 Part。UI 虽能显示 stream Alert，但已有 chunk/answer 可能继续保持 streaming。这是静态推断。[onError 调用](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:756) [processError](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:626) [Store 忽略未知 part](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:850) | Processor error API 应接受 `{ answerId?, error }`，缺 answerId 时用 `activeAnswerId`；验收需覆盖断网/HTTP 非 SSE/连接超时三种场景。 |
| P0 | **用户 stop 缺少失败与超时兜底** | 有 uid/workspace 时只发起 interrupt Promise 并等待 SSE close；没有 `.catch/.finally`、超时或立即本地 soft-stop。若 interrupt 失败或服务端不关流，`stoppingThreads` 和 UI streaming 可能悬挂。这是静态推断。[stopCurrent](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/stream-stop-coordinator.ts:29) | 点击 stop 后立即软关闭 UI；interrupt 后台执行；无论请求成功、失败或超时，均在限定时间内完成 stopped 收尾。 |
| P1 | **后台 thread 错误没有可靠缓存** | `StreamLifecycle.error/interestVerifyError` 只在错误 thread 等于 `currentThreadId` 时调用 Store setter；因此并行后台流错误只广播 event，不写 `ThreadState.lastError/interest_error_*`。切回 thread 后可能看不到错误。[StreamLifecycle 条件](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/stream-lifecycle.ts:64) [Store 本可缓存错误](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/store/index.ts:727) | 错误 setter 必须显式接收 threadId，始终写 thread cache；只有活动 thread 同步全局 `stream`。 |
| P1 | **`task_completed` 对 `result` 顺序有隐含依赖** | `task_completed` 只发事件并 reset processor，不 finalize answer。若 `result` 缺失或晚到，answer 可能未完成且晚到事件因 reset 无法正确收尾。需确认服务端是否保证 `result → task_completed`。[task_completed](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/features/sse-event-dispatcher.ts:41) [result 才 finalize](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:543) | 定义并校验终态协议；允许 `task_completed` 幂等兜底 finalize，或在客户端状态机中明确拒绝非法顺序并上报。 |
| P1 | **SSE `interest_verify_error` 类型契约缺失** | handler 有该 case，Session Detail item union 也有该类型，但 `SSEEventType` 联合没有，导致编译期无法表达真实事件。[handler](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/sseHelpers.ts:127) [SSE union](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/session.ts:720) | 将事件补入统一 schema，并用 exhaustive dispatch 约束所有事件。 |
| P1 | **Replay 创建时间恢复是 no-op** | `replaySession` 调 `setForcedCreatedAt(createdAt)`，但 V2 Processor 实现明确 no-op；因此注释中的“保持创建时间一致”并未实现。[replay 调用](/Users/coloey/notta_brain_web/packages/smart-bar/src/runtime/controller/index.ts:1154) [no-op](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:679) | replay chunk 使用服务端 timestamp/answer created_time，保证刷新前后时间与排序稳定。 |
| P2 | **历史过程耗时会退化为 0 秒** | Session Converter 给同一 answer 的所有 V2 chunks 都使用 `answer.created_time`；`ProcessContainer` 用首尾 chunk.createdAt 计算耗时，历史回答通常得到 0 秒。这是静态推断。[历史 chunk 时间](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:494) [过程耗时算法](/Users/coloey/notta_brain_web/packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/process-container.tsx:20) | Session Detail 持久化事件 timestamp，或存储 thinking duration；无可靠时间时不展示伪造的 0 秒。 |
| P2 | **tool_result 乱序/丢失没有恢复策略** | Processor 只在 `toolChunkMap` 已存在时处理 result；未找到对应 tool use 时静默忽略（除 auth text 尝试）。是否允许乱序需服务端契约确认。[processToolResult](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:487) | 明确事件排序保证；若无保证，按 `tool_use_id` 暂存孤立 result，并在 use 到达后合并。 |
| P2 | **历史加载失败直接终止更多加载** | Loader catch 后将 `hasMoreHistory=false`，仅日志，无内置重试状态，暂时性网络失败会让上拉分页永久停止到下次重建 thread。[Loader catch](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:140) | 保留 `hasMoreHistory`，增加显式 load error 与 retry；只在服务端确认无数据时置 false。 |
| P2 | **旧 Virtual DOM 代码形成概念债务** | deprecated 类型和树 helper 仍留存，且文件名让维护者误以为它是主链路；V2 还从该文件引用附件解析。[deprecated](/Users/coloey/notta_brain_web/packages/smart-bar/src/types/virtualdom.ts:1) [附件解析](/Users/coloey/notta_brain_web/packages/smart-bar/src/utils/common/virtualDOMHelpers.ts:18) | 将 `parseToolAttachments` 移入 V2 独立模块；删除或归档无引用的 V1 Tree 类型/helper，并更新架构文档。 |

## 9. 可直接进入 PRD 的需求表达建议

### 9.1 产品目标

为 Notta Brain 建立跨实时、历史和嵌入式 surface 一致的 Agent 消息运行时，使用户在刷新、切换会话、中断、断网、工具授权失败或后端任务续跑时，都能看到可解释、可恢复且顺序稳定的 AI 输出。

### 9.2 建议需求范围

1. **统一事件契约**
   - 建立显式 event schema：`task_started/thinking/data/current_tool_use/tool_result/citation/result/error/interest_verify_error/task_completed/auth_required/meta_info/heartbeat`；
   - 定义事件必填字段、顺序、终态和幂等键；
   - 前端 dispatcher 使用 exhaustive 类型检查，未知事件保留观测日志但不破坏当前回答。

2. **统一消息 View Model**
   - 外层保持 `AnyPart`，AI 回答保持 `V2AnswerPart`；
   - 内层以有序 `ChunkPart[]` 表达 thinking/message/tool，不再把已废弃 Virtual DOM Tree 写入现行方案；
   - 所有 Chunk 必须有稳定 ID、server timestamp、明确 status，并可由 Session Detail 确定性重建。

3. **实时与历史同构**
   - 同一持久化事件序列，经实时 reducer 与 Session Detail converter 应得到语义等价的 Part/Chunk；
   - pending/processing Session 刷新后自动 replay；finished/failed/interrupted 不重复 replay；
   - replay 不重复用户消息、工具卡、引用或产物。

4. **可靠中断与错误恢复**
   - 用户 stop 立即反馈，后端 interrupt 失败不影响本地收尾；
   - business/transport/client error 都能把正确 answer/chunk 标记为 error；
   - 后台 thread 错误可在切回后恢复；
   - Retry 恢复原 question 的附件、第三方来源、reference block、template 和 artifact intent。

5. **引用一致性**
   - 内嵌 citation marker 与后置 metadata 可乱序合并；
   - 引用必须按 answer 隔离，并保留来源、文件、行号/时间点；
   - 元数据失败时可降级展示，但不得把另一条回答/另一来源的数据串入。

6. **UI 展示规则**
   - streaming：按顺序展开当前 chunks；
   - completed：折叠思考/工具过程，保留最终答案与产物；
   - stopped/error：保留已经生成的内容，明确终态和恢复动作；
   - 历史无法计算真实耗时时，不显示误导性的 `0s`。

### 9.3 建议验收场景

- 正常顺序：thinking → data → tool use/result → data → citation → result → task completed；
- 参数 JSON 跨多个 tool use delta 才闭合；
- citation 标签跨多个 data delta，metadata 后到；
- 用户在 thinking、tool using、answer streaming 三个阶段分别 stop；
- interrupt API 失败、超时、SSE 不主动 close；
- SSE transport 断网、HTTP 200 但非 `text/event-stream` 且 body 为错误 envelope；
- 前台 thread A 与后台 thread B 并行，B 失败后切回 B；
- Session Detail 最后一轮分别为 finished、failed、interrupted、pending、processing；
- 刷新后 replay 与刷新前 UI 的 part/chunk 数量、顺序、引用和 artifact 一致；
- `task_completed` 缺 result、重复 result、重复 tool_result、未知事件；
- 同一文件在两个回答中被引用，行号/时间点不得串线。

## 10. 验证边界

- 本文以提交 `71ea24b54` 的静态源码为准；分支后续变化会使行号和结论漂移。
- 未取得服务端 SSE 协议文档，`result/task_completed` 顺序、tool event 是否保证有序等只能标为待确认。
- 未执行 type-check、unit test、浏览器联调或真实 Session Detail/SSE 请求；因此缺口表中的运行时影响属于源码推断，不是线上复现结论。
- 根 README 中部分路径/功能描述已与当前目录结构不一致，因此本文优先使用路由、类型、服务、Controller、Store 和渲染组件作为一手证据。

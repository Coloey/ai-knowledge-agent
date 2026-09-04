# Notta Brain AI 流式交互与会话回放统一运行时 PRD

> 状态：Draft v0.1（逆向现有前端源码形成，待产品、前端、服务端联合评审）
>
> 调研代码库：`/Users/coloey/notta_brain_web`
>
> 调研分支：`dev/xiaochun/brain-credit-35`
> 调研日期：2026-09-03

## 1. 文档目的

Notta Brain 的一次 Agent 回答不再只是单段文本，而是由思考、工具调用、工具结果、引用、最终答案、产物和错误等异步事件共同组成。本 PRD 希望把这些变化统一为稳定的前端运行时模型，使实时响应和历史会话使用同一套渲染语义，并把 SSE 协议、会话恢复、线程状态等复杂性隔离在 UI 之外。

本文同时记录当前实现，避免将目标架构与现状混淆：当前主链路使用 `V2AnswerPart + AnyChunkPart[]` 扁平模型；旧 `VirtualDOMTree` 已被标为 deprecated，并非当前渲染主模型。

## 2. 当前产品能力盘点

| 能力域 | 当前已确认能力 | 主要入口或证据 |
| --- | --- | --- |
| AI 对话 | 新建/继续会话、Agent 流式回答、思考过程、工具调用、引用、推荐问题、重试、停止、评价 | `packages/smart-bar/src/`、`apps/notta-brain/src/pages/chat/` |
| 知识输入 | 本地文件、Library 文件/文件夹、会议记录、PDF、Web、三方云盘文件、@mention | `packages/smart-bar/src/types/session.ts:124-195` |
| AI 内容生成 | 图片、PPT、Word、Excel、HTML 网站产物；预览、下载及部分 Google Drive 导出 | `packages/smart-bar/src/types/store.ts:273-337` |
| AI 工具与集成 | 企业知识库搜索、文件读写、Shell、Gmail、Google Calendar、MCP 管理、HTML Artifact 工具 | `packages/smart-bar/src/types/store.ts:44-89` |
| Prompt Tools | 105 个工具注册到 SPA，覆盖写作、营销、销售、管理、HR 等场景；支持表单、预设、深链与多语言 Prompt | `apps/notta-brain/src/modules/prompt-tools/lib/tools/index.ts:1-29`、`sections.ts` |
| 会话管理 | 历史列表、分页加载 Session Detail、上下文还原、未完成任务恢复、分享页 | `apps/notta-brain/src/router/router-config.tsx`、`V2SessionLoader.ts` |
| Library | Workspace 文件库、文件夹浏览、上传与搜索 | `apps/notta-brain/src/pages/library/`、`modules/library/` |
| 定时任务 | 任务列表/详情、启停、立即执行、执行历史 | `apps/notta-brain/src/pages/scheduled-tasks/`、`modules/scheduled-tasks/` |
| Meeting 嵌入 | Meeting Dashboard、Record Detail AI Chat、推荐问题、产物入口，通过 Module Federation 供 Notta Web 宿主加载 | `apps/notta-brain/src/features/brain-chat/views/`、`remote/notta-web-embed/` |
| 账号与商业化 | 登录/注册/SSO、Workspace、订阅/账单、Brain Credit 余额与使用 Dashboard、成员权限 | `apps/notta-brain/src/router/router-config.tsx`、`pages/settings/` |
| 多端与分享 | Standalone Brain、Notta Web Remote、H5、免登录体验、Session Share | `apps/notta-brain/src/router/`、`apps/h5/`、`modules/login-free/` |

说明：仓库根 README 中仍有部分旧目录和旧路由描述，本表优先依据当前路由与源码模块，不把 README 中已经不存在的独立 `projects` 路由视为当前能力。

## 3. 背景与问题

### 3.1 用户问题

- 首个 token 返回前缺少明确状态，用户不知道系统是在思考、调用工具还是已经失败。
- 工具可能多次增量返回参数与结果，简单追加 DOM 容易重复、错序或闪烁。
- 实时流、刷新后的 Session Detail、未完成会话恢复如果各自维护 UI 数据结构，同一条回答会出现不同展示。
- 用户切换 Thread、主动停止、网络中断或服务端错误时，UI 可能显示错误线程的 loading/error 状态。
- 引用可能先以内嵌标记出现在文本中，再通过独立 citation 事件补全元数据，需要渐进增强而不能阻断答案展示。

### 3.2 工程问题

- UI 若直接消费 SSE wire event，将被传输协议、后端工具类型和恢复逻辑侵入。
- `thinking / data / current_tool_use / tool_result / result / error` 生命周期不同，但必须落到统一、可枚举、可持久化的状态模型。
- 同一个 `tool_use_id`、`answer_id`、`question_id` 需要稳定关联，才能保证增量更新、重试和历史还原一致。
- 历史数据同时存在 V2 与 legacy 格式，需要兼容读取，但不能让兼容逻辑进入展示组件。

## 4. 产品目标

1. 流式开始后，用户能连续看到“思考 → 工具执行 → 中间文本 → 最终答案/产物”的过程，不因事件分片而重复或跳动。
2. 实时 SSE、Session Detail 历史还原和未完成会话 SSE replay 最终生成同一套 Part/Chunk 语义。
3. 用户停止、传输错误、业务错误、权益错误均能落到明确状态，并能在切换 Thread 或刷新后正确恢复。
4. UI 组件只面向 `Part` 与 `ChunkPart` 渲染，不解析 SSE、不判断后端持久化状态、不负责跨事件关联。
5. 新工具接入时优先增加工具展示适配，不改动消息列表和线程状态主流程。

## 5. 非目标

- 不在本需求中定义 Agent 推理策略或服务端工具编排算法。
- 不展示服务端私有推理、系统 Prompt、密钥或工具敏感原始参数。
- 不重做 Library、定时任务、计费或权限系统，仅定义它们与聊天运行时的状态边界。
- 不继续扩展旧 `VirtualDOMTree`；若产品仍希望使用“Virtual DOM”术语，统一指代规范化渲染模型，而不是旧树类型。

## 6. 统一领域模型

### 6.1 层级

```text
Thread
└── partIds[]
    ├── TextPart              用户问题
    ├── PreparingPart         初始准备文案
    ├── V2AnswerPart          一次 Agent 回答
    │   └── data.chunks[]
    │       ├── ThinkingChunkPart
    │       ├── MessageChunkPart
    │       └── ToolChunkPart
    ├── AuthCardPart          三方授权动作卡
    ├── EmailDraftCardPart    邮件草稿动作卡
    └── RouterChoicePart      Agent/客服等路由选择
```

### 6.2 身份与状态

- `threadId/session_id`：会话和 SSE 连接的稳定主键。
- `question_id`：服务端确认的用户问题 ID；发送时本地先创建临时 TextPart，`task_started` 到达后原子替换身份。
- `answer_id`：一次回答对应的 `V2AnswerPart.id`。
- `tool_use_id`：同一工具调用的增量参数、结果和 UI 节点关联键。
- Part/Chunk 统一状态：`streaming | completed | stopped | error`。
- Chunk 顺序：使用首次创建时的顺序；后续相同 ID 或 `tool_use_id` 只更新原节点，不重复追加。

## 7. 数据链路

### 7.1 实时发送链路

```text
用户发送
  → 本地创建 TextPart、标记 Thread streaming
  → SSEMux 按 threadId 建立 POST SSE
  → SseEventDispatcher 校验并分发事件
  → V2ContentProcessor 将事件归一化为 ChunkPart
  → Zustand store upsert V2AnswerPart/chunk
  → V2AnswerView 按 chunk.type 增量渲染
```

### 7.2 Session Detail 离线还原链路

```text
进入历史 Thread / 上拉分页
  → GET /notta-brain/session/detail
  → V2SessionConverter 反转服务端倒序 QA
  → Question/Answer/Attachment/Error/Artifact 转为相同 Part/Chunk 模型
  → prepend 到 Thread
  → 复用同一套 V2AnswerView
```

### 7.3 未完成会话恢复链路

Session Detail 首屏若最后一条回答为空，或状态为 `pending/processing`，前端调用 `/notta-brain/session/sse-replay`。恢复前保留最后一个 User Part，移除其后的旧 Assistant Parts，再让 replay 事件重新进入同一 Dispatcher/Processor 链路，避免静态快照与增量事件重复。

## 8. 事件到渲染模型的需求

| Wire event | 归一化行为 | UI 行为 | 完成条件 |
| --- | --- | --- | --- |
| `task_started` | 绑定临时用户 Part 与正式 `question_id`，建立 `answer_id → question_id` 映射 | 不新增可见气泡 | 身份绑定幂等完成 |
| `thinking` | 同一活跃段累计为 `ThinkingChunkPart` | 展示流式思考；进入下一阶段后结束 | 后续 data/tool/result/error/stop |
| `data` | 累计为 `MessageChunkPart`；跨 delta 保留原始文本以解析未闭合 citation 标记 | Markdown/文本增量输出 | 下一 tool/result/error/stop |
| `current_tool_use` | 以 `tool_use_id` upsert `ToolChunkPart`；修复并增量解析 JSON 参数 | 展示工具名、执行中状态及可公开输入 | 对应 tool_result/error/stop |
| `tool_result` | 回填结果、成功/失败、附件；PPT 等工具回填进度和预览信息 | 原位更新同一工具节点 | 结果已关联 |
| `citation` | 用 citation 元数据补全最近消息中的 references | 引用角标与来源面板渐进可用 | 无需阻塞主答案 |
| `result` | 结束活跃段，最后一个 MessageChunk 标记最终答案，收集 Artifact，完成 Answer Part | 过程折叠，最终答案与下载项稳定展示 | `V2AnswerPart.completed` |
| `error` | 将所有仍在 streaming 的 Chunk 和 Answer 标为 error，并记录 Thread 错误 | 保留已生成内容并显示可理解错误/重试 | 错误完成态 |
| `interest_verify_error` | 独立记录权益错误，不与普通运行时 error 混合 | 展示 Credit/Quota 提示；历史恢复时标记 restored | 权益错误已归属正确 Thread |
| 用户 stop | 立即软关 SSE、忽略迟到消息，同时请求服务端 interrupt；活跃状态改 stopped | 保留已有内容，停止 loading | 本地收尾不依赖后端响应 |
| `task_completed` | 发出运行时完成事件并 reset Processor 临时缓存 | 不直接决定答案内容 | 清理完成 |
| `auth_required` | 去重后创建授权动作 Part；兼容独立事件和 tool_result 内嵌状态 | 展示第三方授权卡 | 用户授权或继续操作 |
| `meta_info` | 转为 RouterChoicePart | 展示路由选择动作 | 用户选择或忽略 |

## 9. 功能需求

### FR-1 传输与连接隔离

- 每条 SSE 连接必须以稳定 `threadId` 注册。
- 同 ID 新连接启动前必须终止旧连接，旧连接后续消息不得写入 store。
- 页面隐藏时允许连接继续，保证长任务不因切换 Tab 中断。
- HTTP 200 但 `Content-Type` 非 `text/event-stream` 且返回错误 envelope 时，必须按传输错误进入统一错误映射。
- malformed、空消息和 `[DONE]` 必须安全忽略并留下可观测日志，不能使 UI 崩溃。

### FR-2 Part/Chunk 归一化

- UI 可消费类型限定为 `TextPart / PreparingPart / V2AnswerPart / AuthCardPart / EmailDraftCardPart / RouterChoicePart`。
- `V2AnswerPart.data.chunks` 仅允许 `thinking / message / tool` 三种渲染类型。
- Processor 是 wire event 到 UI model 的唯一映射入口；React 组件不得 switch SSE event。
- 未知工具默认走通用 ToolChunk，不应阻断后续答案。

### FR-3 增量渲染

- 流式中所有 Chunk 按首次出现顺序平铺。
- thinking、message 和 tool 参数增量必须更新原 Chunk，禁止重复节点。
- 完成后，除最终答案外的过程 Chunk 收入可展开/折叠的 ProcessContainer；最终答案不得因布局切换而 remount。
- Artifact 显示在最终答案后，支持不同产物的预览/下载策略。

### FR-4 工具调用

- 通过 `tool_use_id` 关联 use/result，支持参数被多次分片。
- 参数 JSON 不完整时应以 repair 方式尽力解析；解析失败保留原始数据用于诊断，但默认不得直接展示敏感内容。
- 工具结果的 `success/error` 与 Chunk 生命周期状态分开表达：调用可以结束，但业务结果仍可能失败。
- PPT/图片/Word/Excel/HTML 等复杂工具允许注册特定展示适配；普通搜索/读取/集成工具复用通用展示。

### FR-5 引用来源

- 支持答案文本中的 citation 标记被跨 delta 切开。
- 支持独立 citation 事件晚于文本到达并补全 title、source、URL、时间或页码等信息。
- 引用解析失败不能阻断正文；无法匹配的引用进入可观测日志。
- 实时与 Session Detail 还原后引用数量、顺序及点击目标保持一致。

### FR-6 中断

- 点击停止后 100 ms 内停止前端 loading/打字指示，并丢弃迟到 SSE 消息。
- 有账号上下文时异步调用 interrupt API；本地 UI 收尾不得等待服务端。
- 活跃 Chunk 和 Answer Part 标记 `stopped`，已完成 Chunk 不回退。
- 从历史进入时，`interrupted/task_interrupted` 必须还原为 stopped。

### FR-7 错误与恢复

- 区分 `stream_business / stream_transport / client_exception`，但统一映射为本地化用户消息。
- 错误发生后保留已输出文本、思考和工具记录，最后活跃节点显示 error。
- Rate limit、Credit/权益、WAF、网络错误和通用服务不可用按错误码映射不同 CTA。
- Thread 错误状态必须缓存到对应 Thread，切换回来时恢复；历史错误标记为 `restored`，避免当作当前新错误重复上报或弹窗。
- 重试必须复用原问题的文本、引用、附件、模板和结构化 Artifact intent。

### FR-8 历史还原与兼容

- Session Detail 的倒序 QA 必须转换为 UI 正序并前插分页。
- Question 需还原临时文件、第三方云盘文件、mention、reference block、模板和 HTML Artifact intent。
- Answer 需同时支持 V2 event 序列和 legacy final_answer/tool_use 格式，兼容逻辑只存在于 Converter。
- 同一份事件夹具通过实时 Processor 与 Session Converter 后，应得到语义等价的 Chunk 顺序、状态、最终答案、引用和 Artifact。

### FR-9 Thread 状态同步

- `currentThreadId` 切换时同步 activityParts、Thread 错误、权益错误和 Artifact 列表。
- 全局 streaming 展示必须由目标 Thread 对应的 `SSEMux.isRunning(threadId)` 恢复，不得沿用前一 Thread 状态。
- 非当前 Thread 的 SSE 可以继续更新其缓存，但不得污染当前 Thread 的错误 Banner 和 loading。
- `task_started` 重复到达时 question identity 绑定必须幂等；发生 ID 冲突时拒绝覆盖并记录诊断信息。

### FR-10 可观测性

- 至少记录 `requestId/threadId/answerId/eventType/failurePhase`，不得记录 Prompt 全文、文件 URL、认证信息或敏感 tool 参数。
- 统计首事件耗时、首答案文本耗时、完成耗时、中断率、传输错误率、历史恢复成功率、实时/历史渲染一致率。
- 对 malformed SSE、未知事件、孤立 tool_result、citation 匹配失败建立计数指标。

## 10. UI/交互要求

- 流式过程中的顺序固定为事件首次出现顺序；更新节点不得引起消息列表整体跳动。
- Thinking 与 Tool 均应有 streaming/completed/stopped/error 可识别状态。
- 最终答案完成后，思考和工具过程默认折叠但可展开；正在流式时保持展开。
- 出错或中断后仍允许复制已生成文本；是否允许重试由错误类型和权益状态决定。
- 引用入口支持答案内角标和底部来源汇总，点击后展示对应文件/页面/时间段或网页。
- Artifact 生成过程与最终产物分离：ToolChunk 展示过程，Artifact 区展示可消费结果。

## 11. 验收标准

### AC-1 标准流式回答

给定 `thinking × N → data × N → result → task_completed`，页面只出现一个 Answer Part；thinking/text 均按顺序累计，最后一个 MessageChunk 成为 final answer，Part 进入 completed。

### AC-2 工具分片

给定同一 `tool_use_id` 的 3 个不完整 JSON 参数片段和 1 个 tool_result，只渲染一个 ToolChunk；最终参数可解析，结果原位回填。

### AC-3 引用分片

给定 citation 标记跨两个 data delta，正文不显示协议标记；citation 事件后引用信息得到补全，Session Detail 还原结果一致。

### AC-4 用户停止

用户停止后立即停止前端 streaming；迟到 data/result 不再更新 UI；活跃节点为 stopped；重新进入历史会话时仍显示 stopped。

### AC-5 错误路径

分别模拟业务 error、断网、200 JSON 错误 envelope、客户端解析异常；均保留已有内容，显示正确本地化错误，并标记正确 failure phase。

### AC-6 Thread 切换

Thread A 流式中切到 Thread B，B 不显示 A 的 loading/error；切回 A 时根据实际连接状态恢复。A 后台完成后，B 不被重渲染为 A 的结果。

### AC-7 历史一致性

保存一组包含 thinking、多个 tool、citation、result、artifact 的事件夹具。实时 Processor 输出与 Session Detail Converter 输出在以下字段上语义一致：Chunk 类型与顺序、工具关联、终态、finalMessageId、references、artifacts。

### AC-8 legacy 兼容

已有 legacy session 能正常展示最终答案和工具过程；新 UI 不需要知道该 session 属于 legacy。

## 12. 指标与成功标准

- SSE 首事件解析成功率 ≥ 99.9%。
- `task_started` 后有终态的回答比例 ≥ 99.5%。
- 实时/历史语义一致自动化用例通过率 100%。
- 因孤立 `tool_result`、重复 Chunk、引用协议泄漏造成的前端异常率降至基线的 10% 以下。
- 用户停止后迟到消息写入率为 0。
- Thread 切换导致的错误态/streaming 串线率为 0。

实际阈值需在接入现有埋点后，用一周生产基线校准。

## 13. 实施建议

### Phase 1：协议与一致性基线

- 固化事件 schema、状态机和可脱敏日志字段。
- 建立“同一事件夹具：实时处理 vs Session Detail 转换”的差分测试。
- 补充 malformed、重复、错序、孤立 tool_result、跨 delta citation 用例。

### Phase 2：生命周期收敛

- 统一 business/transport/client error 对 Chunk、Part、Thread 的落库方式。
- 明确 `result` 与 `task_completed` 的职责，避免任一缺失造成永久 streaming。
- 校验停止 API 无响应、SSE 先关闭、迟到事件等竞态。

### Phase 3：扩展与观测

- 建立工具展示注册表，降低新增 ToolType 对核心 Processor/UI 的修改面。
- 接入一致性、恢复率、孤立事件、首 token/完成耗时指标。
- 在 Standalone、Meeting Remote、Session Share、H5 四个 surface 灰度验证。

## 14. 当前实现与目标差距

1. 当前模型已是扁平 `ChunkPart[]`，旧 `VirtualDOMTree` 仍留有 deprecated 类型和 helper；PRD 应推动术语与死代码收口，而不是恢复旧树。
2. 实时 Processor 和历史 Converter 已共享 Part/Chunk 类型，但仍各自实现一套事件聚合算法，存在随需求演进产生语义漂移的风险，尚未看到正式差分一致性门禁。
3. Controller 在未完成会话 replay 前尝试设置原创建时间，但 `V2ContentProcessor.setForcedCreatedAt()` 当前是 no-op；恢复流中新建 Chunk 的时间与原事件时间可能不一致，需要产品确认是否影响“思考耗时”和排序展示。
4. `SSEMux` 支持多 Thread 连接，但 store 的 `stream` 是当前态，部分错误写回仍依赖 `currentThreadId`；需用 Thread 切换竞态测试确认非当前流不会污染当前 UI。
5. Transport onError 直接调用 `processError(err)`，而 Processor 的业务 error 路径依赖 `answer_id`；应通过故障用例确认活跃 Answer/Chunk 一定能进入 error，而不仅是全局 Stream error。
6. 用户 stop 在存在 uid/workspace 时会等待 interrupt 后的 SSE close，当前未见失败、超时或立即本地 soft-stop 兜底；需要优先验证“点击停止后仍继续流式”的风险。
7. `task_completed` 当前只发事件并重置 Processor，真正完成 Answer 依赖更早的 `result`；服务端若不保证顺序或缺失 result，回答可能无法正确终态化。
8. Handler 已处理 `interest_verify_error`，但它没有进入 `SSEEventType` 联合，当前类型契约与运行时分支不一致。
9. Session Converter 给同一 Answer 内多个 Chunk 使用相同的 `answer.created_time`，而过程 UI 用首尾 Chunk 时间计算耗时；历史回放可能显示误导性的 0 秒。
10. 孤立或乱序 `tool_result` 当前会被静默忽略；历史分页遇到暂时性请求错误会把 `hasMoreHistory` 置为 false，两者都需要明确恢复策略。
11. 根 README 的功能和目录说明有过期内容，不能作为验收口径；需要补一份与当前路由、Remote surface 和 V2 runtime 对齐的产品能力文档。

## 15. 待评审问题

1. 产品命名是否继续使用“Virtual DOM”，还是统一改为“Part/Chunk 渲染模型”？建议后者。
2. `result` 和 `task_completed` 哪一个是回答完成的唯一权威事件？另一事件超时缺失时如何兜底？
3. 是否允许一个 Thread 在后台继续流式？如果允许，全局 stream 状态需进一步 Thread 化。
4. SSE replay 的目标是“续传未完成部分”还是“从头重放整轮”？服务端是否保证事件幂等与顺序？
5. 思考内容对所有用户/所有 Agent 都可见吗？是否需要按模型、权限或合规策略隐藏？
6. Tool 原始参数哪些可展示、哪些必须脱敏？由服务端声明 display payload，还是前端白名单？
7. 历史会话中的引用 URL 或 Artifact 预签名过期后，由哪个接口刷新？
8. legacy session 的兼容窗口和下线标准是什么？

## 16. 主要源码证据

- 当前 V2 Chunk 模型：`packages/smart-bar/src/utils/v2-event-processor/types.ts:4-99`
- 旧 Virtual DOM 已废弃：`packages/smart-bar/src/types/virtualdom.ts:1-5`
- SSE 事件协议：`packages/smart-bar/src/types/session.ts:673-771`
- 实时事件分发：`packages/smart-bar/src/utils/sseHelpers.ts:18-153`
- 实时事件归一化：`packages/smart-bar/src/utils/v2-event-processor/V2ContentProcessor.ts:47-683`
- Session Detail 转换：`packages/smart-bar/src/utils/v2-event-processor/V2SessionConverter.ts:197-705`
- 历史分页与未完成判断：`packages/smart-bar/src/utils/v2-event-processor/V2SessionLoader.ts:29-147`
- SSE 连接和软停止：`packages/smart-bar/src/SSEMux.ts:29-153`
- 停止协调：`packages/smart-bar/src/runtime/controller/features/stream-stop-coordinator.ts:7-97`
- 错误与完成状态：`packages/smart-bar/src/runtime/controller/features/stream-lifecycle.ts:6-85`
- Zustand Part/Thread 更新：`packages/smart-bar/src/runtime/store/index.ts:349-401,487-630,707-777,823-910`
- V2 UI 渲染：`packages/smart-bar/src/fragments/message/components/message-item/v2-answer-view/`

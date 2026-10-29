# 未使用的字体模板占位修复（2026-10-29）

确定性预检/渲染共用 `unused-font-placeholder-1` 策略，仅修复缺失的全大写 X 占位 `@font-face`：声明须在样式顶层、仅有 `font-family/src` 两项，且全书标记、内联样式、SVG 与全部清单 CSS 必须能证明该字体的消费者只涉及从未出现的简单 class 选择器。实际使用的字体、普通字体文件缺失、无法静态证明的选择器、动态字体函数、转义、CSS import 或未纳入证明的 stylesheet 均不适用；图片与样式缺失仍拒绝。

只在输出副本删除已确认无用的声明，保留其余 CSS 字节；原书不改。`sourceRepairs` 记录策略版本、原/新 CSS 哈希、精确删除范围及删除片段哈希，报告发出 `UNUSED_FONT_PLACEHOLDER_REMOVED`，`integrity.originalResourcesPreserved` 明确为 false；正文和原图片有独立完整性检查。装配从原书重新计算同一白名单，逐项比对输出 CSS 和报告后再插图，并保留修复记录，最终仍需 EPUBCheck。历史失败任务、费用账本和缓存不改写或自动重试。

# 当前免费目录：编号章节与平级文章（2026-10-29）

目录/cache 版本为 `illustration-sections-3`。编号章或有导航子级的父章保留原解析路径；仅当所有导航均没有此类章节时，才启用平级文章集合：每条文章导航必须精确对应原始 XHTML `body` 直下的同名 `h1`，顺序须与 spine/原始偏移一致。不会将缺少标题的整本书、任意文件或正文截块冒充文章。封面、扉页、版权、目录和明确注释项目按前置/非正文条目排除；普通文章的错名、重复、缺失边界及 NCX/nav 不一致仍拒绝。

文章中的真实 h2–h6 继续划分小节；没有子标题时保留整篇文章标题和实际文档边界。只在文章分支新增无正文的空 `div` 或纯 `img/br` 容器支持，原始元素、图片和文件范围保留，不跳过嵌套段落、表格或未知正文结构。目录解析不创建模型调用，最终转换仍执行完整资源与格式检查。

新目录写入新缓存文件，不删除或修改旧 `illustration-sections-2` 缓存、选择或 Run。编号书籍的真实小节 index 仍为 V2，section ID 的 V2 源哈希/父章/原始位置算法保持不变；新文章小节 index/ID 使用 V3。规划器同时接受 V2/V3 的真实小节索引，仍验证完整覆盖、来源及段落锚点。已完成旧任务继续读私有持久引用；代码更新不承诺让已失败的旧任务自动恢复或重新付费。

# 当前转换版本：不做生成后 AI 视觉复核（2026-10-27）

按用户要求，新网页转换默认使用 `book-art-v1 / subsection-inline-9`，冻结 `imageReviewMode:disabled`，保留 `planningPolicy:content-people-1`，阶段仍为 `art-plan → convert → assemble`。图片生成后不调用视觉模型，不产生 `REVIEWING/REJECTED` 或伪造 `PASSED`，也不要求视觉模型配置才能创建任务。旧 V7/V8 的审查流程与拒绝/UNKNOWN 记录保持原样；刷新旧任务不会切换策略。

免费目录的 `visualReview.enabled` 固定为 `false` 并说明跳过 AI 视觉复核。Run 的新增 `imageReview:{enabled,description}` 描述该任务的实际策略：V9 为 false，历史 V7/V8 为 true；章节 `visualReview` 仍只用于真正做过审查的历史任务。V9 计价不包含视觉审查，省略 `perChapterReviewUpperMicros`；任务请求、计价哈希、全书艺术分析工作区及小节 operation ID 均与 V8 隔离，不能把旧拒绝图片改成新版成功图。

本次取消的是第二次模型看图判断。原书完整性、所选小节范围、文本证据、构思/提示/回执哈希、实际 PNG 格式和尺寸、图片路径及调用 ID、段落锚点、取消/租约 fence、EPUB 内容与资源保持和最终 EPUBCheck 均继续验证。V9 装配会重读源小节和冻结计划，再核对原图回执与进度的图片绑定。文本或生图调用失败仍可产生 FAILED/SKIPPED/UNKNOWN；SENT/UNKNOWN 不重试，生成成功不等于艺术质量已批准。

V9 导出报告为 `schemaVersion:1 / pipelineVersion:chapter-illustration-conversion-3`，显式记录 `imageReviewMode:disabled / visualReview:disabled-by-request`，没有 `visualReviewPolicyVersion` 或章节审查结论。零成功图仍不生成 EPUB。艺术方案仍是暂定，保留构思、全书采样和来源范围，以便用户直接看图判断。

# V8 历史转换版本（2026-10-24）

新网页任务为 `book-art-v1 / subsection-inline-8`，使用 `art-plan → convert → assemble`。目录仍是小节级；免费目录返回 `artPlanning`、`visualReview` 能力声明、一次固定分析预估 `pricing.bookArtUpperMicros` 以及已包含在单节总价中的 `pricing.perChapterReviewUpperMicros`。转换状态在艺术阶段完成后返回 `bookArtPlan`（气质/理由/代表性覆盖范围/媒介与色板等）、`artDirection`，小节完成规划后可返回 `visualPlan` 的 2–3 个候选与选中理由。私有原文 ID、提示与文件路径不返回网页。

V8 在保留 V7 全部视觉门禁的基础上冻结 `planningPolicy:content-people-1`：人物要求相互矛盾的构思在提交生图前停止，无人场景不继承全书人物画法；新规划与缓存隔离，旧记录不升级。新的有界字段余量与最终 800 码点提示硬限制见艺术配置文档。

详见[当前艺术配置契约与边界](illustration-art-direction.md)。V7 在每张图片生成后增加 `REVIEWING`，对五项视觉检查全部通过后才允许插入；不通过或不确定的图片标记 `REJECTED`，记录 `chapter.visualReview` 的结论和理由，`imageUrl` 为空。`counts.rejected` 独立计数并纳入 `completed`。新任务必须显式启用视觉审查，不回退为未审查图片。查询/刷新不发模型请求，也不自动重生拒绝图片或重发未知调用。

V7/V8 没有通过图片时也完成报告流程：只发布 `report`、不生成 EPUB；Run `SUCCEEDED` 表示流程结束，`partial:true` 与 `counts.succeeded:0` 明示无可用插图。最终装配再次校验实际图像、计划、艺术方案及完整质检绑定。此自动模型判断不能等同人工艺术批准；书级方案仍为暂定。下方 V4/V1 字样属于历史实现，结构定位规则仍复用，新任务的版本与阶段以上述 V8 为准；旧 V4/V5/V6/V7 记录不自动升级。

# 小节配图与正文定位（2026-10-23 历史记录）

当前网页新建转换使用 `illustration-sections-2` 目录：章作为不可选分组，真实 h2–h6 标题或保守的 EPUB 正文文档边界作为可选小节。没有标题的文档边界会明确标注，不伪造语义小节；注释、复杂嵌套及不完整结构仍受保护。`chapterIds` 字段名为兼容旧前端而保留，值为当前目录的小节 ID。旧章级任务的私有选择及已发布结果不改写。

小节 ID 绑定原始文件哈希、父章节和原始起止位置；提取器完整读取所选小节内的正文块，程序枚举可插入段落。规划版本为 `subsection-illustration-plan-4`：模型只选择真实场景证据 ID，程序从枚举的 `after-paragraph` 位置中选择紧邻最后一项证据的安全段落。模型不能指定位置别名、路径、HTML 或偏移。事实与环境证据不得晚于所选段落，位置须紧邻最后一项证据（最多相隔三个源块）。超长小节仍有消息、响应、字符、最多八分块等资源边界；分块摘要必须完整覆盖全部输入，归并结果必须引用已读取片段提供的证据。独立小节摘要契约允许 sceneCandidate.synopsis 最多 160 字，旧章级契约不变。

模型可选择 `compact` / `medium` / `wide` 尺寸预设；仅缺少该展示字段时明确采用 medium，记录 `layoutSource:default`。无效的已提供预设仍拒绝。最终由后端注册 CSS 实现 45% / 70% / 100% 相对宽度、居中、随屏幕缩放，避免绕排和绝对定位。前端展示“对应段落后”和实际尺寸。最终装配在同一份不可变原书上一次插入所有成功图片，原有文本、图片、导航、顺序仍验证；阅读器可以调整渲染，设备显示仍须实机验证。

金额限制由 `BUDGET_LIMITS_ENABLED` 控制，默认开启。显式关闭会停用任务/批次/每日金额阻断，价格估算和调用用量仍记录。JSON、Token、文件、并发、超时、结构校验和未知调用不重发规则保持。目录 `pricing.budgetEnforced` 与结果 `budget.enforced` 明示实际开关；关闭不代表上游供应商无配额或免费。旧持久化记录缺少该字段按开启解释。新小节任务记录 `pipelineVersion:subsection-inline-4` 并纳入规范请求、计价指纹和子操作命名空间，同一本书显式重新选择可建立新版任务，旧 UNKNOWN 不重发、不改写。

单元与隔离端到端测试覆盖真实同文档小节边界、精确源锚点、小节中间位置、提前展示证据拒绝、虚构锚点拒绝、布局传递、旧章级兼容和关闭金额限制后的 HTTP 准入。测试使用桩模型，不代表一次付费网页跑通或图片审美获用户认可。

---

以下为早期章级实现记录，接口字段与历史任务仍保留兼容；“每章/章末”不再是新网页转换的定位规则。

# 多章节插画转换

2026-10-23。本机上传页已实现“上传 → 免费目录 → 勾选章节 → 开始转换 → 逐章自动规划和生图 → 多图统一插入同一本 EPUB”。旧单章接口仍保留，但不再挂载为上传页主流程。默认外部服务仍关闭；启用后也只支持本机 local 开发模式。

## 接口

所有 JSON 沿用 `data/meta` 或 `error/meta`，受现有 owner 会话、loopback Host/Origin 和业务开关约束。

| 方法 | 路径                                                                   | 行为                                                                                                                        |
| ---- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/api/v1/books/:bookId/chapters`                                       | 免费解析并缓存目录，不创建 Run，不依赖文字/图片 Key；返回 source/catalog 版本、标题、完整目录和受支持状态，以及配置费用上界 |
| POST | `/api/v1/books/:bookId/illustration-conversions`                       | 严格 `{catalogId,chapterIds,maxCostMicros}`，需要 `Idempotency-Key`；冻结有序选择与预算并返回 202                           |
| GET  | `/api/v1/books/:bookId/illustration-conversions/lookup?requestKey=...` | 使用当前 owner 的私有提交映射恢复丢失的 POST 响应；只读，未知请求返回 `data:null`，不重新提交                               |
| GET  | `/api/v1/illustration-conversions/:id`                                 | 逐章状态、结果计数、预算和最终下载引用                                                                                      |
| POST | `/api/v1/illustration-conversions/:id/cancel`                          | 请求取消，不代表已经提交的模型请求免单                                                                                      |
| GET  | `/api/v1/illustration-conversions/:id/chapters/:chapterId/image`       | 校验 owned 批次进度与私有 PNG 的大小/hash 后 inline 返回；不暴露上游 URL/路径                                               |

目录保留非章节、分节和歧义条目，并显示禁选原因。首期可选项仍要求导航绑定的顶层编号 h1、完整普通正文和安全章末锚点；不是任何 EPUB 都可逐章配图。章节序号支持 0–500，超出范围仍展示但禁选；单批最多选择 501 章，具体还受预算和资源限制。实际目录解析一次解包，不重复逐章解包来构造列表。

转换响应状态使用现有 Run 的 `QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED`，逐章使用 `WAITING/PLANNING/GENERATING/SUCCEEDED/SKIPPED/FAILED/UNKNOWN`。`counts.completed` 是逐章终态数量，粗阶段为 `convert/assemble`；不会为每章创建一个 Run stage。`partial:true` 明确表示只有部分选中章节生成图片。没有任何成功图片时不发布插画版下载。

## 执行与恢复

- API 只建立持久 Run，独立 Worker 顺序处理章节，生图前分别执行完整章节、来源依据与技术插入预检。使用固定 `literary-v1` 画面约束，不要求用户逐章确认提示词。
- 每章稳定子 operation 绑定 owner、book、source、chapter、style 和计价配置。相同子操作复用计划/图片；主批次选择改变不会使重叠章节自动重新付费。
- 相同请求按服务端规范化指纹复用，不因浏览器换 key 重建收费操作；同一浏览器 key 改请求会冲突。丢响应后的短 GET 仅传 requestKey，避免数百章的长 URL 超过请求头限制。
- 每次逐章进度写入私有不可变 JSON，主 Run 的 stage result 仅保存 hash/size/reference。`checkpointStep` 在同一持久化锁/事务中检查有效租约、取消和源书状态，保持原有粗阶段计数语义。
- 源、配置或计价变化停止任务；SENT/UNKNOWN 不自动重发，费用预占保留。收到明确的调用前预算拒绝可显示 FAILED，不冒充结果未知；成功图不因另一章失败而删除。
- 多图从不可变原书一次组装：逐文档按原始偏移逆序插入，CSS 一份，图片/manifest ID 唯一，拒绝冲突锚点。原正文片段与资源独立校验，再对最终整书执行实际 EPUBCheck，最终仅原子发布 EPUB 和报告两个 Artifact。
- 图片在私有受控目录中复用，进度中的已完成图片可预览；本地打包失败不会触发重新生图。渲染不把单章导出文件依次叠加。

## 成本和容量

`ILLUSTRATION_BATCH_BUDGET_MICROS` 是操作员设置的整批保守准入上界，默认 1,000,000（CNY1）。每章按现有规划器硬上界 CNY0.40 加一张图片的配置价格计算；当前默认图片 CNY0.10，所以 UI 显示每章 CNY0.50 的保守上界。它不是每章实际价格承诺，不是预先扣款或供应商账单。默认批次预算允许两章；要处理更大批次，需要显式配置更高的整批限额，并与文字/图片日预算协调。

选择的总上界超过用户提交或服务端限额时，在创建任务前拒绝。工作线程核对冻结计价快照，每次子调用仍受各自全局 UTC 日预算与图片单次限额约束。当前是以章节最坏支出上界控制整批，文本和图片账本仍分开，并非已经实现统一的供应商实际账单结算。UNKNOWN 可能已收费，不释放预占来制造剩余额度。

每个章节的 CLI 仍会做一次自己的完整兼容性预检，可能重复解包和复制来源。当前以单 Worker/顺序执行控制峰值，尚未实现全批共享解析/预检缓存或生产吞吐优化。最终包仍受已有 EPUB 资源/展开总量限制，较大批次可能在产出部分图片后因容量或格式原因不能发布 EPUB；已有私有图片和成本记录保留。

Windows 深目录回归已覆盖：排版和插图引擎使用独立短系统临时目录，产物仍写入任务私有位置；临时目录只在对应处理的 finally 中清理。此修复不放宽来源与完整性检查。

## 交付边界

本机服务、私有资产与已保存的 Windows 加密 Key 继续保留在仓库外，没有提交/push、数据库迁移或公网部署。没有增加新依赖。自动化替身测试覆盖多章合并、部分失败、UNKNOWN、预算、取消、租约、重复请求、恢复和私有预览；实际网页、模型与文件审核证据记录在本地 notes 的 `outputs/batch-conversion/`，不能以自动化测试代替真实模型或阅读器验收。

统一风格输入只约束生成方向，不保证人物或视觉风格完全一致。图像语义、美感和 Apple Books/Kindle 实机显示仍需另验。当前不提供重新生成/替换、批次历史管理、正式账号、自动过期清理或生产数据库批量调度。

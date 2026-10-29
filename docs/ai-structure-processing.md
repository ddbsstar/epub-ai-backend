# 千问结构识别接入

2026-10-21。在[首条业务链](processing-phase-a.md)上加入可选 AI 结构识别。默认仍关闭外部服务，启用后新任务为 `analyze → process → validate → publish`；旧三阶段任务继续使用原配置，刷新不会重新调用模型。

## 如何使用

配置现有 `QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL`，同时启用 `QWEN_ENABLED`、`PROCESSING_ENABLED` 与 `PROCESSING_AI_ENABLED`。API 与 Worker 使用相同配置和私有数据目录。本机启动器需显式追加 `--ai enabled`；密钥通过环境注入，不允许通过命令行参数或前端传入。`--ai disabled` 是启动器默认值。

本次使用千问中国平台兼容接口 `https://maas.qianwenaiapi.com/compatible-mode/v1`，API 模型 ID 为 `qwen3.8-flash`。OpenClaw 的 `qwen/qwen3.8-flash` 含其内部 provider 前缀，不能照搬作本项目模型 ID。接入依据[首次调用文档](https://platform.qianwenai.com/docs/developer-guides/getting-started/first-api-call)、[结构化输出](https://platform.qianwenai.com/docs/developer-guides/text-generation/structured-output)与[OpenAI Chat API](https://platform.qianwenai.com/docs/api-reference/chat/openai-chat)。

本机开发会话限制继续有效；此版本未完成正式账号或公网部署。健康检查只报告配置，不调用模型。Prisma 新增每日预算表的迁移需要在启用真实 MySQL 适配前显式应用，不会在启动时自动运行。

## 模型的职责与边界

先完成本地结构提取及确定性引擎输入检查，再发出付费请求。每次最多选择 32 个安全候选段落，每段摘录最多 240 个 Unicode 码点，总摘录 UTF-8 不超过 16 KiB。请求只包含候选 ID、有限摘录、简短 class 提示和允许的角色；书内路径、完整书籍和凭据不会随提示发送。

模型只可返回 `body / quote / poem / caption / section-title` 中允许的角色。全部候选须恰好覆盖一次，未知 ID、重复项、缺项、额外字段、非白名单角色、截断或非法 JSON 都拒绝。模型不能返回正文替换、CSS、HTML、文件路径或工具调用。书内内容是待分析数据，提示明确要求忽略其中的指令。

有效方案绑定原书 SHA256、分析器版本与样本指纹；排版引擎重新提取并校验后，只给安全顶层段落添加经过登记的样式规则。原始 body 字节、图片、目录与阅读顺序继续检查。复杂布局及不确定结构保留。章节标题仍沿用原标签的语义；本轮不重写 XHTML 节点。

`APPLIED` 表示采用了通过校验的结构方案；`appliedBlocks` 是应用角色规则的样本数，包括普通正文角色，并不等于肉眼可见变化数。这里只处理有界候选结构，不能称整书每段都经过 AI 精修。没有安全候选时跳过模型；任何 AI 失败均明确回退规则排版，再走同样的完整性和 EPUBCheck 发布门。

为在收费前完整检查书内资源，AI 阶段额外执行一次确定性引擎预检查，临时产物随即清理；这增加本地 CPU/磁盘读取。目前不以此实现承诺生产吞吐，后续可拆出共享解析/验证快照避免重复扫描。

## 成本与恢复

每个任务最多一次模型请求，原生 `fetch` 无自动重试。新任务仍可能产生新请求；当前不提供跨任务、跨用户共享缓存。同任务成功方案保存私有不可变文件，元数据只保存指纹、文件引用、哈希、用量与预算记录。

默认消息上限 24 KiB，响应以流计数限制为 96 KiB，输出最多 2048 tokens，超时 30 秒，关闭思考。输入预占以固定 32768 token 预算计费；消息字节加协议余量仅作保守边界，不是供应商的精确 token 计数。

金额全部为 CNY 微元整数（1 元 = 1000000 微元）。默认单任务预算 50000 微元（0.05 元），全局每日预算 1000000 微元（1 元）。价格配置快照为输入每百万 tokens 0.8 元、输出 2.7 元，来自此前本机已验证配置；不假定缓存或免费额度。`AI_PRICE_VERSION` 随价格/模型/地区调整一起更新，实际以[官方定价与账号账单](https://platform.qianwenai.com/docs/developer-guides/getting-started/model-prices)为准。`estimatedCostMicros` 只是模型返回用量乘配置单价的估算，不代表供应商已结算账单。

调用前在短事务内预约任务及 UTC 日预算；发送前持久化 `RESERVED → SENT`。跨 UTC 日恢复会重新检查发送日预算。成功且有合理用量时按估算结算，缺少可靠用量则保留原预占。网络错误、超时、取消、无效输出、写入方案失败等在请求发出后均保守记录 `UNKNOWN`，保留预占，恢复时禁止自动重发。不能保证上游未计费或仅凭本地队列保证上游恰好计费一次。

租约版本保护预约、发送与结果提交；旧 Worker 不能发布缓存或释放预算。取消与最终产物发布仍在同一持久事务检查。本地模式跨进程使用操作系统锁；SQL 分支使用全局 admission 锁、Run/Book 锁及每日预算行，模型和文件操作均在事务外。

## API 和页面

创建导出仍用 `{ "theme": "reader-first" }`，由服务端开关决定 AI；可加 `"ai": false` 显式跳过。客户端不能提供模型、价格、密钥或任意方案。

RunView 新增 `ai`：`status` 为 `DISABLED/PENDING/RUNNING/APPLIED/FALLBACK/SKIPPED`，并包含安全原因码、模型、候选/采用数量、可用 token 用量及估算费用。处理报告附完整安全账本元数据及引擎角色计数，不含提示/响应原文。页面兼容旧任务，明确区分采用、回退、跳过和未启用。未知失败原因采用固定中文提示，不显示上游原文。

## 验证范围

自动测试覆盖引擎角色应用与内容保真、非法计划、接口完整链、输入损坏收费前阻断、预算拒绝、增量响应限制、超时/取消、同任务缓存、旧租约与 UNKNOWN 恢复、每日预算竞争与 UTC 跨日。普通测试全部使用合成 EPUB 与模型替身，不调用付费服务。

真实调用、页面下载与最后测试数量记录在本机工作区的实现报告；不得把模拟测试或 SQL 未启用时跳过的测试视为真实模型/生产基础设施验证。字体、AZW3、章节对比预览、正式账号、自动清理和 Kindle 实机验证仍不属于本轮。

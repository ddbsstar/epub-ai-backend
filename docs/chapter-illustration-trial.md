# 单章插画本地试跑

2026-10-22。已实现 `scripts/illustrate-chapter.mjs`，供开发者显式运行一章、一张章末插画的有界试跑。本文描述代码契约，实际服务调用、导出结果和账单需另附验证记录；不能据此宣称真实试跑已成功。

这条独立 CLI 路径使用现有内部千问文字与生图适配器，本身不启动 HTTP 服务，也不是生产配图流水线。2026-10-23 新增的[本机上传页与 Worker 接入](chapter-illustration-web.md)将它作为内部执行路径；本文的历史试跑记录仍只证明各次明确记录的 CLI 范围。所有模型与业务开关仍默认关闭。整体产品方向仍见[插画工作流讨论稿](chapter-illustration-workflow.md)，图片服务边界见[生图 API 接入](image-generation-api.md)。

## 执行顺序

1. **完整章节索引**：本地解析 OPF/spine、NCX 或 EPUB3 toc nav 与顶层 `h1` 的一致关系，得到逻辑章范围，允许一章跨多个 XHTML；按原顺序提取完整文字块，不复用排版 AI 的 32 段抽样。绑定原 EPUB SHA-256、解析器版本、章节 ID、文档与文字块哈希。顶层段落生成源位置锚点；本次试跑只允许最后一个安全段落之后的章末锚点。
2. **付费前技术检查**：冻结仓库外私有原书副本，验证源哈希，运行保守规则排版及完整资源检查，分别执行原书与基线的 EPUBCheck；基线必须无 fatal/error。再用私有合成像素实际调用插入器，确认选中锚点和原书样式适合插入。这张像素只用于技术检查，不是生成结果，也不发送给模型。
3. **有界文字规划**：整章可以放入请求时一次规划；否则按连续 Unicode 范围分块，最多 8 次 map 加 1 次 reduce。程序逐块核对起止和拼接，超限拒绝，不静默丢弃正文。map 产出短概要、情绪解读、事实依据和候选场景；reduce 只读取这些有界概要与依据，生成一个构思、章末位置、独立生图提示和替代文本。
4. **新生一张图片**：调用现有 `ImageGenerationService.generateOne()`，只发送规划后的文字提示，不传旧图或参考图。调用与下载各有持久检查点；图片实际解码、尺寸和哈希验证后私有保存。
5. **源绑定插入**：程序重新核对原书、章末段落原始片段与图片哈希，生成固定转义模板、图片资源、样式与 manifest 登记。模型不输出 HTML、CSS 或文件路径。
6. **校验后本地导出**：重建内部引用，核对原有正文片段、图片、ID、spine 顺序和导航目标；再运行外部 EPUBCheck，无 fatal/error 才在私有输出目录发布 `illustrated.epub`。原书始终不覆盖。

`COMPLETE` 表示程序确认所选逻辑章文字完整进入单次请求或连续 map 输入，且 reduce 接收全部 map 结果；它不证明模型逐句理解正确，也不证明情绪解释或图像美感成立。正文语义复杂、目录有歧义、嵌套正文不支持、章末没有安全段落或超过调用上限时均拒绝继续，不声称任意 EPUB 可用。

## 文字模型的约束

模型只收到 `b1`、`b2` 等文字块短别名和 `a1` 章末别名，不收到原书文件路径。响应通过严格 JSON schema 校验；事实与场景依据必须逐字引用已提供的别名，未知、重复或跨分块编造的 ID 都拒绝。reduce 只能引用 map 结果已经携带的依据。通过验证后再映射回本地源 ID。

事实、情绪解释和构思分别保存。输入书文作为不可信资料，不执行其中命令。当前仅允许成年人非露骨场景或无人环境；缺少安全场景或依据时模型可以明确拒绝。生图提示去掉块 ID、路径和原文长引语，附加无文字、无水印等本次试样约束。结构检查不能代替人工判断事实是否支持某种解释，也不能保证生成模型准确遵守全部画面要求。

为覆盖整章，所选章节文字会按界限发送到已配置的文字模型服务，范围明显大于原有 32 段抽样；不上传 EPUB 文件、其他章节或本地路径。图片服务只接收最后的安全图像描述。

## 启动与参数

需要 Node.js >=24.15、已安装的 Java/EPUBCheck，以及仓库外私有数据目录。在后端目录构建，准备私有环境和请求文件后运行：

```text
npm run build
node scripts/illustrate-chapter.mjs --request <absolute-private-request.json>
node scripts/illustrate-chapter.mjs --request <absolute-private-request.json> --until plan
node scripts/illustrate-chapter.mjs --request <absolute-private-request.json> --until image
```

默认 `--until export` 执行至导出。`--until plan` 仍会执行付费前检查和真实文字模型规划；`--until image` 继续生图但不插入。它们不是免费的预览命令。没有其他 CLI 参数，也不接收 Key 或 prompt 命令行参数。

请求 JSON 包含以下四个必需字段，并可带默认 false 的 `recoverReceivedResponses` 布尔字段、可选 `sceneDirection` 字符串及可选 `imagePromptReview` 严格对象；其他字段拒绝，文件不得超过 16 KiB：

```json
{
  "sourcePath": "C:/private-books/source.epub",
  "outputDirectory": "C:/private-trials/chapter-one",
  "chapterIndex": 0,
  "operationId": "chapter-one-trial-v1",
  "recoverReceivedResponses": false
}
```

两个路径必须是绝对路径。`chapterIndex` 从 0 开始，CLI 范围 0–500，但章节索引器还会核对实际可支持章节。`operationId` 为 1–80 个字母、数字、点、下划线或连字符。同一操作恢复时保持这些字段及输出目录不变。输出目录应为本次操作专用的仓库外私有目录，不能是源书所在目录或公开静态目录。

`sceneDirection` 为非空的 1–200 Unicode 码点文字，只给直接规划或 reduce 提供选景上下文，不修改 map 输入或已保存的章节事实。它可以缩小已有安全场景的范围，不能发明原书事实、替代依据或取消模型拒绝。修改该字段会改变规划请求指纹，可能产生新的规划费用，不能当作同一请求的免费恢复。

配置由现有 `AppConfig` 校验，变量定义见 `.env.example`：

- 显式启用 `PROCESSING_ENABLED`、`PROCESSING_AI_ENABLED`、`QWEN_ENABLED`、`IMAGE_GENERATION_ENABLED`；`NODE_ENV` 不得为 production，`HOST` 保持 loopback。即使 `--until plan`，CLI 初始化也要求图片开关与其必需配置齐全。
- 配置 `QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL` 和 `IMAGE_API_KEY`；图片服务使用既有平台，不能把其 Key 发送到未经确认的其他服务地址。
- `PROCESSING_DATA_DIR` 使用与正在运行的上传业务隔离的绝对私有目录，不碰业务数据或锁。`IMAGE_DATA_DIR` 也必须与该业务目录隔离，可以复用已审阅的独立生图账本；同一 operation 必须始终使用同一个图片账本，不能换目录重置收费状态。数据库、Redis、队列保持关闭，仓库适配器保持 local。
- 设置绝对 `EPUBCHECK_JAR_PATH`，按安装情况设置 `EPUBCHECK_JAVA_PATH` 和超时；不自动下载或安装校验器。

实际私有启动器、加密凭据和已填请求文件放在仓库外。Key 只在子进程环境中注入，不写进请求 JSON、代码、文档、命令行或前端。不要为了完成试跑创建或应用数据库迁移。

## 费用、幂等与恢复

文字步骤复用现有持久模型账本，每个 map/reduce 分别留存调用记录和私有不可变结果。发送前预占任务与 UTC 每日预算；一整次规划还检查所有预计调用的预占合计不超过 400000 CNY 微元（0.40 元），超过即拒绝。每次调用仍受 `AI_RUN_BUDGET_MICROS` 和 `AI_DAILY_BUDGET_MICROS` 约束。结果估计金额来自配置价格与可靠用量，不代表供应商最终账单。

图片使用独立 SQLite 账本、`IMAGE_OPERATION_BUDGET_MICROS` 与 `IMAGE_DAILY_BUDGET_MICROS`；本次仅一个 `chapter-image-v1` 调用。文字与图片尚未共享统一操作账本，不能把两者费用当成已经统一事务结算。服务价目、配置估计与实际账号账单需要分开记录。

付费调用不自动重试。文字或图片请求发送后结果不明时保守记 `SENT/UNKNOWN` 并保留预占，同一操作恢复不会自动再次付费。已成功的文字结果须通过私有文件大小、哈希和 schema 校验后复用；图片已成功则复用私有资产，缺失或损坏不会收费补画。供应商已成功但图片下载未完成时，仅在有效私有下载检查点允许的情况下恢复下载，详见[图片恢复规则](image-generation-api.md)。

输出目录的 `private/binding.json` 绑定原书、章节、operationId、编译后的规划器及文字/图片配置指纹；同目录换源或换配置会拒绝，先保存私有 `binding-conflict.json` 供核对，不自动修改绑定。另以 `private/image-store-binding.json` 冻结绝对 `IMAGE_DATA_DIR`，保证恢复时仍处于原有图片账本命名空间，不能通过换图账本重复付费。插入与导出另存计划、图片和成品哈希检查点，校验/发布失败后可复用已有结果。Windows 瞬时 `EPERM/EBUSY` 只对同一临时文件的原子 rename 做最多 630ms 退避，保持本地 OS 锁，不删目标、不非原子覆盖，也不重跑付费步骤。

不要删除账本、检查点或换 operationId 来绕过 UNKNOWN；这会丢失已有费用与操作关系。没有有效结果时应先核对供应商记录，当前没有自动重新付费按钮。

## 本次开发试跑的离线响应恢复

2026-10-22 的 v2 规划诊断中，前两次 map 已成功；第三次供应商已返回 JSON，但 `emotionalReading` 有 81 个 Unicode 码点，超过原本 70 的本地校验上限，因此本次规划停下。失败不表示供应商没有执行或没有收费。收到的原始响应已在本地解析前写入私有检查点，原调用账本仍为 `UNKNOWN/HELD`。

本次修正保持提示词目标 70 字，将 map 响应这一字段的可接受上限放宽到 100 Unicode 码点；没有截断或改写已收到的结果。其他 schema、事实别名、源依据、预算与输入覆盖检查继续执行。只改变本地验证容忍度，不自动修改供应商请求或发起替代付费调用。

为复用这份确实已收到的响应，开发者必须显式设置 `recoverReceivedResponses:true`。恢复只能读取与原调用指纹、输入、提示版本和文件哈希严格匹配的私有响应，使用当前 schema 与依据规则重新校验；任何一项不符就拒绝。恢复收据明确标记 `recoveredFromPrivateResponse:true`，不把原来的失败调用改写成 `SUCCEEDED/SETTLED`，也不释放其 `UNKNOWN/HELD` 预占。账单仍需另行核对。后续尚未调用的阶段依照正常预算继续，不能把整个流程称为零费用恢复。

这是“已经收到供应商响应、仅本地后置校验失败”的受限离线恢复，不适用于网络超时、没有私有响应、响应丢失/损坏、缺少可靠匹配记录或普通未知结果。默认 false；正常 `SENT/UNKNOWN` 依然不会自动重发或自动恢复。

此次开发修正还改变了编译后的规划器哈希。普通 `binding.json` 冲突仍拒绝；仅对此已审阅试跑，操作者先核对私有冲突记录，确认只有 `plannerCode` 变化，再在仓库外 `private/binding-amendment.json` 记录旧绑定与请求绑定（`previous`/`requested`）、旧/新代码 SHA、`reason` 及相应 `tests` 证据，然后明确修订绑定。CLI 不自动认可或应用这份修订。该记录不是 HTTP 参数，也不是允许任意换模型、换源、换提示版本或清空账本的通用入口。`recoverReceivedResponses:true` 本身不绕过绑定或图片账本检查。

这里记录的是实际中断原因与受限恢复规则，不代表整条章节导出已成功；完整成功仍须追加最终图片、插入、EPUBCheck 和导出哈希证据。

## 已保存拒绝与明确改变选景输入

本次随后完成了全部 4 个 map，其中第 3 个来自上述已收私有响应恢复。原 reduce 调用成功返回 `DECLINE:NO_SAFE_SCENE`，因此当时没有生图或导出。该拒绝响应和原调用记录均保留；业务拒绝不是网络未知结果，也不能通过重置原调用或反复提交相同输入消除。

本次操作者另行补充 `sceneDirection`：仅在已保存 map 事实中选择雪晨、野画眉所对应的既有 `b3` 依据，采用无人环境，排除战争、室内器物与人物。该方向是对已有文本依据的收窄，不把先前图片或全书风格视为已获批准。4 份 map 输入和结果不变；仅带方向的 reduce 构成一个不同指纹的新规划请求，本次最多新增一次 reduce 付费调用。原拒绝记录不覆盖、原任务状态不重置，新的规划仍允许返回拒绝，也继续受原有依据和安全校验约束。

为提供这个可选输入而改变的编译代码，也需要追加第二份经过核对的本地绑定修订记录，保留旧/新哈希、变更原因与测试证据。CLI 仍不自动应用绑定修订。这里没有把 `sceneDirection` 设计成自动重试或强制绕过安全拒绝的入口，尚未证明这次新规划、生图或导出已成功。

## 生图前的本地人工提示复核

本次继续核对原文后，发现模型图像提示使用木屋，与 `b116` 的石头寨子依据不一致。这说明别名与 JSON 校验通过仍不足以验证提示的语义事实。此次在首次生图前，由本地操作者补充图像提示复核：明确石房及高低空间关系，删除缺少依据的枝头位置和厚雪；鸟的具体位置、绘画媒介等另在场景简报中标为艺术安排，不冒充原文事实。

可选 `imagePromptReview` 只允许四个必需字段：

| 字段             | 契约                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `sourcePlanHash` | 原始语义规划的 64 位小写十六进制 SHA-256，必须与当前原计划精确匹配 |
| `prompt`         | 1–800 Unicode 码点的独立生图文字提示，继续经过图片服务输入检查     |
| `alt`            | 1–500 Unicode 码点，且须为有效、非空、可安全写入 XML 的替代文本    |
| `reason`         | 1–500 字符的本地复核原因                                           |

默认不提供此对象，继续使用模型的原提示与替代文本；它不自动进行事实、美感或安全审核。提供时 CLI 先核对 `sourcePlanHash`，不匹配则报 `ILLUSTRATION_REVIEW_CONFLICT`，在图片付费前停止。原模型规划完整保留在 `plan.json`，人工复核独立保存到 `image-prompt-review.json`，不改写原计划，也不额外请求文字模型。最终有效计划哈希包含原计划哈希和完整复核对象，插入/导出恢复继续校验该哈希。

这是开发者显式提交的本地人工复核入口，不是上传页功能或自动质量验证器。它不能覆盖旧图片账本、清除 UNKNOWN 或在已经生成后无费用地换图；同一图片调用仍核对原有输入指纹并遵守预算。这里记录复核契约与此次选景纠正，尚不代表图片已经生成、事实问题已由程序自动解决或最终导出已完成。

## 输出与证据

整个输出目录均按私有资料处理，即使文件不在 `private/` 子目录，也可能包含书籍概要和本地资源引用：

| 路径                                                                 | 含义                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `private/chapter-index.json`                                         | 选中整章的文字、源位置、哈希与候选锚点，禁止公开                |
| `private/binding.json`、`private/image-store-binding.json`           | 操作、规划配置与原图片账本命名空间绑定                          |
| `private/binding-conflict.json`、`private/binding-amendment.json`    | 冲突证据与本次开发试跑操作者的私有修订说明；不自动应用          |
| `private/inputs/source.epub`                                         | 校验后的原书私有冻结副本                                        |
| `private/preflight.json`、`source-check.json`、`baseline-check.json` | 付费前规则基线、原书/基线 EPUBCheck 证据；后两者在 private 目录 |
| `private/text-state/`、`private/illustration-plans/`                 | 隔离文字账本与不可变响应/结果                                   |
| `plan.json`                                                          | 概要、情绪、事实依据、构思、章末锚点、生图提示及调用收据        |
| `image-prompt-review.json`                                           | 可选人工提示、替代文本、原因、原计划哈希与有效计划哈希          |
| `image-receipt.json`                                                 | 图片调用、私有资产引用、估计费用和复用标记                      |
| `private/insertion-checkpoint.json`                                  | 校验/发布前可恢复的插入结果及绑定哈希                           |
| `output-check.json`                                                  | 最终成品的外部 EPUBCheck 原始报告                               |
| `illustrated.epub`、`illustration-report.json`                       | 私有成品及插入完整性报告                                        |
| `pipeline-result.json`                                               | 完成状态、调用引用、成品哈希/大小、最终格式计数与未验证标记     |
| `stage-receipt.json`                                                 | 显式停在 plan/image 时的阶段收据，不是完成导出证明              |

图片本体位于 `IMAGE_DATA_DIR` 对应私有资产目录，不由 CLI 建立公开地址。终端只输出安全阶段、计数、状态和收据引用，不输出书文、prompt、Key 或上游图片临时 URL。

基线排版可能调整全书可安全处理文档的样式；本次插画只新增在所选章末。插图后目标 body 字节必然改变，报告使用“原有正文源片段保留 + 精确允许的新增内容”校验，不能继续声称所有 body 字节完全相同。原书、原有图片、原有 ID、阅读顺序和导航目标分别核对。插入器自身报告的 `epubcheck:not-run` 表示该低层函数不调用外部工具，CLI 的真实外部检查证据在 `output-check.json` 与 `pipeline-result.json`。

默认测试均为合成书与替身模型，不产生真实费用。尚需真实调用记录证明端到端完成；即使 EPUBCheck 无错误，也不等于插画美感获批、Apple Books/Kindle 显示已验证、完整书籍规划可用、上传 UI 已接入或生产部署完成。当前收据明确保留 `readerDeviceValidated:false`、`uploadUiIntegrated:false`。

## 2026-10-22 实际试跑结果

本次本地端到端试跑现已完成，以下证据更新前文按阶段记录的“尚未完成”状态。私有证据保存在本机 notes 工作区的 `outputs/` v2 试跑目录，不包含在仓库中，也不在本文提供公开下载链接。

- 完整索引小说第一章，共 4 个文档、312 个文字块、19581 Unicode 码点。v2 实际提交 4 次 map、1 次返回 `DECLINE:NO_SAFE_SCENE` 的原 reduce、1 次补充选景方向后的新 reduce，共 6 次文字请求；第 3 次 map 使用已收私有响应离线恢复，其原账本继续保留 `UNKNOWN/HELD`。此前 v1 另有 1 次失败调用保留预占，不计入这 6 次，也未清除。
- 生图前实际进行了上述源依据人工复核；此次流程依赖操作者纠正提示，尚非完全自动。随后通过现有平台 `z-image-turbo` 真实新生 1 张图片，采用文字输入，不编辑旧图，并在第一章末插入 1 张 PNG。
- 最终 EPUBCheck 为 0 errors、0 warnings；独立完整性检查 155/155 通过。目标正文移除唯一新增插图包装后，55 个原始 body 均恢复匹配；7 张原图、spine 和导航保持。插入后的目标 body 确实改变，不能描述为全部正文 body 字节未变。
- 成品大小 1941025 bytes，SHA-256 为 `8bc854c9986c171c662eaa50434ac44d1dab44a7ef40017cedcb933715f82c21`。相同请求重放复用已有结果，文字/图片账本调用数未增加，成品哈希保持一致。后端完整 `check` 通过，286 项测试通过。
- 按配置费率计算的已结算估计为文字 20006 微元、图片 100000 微元，合计 CNY 0.120006；v1/v2 两次未知文字调用另保留 63488 微元（CNY 0.063488）预占。以上是本地账本配置估计与保留额度，不是供应商实际发票或最终扣费凭证。

图片仍增加了建筑细节和树木等艺术性补充，不能宣称所有视觉元素均为原文事实。用户尚未批准该画风；Apple Books/Kindle 设备显示、美感与完整书籍一致性均未验证。本次完成范围仍是本地 CLI，不包含 HTTP 配图接口、上传 UI 或生产任务编排接入。

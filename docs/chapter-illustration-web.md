# 章节插画网页接入

2026-10-23。本机上传页在基础排版完成后增加章节插画区。用户选择章节，显式提交概要与场景规划；查看并可修改画面描述与替代文本，再显式生成一张图、嵌入章末，完成校验后在页面预览和下载插画版 EPUB。此版本一次选择一个章节、一幅图，尚不支持多章图集汇总导出或整书自动批量。

用户随后明确的[上传 → 全部章节勾选 → 一次转换 → 多图统一插入整书](upload-chapter-conversion-flow.md)已实现本机版本，详见[多章节转换接口与边界](chapter-illustration-conversion.md)。本文以下保留早期单章验证接口的说明，主上传页已改用批量流程。

## HTTP 和任务

所有接口继续使用本机 `BusinessAccessGuard` 的会话归属、loopback Host/Origin 与生产禁用限制，JSON 沿用 `data/meta` 封装。

| 方法 | 路径                                       | 行为                                                                                        |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| POST | `/api/v1/books/:bookId/illustrations/plan` | 严格 `{chapterIndex:0..500}`；按 owned book＋章节生成服务器固定幂等键并创建规划 Run         |
| GET  | `/api/v1/illustrations/:id`                | 只读状态和已有安全构思；plan 的 `exportId` 支持生成提交响应丢失后的恢复                     |
| POST | `/api/v1/illustrations/:planId/generate`   | 严格 `{prompt,alt}`；仅接受已完成且当前会话拥有的规划，生成 Run 按 plan ID 固定幂等         |
| GET  | `/api/v1/artifacts/:id/download`           | 已发布私有图片/EPUB/报告；PNG 使用 inline，保留归属、hash、nosniff、no-store 和同源资源策略 |

POST 需要 `Idempotency-Key`。服务器的固定规划/生成键不依赖客户端换 key。不同生成描述冲突不会创建第二个收费图片操作。每次编辑确认保存到私有不可变文件，主任务元数据只保留其 key/hash/size，原模型构思另存，不把修改描述冒充模型原始输出。

## 执行边界

API 只创建持久任务，现有独立 Worker 负责执行。规划与生成分别使用 `illustration-plan`、`illustration-export` operation。Worker 启动固定 Node CLI，参数只含服务器控制的请求文件路径；不用 shell、不给命令行传 Key，不转发原始输出。子进程通过 IPC 接收取消，父 Worker 持续续租；最后只由现有 `completeStep` 原子检查租约、取消与书籍状态后发布产物。

沿用 [CLI 的全章索引、付费前检查、严格段落依据与插入完整性约束](chapter-illustration-trial.md)。同一规划及生成固定 workspace/operation，复用模型结果和已生成图；不会因 GET、看图或页面刷新再次付费。子 CLI 全局共用独立的 `illustration-text-state` 账本与 UTC 日预算，按 operation 分隔 owner，避免中断的某个任务阻塞其他章节。该账本与主排版文字账本、图片账本目前仍是三套独立预算，不是统一整书成本账本。SENT/UNKNOWN 继续保守停止，不自动重发或释放预占。

`PROCESSING_ENABLED`、`PROCESSING_AI_ENABLED`、`QWEN_ENABLED`、`IMAGE_GENERATION_ENABLED` 需显式启用，适配器仅 local、非 production。默认仍关闭，没有自动数据库迁移。当前开发启动器在仓库外通过 Windows 加密凭据注入模型 Key，不能复制进前端或仓库。

## 页面与限制

页面只存当前 book/plan/export ID 和章节索引以恢复查询，不把提示词或 Key 放浏览器持久存储。规划和生图 POST 只发生在明确点击时；失去生成响应后先查询 plan 的 canonical export。只有成功发布时显示真实图片和下载入口，不使用示意图片冒充结果。

允许任意受支持章节索引，但当前 UI 每本书仅保留当前一组任务；生成后不能在同一本产物内继续追加别章。图片在页面直接预览，EPUB 中仍位于选中章末。看图、原图链接和 EPUB 下载是不同入口。多章累积、多图密度、人物/画风一致性、自动艺术质量判断、整书预算与账号/清理/公网部署尚未实现。

结构校验和来源 ID 检查不等于语义或艺术判断完全正确；画面描述需要用户复核。设备与 Apple Books/Kindle 的真实显示仍需独立验证。

## 验证范围

本文描述已实现的接口、页面与执行边界，不将实现完成等同于真实模型端到端成功。自动化测试使用受控替身验证协议、归属、幂等、恢复与发布约束；真实模型规划、生图、页面预览、下载文件完整性和阅读器显示分别需要运行证据。模型拒绝、后置校验失败和 UNKNOWN 调用均保留原记录，不通过重新提交掩盖失败。

# 生图 API 接入

2026-10-21 接入，2026-10-23 更新。范围：NestJS 内部 `ImageGenerationService` 与本地 CLI，接入现有千问平台的 `z-image-turbo` 同步文字生图接口。没有公开模型代理 HTTP 路由。[单章插画本地试跑 CLI](chapter-illustration-trial.md)显式编排完整章节索引、概要/位置/构思、一张独立生图、章末插入与 EPUBCheck；[本机上传页与 Worker](chapter-illustration-web.md)现通过该 CLI 执行章节插画任务，并提供成功发布后的私有图片预览。这不改变本服务的默认关闭、私有存储和无自动付费重试边界。更完整的产品方向仍见[工作流讨论稿](chapter-illustration-workflow.md)。

## 协议与配置

固定调用 `https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation`，模型 `z-image-turbo`，尺寸 `1024*1024`，`prompt_extend:false`。仅发送一条文字，不传参考图或进入改图模式。[平台文档](https://platform.qianwenai.com/docs/api-reference/image-generation/z-image)限制提示词 800 字符，本版按 800 Unicode 码点加 8192 UTF-8 字节限制，超限拒绝，不截断。响应上限 96 KiB，严格检查完成状态、单条 choice、单个图像和 `usage.image_count:1`；默认超时 120 秒，无自动重试。

[平台价格表](https://platform.qianwenai.com/docs/developer-guides/getting-started/model-prices)在接入时列出关闭改写为 0.10 元/张。当前收据金额是配置估计，不是账号已结算账单。该平台是已有第三方服务；其 Key 不发送到官方阿里云区域接口，目标域名不可随意替换。

`IMAGE_GENERATION_ENABLED` 默认 false，与文字模型/EPUB 处理开关独立。启用需要 `IMAGE_API_KEY`、绝对私有目录 `IMAGE_DATA_DIR`，当前只允许本地开发环境。完整配置见 `.env.example`。金额为 CNY 微元整数；默认单次操作 100000、每日图片调用 1000000。启动、健康探测和默认测试不调用图片服务。

## 调用方式

Node >=24.15，在后端目录构建后调用：

```text
npm run build
npm run image:generate -- --request <absolute-private-request.json>
```

私有请求文件：

```json
{
  "ownerId": "local-development",
  "operationId": "illustration-one",
  "callKey": "image-v1",
  "prompt": "An original, restrained book illustration..."
}
```

文件和生成物均放仓库外。Key 只从环境注入，不放请求文件、命令行或前端。CLI 输出安全 JSON 收据：调用 ID、模型、估计费用、私有 PNG 路径、hash 与尺寸，不输出 Key、prompt 或上游临时 URL。内部模块可依赖注入调用 `generateOne()`，无需绕行 HTTP。

## 保存和恢复

只下载精确白名单中的 HTTPS 域名，拒绝重定向和内网 DNS；实际 TLS 连接固定在已核验公网 IP，保持原 hostname 校验，不发送鉴权头。下载有流大小/超时限制，Sharp 实际解码验证像素与格式，仅接受 PNG/JPEG，导出不带原元数据的 PNG。

真实响应另外使用 `dashscope-a717.oss-accelerate.aliyuncs.com`，已按精确 host 加入默认名单。其他账户/服务返回不同桶时仍拒绝，由操作者核实具体 host 后配置，不能改为任意域名或通配符；已保存的检查点可随后恢复下载。

`IMAGE_DATA_DIR/assets/` 保存私有图片，同一目录中的独立 SQLite 库保存小型账本。关闭时不创建文件，不触碰正在运行的 EPUB 数据/锁。目录不得成为公开静态目录。

按 owner/operation/callKey 去重并核对内容/模型/规格/价格版本指纹。操作预算首次冻结；事务与 claimToken 防止跨进程重复发送，库内最多一个在途调用。发送前持久化 SENT；任何发送后的失败保守记 UNKNOWN、保留预占，不自动重画。跨 UTC 日发送重新准入。成功按配置的单张价格估计结算，不伪造 token 用量。

同一请求再次运行，文件 hash 有效就复用。文件丢失或损坏直接拒绝，不收费补画。过期 RESERVED 可安全取消释放，过期 SENT 转 UNKNOWN 并保留预算；旧 claim 无法提交。供应商成功返回后先把临时 URL 写入仓库外私有 `pending/` 文件，账本仅保存该文件引用与 hash，之后才下载。若下载失败，再次执行同一请求可在验证检查点和取得新 claim 后仅恢复下载，不重发生图、不重复预约费用、不改变原生成日预算；成功后清除临时 URL 文件。检查点缺失、损坏或链接过期仍然失败并保留原费用，不自动重画。历史无检查点的 UNKNOWN 不能凭空恢复。

当前账本只累计图片调用，尚未与文字分析合并为整本工具流预算。已发布图片的私有预览与下载由本机业务接口提供；尚未提供正式账号、图片账本的 MySQL 适配、自动清理或公网部署。接入 API 不表示图像已达到书籍美感要求。

章节试跑另有默认关闭的 `recoverReceivedResponses`，只用于严格匹配的已收私有文字响应在本地重新校验，保留原 UNKNOWN 账本与预占，详见[受限离线恢复](chapter-illustration-trial.md)。它不作用于生图账本，不使图片 UNKNOWN 自动重画；图片仍只按本节已有供应商成功检查点恢复下载。

同一章节 CLI 的可选 `sceneDirection` 作用于文字规划，不修改图片协议；新方向可能产生一笔新的文字规划费用，仍须通过依据与拒绝检查后才允许调用图片服务。先前规划拒绝不会被覆盖，也不会自动转成生图重试。

## 验证

离线测试覆盖协议/输入/响应边界、无重试、超时取消，下载域名/DNS/IP 固定/重定向/解码/像素体积，账本并发/跨日/预算/UNKNOWN/旧 claim/重开，服务重复调用复用/冲突/损坏缓存。

独立图片服务的真实调用结果在本机工作区另存；替身测试不代表真实账号权限或实际账单。单图服务本身不修改 EPUB；章节 CLI 是否真实完成须以其单独验证记录为准，不能由图片接入记录推断。Apple Books/Kindle 插图效果尚未验证。

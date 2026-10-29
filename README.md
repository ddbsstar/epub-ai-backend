# EPUB AI 后端

NestJS 12 + TypeScript，使用独立仓库管理。需要 Node.js >=24.15，推荐 Node 24 LTS。

已实现本机 EPUB 上传、后台处理、校验与下载，并可选接入千问识别有界候选结构。启动方式见 [业务实现说明](docs/processing-phase-a.md)，AI 范围、预算与恢复见 [千问接入说明](docs/ai-structure-processing.md)。业务与 AI 调用均默认关闭，当前本机会话模式不用于公网部署。

另已接入独立的内部文字生图服务，默认关闭；命令、图片预算与私有保存见[生图 API 接入](docs/image-generation-api.md)。开发者可通过[单章插画本地 CLI](docs/chapter-illustration-trial.md)显式试跑完整章节索引、概要规划、一张新图、章末插入与校验导出。

[多章节插画转换](docs/chapter-illustration-conversion.md)已连接本机上传页、HTTP 与独立 Worker：上传后免费列出目录，勾选章节并点击转换后自动规划、生图，将成功图片统一插入同一本 EPUB，提供私有预览与整书下载。预算、受支持章节和处理容量仍有限制，默认批次预算上界为 CNY1；旧[单章验证接口](docs/chapter-illustration-web.md)保留。所有外部服务仍需显式启用，尚未完成生产任务编排与公网部署；实现与自动化测试不代表任何书籍、艺术质量或阅读器显示均已验证。

本地章节试跑对已收到但后置校验失败的私有文字响应提供显式离线恢复，默认关闭，严格匹配输入与调用证据并保留原 UNKNOWN 预占；这不改变正常未知结果禁止自动付费重试的规则。具体条件见上述 CLI 文档。

新网页任务使用[按书籍内容制定艺术方案](docs/illustration-art-direction.md)：`art-plan → convert（规划/生图）→ assemble`，先从代表性样本确定本书视觉配置，再为完整选中小节提出 2–3 个有据构思，代码将选中项落实到生图提示。当前 V9 按用户要求取消生成后的 AI 二次视觉复核：生成成功图经来源、计划、PNG、锚点与 EPUB 格式检查后插入，报告明确标记未做 AI 视觉复核，不伪造 PASS。V7/V8 历史门禁和拒绝/UNKNOWN 记录不变，新旧任务与缓存指纹隔离。方案仍是暂定，生成成功或格式检查通过不代表用户艺术批准。

可选 `sceneDirection` 只收窄已有依据下的选景。改变方向会形成可能收费的新规划输入，保留先前拒绝结果，不覆盖或重试原拒绝调用。

## 本地开发

```sh
npm ci
```

复制 `.env.example` 为未跟踪的 `.env`，然后启动：

```sh
npm run start:dev
```

默认监听 `127.0.0.1:3000`。数据库、Redis、队列和千问默认关闭，复制示例配置后即可启动。Windows 可用 `Copy-Item .env.example .env`；如 PowerShell 拦截 `npm.ps1`，使用 `npm.cmd`。

- 健康接口：`GET /api/health`
- 就绪接口：`GET /api/health/ready`，已启用的基础设施不可用时返回 `503`；默认关闭的依赖不阻止就绪。
- 开发接口文档：`/api/docs`，OpenAPI JSON：`/api/docs-json`
- 生产环境文档默认关闭；部署到容器时将 `HOST` 设为 `0.0.0.0`。

## 接口约定

成功响应由全局拦截器包装：

```json
{
  "data": {
    "status": "ok",
    "service": "epub-ai-backend",
    "dependencies": {
      "database": "disabled",
      "redis": "disabled",
      "queue": "disabled",
      "qwen": "disabled"
    }
  },
  "meta": { "requestId": "request-id" }
}
```

错误统一为 `{ error: { code, message, details? }, meta: { requestId } }`，响应头同步提供 `x-request-id`。DTO 使用 `class-validator` / `class-transformer`，全局拒绝未知字段。控制器返回业务数据即可，无需再次包装。

健康接口报告进程及依赖状态；启用 MySQL 时会执行有连接超时的 `SELECT 1`，结果缓存 5 秒。模型状态 `configured_not_checked` 只说明配置已启用，不代表模型连通或书籍处理可用，健康检查不会调用付费 API。上传、规则排版、任务查询与下载接口通过 `PROCESSING_ENABLED` 显式启用，正式账号登录尚未实现。

## 基础设施

| 模块     | 实现及边界                                                                         |
| -------- | ---------------------------------------------------------------------------------- |
| 配置     | Zod 严格校验端口、开关、URL 和必需凭据；失败只输出字段名                           |
| 日志     | Pino 结构化事件和请求编号；不记录请求体、头、书籍内容或原始异常                    |
| HTTP     | Helmet、安全请求大小限制、DTO 校验、统一错误、内存限流                             |
| MySQL    | Prisma 7 + MariaDB adapter，连接池可配置，显式迁移                                 |
| 后台任务 | 独立 Worker、步骤检查点与持久幂等；本机文件驱动或 MySQL/BullMQ 适配                |
| AI       | 受约束角色方案、持久调用账本、任务与每日预算、结果缓存；无公开模型代理、无自动重试 |

单实例内存限流适用于当前阶段。多实例部署前应采用共享限流存储；可信代理设置需要按实际反向代理拓扑配置，当前不信任任意转发头。

## 数据库与队列

本地依赖可用 `compose.dev.yml` 启动，绑定 `127.0.0.1:3307` 和 `127.0.0.1:6380`。先在 `.env` 设置示例中的 MySQL/Redis 密码；空密码会使 Compose 拒绝启动。具体命令及 URL 编码见 [部署说明](docs/deployment.md)。

按需配置 `DATABASE_URL` / `REDIS_URL` 并打开 `DATABASE_ENABLED`、`REDIS_ENABLED`、`QUEUE_ENABLED`。队列要求 Redis 同时启用。

```sh
npm run prisma:generate
npm run db:validate
npm run db:migrate:dev -- --name describe_change
# 部署时由操作者显式执行，不随应用启动执行
npm run db:migrate:deploy
```

数据库脚本在缺失真实 `DATABASE_URL` 时拒绝执行迁移。`prisma:generate` 和 `db:validate` 不连接数据库。初始迁移保留 `background_jobs`，新增迁移建立 EPUB 业务元数据表及模型每日预算表；应用不会自动应用迁移。不要把迁移命令指向未确认的已有数据库。

Worker 负载只含任务/步骤 ID 与派发代数，并发默认 1，恢复和发布通过数据库状态及租约控制。仅在显式启用业务 AI 时调用模型；SENT/UNKNOWN 调用恢复后不会自动重发。生产迁移使用单独的 Docker `migration` target，运行镜像只保留生产依赖。

## 配置与凭据

变量及默认值见 `.env.example`。千问需要显式启用 `QWEN_ENABLED` 并设置服务端 Key、兼容 API 地址与模型名称，业务还要求 `PROCESSING_AI_ENABLED`。默认输出上限 2048 tokens、超时 30 秒；金额为 CNY 微元，价格版本与费率应随模型/地区一起调整。生产模型地址要求 HTTPS，不接受 URL 中的用户名、密码或查询参数，不跟随重定向。

`.env`、生成客户端、上传及构建产物均被忽略。模型 Key 和连接密码只属于后端；不能放入前端或提交到 Git。

## 检查与测试

```sh
npm run check
```

包含 Prisma 生成/校验、Prettier、Oxlint、TypeScript、Vitest HTTP/配置/模型边界测试和生产构建。测试不调用真实模型；普通测试不依赖 MySQL/Redis，并忽略本地 `.env`。

`npm run test:integration` 只在 `RUN_INFRA_INTEGRATION=true` 且配置指向隔离的本机 `3307` / `6380` 时执行 MySQL CRUD 和队列持久化测试。CI 会启动临时依赖、应用迁移并清理测试记录，不使用生产凭据。

GitHub Actions 同时检查代码、真实 MySQL/Redis 集成和非 root 容器启动；镜像不会自动发布。Dependabot 提交依赖升级 PR，依赖更新仍需通过检查。

## 目录

```text
src/
  ai/          # 内部模型适配入口
  common/      # HTTP 协议、校验、错误和日志
  config/      # 环境变量边界
  database/    # Prisma 生命周期
  health/      # 健康接口
  queue/       # Redis、BullMQ 生命周期
prisma/        # schema 和可审阅迁移
test/          # HTTP、配置、模型及隔离依赖测试
docs/          # 容器和部署说明
```

新增功能应建立自己的模块，复用公共校验、日志与协议。构建输出 `dist/`，使用 `npm run start:prod` 启动。所有外部服务客户端在应用关闭时释放连接。

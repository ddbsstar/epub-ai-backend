# EPUB 业务实现：首条上传与导出闭环

2026-10-20 首阶段记录。该阶段实现本机开发业务闭环，样书验证使用规则排版。2026-10-21 后续已加入可选千问结构识别，当前 AI 开关、预算与恢复见 [AI 接入说明](ai-structure-processing.md)。架构基线见 [backend-architecture.md](backend-architecture.md)。

## 已实现

- multipart 文件流上传，最大 100 MiB，专用私有目录、SHA256、随机对象 key；文件不会存入代码仓库、MySQL 正文列或队列 payload。
- 随机 HttpOnly/SameSite 本机会话区分归属，原书、任务与产物分别核验访问。当前不提供正式账号登录，业务开关只允许非生产、loopback 环境；默认关闭。
- 独立 API 与 Worker，三个真实阶段：`process → validate → publish`。真实阶段计数、持久幂等、取消、步骤检查点、租约、旧 Worker fencing、派发代数恢复及多个产物原子发布。
- 通用发现 container/OPF/manifest/spine/目录路径，逐 entry 解包/写包，逐章解析。保守规则整理明确语义的文字章节，复杂章节保留并报告；原始 CSS 存档保留，新样式引用副本。
- 全部正文 body 原始字节、原图片、资源引用与阅读顺序检查；受约束修复 XHTML DOCTYPE、NCX UID/playOrder。EPUB 2 仅在唯一 PNG/JPEG 封面条目的 `properties` 单一 token 为 `cover-image`，且已有唯一匹配的 `meta name="cover"` 时，移除冗余 EPUB 3 属性并记录 `OPF_EPUB2_COVER_PROPERTY_REPAIRED`；其他属性、版本及缺失/冲突封面声明留给格式检查，不猜测修复。写出的 ZIP 再逐条目验证 CRC、SHA256、大小。
- 外部 EPUBCheck 对原书和导出分别检查，新增错误或 fatal 阻断发布。原书已有且未增加的问题会在摘要/报告明确显示，不把它们宣称为零错误。
- 可下载 EPUB、处理报告及原书安全 JPEG/PNG 封面。前端接真实文件选择/拖入、幂等创建、轮询、取消、刷新恢复与下载。

## 本机启动

需要 Node.js >=24.15、Java 11+、独立安装的 EPUBCheck 5.4.0 完整发行包。`--epubcheck-jar` 指向发行包中的 jar，其旁边的 lib 等依赖也须保留。

后端先执行 `npm ci`、`npm run build`。随后两个终端使用相同的专用数据目录：

```powershell
# 终端一：API；将下列两个路径换成实际绝对路径。
npm run start:local -- api --data-dir C:\epub-local-data --epubcheck-jar C:\tools\epubcheck\epubcheck.jar

# 终端二：独立 Worker。
npm run start:local -- worker --data-dir C:\epub-local-data --epubcheck-jar C:\tools\epubcheck\epubcheck.jar
```

如果 Java 不在 PATH，追加 `--java` 参数和 Java 可执行文件路径。启动器显式关闭数据库、Redis、队列和千问，只监听本机。前端仓库使用 Node 24 运行 `npm run dev`，访问 `http://127.0.0.1:5173/upload`；`/api` 代理到 `127.0.0.1:3000`。

普通 `npm run start:dev` / 生产镜像仍保持默认业务关闭；不要仅为了显示上传页将该本机模式暴露公网。`PROCESSING_ALLOWED_ORIGIN` 默认前端 loopback 地址；它是服务端配置，不是浏览器密钥。

## 本地与 MySQL 适配

本地开发使用 `metadata/state.json` 原子保存有界业务记录，Node 内置 SQLite 的两个独立文件只提供操作系统文件锁：`state-lock.sqlite` 用于短事务互斥，`worker-lock.sqlite` 限制一个 Worker。进程退出后锁自动释放；运行中不要删除/替换协调文件，也不支持网络盘。配置/检查点最大 16 KiB，最多 16 个步骤；历史容量、owner 活跃任务数有上限。这一实现服务于本机验证。

已实现 Prisma/MySQL 持久化适配和 BullMQ Worker 分支，新增四个表的迁移在 `prisma/migrations/20261020000000_create_processing_metadata/`。MySQL 采用有界 Run 聚合 JSON，保留独立步骤类型；短事务同时推进步骤、保存检查点或发布产物，数据库包含查询/恢复索引及幂等唯一键。

启用 MySQL 分支前，按现有部署文档准备项目独立数据库和 Redis，再**显式应用迁移**；程序不会自动迁移。设置 `DATABASE_ENABLED`、`REDIS_ENABLED`、`QUEUE_ENABLED`、`PROCESSING_ENABLED` 并选择 `PROCESSING_REPOSITORY=mysql`，API 与 Worker 使用同一私有文件目录。当前业务的本机访问限制仍然有效。

MySQL/Redis 真实集成测试只允许隔离的 localhost 3307/6380，`RUN_INFRA_INTEGRATION` 未启用时跳过。当前机器完成的是 local 分支验证，不能据此宣称 MySQL/BullMQ 生产部署已验证。

## API

| 方法 | 路径                             | 行为                                                                       |
| ---- | -------------------------------- | -------------------------------------------------------------------------- |
| POST | `/api/v1/uploads`                | multipart 字段 `file`；成功返回上传收据和 bookId，完整解析在 Worker 中进行 |
| POST | `/api/v1/books/:bookId/exports`  | `{ "theme": "reader-first" }`＋`Idempotency-Key`，202 返回持久任务         |
| GET  | `/api/v1/runs/:id`               | 真实状态、阶段、完成单位、校验摘要、已发布文件链接                         |
| POST | `/api/v1/runs/:id/cancel`        | 请求取消；运行中的步骤完成停止收尾后确认终态                               |
| GET  | `/api/v1/artifacts/:id/download` | 归属核验及 hash 检查后流式返回 EPUB、报告或封面                            |

JSON 使用既有 data/meta 或 error/meta envelope；文件是二进制流。相同幂等 key 与相同参数返回原任务，不同参数冲突；任务创建超时后前端复用原 bookId/key。刷新只恢复 runId，不重新上传书籍。

## 验证证据与边界

真实《尘埃落定：纪念版》已通过页面上传、独立 Worker、原书/输出 EPUBCheck、页面下载与刷新恢复：55 个正文文档原字节保留，50 个整理、5 个保留，7 张原图片保持；输出 881,084 字节，SHA256 `7e925003e8563ccb9a062b14da426b078cf387c4e01f587c07b09b9e4e4bb848`。输出 EPUBCheck 0 错误、0 警告；刷新后仍是同一条书籍记录与任务。

单次大文件边界检查使用 54,742,022 字节技术书：引擎约 3.477 秒，独立 Node 进程 maxRSS 约 142.53 MiB，17 个文档因复杂结构全部保留，资源完整性通过。该次没有额外运行 EPUBCheck，不代表复杂技术书美化成功，也不是吞吐或生产配置承诺。

当前支持单包 EPUB 2/3、UTF-8、可重排文字书。加密/签名/混淆字体、主动内容、远程资源、无效书内引用会拒绝；复杂 CSS、内联样式、表格、公式等保留原章节。原书检查可能有问题，需查看具体报告。

本轮没有模型账本/预算调用、字体子集生成、AZW3 转换、章节前后对比预览、正式账号、自动过期清理或服务器部署。页面目前展示封面及处理摘要。历史、原书及中间产物保存在专用开发目录直到主动清理；不要把设计稿中的建议 TTL 当作已实现行为。后续清理需停止使用该数据目录的 API/Worker并保留需要的文件，运行中不可直接删除目录。

测试使用自建小型 EPUB，不把用户原书、生成书籍、日志或配置加入公开仓库；CI 普通测试不调用模型或外部基础设施。格式、内容保真、浏览器展示与 Kindle 实机是不同验证层，本轮未验证 Kindle 实机或 Send to Kindle。

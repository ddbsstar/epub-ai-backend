# 开发依赖、迁移与容器运行

本仓库是独立 NestJS API。以下配置提供本地开发与生产容器的基础，不表示已连接或部署到任何真实服务器，也不会在启动时自动执行数据库迁移。

## 无外部依赖的启动

使用 `.nvmrc` 指定的 Node.js 24。复制 `.env.example` 到未跟踪的 `.env`，保留默认关闭的外部服务开关：

```sh
npm ci
npm run prisma:generate
npm run start:dev
```

Windows PowerShell 可用 `Copy-Item .env.example .env`；若已存在 `.env`，先保留自己的配置。默认后端监听 `127.0.0.1:3000`。`DATABASE_ENABLED`、`REDIS_ENABLED`、`QUEUE_ENABLED`、`QWEN_ENABLED` 为 `false` 时不要求相应的真实服务或凭据。

`GET /api/health` 的成功响应为 `{ data, meta }`：`data` 包含进程与依赖状态，`meta.requestId` 用于排查请求。数据库启用时执行连接检查；Redis、队列报告连接状态；千问只报告配置状态，不发起付费调用。EPUB 业务默认关闭，本机上传/处理/下载的独立 API、Worker 启动与当前限制见 [业务实现说明](processing-phase-a.md)。现有生产 Compose 仍只提供基础 API 与前端，不代表已完成 Worker/校验工具/账号的生产集成。

容器健康检查使用 `GET /api/health/ready`：默认关闭的依赖不影响就绪；已启用的基础设施不可用时返回 `503`。该接口同样不执行付费模型调用。

## 本地 MySQL 与 Redis

`compose.dev.yml` **只启动依赖**，应用继续由现有的 `npm run start:dev` 运行。它创建独立的 MySQL 8.4 LTS 和 Redis 8.2 实例及命名卷：

| 依赖  | 宿主机地址       | 容器端口 |
| ----- | ---------------- | -------- |
| MySQL | `127.0.0.1:3307` | `3306`   |
| Redis | `127.0.0.1:6380` | `6379`   |

这套配置不会使用宿主机已有的 `3306` 数据库。所有发布端口都绑定本机回环地址，不对公网开放。

先在未跟踪的 `.env` 中设置以下 Compose 变量。密码没有默认值，缺少或为空时 Compose 会失败：

- `MYSQL_DATABASE`：本项目独立的数据库名。
- `MYSQL_USER`：本项目应用账户，不使用 root。
- `MYSQL_PASSWORD`：独立生成的应用账户密码。
- `MYSQL_ROOT_PASSWORD`：独立生成的本地容器管理密码。
- `REDIS_PASSWORD`：独立生成的 Redis 密码。

Redis 开启 AOF 和 `noeviction`，供队列连接使用。MySQL 和 Redis 的健康检查分别验证应用账户的 `SELECT 1` 与带认证的 `PING`。

```sh
docker compose --env-file .env -f compose.dev.yml config --quiet
docker compose --env-file .env -f compose.dev.yml up --detach --wait
docker compose --env-file .env -f compose.dev.yml ps
```

`config --quiet` 仅检查配置，不输出解析后的秘密。Compose 变量用于初始化依赖；应用连接使用另行配置的 URL：

```text
DATABASE_URL=mysql://<MYSQL_USER>:<URL编码的MYSQL_PASSWORD>@127.0.0.1:3307/<MYSQL_DATABASE>
REDIS_URL=redis://:<URL编码的REDIS_PASSWORD>@127.0.0.1:6380
```

URL 中的密码需要按 URL 规则编码。配置好 URL 后再启用 `DATABASE_ENABLED=true`、`REDIS_ENABLED=true`；需要队列时同时设置 `QUEUE_ENABLED=true`。Compose 不会自动修改应用的 `.env`。

停止本项目依赖并保留数据卷：

```sh
docker compose --env-file .env -f compose.dev.yml down
```

MySQL 的初始化变量只对全新的数据卷生效。修改 `.env` 不会重设已有卷的用户密码；需要使用数据库账户管理流程，而不是依赖容器重启。不要把其他项目的数据目录挂载到这里。

## Prisma 与迁移

Prisma 7 使用 MySQL provider 和 `@prisma/adapter-mariadb`。客户端生成到 `src/generated/prisma`，构建时编译进 `dist/generated/prisma`；生成和离线检查不需要连接数据库。

当前 schema 包含未来后台处理共用的 `BackgroundJob` 元数据，初始 SQL 迁移位于 `prisma/migrations/20261019000000_create_background_jobs`；尚未提供任务创建或 EPUB 处理接口。

```sh
npm run prisma:generate
npm run db:validate
```

已有、已评审的迁移通过显式命令应用到 `.env` 中指定的独立数据库：

```sh
npm run db:migrate:deploy
```

该命令需要真实有效的 `DATABASE_URL`。应用启动不执行迁移，不执行 `db push`，不会自动创建或重置真实数据库。

新 schema 变更应在独立开发数据库生成迁移，连同 SQL 一起评审提交。`db:migrate:dev` 的 shadow database 需要相应权限或单独配置；本地 Compose 的应用账户只拥有业务库权限，不能直接假设拥有创建任意数据库的权限。正式环境使用 `db:migrate:deploy`，迁移前按实际数据量安排备份与兼容性检查。

## 生产镜像

以本仓库为构建上下文：

```sh
docker build --pull --target runtime --tag epub-ai-backend:local .
```

多阶段构建使用官方 Node.js 24.19.0 Bookworm Slim。构建阶段运行 Prisma generate 和 Nest 编译；最终阶段仅复制生产依赖、编译后的代码及生成客户端，不携带开发 CLI、源码、`.env`、迁移目录或工作记录。容器以 `node` 用户运行 `dist/main.js`。

镜像默认：

- `NODE_ENV=production`、`HOST=0.0.0.0`、`PORT=3000`。
- `SWAGGER_ENABLED=false`，生产不开放 Swagger 文档。
- 数据库、Redis、队列与千问开关关闭，按需通过运行环境显式启用。

容器内必须监听 `0.0.0.0` 才能让其他容器访问；宿主机开发默认仍为 `127.0.0.1`。真实密钥在运行时注入，不通过 `ARG`、`ENV` 构建参数或镜像层保存。

迁移另有 operator-only target，保留 Prisma CLI、迁移 SQL 与 URL 校验脚本，供受控发布步骤显式调用：

```sh
docker build --target migration --tag epub-ai-backend:migration .
docker run --rm --env-file .env epub-ai-backend:migration
```

执行前确保 URL 指向要迁移的独立数据库，且该地址能从迁移容器访问；容器中的 `127.0.0.1` 指该容器自己。不要把迁移命令加入 web 容器的启动命令。生产 runtime 不包含 Prisma CLI。

## 两个独立仓库组合

`compose.production.yml` 假设以下相邻目录，不需要合并 Git 仓库：

```text
deployment/
  epub-ai-backend/   # ddbsstar/epub-ai-backend
  epub-ai-frontend/  # ddbsstar/epub-ai-frontend
```

前端 `build.context` 为 `../epub-ai-frontend`；目录名不同时需明确修改。两个上下文各自使用允许清单，不能使用包含 `work/` 或凭据的父工作区。

生产 Compose 只提供 API 与前端，不自动带上开发用 MySQL、Redis。外部依赖需要先在确认资源与网络后的运行环境中准备。把后端运行环境设置为可从容器访问的数据库／Redis 地址后，在后端目录执行：

```sh
docker compose --env-file .env -f compose.production.yml config --quiet
docker compose --env-file .env -f compose.production.yml up --detach --build
```

后端不发布宿主机端口；前端仅发布 `127.0.0.1:8080`，内部 `/api` 代理到 `backend:3000`。正式域名、HTTPS、秘密管理、数据库备份以及服务器已有项目和端口的核对属于实际部署步骤。提供这些模板不代表已经完成它们。

这套 Compose 使用非 root 镜像、只读根文件系统、`/tmp` 临时挂载、进程初始化与健康检查。后续处理 EPUB 若需要持久化文件，应显式接入对象存储或专用数据卷，并配置清理策略；不要依赖容器可写层。

## CI 与依赖维护

GitHub Actions 分为三个任务：

1. 使用 Node.js 24、`npm ci` 和锁文件缓存，关闭所有外部服务，运行 Prisma generate／validate、格式、lint、类型、测试与构建检查。
2. 在独立 runner 上启动 Compose MySQL／Redis，应用迁移，运行 `test:integration`；验证数据库读写、队列写入与资源关闭，使用明确的临时测试凭据，不访问生产服务，完成后停止容器。本地执行同一测试必须显式设置 `RUN_INFRA_INTEGRATION=true`，并使用独立的 `3307`／`6380` 服务。
3. 构建 production 和 migration 镜像，实际启动非 root production 容器，验证存活、就绪接口及生产 Swagger 关闭；不推送镜像。

所有任务仅有 `contents: read` 权限，checkout 不保存凭据；不使用发布密钥，不执行部署。Dependabot 每周检查 npm、Actions 和 Docker，次版本与修订版本分组，主要版本独立评审，不自动合并。镜像使用已核实存在的明确版本标签，后续可按发布策略固定 digest。

本机未安装 Docker 时，不启动、拉取或声称本地验证了容器；容器和真实依赖验证以 GitHub Actions 结果为准。

参考：[Node 官方镜像](https://hub.docker.com/_/node)、[MySQL 8.4 LTS](https://dev.mysql.com/doc/refman/8.4/en/mysql-releases.html)、[MySQL 官方镜像](https://hub.docker.com/_/mysql)、[Redis 官方镜像](https://hub.docker.com/_/redis)、[Prisma Docker 指南](https://www.prisma.io/docs/guides/docker)。

# EPUB AI 后端

基于官方 Nest CLI 初始化的 NestJS 12 + TypeScript 服务，作为独立仓库维护。

当前提供基础 API 和环境变量配置。MySQL、千问模型及 EPUB 处理业务尚未接入，不会在启动时连接数据库、创建数据表或调用模型。

## 本地启动

使用 Node.js 24.15 或以上版本，推荐 Node.js 24.19（见 `.nvmrc`）。

```sh
npm install
```

将 `.env.example` 复制为 `.env`。默认配置已能启动，数据库与千问变量可以暂时留空：

```sh
npm run start:dev
```

Windows PowerShell 可以用 `Copy-Item .env.example .env` 复制配置；若执行策略阻止 `npm.ps1`，使用 `npm.cmd`。

服务默认地址：`http://127.0.0.1:3000`。前端开发服务器可以将 `/api` 代理到此地址。当前 API 只监听本机回环地址。

## 健康检查

```http
GET /api/health
```

未配置外部服务时返回：

```json
{
  "status": "ok",
  "service": "epub-ai-backend",
  "dependencies": {
    "database": "not_configured",
    "qwen": "not_configured"
  }
}
```

该接口检查进程存活与配置项是否齐全，不测试数据库或模型连通性，也不返回配置值。相关配置齐全时，对应状态变为 `configured_not_checked`；这不表示已经建立连接。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `PORT` | API 端口，默认 `3000` |
| `MYSQL_HOST`、`MYSQL_PORT` | 预留的 MySQL 地址和端口 |
| `MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` | 预留的数据库账号和库名 |
| `QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL` | 预留的千问凭据、兼容 API 地址和模型标识 |

后续接入数据库时再添加驱动、迁移与连接检查；后续接入模型时再实现 AI 服务。本仓库不包含真实凭据，`.env` 已被 Git 忽略。

## 检查与构建

```sh
npm run lint
npm test
npm run build
npm run start:prod
```

健康接口端到端测试会验证：无数据库/模型凭据时服务可启动、`/api/health` 返回约定状态、未带 `/api` 的 `/health` 不被暴露。测试不会访问 MySQL 或调用 AI。

构建产物在 `dist/`，生产启动入口为 `dist/main.js`。

## 目录

```text
src/
  health/health.controller.ts  # 进程和配置状态
  app.module.ts               # 应用模块、.env 加载
  main.ts                     # 本地监听与端口校验
  setup-app.ts                # API 前缀、退出钩子
test/app.e2e-spec.ts           # HTTP 端到端检查
```
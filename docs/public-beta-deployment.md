# 公开排版试用部署

2026-10-29 已部署到用户指定的共享服务器（YT.NET 管理 ID 21149，已通过保存的 SSH 主机密钥及凭据确认当前主机）。

- 网站：<https://epub.199.30.89.47.sslip.io/>
- 上传：<https://epub.199.30.89.47.sslip.io/upload>
- 部署版本：`20261029-editorial-beta-01`。这是当前已验证工作区的构建发布，未提交或推送 Git。
- 范围：匿名会话隔离、单机单 Worker 的纯排版试用，配置与边界见 [public-beta.md](public-beta.md)。未启用模型、生图、MySQL 或 Redis。

## 服务器运行方式

Debian 12，1 vCPU、约 1 GiB 内存。为控制常驻资源，使用 systemd 管理独立 API 与 Worker，Caddy 提供静态前端、反向代理与自动 HTTPS；没有启动 Docker 或修改原有代理服务。

| 项目                             | 位置                                                 |
| -------------------------------- | ---------------------------------------------------- |
| 当前发布指针                     | `/opt/epub-ai/current`                               |
| 版本目录                         | `/opt/epub-ai/releases/20261029-editorial-beta-01`   |
| Node 24.22.1（官方 SHA256 校验） | `/opt/epub-ai/runtime/node/bin/node`                 |
| EPUBCheck 5.4.0                  | `/opt/epub-ai/runtime/epubcheck-5.4.0/epubcheck.jar` |
| 独立持久数据                     | `/var/lib/epub-ai/data`                              |
| 运行环境（不含模型密钥）         | `/etc/epub-ai/beta.env`                              |
| HTTPS 配置                       | `/etc/caddy/Caddyfile`                               |
| 部署证据与运维文件               | `/opt/epub-ai/ops`                                   |

API 仅监听 `127.0.0.1:3100`；Caddy 保留配置的 Host，并固定传入 HTTPS 协议。外部仅通过 HTTPS 访问业务。两个应用服务以专用无登录用户 `epub-ai` 运行，只有独立数据目录可写，禁止访问用户家目录及外网，具有进程和内存上限。服务器原有服务继续运行。

试用单书 20 MiB、每会话保留 5 本、每会话 1 个活跃转换、全局 10 个活跃转换，保守存储准入预算 1 GiB。上传后 24 小时失去访问权限，清理周期 30 秒；迟到的临时文件有额外安全清理窗口。不是正式账号系统，清除 Cookie 或换浏览器无法恢复原会话。

Java 使用 `-XX:TieredStopAtLevel=1 -XX:+UseSerialGC -XX:ActiveProcessorCount=1`，通过 `JAVA_TOOL_OPTIONS` 注入。对同一份 2,229-byte 原创测试 EPUB 的一次独立格式检查，默认参数 25.204 秒，调整后 15.004 秒，结果均为零错误和警告。这是一个小样本，不是所有书的性能保证。

## 检查与运维

```sh
systemctl status epub-ai-api epub-ai-worker caddy
journalctl -u epub-ai-api -u epub-ai-worker --since '10 minutes ago'
curl --fail https://epub.199.30.89.47.sslip.io/api/health/ready
df -h /
du -sh /var/lib/epub-ai/data
```

发布前确认无活跃任务。发布包只含已验证的后端构建/依赖锁、前端静态构建及字体许可、校验工具，不携带本机书籍、凭据、旧工作数据或模型密钥。校验完整包和文件级 SHA256 后安装 Linux 生产依赖，再原子切换 `current`。应用不会自动执行数据库迁移。

后续回退到已保留的版本时，先确认当前任务空闲，切换 `current` 到确切旧版本，再重启两个应用服务；不要删除数据、锁或 marker。首次发布没有旧版本可回退，可只停止本项目的 API、Worker 和 Caddy，保留数据以便恢复。不要操作共享服务器上其他项目的服务。

## 本次实际验证

- 后端完整检查 671 tests / 30 files，前端 99 tests / 11 files；公开构建排除插画实验代码，含两份字节一致的 OFL 许可。
- 真实外部 HTTPS 上传原创测试 EPUB、明确创建排版任务、独立 Worker、下载 EPUB/报告成功，格式检查零错误/警告；覆盖 1 文档、5 段、2 标题、1 引文。
- 外网 96 项检查包括全部 15 个前端资源哈希、Secure 会话、幂等、跨会话任务/下载不可见、同源保护和旧付费路径关闭。独立输出审计 16 项通过，原文 body、目录、metadata、spine 和原 CSS 保留。
- HTTP 自动跳转 HTTPS；证书链实际验证通过；API 3100 不可从外部访问，原有服务端口仍可达。
- 应用空闲时重启两服务后恢复正常，持久元数据 SHA256 与书籍/任务/产物数量完全一致；两进程实际加载 Java 参数。
- 没有本轮实际浏览器点击或 Apple Books / Kindle 设备验证。公开入口与真实接口链路已验证，不代表任意 EPUB 都能改善。

本机完整发布清单、私有操作记录和验证 JSON 位于原笔记目录 `work/public-beta-deploy/`。临时下载分享的两小时有效期与此独立服务器网站无关。

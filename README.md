# AIMon

AI 中转站渠道与模型测活面板，支持最新版 New API（含新版/旧版会话兼容）和 Sub2API。

## 功能

- 自动识别站点类型、登录并读取余额、可用分组与倍率
- 首次访问设置页面管理密码，支持登录、退出和修改密码；修改后旧会话立即失效
- 遇到 Cloudflare challenge 时按需建立持久 CloakBrowser 会话；Cookie 重试仍被拦截时自动改用浏览器内同源请求
- New API（新旧页面）与 Sub2API 的应用层 Turnstile 登录可自动回退到浏览器会话
- 支持不登录的手动接入：可填写多个“分组名 + 倍率 + API Key”并直接获取模型
- 按 `分组名_Monitor` 复用或创建远端 API Key
- 读取每个具体分组 Key 的真实模型列表
- 站点、分组、模型三级配置与手动排序
- 每个模型测活次数可在页面设置（默认 3，范围 1–10）；同一模型严格串行，同一站点最多 3 个模型并发
- 记录成功率、平均首字节、平均总耗时、平均 TTFT 与分级结果
- 全局、站点、分组、单模型四级手动测活
- 分组及以上测活会先刷新远端分组倍率，站点及全局测活还会刷新账户余额；手动接入保持本地配置
- 分钟级自动测活，`0` 为关闭
- 综合成功率、延迟和标准倍率的推荐排序，可随时恢复手动顺序
- SQLite 持久化；账号、密码与 API Key 使用 AES-256-GCM 加密

## Docker 部署

需要 Docker 24+ 与 Docker Compose。

```bash
cp .env.example .env
# 修改 .env，至少设置 AIMON_SECRET
docker compose up -d --build
```

访问 `http://服务器IP:8787`。公网首次部署建议提前设置 `AIMON_BOOTSTRAP_PASSWORD`，服务会在数据库为空时自动初始化页面管理密码，避免“谁先打开页面谁设置密码”的窗口；数据库已有管理密码时，此变量不会覆盖现有密码。本地未设置该变量时，首次打开仍会进入密码设置页。

`AIMON_SECRET` 用于加密本地敏感数据。部署后不要随意更换，否则已保存的凭据将无法解密。`data/` 目录包含 SQLite 数据库和 `cloak-profiles/` 浏览器登录会话；两者都应按密码同等级保护并纳入服务器备份，不能提交到 Git。

## Zeabur 部署

Zeabur 不会使用仓库中的 `docker-compose.yml`，而且服务重启或重新部署时会重置未挂载的容器文件系统。首次部署前必须在 AIMon 服务的 **Volumes** 页面创建一个持久卷，并将 **Mount Directory** 精确设置为 `/app/data`。`DATA_DIR` 保持 `/app/data`，`AIMON_SECRET` 必须设置为长期不变的随机字符串。

Docker 镜像默认设置 `REQUIRE_PERSISTENT_DATA=true`。如果 `/app/data` 没有位于真实挂载卷中，AIMon 会拒绝启动并在日志中给出挂载提示，避免继续把配置写进下次部署就会消失的临时文件系统。Zeabur 首次挂载 Volume 会清空目标目录；已有临时数据库时，应先导出 `/app/data/` 中的全部文件，再挂载并重新导入。

## 本地开发

需要 Node.js 22.5+（推荐 Node.js 24）。

```bash
npm install
npm run dev
```

前端地址为 `http://localhost:5173`，API 地址为 `http://localhost:8787`。

```bash
npm run typecheck
npm test
npm run build
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 服务端口 |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `REQUIRE_PERSISTENT_DATA` | 本地 `false`，Docker `true` | 启动前要求 `DATA_DIR` 位于 Linux 独立挂载卷中；仅明确使用持久宿主机文件系统时关闭 |
| `AIMON_SECRET` | 仅开发回退值 | 敏感字段加密密钥，生产必须设置 |
| `AIMON_BOOTSTRAP_PASSWORD` | 空 | 可选的首次启动页面管理密码，至少 8 字符；仅在数据库尚无管理密码时生效 |
| `REQUEST_TIMEOUT_MS` | `30000` | 单次远端请求超时 |
| `AIMON_BASIC_USER` | 空 | 可选的第二层 HTTP Basic Auth 用户名，必须与密码同时设置 |
| `AIMON_BASIC_PASSWORD` | 空 | 可选的第二层 HTTP Basic Auth 密码，必须与用户名同时设置 |
| `CLOAKBROWSER_ENABLED` | `true` | 检测到 Cloudflare challenge 时启用浏览器会话 |
| `CLOAKBROWSER_HEADLESS` | `true` | CloakBrowser 无头模式；极严格站点可能需要配合 Xvfb 改为 `false` |
| `CLOAKBROWSER_TIMEOUT_MS` | `60000` | 等待 Cloudflare 会话建立的最长时间 |
| `CLOAKBROWSER_IDLE_MS` | `180000` | 浏览器站点上下文空闲回收时间，最低 60000ms |
| `CLOAKBROWSER_MAX_CONTEXTS` | `2` | 同时保留的站点浏览器上下文上限；每个站点内请求仍最多 3 并发 |
| `CLOAKBROWSER_PROXY` | 空 | 可选 HTTP/SOCKS5 代理；设置后所有远端请求均走浏览器，避免代理 IP 与 CF 会话不一致 |
| `CLOAKBROWSER_BINARY_PATH` | 自动 | 可选本地 Chrome/Chromium 路径；专用浏览器不可下载时会自动寻找系统 Chrome/Edge 兜底 |
| `CLOAKBROWSER_AUTO_UPDATE` | `false` | Docker 固定关闭运行时自动更新，浏览器升级随镜像重建进行 |
| `CLOAKBROWSER_LICENSE_KEY` | 空 | 可选 CloakBrowser Pro 授权 |

## 兼容说明

- New API 通过 `/api/status`、`/api/user/login`、`/api/user/self/groups` 与令牌接口接入。
- Sub2API 通过 `/api/v1/auth/login`、用户分组与 Key 接口接入。
- 测活优先使用 `/v1/chat/completions` SSE；不支持流式时回退非流式 Chat Completions，明确不支持该端点时再回退 `/v1/responses`。
- 启用了 TOTP/2FA 的远端账号目前无法自动登录，请使用未启用 2FA 的专用监控账号。
- New API 的分组名同时是分组标识。分组改名后无法百分之百可靠地自动识别；AIMon 只复用能够确定属于同一分组的 Key，无法可靠判定的分组保持未选，避免误绑其他 Key。
- 站点 Base URL 推荐只填站点根地址（如 `https://api.example.com`）；输入末尾的 `/v1` 或 `/api/v1` 也会自动归一化。
- 编辑自动登录站点时，同一 Base URL 可沿用已保存密码；Base URL 变化后必须重新填写站点凭据，或明确选择统一默认凭据，避免把旧密码发送到误填的新地址。
- 手动接入不会登录或同步余额、远端分组名和倍率；再次编辑时只按当前填写内容刷新模型列表。
- CloakBrowser 会保留每个站点的浏览器上下文并在严格 CF 下使用真实浏览器网络栈。托管 Turnstile 可自动处理；必须人工点击、图片识别或其他交互的验证码不会尝试绕过，失败时界面会提示改用手动 API Key 接入。
- 使用 `CLOAKBROWSER_PROXY` 时，代理 URL 可能包含凭据，应将 `.env` 作为敏感文件保护。Docker 的 `cloakbrowser-cache` 卷会持久保存已下载浏览器，Pro 授权首次下载仍需服务器能访问外网。
- 当前测活并发控制基于单 Node.js 进程。请使用单实例部署，不要在多个副本间共享同一个 SQLite 数据目录。

页面管理密码使用 scrypt 强哈希保存在 SQLite 中，登录会话使用 `HttpOnly`、`SameSite=Strict` Cookie；修改密码后其他旧会话会立即失效。公网部署仍应使用 HTTPS，并可额外启用 HTTP Basic Auth、Nginx/Caddy 鉴权或 Cloudflare Access。
由于管理员可以配置任意目标 URL，AIMon 具备访问服务器所在网络的能力。请只向可信管理员开放面板，并限制反向代理和防火墙访问范围。

# AIMon

AI 中转站渠道与模型测活面板，支持最新版 New API（含新版/旧版会话兼容）和 Sub2API。

## 功能

- 自动识别站点类型、登录并读取余额、可用分组与倍率
- 遇到 Cloudflare challenge 时按需使用 CloakBrowser 建立浏览器会话后重试
- 支持不登录的手动接入：可填写多个“分组名 + 倍率 + API Key”并直接获取模型
- 按 `分组名_Monitor` 复用或创建远端 API Key
- 读取每个具体分组 Key 的真实模型列表
- 站点、分组、模型三级配置与手动排序
- 每个模型连续测活 3 次；同一模型严格串行，同一站点最多 3 个模型并发
- 记录成功率、平均首字节、平均总耗时、平均 TTFT 与分级结果
- 全局、站点、分组、单模型四级手动测活
- 分钟级自动测活，`0` 为关闭
- 综合成功率、延迟和标准倍率的推荐排序，可随时恢复手动顺序
- SQLite 持久化；账号、密码与 API Key 使用 AES-256-GCM 加密

## Docker 部署

需要 Docker 24+ 与 Docker Compose。

```bash
cp .env.example .env
# 修改 .env，设置 AIMON_SECRET 与 Basic Auth
docker compose up -d --build
```

访问 `http://服务器IP:8787`。

`AIMON_SECRET` 用于加密本地敏感数据。部署后不要随意更换，否则已保存的凭据将无法解密。`data/` 目录包含 SQLite 数据库，需要纳入服务器备份。

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
| `AIMON_SECRET` | 仅开发回退值 | 敏感字段加密密钥，生产必须设置 |
| `REQUEST_TIMEOUT_MS` | `30000` | 单次远端请求超时 |
| `HEALTH_ATTEMPTS` | `3` | 单模型测活次数，建议保持 3 |
| `AIMON_BASIC_USER` | 空 | 可选的 HTTP Basic Auth 用户名 |
| `AIMON_BASIC_PASSWORD` | 空 | 可选的 HTTP Basic Auth 密码 |
| `ALLOW_UNAUTHENTICATED` | `false` | 生产环境显式允许无内置认证，仅适用于已有上游鉴权或可信内网 |
| `CLOAKBROWSER_ENABLED` | `true` | 检测到 Cloudflare challenge 时启用浏览器会话 |
| `CLOAKBROWSER_HEADLESS` | `true` | CloakBrowser 无头模式；极严格站点可能需要配合 Xvfb 改为 `false` |
| `CLOAKBROWSER_TIMEOUT_MS` | `60000` | 等待 Cloudflare 会话建立的最长时间 |
| `CLOAKBROWSER_LICENSE_KEY` | 空 | 可选 CloakBrowser Pro 授权 |

## 兼容说明

- New API 通过 `/api/status`、`/api/user/login`、`/api/user/self/groups` 与令牌接口接入。
- Sub2API 通过 `/api/v1/auth/login`、用户分组与 Key 接口接入。
- 测活优先使用 `/v1/chat/completions` SSE；明确不支持该端点时回退 `/v1/responses`。
- 启用了 TOTP/2FA 的远端账号目前无法自动登录，请使用未启用 2FA 的专用监控账号。
- New API 的分组名同时是分组标识。分组改名后无法百分之百可靠地自动识别；AIMon 只复用能够确定属于同一分组的 Key，无法可靠判定的分组保持未选，避免误绑其他 Key。
- 站点 Base URL 推荐只填站点根地址（如 `https://api.example.com`）；输入末尾的 `/v1` 或 `/api/v1` 也会自动归一化。
- 手动接入不会登录或同步余额、远端分组名和倍率；再次编辑时只按当前填写内容刷新模型列表。
- CloakBrowser 用于取得正常浏览器会话，不保证通过所有交互式验证码。失败时界面会提示改用手动 API Key 接入。
- 当前测活并发控制基于单 Node.js 进程。请使用单实例部署，不要在多个副本间共享同一个 SQLite 数据目录。

公网部署务必启用内置 Basic Auth，或在 Nginx、Caddy、Cloudflare Access 等上游增加访问认证。
由于管理员可以配置任意目标 URL，AIMon 具备访问服务器所在网络的能力。请只向可信管理员开放面板，并限制反向代理和防火墙访问范围。

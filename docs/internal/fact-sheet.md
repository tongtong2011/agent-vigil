# agent-vigil 事实清单（fact-sheet）

> 本文件是所有文档/README/llms.txt 的**唯一事实来源**。每条事实后附源码依据。
> 生成：2026-10-11 · 对应版本：V3.1.0（package.json version 0.1.0，CHANGELOG 最新 V3.1.0）

## 1. 项目定位（源码实证）

- **是什么**：跑在电脑端的 Node.js 只读桥接服务，把「爱思办公」电脑端（Electron 桌面应用 + 本地 AI 后端 agnesd）的 AI 任务实时同步为手机 PWA 看板，并提供邮件/企业微信推送与任务告警。`bridge.js:1-16`、`lib/official.js:1-23`
- **数据源（当前版本唯一）**：爱思办公本地后端 agnesd（goose 框架 ACP 协议 = JSON-RPC over WSS，自签名证书）。`lib/acp.js:3-23`
- **V4 规划**：数据源插件化，支持更多 agent 工具（`docs/启动文档.md`、`V4多渠道接入需求与设计文档.md`）。**尚未实现**。

## 2. 真实安装与启动（源码核实）

- 依赖：Node.js ≥ 18；`npm install`（express / ws / qrcode / nodemailer，其中发信实际用自研 `lib/smtp.js`，nodemailer 为声明依赖未实际使用——`lib/mailer.js:23-29` 说明弃用原因）
- 启动：`npm install && node bridge.js`（`package.json` scripts.start）或双击 `启动服务.bat`
- 默认监听 `0.0.0.0:8787`（`lib/config.js` DEFAULTS）
- 首次配置：电脑浏览器打开 `http://127.0.0.1:8787/setup.html` 配置向导（仅限本机回环，`lib/setupApi.js:14-18`）
- cloudflared 未安装时首次启动自动从 Cloudflare 官方 GitHub releases 下载到 `tools/`（`lib/tunnel.js:12-27`），失败降级纯局域网
- 远程仓库：`origin = https://github.com/tongtong2011/agent-vigil`

## 3. 已实现功能清单（V3.1，附源码路径）

| 功能 | 实现位置 | 说明 |
| --- | --- | --- |
| ACP 自动发现（端口从日志、密钥从进程内存 ReadProcessMemory） | `lib/acp.js`、`lib/get-agnes-secret.ps1` | agnesd 重启换端口/密钥后连续失败 ≥3 次自动重新发现 |
| 手机 PWA 看板（对话视图、步骤折叠、两级分组） | `web/index.html`、`web/app.js`、`web/style.css` | 单页，Android/iOS/鸿蒙通用 |
| 实时推送 + 兜底轮询 | `bridge.js:415-461`、`lib/wsHub.js` | ACP 变化通知 300ms 防抖拉取；轮询间隔 `pollIntervalMs`(默认 3s)；前端 8 秒兜底轮询 + 断线指数退避 |
| 手机发消息（唯一写方法） | `lib/acp.js`（session/prompt）、`lib/localApi.js` | 需配对令牌 + 限速（每分钟 10 条，429 提示），`messages.enabled` 可关闭 |
| 二维码配对 | `lib/pair.js` | 6 位码，TTL 5~120 分钟（默认 15），**有效期内可重复使用**（V3.1 修正：非一次性），设备令牌仅存内存，桥接重启需重新配对 |
| 公网隧道 | `lib/tunnel.js` | quick（trycloudflare 免注册）/ named（固定域名，幂等 provision：复用隧道、补 CNAME、补 ingress）双模式，断线指数退避重启 |
| 邮件推送（配对码/地址变动） | `lib/mailer.js`、`lib/smtp.js` | 自研 SMTP 客户端（兼容非标服务器如 2925.com）；内容签名去重；失败 3 分钟重试至多 5 次 |
| 发件档案故障转移 | `bridge.js:169-189` | 连续 2 次失败自动切换下一份已存档案并立即重试 |
| 企业微信推送（可选） | `lib/wecom.js` | 官方 API，token 缓存 + 失效自动刷新 |
| 配置向导（本机限定的 5 步向导） | `lib/setupApi.js`、`web/setup.html` | 白名单字段保存、凭据永不回传前端（掩码）、保存热应用（mailer/wecom/隧道/TTL/告警定时器重建） |
| 手机远程配置 | `lib/remoteApi.js`、`web/remote.html` | 管理令牌仅经推送邮件下发（timingSafeEqual 防时序攻击）；仅低风险操作：改收件人/切档案/测试邮件 |
| **任务告警（V3 核心）** | `lib/alerts.js` | ①手机端「🔔追踪」清单（localStorage 持久 + 同步回 config.json `alerts.watchlist`）②定时汇总邮件（`digestIntervalMinutes` 10~240，默认 60）③阻塞即时告警（异常/待确认，同一阻塞态不重复，恢复后重置再告警），检测节奏固定 60 秒 |
| 任务四态状态模型（V3.1 重做） | `lib/official.js:31-43` | 正在执行/执行完成/异常/待确认；只看最新一轮结果，历史中途失败已恢复不算异常 |
| 离线缓存 + SW 自动更新 | `web/sw.js`（CACHE `otc-shell-v15`） | 静态资源 `private, no-cache, max-age=0`（绕过 CF 4h 强缓存） |

### ⚠ 未实现 / 需澄清（防止文档夸大）

- **「token/配额耗尽」专项告警不存在**：积分耗尽只作为阻塞态（异常/待确认）的成因之一被间接覆盖（`lib/mailer.js:268` 邮件文案提及积分耗尽排查）。文档中不得声称"token 耗尽专属告警"。
- V4 多渠道接入、数据源插件化：仅规划文档，无代码。
- `official.baseUrl/token`：占位符，HTTP 直连模式未使用（`lib/config.js:24-28`）。

## 4. HTTP API（全部需 `X-Device-Token`，配对时签发；`lib/localApi.js`）

- `GET /health`（免鉴权）
- `POST /api/pair`（配对码 → 设备令牌）
- `GET /api/tasks`、`GET /api/tasks/:id`
- `POST /api/tasks/:id/messages`（发消息，V2）
- `GET/POST /api/setup/*`（仅 127.0.0.1，远程 403）
- `/api/remote/*`（管理令牌鉴权）
- WebSocket：`/ws?token=<设备令牌>`，消息类型 hello/subscribed/task_update/step_update/pong（`lib/wsHub.js`）

## 5. 配置项全表（config.json，与 lib/config.js DEFAULTS 核对）

listenHost(0.0.0.0) / port(8787) / timeoutMs(5000) / pollIntervalMs(3000)；
acp{port=0 自动发现, secret='', autoDiscover=true}；official{baseUrl,token,headers=占位符未用}；
tunnel{enabled=true, cloudflaredPath='', mode='quick'|'named', hostname, tunnelName='agnes-board', tunnelToken}；
pair{codeTtlMinutes=15, 5~120}；messages{enabled=true}；
mailer{smtpHost,smtpPort=465,smtpSecure=true,user,pass,to,toHistory[],from,saved[]}；
wecom{corpId,corpSecret,agentId,toUser='@all'}；setup{done}；
alerts{digestIntervalMinutes=60, digestEnabled=false, digestTitle='任务汇总邮件', alertPrefix='单任务报警-', alertEnabled, watchlist[]}。

## 6. 安全边界（全部源码实证）

- 只读铁律：默认仅 initialize / session/list / session/load；唯一写 = session/prompt（配对令牌 + 限速 + 可关闭）
- agnesd 密钥仅存电脑内存，不下发手机端；SMTP 凭据只存本机 config.json（**已被 .gitignore 排除且从未入库**，git log --all 验证）
- 向导仅本机回环；远程页令牌仅经邮件下发；timingSafeEqual 防时序攻击
- 无演示假数据机制；未连上数据源时看板为空 + 三处提示
- MIT 许可

## 7. 待澄清清单（需用户决策，不阻塞文档）

1. npm 包 version 仍为 0.1.0 而 CHANGELOG 已到 V3.1.0——是否对齐？（改 version 属工程文件，护栏内未授权，未动）
2. `lib/wecom.js` 存在但向导入口未见企微配置步骤（仅 config 可配）——文档按"config.json 可选配置"表述，已核实 `bridge.js:384` 有描述输出。
3. 历史包命名 `爱思办公手机协同端-VX.Y.Z.zip`（CHANGELOG 约定）与新产品名不一致——新 Release 建议改用 `agent-vigil-vX.Y.Z.zip`。
4. 根目录 `agnes-office-mobile任务会话记录 .md`（136KB 开发日志）与 `技术分享素材.md` 是否随开源仓库公开？建议移出或放入非公开分支（未动，等决策）。
5. `敏感配置备份.md` 已被 .gitignore 正确排除（git log --all 验证无历史），但文件本身在项目目录内，**开源分发打包时注意排除**。

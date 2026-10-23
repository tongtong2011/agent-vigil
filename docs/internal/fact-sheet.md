# agent-vigil 事实清单（fact-sheet）

> 本文件是所有文档/README/llms.txt 的**唯一事实来源**。每条事实后附源码依据。
> 生成：2026-10-11 · 更新：2026-10-23（同步 V4.1.0 多渠道代码后） · 对应版本：V4.1.0（package.json version 0.1.0，CHANGELOG 最新 V4.1.0）

## 1. 项目定位（源码实证）

- **是什么**：跑在电脑端的 Node.js 只读桥接服务，把电脑上多个 AI Agent harness 的任务实时聚合为手机 PWA 看板（AgentVigil），并提供邮件/企业微信推送与任务告警。`bridge.js:1-16`、`lib/adapters/index.js`
- **数据源（V4 起多渠道插件化，已实现）**：
  - `agnes` 爱思办公本地后端 agnesd（goose 框架 ACP 协议 = JSON-RPC over WSS，自签名证书）——`lib/adapters/agnes.js` 委托包装 `lib/official.js`
  - `workbuddy` 本地转录 JSONL 直读（数据根 `~/.workbuddy`，进程门禁）——`lib/adapters/workbuddy.js`；V4.1 起 headless CLI（`dist/codebuddy-lite-wb.mjs`）可发消息续聊
  - `trae` 记忆子系统转录 JSONL 直读（数据根 `~/.trae-cn/memory/projects`，只读、两态 running/done）——`lib/adapters/trae.js`
  - 适配器统一接口 `lib/adapters/base.js`（channel/displayName/init/close/health/describe/listTasks/getTask/sendMessage/setOnChange/taskCount + canSend），注册表工厂 `lib/adapters/index.js`（快照预热 stale-while-revalidate）
- **渠道策略单一真源**：`lib/channels.js`（channelCfg 渠道生效策略、agnes 回退 alerts 顶层旧生效源、watchlist 二元组归一）

## 2. 真实安装与启动（源码核实）

- 依赖：Node.js ≥ 18；`npm install`（express / ws / qrcode / nodemailer，其中发信实际用自研 `lib/smtp.js`，nodemailer 为声明依赖未实际使用——`lib/mailer.js:23-29` 说明弃用原因）
- 启动：`npm install && node bridge.js`（`package.json` scripts.start）或双击 `启动服务.bat`
- 默认监听 `0.0.0.0:8787`（`lib/config.js` DEFAULTS）
- 首次配置：电脑浏览器打开 `http://127.0.0.1:8787/setup.html` 配置向导（仅限本机回环，`lib/setupApi.js:14-18`）
- cloudflared 未安装时首次启动自动从 Cloudflare 官方 GitHub releases 下载到 `tools/`（`lib/tunnel.js:12-27`），失败降级纯局域网
- 远程仓库：`origin = https://github.com/tongtong2011/agent-vigil`

## 3. 已实现功能清单（V4.1，附源码路径）

| 功能 | 实现位置 | 说明 |
| --- | --- | --- |
| **多渠道适配器（V4 核心）** | `lib/adapters/*`、`lib/channels.js` | 统一任务格式（四态）+ 注册表工厂 + 快照预热（stale-while-revalidate，60 秒常热刷新）；单渠道 init 失败降级不拖垮其他渠道；渠道启停热应用（`applyChannels`） |
| ACP 自动发现（端口从日志、密钥从进程内存 ReadProcessMemory） | `lib/acp.js`、`lib/get-agnes-secret.ps1` | agnesd 重启换端口/密钥后连续失败 ≥3 次自动重新发现 |
| 手机 PWA 看板（对话视图、步骤折叠、两级分组、渠道 Tab） | `web/index.html`、`web/app.js`、`web/style.css` | 单页，Android/iOS/鸿蒙通用；渠道 Tab 含健康状态点，单接入不显示；按渠道缓存 + 服务端快照秒显 |
| 实时推送 + 兜底轮询 | `bridge.js`、`lib/wsHub.js` | ACP 变化通知 300ms 防抖拉取；轮询间隔 `pollIntervalMs`(默认 3s)；前端 8 秒兜底轮询 + 断线指数退避；WS 实时事件目前仅 agnes 接线，其他渠道靠快照/下拉刷新 |
| 手机发消息（唯一写方法） | `lib/adapters/agnes.js`（session/prompt）、`lib/localApi.js` | agnes：配对令牌 + 限速（每分钟 10 条，429 提示），`messages.enabled` 可关闭；workbuddy：V4.1 headless CLI 续聊（lite bundle + `custom-local:` 前缀）；trae：501 UNSUPPORTED |
| **Tab 式配置中心（V4.1 重构）** | `web/setup.html`、`lib/setupApi.js` | 6 页签（首页总览/邮箱推送/公网访问/公共配置/渠道独立配置/看板与配对），每页独立保存；渠道 chip 勾选条，勾选才出现渠道配置块 |
| 二维码配对 | `lib/pair.js` | 6 位码，TTL 5~120 分钟（默认 15），有效期内可重复使用，设备令牌仅存内存，桥接重启需重新配对 |
| 公网隧道 | `lib/tunnel.js` | quick（trycloudflare 免注册）/ named（固定域名，幂等 provision：复用隧道、补 CNAME、补 ingress）双模式，断线指数退避重启 |
| 邮件推送（配对码/地址变动） | `lib/mailer.js`、`lib/smtp.js` | 自研 SMTP 客户端（兼容非标服务器如 2925.com）；内容签名去重；失败 3 分钟重试至多 5 次 |
| 发件档案故障转移 | `bridge.js` | 连续 2 次失败自动切换下一份已存档案并立即重试 |
| 企业微信推送（可选） | `lib/wecom.js` | 官方 API，token 缓存 + 失效自动刷新 |
| 手机远程配置 | `lib/remoteApi.js`、`web/remote.html` | 管理令牌仅经推送邮件下发（timingSafeEqual 防时序攻击）；绿档操作：收件人/档案/测试邮件/告警与汇总/配对 TTL/发消息开关/隧道启停模式 |
| **任务告警（V3）/ 多渠道分层（V4）** | `lib/alerts.js`、`lib/channels.js` | ①二元组追踪清单 `{channel,taskId}`（localStorage 持久 + 同步回 config.json）②阻塞即时告警（异常/待确认，同一阻塞态不重复，恢复后重置），按渠道双重过滤 ③合并汇总邮件 `sendDigestAll`（一封按渠道分节，节拍 = 全局 `alerts.digestIntervalMinutes`），检测节奏固定 60 秒 |
| 任务四态状态模型（V3.1 重做） | `lib/adapters/base.js`（deriveTaskStatus） | 正在执行/执行完成/异常/待确认；只看最新一轮结果；trae 渠道摘要无状态字段 → 两态简化 |
| 离线缓存 + SW 自动更新 | `web/sw.js`（CACHE `otc-shell-v21`） | 静态资源 `private, no-cache, max-age=0`（绕过 CF 4h 强缓存）；shellVer 自愈仅护看板，setup/remote 页无自愈 |
| **离线验证脚本（V4）** | `tests/verify-*.js` | 配置迁移 4 组 / 合并汇总 9 组 / Trae 适配器（系统临时目录沙箱，绝不碰真实 config.json） |

### ⚠ 未实现 / 需澄清（防止文档夸大）

- **「token/配额耗尽」专项告警不存在**：积分耗尽只作为阻塞态（异常/待确认）的成因之一被间接覆盖（邮件文案提及积分耗尽排查）。文档中不得声称"token 耗尽专属告警"。
- **Trae 渠道发消息不存在**：主数据库加密且被进程锁定、无指令注入通道（取证结论见 CHANGELOG 变动二十七）；`sendMessage` 抛 `UNSUPPORTED`（501）。候选方案 opencode 待评估。
- **豆包渠道不可接入**：无本地 API/ACP/可读数据文件（已验证，见 docs/需求与功能点演进回溯.md）。
- `official.baseUrl/token`：占位符，HTTP 直连模式未使用（`lib/config.js:22-26`）。

## 4. HTTP API（全部需 `X-Device-Token`，配对时签发；`lib/localApi.js`）

- `GET /health`（免鉴权；含 `channels` 各渠道 {channel,displayName,ok,canSend,describe,tasks} 汇总）
- `POST /api/pair`（配对码 → 设备令牌）
- `GET /api/tasks?channel=`（默认 agnes；快照优先，`?fresh=1` 强制实拉）、`GET /api/tasks/:id?channel=`（未知渠道 400 CHANNEL_UNKNOWN）
- `POST /api/tasks/:id/messages`（发消息；只读渠道 501 UNSUPPORTED）
- `GET/POST /api/setup/*`（仅 127.0.0.1，远程 403；保存白名单含 `channels.<ch>` 非凭据字段，渠道键与字段键双重白名单）
- `/api/remote/*`（管理令牌鉴权；save-settings 绿档白名单，凭据字段收到即丢弃）
- WebSocket：`/ws?token=<设备令牌>`，消息类型 hello/subscribed/task_update/step_update/pong（`lib/wsHub.js`；实时事件仅 agnes 接线）

## 5. 配置项全表（config.json，与 lib/config.js DEFAULTS 核对，2026-10-23）

listenHost(0.0.0.0) / port(8787) / timeoutMs(5000) / pollIntervalMs(3000)；
acp{port=0 自动发现, secret='', autoDiscover=true}；official{baseUrl,token,headers=占位符未用}；
tunnel{enabled=true, cloudflaredPath='', mode='quick'|'named', hostname, tunnelName='agnes-board', tunnelToken}；
pair{codeTtlMinutes=15, 5~120}；messages{enabled=true}；
mailer{smtpHost,smtpPort=465,smtpSecure=true,user,pass,to,toHistory[],from,saved[]}；
wecom{corpId,corpSecret,agentId,toUser='@all'}；setup{done}；
alerts{digestIntervalMinutes=60, digestTitle='任务汇总邮件', digestEnabled=false*, alertPrefix='单任务报警-'*, alertEnabled*（* 仅作 agnes 渠道回退源）, watchlist=[{channel,taskId}]}；
board{listLimit=100, listLimitMax=1000}（V4.1 全渠道统一）；
channels{agnes{enabled=true}, workbuddy{enabled=true, alertEnabled=false, digestEnabled=false, alertPrefix=''}, trae{enabled=true, alertEnabled=false, digestEnabled=false, alertPrefix=''}}；未知渠道键前向兼容保留；渠道级旧键（digestIntervalMinutes/digestTitle/listLimit/listLimitMax）加载/保存自动清洗。

## 6. 安全边界（全部源码实证）

- 只读铁律：agnesd 仅 initialize / session/list / session/load；唯一写 = session/prompt（配对令牌 + 限速 + 可关闭）。workbuddy/trae 只读本地转录文件；workbuddy 发消息走 headless CLI 续聊（V4.1，受同样三重约束）；trae sendMessage 抛 UNSUPPORTED
- agnesd 密钥仅存电脑内存，不下发手机端；SMTP 凭据只存本机 config.json（**已被 .gitignore 排除且从未入库**，git log --all 验证）
- 配置中心仅本机回环；远程页令牌仅经邮件下发；timingSafeEqual 防时序攻击；隧道令牌永不回传前端
- 无演示假数据机制；渠道数据源不可用 = 该渠道看板为空 + 三处提示（workbuddy/trae 进程门禁，应用关闭即清零）
- 离线验证脚本走临时目录沙箱，不触碰真实 config.json
- MIT 许可

## 7. 待澄清清单（需用户决策，不阻塞文档）

1. npm 包 version 仍为 0.1.0 而 CHANGELOG 已到 V4.1.0——是否对齐？（改 version 属工程文件，未动）
2. `lib/wecom.js` 存在但配置中心未见企微独立页签（仅 config 可配，邮箱推送页 advanced 区有入口）——文档按"config.json 可选配置"表述。
3. ~~历史包命名~~ ✅ 已统一：CHANGELOG 约定与 00-文档导航 资产表均为 `agent-vigil-VX.Y.Z.zip`。
4. 根目录 `agnes-office-mobile任务会话记录 .md`（136KB 开发日志）与 `技术分享素材.md` 是否随开源仓库公开？建议移出或放入非公开分支（未动，等决策）。
5. `敏感配置备份.md` 已被 .gitignore 正确排除（git log --all 验证无历史），但文件本身在项目目录内，**开源分发打包时注意排除**。
6. npm 包名 `agent-vigil` 尚未在 npm registry 发布（当前 `private: true`）。

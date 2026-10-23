# 变动回溯文档（CHANGELOG）

> 用途：记录每次影响使用体验或行为的关键变动，便于后续回溯排查。
> 版本包命名规则：`agent-vigil-VX.Y.Z.zip`（放在项目同级目录）。

---

## V4.1.0（2026-10-12）

### 变动二十八：WorkBuddy 消息回写修复（CLI 独立入口错配，发送真实可用）

- **问题**：WorkBuddy 详情页「发送」实际从未成功过 — 探测到的 CLI 入口是 `bin/codebuddy`（bin 脚本），它 `require('../dist/codebuddy')` 的主包在 app.asar 打包态内，桥接用独立 node.exe spawn 必崩 `MODULE_NOT_FOUND`；而 bin 脚本的 `--version` 照常打印（2.161.0），版本探测无法识别残缺，探针误判「CLI 可用」。
- **修复**：`_probeCli` 候选次序改为「用户配置 cliPath > `dist/codebuddy-lite-wb.mjs`（桌面端真正的独立完整 bundle）> `bin/codebuddy`」；`sendMessage` 对来自 models.json 的裸模型 id 自动补 `custom-local:` 前缀（CLI 侧自定义供应商条目带此前缀，裸 id 会按内置模型解析报 503/未知模型）。
- **验证**（2026-10-17 实测）：lite bundle 独立运行 ✓；headless 首轮建会话 ✓；`--resume` 二轮续聊 ✓；转录 JSONL 双轮内容 ✓；离线探针指向 lite 入口 ✓；桥接重启后三渠道在线。临时测试会话/目录已全部清理。
- 前提保持：WorkBuddy 桌面端需运行（进程门禁）；模型走 models.json 自定义供应商。

### 变动二十七：新增 Trae 渠道（WorkBuddy 同款本地文件直读模式）

**背景**：多渠道插件化体系接入第三个渠道。取证结论：Trae CN（字节系 AI IDE）的会话正文存于 `%APPDATA%\Trae CN\ModularData\ai-agent\database.db`，文件头为加密数据（非 SQLite 明文）且被运行中进程独占锁定，不可直读；IDE 无本地指令注入通道。唯一稳定可读的本地数据源 = 记忆子系统转录（`~/.trae-cn/memory/projects/<项目转义目录>/<YYYYMMDD>/session_memory_<sessionId>.jsonl`，逐回合追加，无需鉴权）。

- 新增 [lib/adapters/trae.js](lib/adapters/trae.js)：`TraeAdapter extends BaseAdapter`，WorkBuddy 同款读盘策略（mtime/size 缓存 + 1 秒扫描节流 + fs.watch 递归监听防抖 onChange + tasklist 进程探测 30 秒缓存）
  - 任务 = 会话（sessionId 跨天聚合，全量合并读取）；**标题 = 最新一轮 intent**（用户在 IDE 里改的会话名仅存加密主库与云端，本地明文取不到；最新指令随任务推进自动更新，2026-10-12 用户定稿）
  - **cwd/group 工作区池精确映射**：workspaceStorage 各 hash 目录下的 workspace.json folder 字段 + 全局 state.vscdb 明文页 file:/// URI → 真实路径池，按转义规则反查；未命中才退回近似还原（`-` 歧义不可逆，仅展示用）
  - 详情对话流：intent→user / outcome→agent 逐回合成对入列；actions[] 摊平为 done 步骤
  - **两态简化**：摘要记录异步落盘、不携带执行状态字段，failed/waiting 不可判定 → 仅 running（应用在线 + mtime<90 秒活动窗）/ done 两态；该渠道不触发即时告警，汇总邮件正常参与
  - 只读渠道：`canSend=false`，sendMessage 抛 `UNSUPPORTED`（501）
- 注册表接入：[lib/adapters/index.js](lib/adapters/index.js) 注册 `trae` 渠道（数据根可经 `channels.trae.dataDir` 覆盖）；[lib/config.js](lib/config.js) 默认块 `trae:{enabled:true, alertEnabled:false, digestEnabled:false, alertPrefix:''}`
- 前端零改动：配置页渠道 chip / 看板 Tab / watchlist / 告警前缀均按注册表动态渲染
- 测试：[tests/verify-trae-adapter.js](tests/verify-trae-adapter.js)（临时 fixture + 进程门禁关/开双路径 + 跨天聚合 + 两态 + watch 回调）

### 变动二十六：配置页重构为 Tab 式配置中心（每页独立保存 + 渠道勾选条动态配置块）

**背景**：变动二十五把渠道级配置平铺在向导第 4 步，用户反馈：未来内置 10~20 个渠道时配置页会过长；且「所有配置集中到最后一步统一保存」交互怪异。定稿口径：整页改为 **Tab 式配置中心**（首页=介绍/导航，每个大配置项一个独立页签、各自保存按钮分开保存）；渠道区拆两个页签——「公共配置」（全渠道统一节拍）+「渠道独立配置」（紧凑勾选条，**勾上某渠道才动态出现该渠道的配置块**，不勾不出现）。用户拍板：渠道拆两页签；配对码有效期/条数上限独立「看板与配对」页签。

- [web/setup.html](web/setup.html) 全量改版（纯前端，后端 [lib/setupApi.js](lib/setupApi.js) 白名单部分提交特性天然支持，零改动）：
  - 5 步向导 + 顶部进度条 → **6 页签 Tab 导航**：首页（介绍 + 当前状态总览卡 + 连接手机二维码卡 + 快捷入口）/ 邮箱推送（原第 2 步 + 企业微信 advanced 移入）/ 公网访问（原第 3 步）/ 公共配置（汇总间隔 + 汇总标题，空标题拦截回填逻辑随迁）/ 渠道独立配置（原渠道区）/ 看板与配对（配对码有效期 + 列表条数上限滑块）
  - 每个配置页签底部**独立保存按钮**：`saveAll()` 拆为 `saveMailer / saveTunnel / saveAlertsCommon / saveChannels / saveBoardPair` 五个函数，各自只提交对应 patch 块（共用 saveTab helper：save → done → 页签内提示）；保存后标记 pairStale，回首页自动刷新二维码/配对码
  - 渠道独立配置页：渠道渲染为**紧凑 chip 勾选条**（小复选框胶囊排一行可换行，20 个渠道只占两三行）；勾选变化即时增删下方 `.ch-block`（汇总/报警开关 + 前缀输入）；渠道值存 JS 态 `chState`，取消再勾不丢已编辑值；「至少勾一个」拦截保留
  - 首页新增状态总览（邮箱/隧道/已接入渠道/追踪任务数四行 stat，消费 /api/setup/status）与连接手机卡（自原第 5 步 done-area 移植，pair-info 改为进入首页时惰性拉取）
- 页面标题「配置向导」→「配置中心」；.steps 进度条 CSS 移除，新增 .tabs/.chip 样式
- 未动：remote.html、手机端、隧道 provision、发件档案、测试邮件等逻辑原样平移

### 变动二十五：渠道级配置改造（复选框启停 + 开关/前缀按渠道 + 间隔/标题/上限全局统一）

**背景**：V4 多渠道上线后配置粒度混乱——渠道启停只能手改 config.json、汇总/报警开关不分渠道，而汇总间隔和列表上限却按渠道各存一份。用户定稿口径：渠道启停在配置页用**复选框勾选**；「任务汇总总开关」「单任务报警开关」「报警标题前缀」**按渠道独立配**；「汇总间隔」「汇总标题」「看板列表条数上限」**全渠道统一配一份**；追踪清单维持按渠道分开。

- 配置模型（[lib/config.js](lib/config.js)）
  - 渠道级收窄为四键：`enabled / digestEnabled / alertEnabled / alertPrefix`；`digestIntervalMinutes / digestTitle` 归全局 alerts，`listLimit / listLimitMax` 归新全局块 `board`
  - **旧 config.json 自动迁移**：load 时旧渠道级 listLimit/listLimitMax 取最大值并入 board（真实存量 workbuddy 1000 → board.listLimit=1000，行为不变）；agnes 渠道级间隔/标题仅在 alerts 顶层未显式写时提升；save 落盘前逐渠道 prune 旧键——旧配置随任意一次保存完成清洗
  - agnes 回退机制保持：channels.agnes 开关/前缀未显式配置时回退 alerts 顶层（老配置零迁移）
- 渠道启停热应用（[lib/adapters/index.js](lib/adapters/index.js)）：适配器始终注册（watchlist 条目不丢、临时停用不清追踪清单），`isEnabled()` 实时读 config；新增 `applyChannels()`——新启用渠道即席初始化接入、停用渠道清快照 + close 并记日志；未启用渠道不预热/不进 /health/告警整体跳过
- 告警节拍统一（[lib/channels.js](lib/channels.js) / [lib/alerts.js](lib/alerts.js)）：合并汇总节拍 = 全局 `alerts.digestIntervalMinutes`（不再取各渠道最小值）；`checkBlocking / sendDigestAll` 按「渠道启用 + 该渠道开关」双重过滤，停用渠道不出节不报警
- 配置向导第 4 步改版（[web/setup.html](web/setup.html)）：顶部「接入渠道」复选框组（默认勾爱思办公，可勾多个，至少勾一个，全部取消拦截保存）；每渠道子块 = 汇总开关 / 报警开关 / 标题前缀（未勾选渠道子块隐藏）；全局区 = 统计间隔、汇总标题、配对码有效期、看板列表条数上限滑块；保存白名单同步收窄（[lib/setupApi.js](lib/setupApi.js)）
- 手机远程配置页同步（[lib/remoteApi.js](lib/remoteApi.js) / [web/remote.html](web/remote.html)）：告警卡片同样按渠道分块 + 全局项；非凭据白名单原则不变
- 看板 Tab「勾几个显几个」（[web/app.js](web/app.js)）：推翻「≥2 才渲染 Tab」——只接入爱思办公也显示单 Tab；未启用渠道 /health 不返回 → Tab 自然消失。SW 缓存 bump v21（lib/localApi.js shellVer ↔ web/app.js SHELL_VER ↔ web/sw.js CACHE 三处同步）
- 离线验证（[tests/verify-digest-merge.js](tests/verify-digest-merge.js) 7 组 + 新增 [tests/verify-config-migration.js](tests/verify-config-migration.js) 4 组）：合并一封两节 / 全局节拍（渠道级旧键 999 失效）/ down 节 / 基线独立 / 来源徽章 / 不重复轰炸 / **渠道停用隔离（报警不发 + 仅 agnes 出节）**；迁移沙箱断言——board 提升 / agnes 旧键提升 / save 落盘清洗 / 未知渠道前向兼容（全程系统临时目录构造沙箱，绝不碰真实 config.json）
- 实测：9 个后端 + 4 个前端文件 node --check 通过；重启后 /health shellVer=v21 只含启用渠道；browser_use 实测——第 4 步复选框/子块/全局项渲染、取消勾选 WorkBuddy 子块隐藏、保存热生效（/health 只剩 agnes、日志「渠道已停用：WorkBuddy」）；board.listLimit=1000 经滑块端到端恢复
- 踩坑：验证期浏览器子代理加载了被旧 Service Worker 缓存的 setup.html 旧版页面（旧页 saveAll 发旧 patch 使 board.listLimit 短暂回退 100，经 UI 重设 1000 恢复）——shellVer 自愈机制只覆盖看板（app.js），setup.html/remote.html 独立页面无自愈；测试此类页面需带 query 参数绕缓存并先注销 SW

### V4.1.0 踩坑实录（开发期问题 → 解决实践）

| # | 问题 | 根因 | 解决 |
|---|---|---|---|
| 1 | 浏览器测试 setup.html 看不到新功能，且一次"保存"把 board.listLimit 从 1000 打回 100 | 旧 Service Worker 以 cache-first 持续下发旧版 setup.html；旧页 saveAll 发旧 patch（无 board 块、带渠道级 listLimit），deepMerge 覆盖迁移值后又被 prune | URL 带 query 绕缓存 + 注销 SW 清 caches 重测；shellVer 自愈只护看板，独立配置页无此机制——升级发布后提示用户先开一次看板 |
| 2 | 迁移值随浏览器旧页保存丢失 | 旧 patch 经白名单过滤后仍会改写 channels，触发 load 迁移重算（此时渠道级 listLimit 已被旧值覆盖） | 迁移设计本就「随任意一次保存收敛」，数据无损坏（行为回默认 100）；经 UI 滑块重设 1000 端到端恢复并顺带验证 board 白名单 |


## V3.1.0（2026-10-10）

### 变动十二：任务状态模型重做（四态制，核心对齐改动）

**背景**：旧逻辑「任一步工具失败 → 永久标记失败」导致状态严重失真——实测 5 个历史任务抽样 5 个误报（`session/load` 全量重放会把历史上每次失败的工具调用都带回来）。

- 状态仅四个：**正在执行 / 执行完成 / 异常 / 待确认**；永久删除「失败」状态
- **判定只看最新一轮指令的执行结果**：最新 AI 回复的最后一个工具调用 failed → 异常；成功或纯文本回复 → 执行完成（中途失败已恢复的也算）；最后一条是用户消息 → 待确认；运行中 / 90 秒内有活动 → 正在执行
- 全链路适配：official.js（deriveTaskStatus 尾部判定）/ alerts.js（classify 四态分类）/ mailer.js（邮件配色）/ app.js（STATUS）/ style.css（waiting 徽章）
- 验证：9 项全分支桩测试通过；31 个历史会话全部修正为正确状态
- **坑**：桥接刚启动时任务详情从未加载（d=undefined、steps 空），首版把 31 个全标成「待确认」——列表区分「已加载 → waiting / 未加载 → done」中性降级，打开详情后自动精确化

### 变动十三：命名隧道（固定域名，Cloudflare Named Tunnel）

**背景**：trycloudflare 快速隧道地址随机、偶发假在线；用户在 dpdns.org 注册永久子域名并托管 Cloudflare 后，可升级为固定地址的正式隧道。

- `tunnel.mode = quick | named` 双模式：默认 quick 行为不变（无域名用户零感知）；named 走 `cloudflared tunnel run`，令牌走 `TUNNEL_TOKEN` 环境变量（不进命令行/进程列表），地址固定 `https://<hostname>`
- 向导第 3 步新增「初始化命名隧道」按钮 + 表单（域名 / API 令牌 / 隧道名），一键 provision：找 zone → 建/复用隧道 → 绑 CNAME → 写 ingress → 热切换
- **自检式幂等初始化**（实战打磨）：同名隧道已存在则复用（走 `GET /cfd_tunnel/{id}/token` 重新取运行令牌）、CNAME 缺失或指向不对自动补、ingress 路由缺失自动写（保留隧道上其他域名的既有规则）——用户手工配置了一半也没关系，点一次收敛到正确状态
- 安全边界：apiToken 仅 provision 用一次不持久化；tunnelToken 持久化 config.json 但绝不回传前端
- 配置变更热应用：bridge 对隧道配置做签名比对（enabled/mode/hostname/tunnelToken/cloudflaredPath 任一变更 → tunnel.restart()）
- **三个实战坑**：
  1. `cloudflared tunnel run --no-autoupdate` 报 `flag not defined` 秒退——全局 flag 必须放在子命令前：`tunnel --no-autoupdate --protocol http2 run`
  2. provision API 的 `config_src` 参数值应为 `'cloudflare'`（dashboard 托管配置），写成 `'token'` 会与令牌运行方式冲突
  3. **手工配置「建隧道 + 加 CNAME」后仍 503**：隧道的 ingress 路由（Zero Trust 仪表盘的 Public Hostname）与 DNS CNAME 是两件事，缺一不可——流量进了隧道没有路由规则就迷路。provision 现自动补写 ingress：`[{hostname, service: http://localhost:8787}, {service: http_status:404}]`
- README 新增命名隧道 QA：三段链路排查法（DNS 解析不出 = CNAME 缺失 / 503 = ingress 缺失 / 本机服务没起 = curl /health）+ 完全手工配置路径

### 变动十四：缓存与前端更新体验修复

- **静态资源响应头改为 `private, no-cache, max-age=0`**：修复「改了前端，浏览器刷新无数次、无痕窗口都看不到新版」——根因是 CF 对无缓存头的 .js/.css 默认边缘缓存 4 小时并下发同款强缓存头给浏览器。**CF 怪癖**：源站发 `no-cache` 会被 CF 当作「无有效缓存头」回退到 zone 默认 4h；`private` 才会 BYPASS（实测 `cf-cache-status: BYPASS`）
- 追踪铃铛从详情页移到任务列表卡片（右上角），关闭态置灰；悬停提示统一为「任务状态邮件提醒」，开启/关闭 toast 文案同步
- 配对码有效期滑块回归向导第 4 步（5~120 分钟）：config.json 里的值一直生效（120），只是 V3 精简向导时界面被移除
- sw.js 缓存版本 v11

### 变动十五：可观测性（配对码邮件对账日志）

- 每次推送配对码邮件时打印：`[配对码邮件] 码=xxx seq=N 发送时间=YYYY/MM/DD HH:mm:ss TTL=N分钟 预计过期=... 地址=...`
- 用途：核对 codeTtlMinutes 是否真实生效（下一封自动刷新邮件应比上一封晚整 TTL，重启另算）——重启会作废旧码立即发新码，与 TTL 无关

### 变动十六：手机远程配置绿档化（告警/配对有效期/发消息/隧道均可在手机改）

**背景**：远程页原本只能改收件人/切档案/发测试邮件，调个告警开关或隧道还得跑回电脑；但 SMTP 授权码、隧道令牌等凭据绝不能出 127.0.0.1。按「绿档搬、红档留」划界。

- 新增 `POST /api/remote/save-settings`：严格白名单，仅接收 alerts（双开关/间隔 10~240 限幅/标题 50 字/前缀 30 字）、pair.codeTtlMinutes（5~120）、messages.enabled、tunnel（enabled/mode）；**hostname/tunnelToken/cloudflaredPath 等字段收到即丢弃**，注入实测 `tunnelToken=HACKED123` 不影响原值
- status 扩展回显 settings 块；隧道令牌永不回传，只给 `canNamed`（是否已初始化）布尔；切 named 前服务端二次校验本机已有令牌+域名，未初始化返回 `NAMED_NOT_READY`（初始化仍须电脑端向导第 3 步）
- 保存后直接调向导同款 `applySetupChanges()` 热应用：mailer/wecom 重建、`pair.setTtlMinutes`、隧道签名比对重启、`alerts.applyConfig` 定时器重建
- remote.html 新增三张卡：任务告警与汇总（switch 开关+间隔 select+标题输入）、访问与配对（TTL 滑块+发消息开关）、公网隧道（启用开关+快速/固定域名分段+当前地址）；底部安全 hint 同步更新
- named 模式 tunnel.url 不回填时状态接口用 `https://<hostname>` 补全，避免手机误显「隧道未就绪」
- 验证：status 回显 9 字段正确、幂等保存 ok、凭据注入被忽略、无令牌 401、重启后本地/公网 health 双 200、ACP 真实数据在线
- 踩坑：Edit 写入时该行闭合引号莫名丢失（磁盘字节实测缺 `'`，编辑器渲染却正常），`node --check` 抓到 `Invalid token`，以字节级替换修复——此后 JS 改动一律先过 `node --check`

### 变动十七：V4 启动 · AgentAdapter 公共接口 + WorkBuddy 适配器（本地转录直读）

**背景**：V4 目标「一个桥接盯多个 AI Agent」。Phase 1 落地适配器层：抽象统一接口 + 接入第二个渠道 WorkBuddy（此前已验证其 Remote Control 网关全部 401，唯一可行路径=本地文件直读）。

- `lib/adapters/base.js`：BaseAdapter 接口约定（channel/displayName/init/close/health/describe/listTasks/getTask/sendMessage/setOnChange/taskCount）+ 统一任务格式（id/title/status 四态/progress/steps/messages/cwd/group）+ 公共工具（mapStepStatus、deriveTaskStatus、calcProgress、isoMs、cleanUserText）。四态语义与 alerts.js 对齐：running（90 秒内活跃）> failed（最新一轮尾部工具失败）> waiting（最后一条是用户消息）> done
- `lib/adapters/agnes.js`：爱思办公适配器，委托包装现有 OfficialClient（零回归，验证接口表达力：列表/详情/发消息/健康/实时回调全部透传）
- `lib/adapters/workbuddy.js`：WorkBuddy 适配器（只读）——数据根 `%USERPROFILE%\.workbuddy`；列表按 mtime 缓存摘要（每文件只读头尾各 96KB，390 个会话实测 1ms）；详情全量解析 JSONL（ai-title 标题+cwd、fc↔fcr 靠 callId 关联成步骤流、message→对话流、无工具时用 tasks/<sid>/N.json todo 充当步骤、assistant-display 智能体名）；健康=WorkBuddy.exe 进程存活（30 秒缓存）；fs.watch 递归监听转录追加实时回调；sendMessage 明确抛 UNSUPPORTED（网关无写路径）。关键清洗：用户消息剥离 `<system-reminder>` 注入块并解出 `<user_query>` 内层真实输入（标题污染修复）
- `lib/adapters/index.js`：注册表工厂（agnes 默认 + workbuddy 自动发现数据根即接入，channels.workbuddy.enabled=false 可关）；单渠道 init 失败降级不拖垮其他渠道
- 最小接线：bridge.js 启动时 initAll + SIGINT closeAll；/health 新增 `channels` 汇总（[{channel,displayName,ok,describe,tasks}]）。看板 Tab/告警多渠道/watchlist 二元组属 Phase 2/3，本次不动
- 实测：390 个 WorkBuddy 历史会话（四态分布合理 done94/waiting6）、详情 82 消息/124 步骤 25ms、agnes 32 会话回归正常、本地+公网 health 双 200
- 踩坑：①块注释里写 `projects/*/*.jsonl` 中的 `*/` 会提前终止注释（node --check 拦截）②Write 工具对本文件内容反复反序列化失败，PowerShell here-string 落盘解决

### 变动十八：V4 Phase 2 · 配置分层（channels 分渠道告警 + watchlist 二元组）

**背景**：Phase 1 让多个渠道共用一套告警配置，追踪任务也只有裸 id（无法区分渠道）。Phase 2 把「告警策略」与「追踪清单」全部按渠道分层，且对存量爱思办公用户做到配置零迁移、邮件外观零回归。

- `lib/channels.js`（新增，单一真源）：`channelCfg(cfg,ch)` 解析渠道生效策略——**agnes 的 channels 字段留空即回退 V3 的 `alerts` 顶层旧生效源**，其他渠道读 `channels.<ch>` 独立值；`digestTitleFor/alertPrefixFor` 处理默认文案——agnes 默认仍为「任务汇总邮件」「单任务报警-」（无标签），新渠道留空时自动带 `[渠道名]` 前缀（如 `[WorkBuddy] 任务汇总邮件`）；`normalizeWatchlist` 把清单规范成二元组 `{channel,taskId}`——**旧的纯 id 字符串/无 channel 对象读取时一律归一成 agnes，旧 config 无需迁移**，去重 + 单渠道 50 / 总量 200 上限 + 未知渠道过滤
- `lib/config.js`：DEFAULTS 新增 `channels`（agnes 仅 enabled；workbuddy enabled 默认 true、两个告警开关默认 false、间隔 60 分钟、文案留空）；`load()` 对 channels **逐层合并**（浅 Object.assign 会让 file 里的单个渠道对象整体替换默认、丢掉其余默认字段）；file 中未知新渠道键原样保留（前向兼容）
- [lib/alerts.js](lib/alerts.js) 多渠道化：内部清单改二元组；`classify(channel,id)` 按渠道取适配器（兼容旧单参签名=agnes），四态判定同时适配 agnes（工具挂消息 `tools`）与文件型渠道（独立 `steps`，兼容 assistant/agent 两种角色名）；阻塞检测遍历全渠道、**按渠道读 alertEnabled**，去重键与告警态恢复键改 `${channel}:${taskId}`；定时统计**按渠道独立定时器**（间隔可不同，开关热生效即重建），变化指纹按渠道分区互不串扰；数据源全不可用的异常邮件**按渠道分别去重**（_downNotified 集合）；`sync` 支持两种形态——全量二元组 / `{channel, ids:[...]}` 只覆盖单渠道（保留其他渠道条目）；`status()` 旧字段保留（agnes 视角）并新增 `channels` 明细
- [lib/mailer.js](lib/mailer.js)：sendAlert/sendDigest 新增可选 `source`（渠道名徽章），sendAcpDown 按 source 切换「爱思办公专有文案/通用渠道文案」两套模板；**agnes 不传 source，三封邮件的标题与正文与 V3 完全一致（零回归）**
- [lib/localApi.js](lib/localApi.js)：tasks 列表/详情/发消息全部支持 `channel` 参数（query/body，缺省 agnes；未知渠道 400 CHANNEL_UNKNOWN），响应带 channel/displayName；watchlist 全量返回二元组、`?channel=` 返回该渠道纯 id；错误映射新增 AdapterError（UNSUPPORTED=501，WorkBuddy 只读发消息实测 501）
- 配置白名单：[lib/setupApi.js](lib/setupApi.js)（本机向导）与 [lib/remoteApi.js](lib/remoteApi.js)（手机远程页）的 save/status 支持 `channels.<ch>` 的非凭据字段（enabled/两个开关/间隔 10-240 限幅/标题 slice50/前缀 slice30），**渠道键与字段键双重白名单，连接参数、dataDir、凭据一律不收**；两端 status 回传各渠道生效值+追踪数+displayName
- [bridge.js](bridge.js)：AlertManager 与两个配置 API 注入 adapters；前端 [web/app.js](web/app.js) 单渠道视图恒以 `channel:'agnes'` 同步（只覆盖 agnes，不影响其他渠道），SW 缓存 bump v16
- 实测：离线 30+ 断言（旧格式归一/去重/限量、agnes 回退、四态 7 分支、渠道开关门控、同态去重、双渠道独立指纹、全故障渠道邮件、旧 classify 签名）；真实 390 个 WorkBuddy 会话 classify 抽查正确；HTTP 层 200/400/501 实测；重启后本地+公网 health 双 200（agnes 32 / workbuddy 390 均在线）；现有 32 条旧 watchlist 自动归一 agnes，零迁移
- 注意：WorkBuddy 渠道两个告警开关默认**关闭**，需要在向导/远程页手动开启后才会发该渠道邮件；看板渠道 Tab 为 Phase 3

### 变动十九：V4 Phase 3 · 看板渠道 Tab（多渠道切换，单接入不显示）

**背景**：Phase 2 完成配置分层后，前端仍是单看板视角。Phase 3 让列表页按启用渠道渲染切换 Tab——「一个看板盯多个 Agent」的前端最后一环；同时明确**单接入（仅 agnes）时界面与 V3 完全一致，零感知**。

- 后端能力位：BaseAdapter 新增 `canSend`（默认 true，[lib/adapters/base.js](lib/adapters/base.js)）；WorkBuddy 只读渠道覆写 false（[lib/adapters/workbuddy.js](lib/adapters/workbuddy.js)）；/health 的 channels 汇总带 canSend（[lib/adapters/index.js](lib/adapters/index.js)）
- 渠道 Tab（[web/index.html](web/index.html) + [web/style.css](web/style.css) + [web/app.js](web/app.js)）
  - 列表页顶置 `#ch-tabs` 胶囊 Tab（横向可滑动）：Tab = displayName + 健康状态点（绿=在线/红=故障），当前 Tab 蓝底高亮；**仅启用渠道 ≥2 时渲染**，单接入不出现
  - 点击切换：清空任务与分组展开态、按 `?channel=` 重拉列表；当前 Tab 渠道在 /health 中消失时自动回退第一可用渠道
  - 追踪键升级为「渠道:任务id」（loadWatchLs 兼容旧纯 id 自动归 agnes）；syncAlerts 只上报当前渠道（服务端单渠道覆盖，其他渠道条目不受影响）
  - 详情页快照 currentChannel 防 Tab 串扰；底部发消息输入栏按渠道 canSend 显隐——WorkBuddy 只读渠道隐藏输入框，与后端 501 语义一致
  - 任务缓存 LS 改 `{ch, tasks}` 结构（旧数组=agnes）；WS 实时事件目前仅 agnes 接线（bridge 只对 official.setOnChange），非 agnes 渠道列表/详情更新靠下拉刷新，相关推送回调按渠道门控防串台
- SW 缓存 bump v17
- 实测：全部改动文件 node --check 通过；重启后本地+公网 /health 双 200（agnes canSend=true / workbuddy canSend=false）；browser_use 三轮实测 8 项全过——自动配对、双 Tab 渲染带状态点、agnes 默认列表、切 WorkBuddy/切回、WorkBuddy 详情无输入框、agnes 详情有输入框、铃铛开（金色+toast）/关（灰色）闭环且最终关闭
- 踩坑：验证期发现服务端 watchlist 曾被短暂覆盖为缺 4 条的快照（32→28），来源指向离线验证脚本直写真实 config.json 的副作用；用户手机端随即以本地完整 32 条同步自愈（服务端真源设计反向发挥作用），已复核 GET /api/alerts/watchlist 返回完整 32 条无过滤丢失。规约沉淀：**离线验证/测试脚本一律不得直写真实 config.json**——须深拷贝 cfg 或把保存路径指向临时文件

### 变动二十：看板列表加载提速（服务端快照预热 + 前端按渠道缓存秒显）

**背景**：用户反馈手机打开看板链接后列表加载慢——进看板先空屏再渲染；切到 WorkBuddy 又空屏重拉；**切回爱思办公还是空屏**，每次切换都像全新请求。桥接为个人/小团队本地部署（无并发压力），可激进缓存：让服务端提前把各渠道任务列表备好，手机端点进来即取即显。

- 服务端快照（[lib/adapters/index.js](lib/adapters/index.js)）：createAdapters 内置 `_snap` 快照表（ch → {tasks, at}）
  - `listTasksSnapshot(ch)`：有快照**立即返回**（过期也先返回旧数据、同时后台静默刷新，stale-while-revalidate）；无快照才等待实拉
  - `listTasksFresh(ch)`：绕过快照强制实拉并回写（下拉/手动刷新用），失败向上抛保持既有错误语义
  - 预热：initAll 每个 adapter init 后立即实拉预热；60 秒常热定时器周期刷新全渠道快照（对齐阻塞检测节奏）；closeAll 清定时器
  - 隔离铁律延续：快照刷新失败仅 warn 日志并保留旧快照，单渠道故障不拖垮其他渠道
- API 层（[lib/localApi.js](lib/localApi.js)）：GET /api/tasks 默认走 `listTasksSnapshot`（命中即毫秒级返回）；`?fresh=1` 走 `listTasksFresh`；adapters 未注入的旧装配路径保持直连
- 前端（[web/app.js](web/app.js)）
  - 新增 `state.tasksByCh`（Map）：按渠道内存缓存任务列表，**切 Tab 先用缓存秒显再静默刷新**（修掉「切回又空屏」的根因——旧 switchChannel 先清空重拉）
  - loadList 快照 `ch = state.channel` 防竞态：响应回来若已切走，只更新缓存不覆盖当前渠道渲染
  - 新增 `prefetchOtherChannels()`：当前渠道加载完成 / 渠道注册表就绪后，后台静默预取其他渠道列表（去重防并发）；503 时若有缓存保留旧列表（顶部提示条说明原因）
  - 刷新语义分层：下拉刷新/手动刷新/轮询降级走 `fresh=1` 实拉；进看板/切 Tab 走快照（WS 实时事件仍按原逻辑原地更新，不经快照）
- SW 缓存 bump v20（lib/localApi.js shellVer ↔ web/app.js SHELL_VER ↔ web/sw.js CACHE 三处同步）
- 实测：4 个改动文件 node --check 通过；重启后 /health shellVer=v20 双渠道全绿（agnes 32 条 / workbuddy 390 条）；带令牌实测——agnes 快照 **13ms**、workbuddy 快照 **11ms**（旧路径 workbuddy 实拉 33ms 起，公网还叠加隧道往返）、`?fresh=1` 正常回写；服务日志无错误无刷新失败告警
- 说明：workbuddy 列表 100 条为其既有 MAX_LIST 上限（快照/实拉一致），/health tasks=390 是 taskCount 全量计数，非本次回归

### 变动二十一：看板列表条数上限可配置（workbuddy MAX_LIST 100 → 配置项）

**背景**：用户重度使用 WorkBuddy 近半年任务积累 390+ 条，写死的 `MAX_LIST = 100` 只显示最近 100 条——用户指出这是人为截断，上线后用户任务到 101 条时第 101 条"消失"会被当成 bug。需求：条数上限做成配置（向导滑块 100~1000，默认 100），滑块上限值也可在配置文件里继续调大，不设硬顶（改多大只是"允许多大"，实际返回条数受任务总量自然约束）。

- 配置项（[lib/config.js](lib/config.js) DEFAULTS.channels.workbuddy 新增，均热生效）
  - `listLimit`：看板列表条数上限，默认 100，下限兜底 100（[lib/adapters/workbuddy.js](lib/adapters/workbuddy.js) `_listLimit()` 实时读取，删除写死的 MAX_LIST 常量）
  - `listLimitMax`：向导滑块允许的最大值，默认 1000；**不进 setup 白名单，仅配置文件可改**——手改后重新打开向导，滑块范围自动扩展到 100~新值
- 向导 UI（[web/setup.html](web/setup.html) 第 4 步「看板列表条数上限」滑块）：仿配对码有效期滑块；标题右侧实时显示当前值（滑动跟随，保存后与配置一致）；**配置文件手改值超出滑块范围时（如 2000 > 滑块上限 1000），滑块钳在最大位但标题仍显示实际生效值 2000**
- API（[lib/setupApi.js](lib/setupApi.js)）：channelStatuses 回显两键；POST /api/setup/save 白名单收 `channels.workbuddy.listLimit`（下限 100、上限 = 当前 `listLimitMax` 钳制）；适配器经 cfg 引用实时读值（config.save 原地 deepMerge，引用恒为最新）→ 保存即热生效无需重启
- 文档：README「配置说明（config.json）」表新增两键说明（含手改方式）
- 实测：4 个改动文件 node --check 通过；重启后 /api/setup/status 回显 listLimit=100/listLimitMax=1000；经 setup API 保存 listLimit=1000 热生效（无重启）——workbuddy 实拉 **392 条 / 82ms**、快照 **392 条 / 27ms**，agnes 32 条不受影响；公网 /health v20 双绿（workbuddy tasks=392）；当前用户配置保留 1000

### 变动二十二：多渠道邮件合并（汇总一封分节 + 报警标注来源渠道）

**背景**：V4 多渠道上线后，每个启用「任务汇总」的渠道仍各发各的定时邮件（渠道多了收件箱被轰炸），且单任务报警邮件看不出任务来自哪个渠道。用户需求：①汇总邮件**只发一封**，内部像看板首页 Tab 一样按渠道分节（「爱思办公任务汇总」一节带表格、「WorkBuddy 任务汇总」一节，无变化的渠道显示现有提示文案）；②报警邮件显示任务来源渠道（爱思办公还是 WorkBuddy）。**用户追加**：两种邮件都要像看板一样先显示任务目录再显示任务——渠道多、任务多之后定位必须三级不缺失（**渠道 → 任务目录 → 任务**）。

- 汇总合并一封（[lib/alerts.js](lib/alerts.js)）
  - `sendDigest(channel)` 替换为 `sendDigestAll()`：遍历所有启用汇总的渠道，收集各渠道 `_digestSection()` 分节，合到一封 `mailer.sendDigest({sections, ...})`；**节拍 = 各启用渠道间隔的最小值**（单一定时器 `_digestTimers['*']`，`_digestBeat`），applyConfig 热应用重建
  - `_digestSection(ch, ids)`：单渠道收集有变化任务行；指纹基线 key 升级 `渠道:任务id`，**基线仍按渠道独立**（删旧写新只动本渠道前缀）；全部任务查询失败不再单独发整封异常邮件，返回 down 节（`{down: true}`）
  - 汇总关闭或无追踪任务的渠道不出节；日志输出「合并定时统计已发送（爱思办公 N 个有变化；WorkBuddy 均无变化）」
- 邮件模板分节渲染（[lib/mailer.js](lib/mailer.js)）
  - `sendDigest(p)` 重写为多分节：每节 = 渠道徽章 + 「任务汇总」标题 + 表格；down 节 → 红色「数据源不可用」警告框；rows 空 → 「本轮 X 个被追踪任务均无变化」；有行 → 表格 + 「另有 N 个无变化」脚注；主标题用顶层 `alerts.digestTitle`，节拍说明改为「各渠道合并为一封」
  - **`sendAcpDown` 整函数删除**（数据源故障信息并入合并邮件 down 节，不再单独发异常邮件）
- 报警邮件来源徽章（[lib/alerts.js](lib/alerts.js) `checkBlocking`）：`source = displayNameOf(channel)`——**所有渠道（含 agnes）都带**，正文显示「来源渠道：爱思办公 / WorkBuddy」，用户可分辨任务来自哪个看板 Tab
- 邮件三级定位（渠道 → 任务目录 → 任务，用户追加需求）
  - 数据源：workbuddy 详情自带 `group` 显示名直取；agnes 详情原本不带目录——[lib/official.js](lib/official.js) `_acpDetail` 正常/降级两处返回补 `cwd`
  - [lib/alerts.js](lib/alerts.js) 新增 `_dirOf(t)`：`group` 优先、回退 `path.basename(cwd)`；汇总行与告警 payload 都带 `dir`；告警日志同步带 `[渠道/目录]` 便于对账
  - [lib/mailer.js](lib/mailer.js)：汇总表格加「📁 目录」列（**目录列在任务列前**，与看板「先目录后任务」一致，空显示 —）；报警邮件状态块内加「📁 任务目录：X（来源渠道：Y）」行
- 离线验证（[tests/verify-digest-merge.js](tests/verify-digest-merge.js)，mock mailer/adapters 深拷贝 cfg）：9 组断言全绿——双渠道一封两节 / 节拍 30（取最小）/ 汇总关渠道不出节 / down 节 / 基线独立（挂掉两轮恢复后只影响自己）/ agnes 也带来源徽章 + 目录（basename 回退）/ workbuddy 目录（group 直取）/ 同一阻塞态不重复轰炸
- 实测：`node --check` 通过；重启后日志「定时统计：爱思办公 每 30 分钟（合并为一封，按最短间隔 30 分钟发送）」；经 setup API 临时把间隔调 10 分钟收到真实合并邮件验证后恢复 30

### 变动二十三：邮件渠道节标题样式修正 + 标题配置空值拦截（默认值回填）

**背景**：①变动二十二上线的汇总邮件渠道节用了「胶囊徽章 + 标题」样式，用户实测反馈胶囊看起来像可切换的标签页（邮件里根本没有交互），要求改成一目了然的列表分节——一个渠道、一个标题、一个表格；②标题类配置（汇总标题/报警前缀）清空后点保存会存进空串，用户要求：留空保存必须拦截并自动填回默认值，且把默认值写进配置项说明便于参照。

- 渠道节标题去胶囊（[lib/mailer.js](lib/mailer.js)）：「[渠道名] 任务汇总」胶囊 → 纯静态标题行「渠道名 · 任务汇总」（左侧 4px 蓝竖线 + 15px 加粗），多渠道纯上下罗列，零交互暗示
- 报警邮件同步（[lib/mailer.js](lib/mailer.js)）：删除正文来源胶囊；来源并入「📁 任务目录：X（来源渠道：Y）」行，目录缺失时单独一行「来源渠道：Y」——三级定位（渠道/目录/任务）不缺失
- 标题空值拦截（[web/setup.html](web/setup.html) saveAll / [web/remote.html](web/remote.html) saveSettings）：清空留空点保存 → **阻止提交** + 两个标题输入框自动填回默认值（「任务汇总邮件」/「单任务报警-」）+ 红色提示「已自动填回默认值…请确认后重新保存」；确认后再次保存正常（远程页按手机体验：回填后直接以默认值保存）
- 后端兜底（[lib/setupApi.js](lib/setupApi.js)）：标题字段白名单收到空串一律**不写入**（保留原值），直接调 API 也无法把标题抹成空
- 说明文案：两个输入框 label 明确「留空保存会被拦截并自动填回默认『XXX』」，placeholder 显示「默认值：XXX」
- 实测：browser_use 本机向导实测 3/3 通过（清空→保存→拦截+回填+错误提示；再次保存成功）；`node --check` 通过；离线断言 6 组全绿（告警 payload 未变）

### 变动二十四：WorkBuddy 进程门禁（应用不在 = 渠道无数据）

**背景**：用户关闭 WorkBuddy 桌面端后，看板 Tab 顶部提示「取不到数据」、下方却仍渲染旧列表——根因是进程探测（health → tasklist）与数据读取（磁盘 JSONL 直读，本身不依赖应用进程）是两条独立路径，产生「进程没了数据还在」的矛盾观感。用户定稿语义：**确认拿不到就清零，跟实际相符**（WorkBuddy 无本地 API/ACP 可走，读盘是唯一数据途径；进程门禁对齐 agnes「未检测到进程=空看板」体验）。

- [lib/adapters/workbuddy.js](lib/adapters/workbuddy.js)：`listTasks`/`getTask` 入口**前置进程探测**，探测不到 WorkBuddy.exe → 返回空列表/null；快照层随空列表自然清零 → 看板清空只留提示条，应用重开后自动恢复（health 有 30 秒缓存，最长 30 秒延迟）
- `getTask` 同门禁：应用不在时详情按无数据处理，告警分类跳过（不会对已关闭渠道误报）
- 附带简化：running 叠加不再需要 appAlive 条件（门禁保证在线才走到这一步）
- 实测：`node --check` 通过；应用在线路径 394 条正常返回（health=true）；关闭路径为门禁早退逻辑，用户关闭应用后 ≤60 秒（快照刷新周期）看板清零、重开自动恢复

### V3.1.0 踩坑实录（开发期问题 → 解决实践）

| # | 问题 | 根因 | 解决 |
|---|---|---|---|
| 1 | cloudflared 启动即退 `flag not defined` | Go 子命令 flag 顺序：全局 flag 不能放子命令后 | `tunnel --no-autoupdate --protocol http2 run` |
| 2 | 命名隧道通了但域名 503 | 隧道 config 为 null（无 ingress 规则），CNAME 只解决「域名→边缘」半段 | API 写入 ingress 规则（Public Hostname 的等价物） |
| 3 | 用户手工配置隧道不通 | 教程普遍漏讲 Public Hostname，只讲建隧道+加 CNAME | provision 自检补全 + README QA 明确标注 |
| 4 | 改前端后刷新/无痕都看不到 | CF 默认 4h 强缓存 + 把 no-cache 当无效头 | `private, no-cache, max-age=0` → BYPASS |
| 5 | 新域名电脑打不开、手机能开 | 运营商 DNS 对「查无记录」负缓存 ~30 分钟（SOA TTL 1800s） | 一次性现象，等过期/换网络；新配域名属正常 |
| 6 | 四态改造后 31 个历史任务全标「待确认」 | 桥接刚启动详情未加载，误判无数据=waiting | 未加载给中性值 done，详情打开后精确化 |
| 7 | 自测配对码总「被消耗」 | 验证请求本身会消费一次性码 | 用本机免鉴权 GET /api/setup/pair-info 取码 |
| 8 | 爱思重启后连续 2 封空白汇总邮件，ACP 永久连不回 | agnesd 重启换端口（50301→60884）+换 secret，AcpClient 死守旧端口重试无重新发现机制 | rediscover：连续重连失败 ≥3 次自动重新发现新 pid/port/secret 并切换；完整回溯见 [docs/Bug回溯与修复经验.md](docs/Bug回溯与修复经验.md) BUG-001 |
| 9 | 配对码「点一次就作废」与 TTL 矛盾：用户 120 分钟内第二次点邮件链接报「无效或已过期」，且每次消费还触发新码邮件 | `PairManager.pair()` 用后即焚（一次性语义）与「有效期」语义冲突——用户明确：TTL 内点多少次都应有效 | 移除消费即焚：码在 TTL 内可重复配对（多设备各自换令牌），过期才作废自动换新；消费不再触发新码邮件；README 5 处「一次性」描述同步修正 |
| 10 | 单任务告警/汇总邮件的「打开看板」链接点不开：链接是纯地址不带 code，未配对手机停在配对页；且旧 code 链接失败会盖掉本地已有令牌 | alerts 的 getBaseUrl 只返回 `tunnel.url`；boot 见 `?code=` 无条件 autoPair 且失败即停配对页，不回退本地令牌 | ① getBaseUrl 拼当前有效码（PairManager.currentCode），未配对设备点击即自动配对进入 ② autoPair 失败时回退读本地 conn + health 校验，已配对设备直接进 |
| 11 | 电脑端批量「全开」追踪后，手机只显示一半任务有标记，两边不同步 | 追踪标记在每个浏览器各存一份 localStorage，UI 只渲染本地副本、从不向服务端拉取；且 enterList 每次都把本地清单**全量覆盖推送**——旧副本设备一进看板就冲掉其他设备的改动（顺序决定数据） | 确立**服务端为清单唯一真源**：新增 GET /api/alerts/watchlist（alerts.getWatchlist）；enterList 改为 reconcileWatch()——进看板先拉服务端清单覆盖本地并重绘，拉取失败（离线）保留本地不推送；实际开关操作仍即时推送；SW v14 |
| 12 | 汇总邮件渠道节用胶囊徽章，用户误认为可切换的标签页（实测截图反馈） | 邮件里没有交互，任何「控件感」视觉（胶囊/按钮样）都会误导；且仅凭截图无法还原设计意图，需按用户口述的字面结构（渠道→标题→表格罗列）实现 | 改纯标题行（左竖线+加粗）；教训：**邮件模板不用任何按钮/胶囊/标签类样式表达分组** |
| 13 | 合并汇总邮件整轮未发且日志无任何痕迹 | 服务端 watchlist 被清空（清空动作发生在留存日志之外无法取证；config.save deepMerge 对未提及的数组键原样保留，本次保存操作已排除嫌疑），sendDigestAll 无追踪任务 → sections 空 → 静默 return false | 排查「定时邮件没发」先查 `/api/setup/status` 的 watchCount 是否为 0；设备本地清单未被覆盖时，任意铃铛开关触发 sync 即整清单自愈（32→28 事件先例） |

---

## V3.0.0（2026-10-09）

### 变动十：任务邮件告警与定时统计（预警和告警）

**背景**：任务跑着不用盯屏幕，但要「出事了知道」。V3 给看板加上邮件预警：手机上标记要监控的任务，出现异常 / 等待确认时第一时间收到邮件，也可以按间隔定时收到汇总报告。

**组成（三个开关，各管一摊）**
- 「🔔 追踪」开关（任务详情页右上）：给单个任务打监控标记，**状态存手机本地（localStorage）**，关掉页面重开保持；同时全量同步到服务端副本（`config.json` 的 `alerts` 块），供桥接定时扫描——手机不在家定时器照常工作
- 「📊 统计」总开关（列表页顶栏）：开 → 每隔设定分钟数把所有被追踪任务汇总成一封**表格邮件**（任务名 / 状态 / 最新反馈消息）
- 「🔔 告警」总开关（列表页顶栏）：开 → 被追踪任务进入**阻塞态（出现异常 / 待用户确认）**时立即发单任务提醒邮件；同一阻塞态不重复轰炸，恢复后再次阻塞会重新告警

**状态四态推导（[lib/alerts.js](lib/alerts.js)，基于只读数据）**
- 正在执行：任务活动中（90 秒内有动静或存在运行中的步骤）
- 出现异常：**最后一步**工具调用是失败（AI 折在错误上没再往下走）
- 任务结束：有步骤且最后一步成功（中途失败过但已恢复推进的也算）
- 待用户确认：纯对话任务（无工具步骤）AI 停止输出——等用户回复
- ⚠️ 官方接口没有「等待确认」原生信号，以上为启发式推导；「异常」特意只看**尾部失败**——`session/load` 会把历史上每一次失败的工具调用都重放回来，若任一失败就算异常，几乎所有老任务都会误报（实测 5 个抽样任务 5 个中招，修复后全部正确归类为「任务结束」）

**其他**
- 定时统计间隔在**配置向导第 4 步**设置（30 分钟 / 1 / 2 / 4 小时，默认 1 小时），保存热生效（[lib/setupApi.js](lib/setupApi.js) 白名单 + `alerts.applyConfig()` 重建定时器）
- 邮件复用现有发件服务与收件人（[lib/mailer.js](lib/mailer.js) 新增 `sendAlert` / `sendDigest`），1 秒限速 + 失败自动重试；告警邮件异常=红色系、待确认=琥珀色，带最新消息与「打开看板」按钮
- 阻塞检测固定 60 秒一轮，不受统计间隔影响；定时器均 `unref` 不阻塞退出

**注意事项**
- 手机端开关改动需要能连上桥接才同步到服务端；同步失败静默，下次操作自动补同步
- 告警扫描会对被追踪任务每 60 秒做一次 `session/load`——同 V1 变动二，电脑端对应任务可能偶发「被锁」红点，属正常现象
- 统计邮件里每条任务只带最新反馈的前 120 字，看全量请打开看板
- 桥接重启后服务端副本从 `config.json` 恢复，但手机需重新配对（配对码一次性，安全设计不变）

---

### 变动十一：向导整合告警配置 + 邮件标题可配（同日迭代）

**背景**：告警配置入口收拢——配置类的东西进向导，看板顶栏只留现场操作。

**改动**
- 向导第 2 步更名「**任务看板及配置地址推送**」并重写介绍：说明 Cloud 桥接隧道会不定时失效、地址重建后自动推送新地址到邮箱（原「邮箱推送」）
- 移除向导第 2 步「启用邮件推送」开关：邮件推送为常开主通道，表单常显（原关闭逻辑 = 清空发件配置，已无此路径）
- 配置向导第 4 步从「配对策略与手机消息」重构为「**任务告警与汇总**」：移除配对码有效期滑块与手机发消息开关（发消息默认允许，`messages.enabled` / `pair.codeTtlMinutes` 仍可改 config.json）
- 「**任务汇总**」总开关从手机看板顶栏**迁入向导第 4 步**（`alerts.digestEnabled`）；随后「🔔告警」按钮也迁入，手机看板顶栏不再有任何告警类开关
- 新增「**任务汇总邮件标题**」（`alerts.digestTitle`，留空默认「任务汇总邮件」）与「**单任务报警邮件标题公共前缀**」（`alerts.alertPrefix`，留空默认「单任务报警-」；报警标题 = 前缀 + 任务名），均持久化到 config.json
- **「单任务报警」总开关迁入向导第 4 步**（`alerts.alertEnabled`，置于报警标题前缀之前）：手机看板顶栏「🔔告警」按钮移除；策略生效条件 = 任务已「🔔追踪」+ 总开关打开，实时读 config（向导保存热生效）；手机端 sync 只上报追踪清单，不再覆盖服务端开关
- **收件邮箱支持多地址**（向导 + 手机远程配置页通用）：输入用逗号（中英文均可）分隔，保存时自动归一化（去空格/去重/统一英文逗号）；SMTP 层逐个 RCPT——单个地址被对方服务器拒收（如写错）只记警告，其余收件人照常收到，全部被拒才报错
- 手机端 `alerts/sync` 只上报追踪清单（`digestEnabled`/`alertEnabled` 均不再上报，服务端值不被覆盖）；`alerts.applyConfig()` 热应用重建定时器，向导保存即生效

**验证**：汇总/告警邮件各实发一封（标题分别为「我的任务日报」「告警|任务名」）确认标题全链路生效；向导第 4 步浏览器实测 9/9 通过。

---

## V2.0.0（2026-10-06）

### 变动一：基于互联网访问（Cloudflare 免费隧道）

**背景**：V1 仅限局域网，人不在家就看不了任务。V2 启动时自动拉起 `cloudflared`（Cloudflare 官方免费工具，免账号、免域名），获得 `https://xxxx.trycloudflare.com` 公网地址，手机在任何网络都能访问，流量经 Cloudflare 加密中转。

**实现**（[lib/tunnel.js](lib/tunnel.js)）
- 从 cloudflared 输出解析公网 URL；进程意外退出时指数退避自动重连（5 秒起，上限 5 分钟）
- 未安装 cloudflared 时**安静降级**为纯局域网模式（打印下载指引），绝不阻塞启动
- 附带 `tools/cloudflared.exe`（Windows 版，也可自行从官方下载放入 tools/ 或 PATH）

**注意事项**
- 快速隧道地址**每次重启服务都会变**——但新地址会自动推送到配置的邮箱（见变动二），无需人肉到电脑旁看
- 首次建连偶尔较慢（Cloudflare 边缘建连），重试即可

---

### 变动二：配对信息自动推送（邮箱 SMTP 主通道 + 企业微信可选）

**背景**：地址和配对码会随重启/过期变动，V1 只能守在电脑旁看控制台。V2 支持「有变动就推」：配对码生成、过期自动刷新、隧道地址就绪/变化时，自动把 **访问地址 + 配对码 + 二维码** 推送到用户邮箱。

**实现**
- [lib/mailer.js](lib/mailer.js)：SMTP 发信（HTML 邮件内嵌二维码，手机点链接或扫码均可），失败自动重试，1 秒限速
- [lib/smtp.js](lib/smtp.js)：自研轻量 SMTP 客户端（逐条发送每步等待、AUTH 后重发 EHLO、STARTTLS、支持内嵌图片）
- [lib/wecom.js](lib/wecom.js)：企业微信应用消息（可选通道，token 缓存复用）
- [bridge.js](bridge.js)：多通道推送调度，30 秒去抖合并（避免地址+配对码同时变动时连发多条）；首推最长等隧道 20 秒（尽量推公网地址）；**全部通道失败自动重试**（3 分钟 × 最多 5 次，保证新码最终进邮箱）
- 全部使用**部署者自己的邮箱/企微账号**，配置存本地 `config.json`，不经任何第三方中转

**推送内容对齐（V2 补充，用户实测反馈）**
- 每次产生新的地址/二维码/配对码都发一封邮件（首启、重启、过期刷新、隧道变化均触发）
- 邮件正文带**服务器发送时间**（电脑本机时间，`YYYY-MM-DD HH:mm:ss`）——因为邮件收件时间与服务器时间可能错位，以发送时间为准判断码是否过期
- 邮件带**「第 N 次生成」计数**：本次启动后第 N 个码；向导完成页、控制台横幅显示同一计数，三方对应即可确认邮件不是旧的
- 推送失败不再静默丢弃（见上：自动重试）

**注意事项**
- 邮箱需在设置里开通 SMTP 服务并生成**授权码**（不是登录密码），向导第 2 步有图文教程
- 配对码是一次性的且默认 15 分钟有效，**使用后或过期会自动推新码**（60 秒内）
- 未配置任何推送通道时功能自动关闭，服务不受影响
- **非标服务器提示（如 2925.com）**：个别服务商要求发件地址必须是授权身份之一（如手机号别名），登录邮箱反而被断连。`config.json` 的 `mailer.from` 可指定发件地址（留空=同登录邮箱）；向导「发送测试邮件」遇到 554 时会自动解析服务器提示并列出可填的身份

---

### 变动三：手机端可发消息（突破纯只读的唯一例外）

**背景**：V1 手机只能看。任务报错或 AI 等待确认时，用户没法在手机上回一句「同意执行」或「改用方案 B」，必须跑回电脑旁。

**实现**
- 手机详情页底部新增输入栏，发送后消息走 `POST /api/tasks/:id/messages`（[lib/localApi.js](lib/localApi.js)）
- [lib/official.js](lib/official.js) `sendMessage` → [lib/acp.js](lib/acp.js) `promptSession` 调 ACP `session/prompt` 把消息写入会话，**等价于电脑端输入框发消息**；AI 回复经 session/update 通知流实时回显到手机对话
- 安全：仅已配对设备令牌可用；每 IP 每分钟限 10 条；消息上限 4000 字符；可在配置关闭（`messages.enabled=false` 回归纯只读）

**注意事项（重要）**
- 「发送即确认」：消息送达会话即返回成功，**AI 处理需要时间**（复杂任务可能数分钟），回复会实时出现在对话流里，无需等待页面
- 发消息会让 AI 继续处理该任务——**只对信任的任务发**，别拿执行中的任务做测试
- 限速超限返回 429，稍等 1 分钟再发

---

### 变动四：配对码有效期可配置（pair.codeTtlMinutes）

- 默认 15 分钟，可配 5~120 分钟（越短越安全、越长越方便），开源部署者自定
- [lib/pair.js](lib/pair.js) 构造时读取，配置向导保存后**热更新**（仅影响之后新发的码）

---

### 变动五：配置向导（首次部署引导）

**背景**：开源后，别人下载包启动时需要先配邮箱/隧道等外部服务账号。V2 新增**仅限本机访问**的分步引导页。

**使用**：启动服务后，控制台横幅会提示打开 `http://127.0.0.1:8787/setup.html`，按 5 步完成：
欢迎 → 邮箱推送（服务商预设 + 授权码教程 + 测试邮件按钮）→ 公网隧道（自动检测 cloudflared）→ 配对策略（TTL 滑块 + 发消息开关）→ 完成（保存并展示二维码/配对码）

**实现**（[lib/setupApi.js](lib/setupApi.js) + [web/setup.html](web/setup.html)）
- 安全铁律：全部接口**仅允许 127.0.0.1 访问**（远程请求一律 403）——页面含 SMTP 授权码等敏感凭据；授权码/Secret 永不回传前端（只回掩码）
- 白名单字段保存（防止覆盖 official.token 等内部字段）；保存后**热应用**（重建推送器/启停隧道/更新 TTL，无需重启）
- 配置存部署者自己的 `config.json`，绝不上传

---

### 变动六：发件配置档案（记忆 / 一键切换 / 重置，收发分离）

**背景**：用户可能有多家发件邮箱（如 2925 限频时临时切 126），之前换服务商要整段重填；且发件配置与收件邮箱混在一起，重置发件会误伤收件邮箱。

**实现**（[lib/setupApi.js](lib/setupApi.js) + [web/setup.html](web/setup.html) + [lib/config.js](lib/config.js)）
- 向导第 2 步重新分组：**📤 发件服务**（SMTP/授权码/发件地址）与 **📥 收件邮箱** 独立区块——重置/切换发件配置**不影响收件邮箱**
- **发件配置档案**（记忆功能）：
  - 「保存当前为档案」：命名保存（同名单独覆盖更新，最多 10 份），含授权码，**只存本机 `config.json`（`mailer.saved` 数组），绝不回传网页、绝不上传**（页面只显示掩码如 `l***@126.com`）
  - 「应用」：下拉选择一键切换，热生效无需重启；授权码不回显，测试/保存时留空即沿用已生效值
  - 「删除」：删除指定档案（不影响当前生效配置）
  - 「重置发件配置」：清空当前生效的发件配置，**档案与收件邮箱保留**，可随时从档案一键恢复
- 切换服务商预设时自动清空「发件地址别名」（别名多为个别服务商专属，如 2925 手机号别名，切 126 必须清）
- 新增接口：`POST /api/setup/mail-profiles`（save/apply/delete）与 `POST /api/setup/mail-reset`，同样仅限本机访问

---

### 变动七：手机远程配置 + SMTP 发件配置自动故障转移

**背景**：用户人在外面时，收到的新配对码邮件里只有看板地址——想改收件邮箱、切换发件配置（比如当前 SMTP 限频收不到邮件）还得跑回电脑；且只保存了一套发件配置时，该服务商一限频推送就断。

**实现**（[lib/remoteApi.js](lib/remoteApi.js) + [web/remote.html](web/remote.html) + [bridge.js](bridge.js) + [lib/mailer.js](lib/mailer.js)）

1. **邮件第二区块（手机远程配置）**
   - 推送邮件新增绿色分块（与看板连接信息用分隔线隔开）：远程配置页**链接 + 二维码**，手机扫码直达
   - 远程页受限操作：**改收件邮箱 / 切换发件配置档案 / 发测试邮件**，改完热生效并立即重发最新连接信息
   - 安全设计与完整向导互补：改 SMTP 主机/授权码等敏感操作仍仅限电脑本机 `setup.html`；远程页凭据 = 管理令牌（`timingSafeEqual` 比对），令牌**只随推送邮件下发**（能收到邮件 = 邮箱主人），桥接重启自动刷新；授权码永不回传（档案仅名称 + 掩码）
   - 链接**每次推送动态生成**（用当前最新隧道/局域网地址拼接）——隧道重建后新邮件自动带最新链接，旧邮件链接随旧域名一起失效

2. **SMTP 发件配置自动故障转移**
   - 保存过 **≥2 份发件配置档案**时：当前配置连续 **2 次**发送失败 → 自动切换到下一份档案并**立即重试**（不等 3 分钟），日志提示 `已自动切换发件配置 →「档案名」`
   - 设计意图：多套 SMTP 指向同一收件邮箱——哪套服务器活着，推送都能送达；切换持久保存
   - 无档案时行为不变：全部通道失败按 3 分钟 × 5 次自动重试

3. **收件邮箱编辑增强（远程配置页）**
   - 收件邮箱输入框**默认显示完整当前地址、直接可编辑**（原先只显示掩码占位，需整段重输）——收件地址不是凭据（本就随邮件明文可见），改为完整回显
   - **历史快选**：每次成功修改收件人，旧地址自动入历史（去重、最多 10 条，存 `config.json` 的 `mailer.toHistory`）；点输入框出现下拉，**选中历史地址即自动切换**（无需再点保存），切换后立即重发连接信息到新邮箱
   - 邮件标题追加发送时间戳（`· 20261006-150003` 格式，与正文「发送时间」一致），邮件列表里一眼辨认新旧

---

### 变动八：手机详情页钉住区瘦身（屏幕留给消息流）

**背景**：任务标题卡片（标题+状态+创建时间）与首条指令卡固定不随滚动，长指令展开时占近半屏——用户主要看的是真实消息交互，固定区要尽量小。

**改动**（[web/app.js](web/app.js) + [web/style.css](web/style.css) + [web/index.html](web/index.html)）
- 任务标题+创建时间**并入顶栏**：「任务详情」右侧小字（12.5px，超长省略号）+ 创建时间灰字（11px）；列表页不显示，仅详情页
- **状态徽章移除**（信息量有限，据用户反馈去掉）
- 原标题大卡片整体删除——钉住区仅剩「返回按钮 + 首条指令卡」
- **首条指令改为推拉门**：默认收起只露约两行（92px，底部渐隐提示还有内容），点击「▾ 展开」弹开（最高 38vh）后内部可滚动看全文，再点「▴ 收起」弹回；每次进入详情页默认收起

---

### 变动九：任务列表两级分组（文件夹 → 任务）

**背景**：任务增多后首页平铺一长串，浏览繁琐。电脑端任务是按其工作目录分文件夹组织的，手机端对齐为两级结构。

**实现**（[lib/official.js](lib/official.js) + [web/app.js](web/app.js) + [web/style.css](web/style.css) + [web/index.html](web/index.html)）
- 数据源：ACP 会话无显式文件夹字段，分组依据为会话的 **`cwd`（工作目录）**，文件夹名取路径最后一段（经探针核实真实数据：`agnes_WorkSpage / 小红书-绘本动画 / wx视频号 / douyin_space / openmontage`）
- 每个任务输出新增 `cwd` 字段，前端按此聚合
- **默认全部收起**：首页只显示文件夹行（▸ 箭头 + 名称 + 任务数胶囊，长按/悬停可见完整路径）
- 点文件夹行**展开/收起**该目录下任务；展开态实时刷新时保留展开状态
- 顶栏新增**「全部展开 / 全部收起」**（仅列表页显示），两级一次性展开
- 组与组内任务均按最近更新时间倒序

浏览器端到端实测四项全通过（默认收起 / 单目录展开收起 / 全部展开收起 / 卡片进详情）。

---

### 修复

1. **发消息 20 秒超时报错**（[lib/acp.js](lib/acp.js)）：ACP `session/prompt` 要等 AI 处理完本轮才返回，复杂任务远超 20 秒 → 曾把「已送达、处理中」误报为内部错误。改为**发送即确认**（8 秒内确认消息被接受即返回，AI 回复经通知流实时推送）。
2. **手机端发消息 5 秒误报「signal is aborted without reason」**（[web/app.js](web/app.js)）：前端请求超时写死 5 秒，而后端需等 ACP 确认约 8 秒 → 5 秒时前端主动中断，报错一闪而过。发消息请求超时改为 20 秒，超时提示改为中文（「连接超时，请重试」）。
3. **隧道地址误解析**（[lib/tunnel.js](lib/tunnel.js)）：cloudflared 错误输出中的 `https://api.trycloudflare.com`（Cloudflare API 地址）曾被正则误认为隧道地址 → 已排除 `api.`/`www.` 等固定子域。
4. **配对接口防爆破**（[lib/localApi.js](lib/localApi.js)）：`/api/pair` 增加限速（每 IP 5 分钟窗口失败 5 次锁定 5 分钟），防止公网模式下猜码。
5. **配对码有效期配置启动时不生效**（[bridge.js](bridge.js) + [lib/pair.js](lib/pair.js)）：bridge 传给 PairManager 的字段名与构造参数不匹配，`pair.codeTtlMinutes` 只有向导热应用才生效、重启后回退 15 分钟 → 已修复（重启后按配置生效）。
6. **SMTP 会话收尾不优雅**（[lib/smtp.js](lib/smtp.js)）：发送完（或失败）立即断开连接，部分按账号维护发送会话表的服务器会占住名额导致后续 MAIL FROM 被断连 → 改为发 QUIT 后等待 500ms 再关闭。
7. **隧道"假在线"**（[lib/tunnel.js](lib/tunnel.js)）：Cloudflare 快速隧道的注册可能被服务端撤销（域名 DNS 记录被删），但 cloudflared 进程仍活着——原有的"进程退出才重连"机制不会触发，导致公网地址打不开而控制台却显示正常 → 新增**隧道健康检查**：每 60 秒走公网完整链路请求一次自己的 `/health`（DNS→CF 边缘→隧道→本机），连续 2 次失败判定假在线，强制杀掉 cloudflared 走既有重连逻辑重建隧道，新地址自动推送邮箱。
8. **远程配置页一律 401「令牌无效」**（[web/remote.html](web/remote.html)）：页面首次加载状态的 GET 请求没把管理令牌拼到 URL 上（仅保存类 POST 携带）——无论扫哪封邮件的码都报错 → GET/POST 统一带令牌。
9. **Service Worker 缓存旧配置页**（[web/sw.js](web/sw.js)）：缓存策略会把修复前的 `remote.html`/`setup.html` 旧版留在手机上（cache-first，二次打开仍旧版引发难排查的 401）→ 缓存版本 bump（v3），且配置/工具页永久排除出缓存，始终取最新。
10. **日志轮转后桥接无法发现 agnesd 端口**（[lib/acp.js](lib/acp.js)）：端口发现只读日志尾部 256KB，日志增长/轮转后「on port」行消失，桥接重启即报「已发现 agnesd 但未能从日志解析端口」、任务全空 → 新增 **netstat 兜底**：日志解析失败时直接从 `netstat -ano` 查该进程监听的 127.0.0.1 端口（解析与系统语言无关），再读密钥连接。实测日志失效时经此路径成功连上。

---

## V1.0.0（2026-10-05 打包；2026-10-06 补充变动回溯）

### 变动一：详情页从「步骤流水」改为「对话视图」（核心对齐改动）

**问题现象**
手机端点开任务后显示的是 AI 执行的技术步骤列表（shell 命令、文件读写等 273 条工具调用流水）+ 进度条/百分比，与电脑端爱思办公点开任务看到的界面完全不同。

**根因**
第一版按项目开发文档定义的统一任务模型（steps + progress）实现了详情视图，属于"按文档设计"，没有对照电脑端真实 UI。电脑端真实形态是**对话流**：用户消息在右侧、AI 回复在左侧，工具调用收进"已处理 N 分 N 秒"的折叠条。

**解决方案（数据聚合层重做，[lib/official.js](lib/official.js)）**
- 聚合单位从「工具调用记录」改为「对话回合」：
  - 用户消息按条分组 → 每条一个蓝色气泡
  - AI 的连续输出（文字段落 + 工具调用交错）合并为一条完整回复 → 白色气泡
  - 工具调用折叠到所属回复下方的「已处理 N 步 / N 分 N 秒」胶囊里，默认收起
- 列表页去掉进度条和百分比（电脑端没有，用户确认不需要），只保留标题 + 状态徽章 + 时间
- 详情页支持 Markdown 渲染（表格、加粗、代码块），内容无变化时不重渲染，保证阅读不被刷新打断

**涉及文件**
- [lib/official.js](lib/official.js)：`_acpDetail` 聚合逻辑重写（按对话回合分组）
- [web/app.js](web/app.js)：详情页渲染重写（聊天气泡 + 折叠过程 + Markdown）
- [web/style.css](web/style.css)：气泡、折叠条、表格样式

**注意事项（重要）**
1. 桥接服务重启后**配对码会换新**，手机端旧配对失效，需重新输码/扫码（安全设计：配对码一次性、15 分钟有效）。
2. 手机端如仍显示旧版界面，**下拉刷新 1~2 次**清掉旧页面缓存（仅本次需要，见"顺手修复"第 1 条，之后改版会自动更新）。

---

### 变动二：电脑端任务「被锁」红点问题的解释与缓解

**问题现象**
V1.0.0 时期，手机看板打开某任务详情页期间，电脑端爱思办公会把这个任务标红并提示"当前被锁"；用户在电脑端点开该任务时，锁会从手机端"转移"回电脑端。改为对话视图后红点基本消失。

**根因**
手机看板读取任务详情的唯一途径是向 agnesd（爱思办公本地 AI 后端）执行 ACP 的 `session/load`（整段会话历史重放，用于聚合成对话）。agnesd 会感知"谁打开了这个会话"：
- V1.0.0 详情页用**固定轮询**（页面开着每 2~5 秒请求一次），每次请求都触发一次 `session/load`，等于持续告知后端"该会话正被外部客户端打开" → 电脑端红点常驻；
- 用户在电脑端点开任务 → 电脑端自己也执行一次会话加载 → 锁转移回电脑端。

**缓解方案（刷新机制改为事件驱动，[lib/official.js](lib/official.js) + [web/app.js](web/app.js)）**
1. 平时不请求：只有 WebSocket 推送（任务真有动静）才触发一次详情加载；
2. 兜底轮询从 2~5 秒放宽到 8 秒；
3. 前端 1.5 秒节流 + 服务端 2 秒防抖 + 内容无变化不重渲染。

三层叠加后 `session/load` 频率从"每 2 秒一次"降到"任务有变化才一次"，agnesd 大部分时间认为会话未被外部打开，红点不再常驻。

**注意事项（重要，无法 100% 根除）**
- 只要手机要看详情就必须 `session/load`（协议只提供这一条只读路径），因此**偶发红点属于正常现象**（典型场景：AI 执行中、手机长时间停留在详情页）。电脑端点一下任务即可把锁拿回来，不影响任何功能。
- 若需彻底消除：做「历史快照缓存」——首次 load 后落盘快照，后续只拉增量。列为 V2 候选方案。

---

### 顺手修复

1. **PWA 缓存策略（[web/sw.js](web/sw.js)）**：原为"永久缓存"策略，改版后手机端永远拿旧页面；已改为后台自动更新（stale-while-revalidate），以后升级无需用户手动清缓存。
2. **启动服务.bat 编码**：原 UTF-8 编码在部分终端下中文乱码/闪退，已重写为 GBK 编码，双击即可正常弹出服务窗口。

---

### V1.0.0 基础能力（打包时已包含）

- 桥接服务（Node.js + Express + ws）：`/health`、`/api/pair`、`/api/tasks`、`/api/tasks/:id`、`/ws` 实时推送
- 打通爱思办公真实数据（ACP 模式，[lib/acp.js](lib/acp.js)）：
  - 端口从爱思办公日志自动发现，密钥从 `agnesd` 进程内存读取（[lib/get-agnes-secret.ps1](lib/get-agnes-secret.ps1)，随机生成不落盘）
  - WebSocket 长连接断线自动重连；爱思办公重启后自动重连（密钥/端口会变）
  - 全程只读，不调用任何写接口（`session/new` / `prompt` 等）
- 手机端 PWA：配对页 → 任务列表 → 任务详情，WebSocket 实时 + 轮询降级
- mock 演示模式保留：`config.json` 中 `"mode": "mock"` 可切换
- 打包脚本：`启动服务.bat`（Windows 双击启动）

---

## 已知边界（持续有效）

| 项 | 说明 |
|---|---|
| 进行中任务的延迟 | AI 正在执行时，手机端进度约 3~5 秒刷新一次（受 `session/load` 防抖限制） |
| 偶发"被锁"红点 | 见 V1 变动二注意事项，属正常现象 |
| 服务重启 | 手机需重新配对（配对码会自动推送到邮箱）；爱思办公重启则桥接自动重连 |
| 快速隧道地址会变 | 每次重启服务公网地址都会换新，新地址自动推送到邮箱；需要固定地址需自己的域名（命名隧道） |
| 推送依赖邮箱在线 | 手机邮件 App 需保持收信（建议开启通知），配对码/地址变动第一时间收到 |

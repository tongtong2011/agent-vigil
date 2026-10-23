# AGENTS.md — AgentVigil

本仓库是 **AgentVigil** 的主开发仓库（TRAE 工作区）：AI Agent 任务的移动看板 + 邮件告警，跨 harness 聚合（V4 起插件化多渠道，已内置：爱思办公 ACP / WorkBuddy / Trae）。

## 项目事实（写文档/回答时以此为准）

- 名称：**AgentVigil**（npm 包名与目录名已统一为 `agent-vigil`）
- 标语："Keep a vigil over every agent, in every harness." / 移动看板 + 邮件告警，盯住你所有 AI Agent 的任务
- 定位：**服务层，不是插件**——不改 Agent 工具本身，把多 harness 的任务聚合成「一个看板 + 一个邮箱」
- 当前版本：**V4.1.0（开发期）**；多渠道适配器架构（V4）：`lib/adapters/`（base 接口 + agnes/workbuddy/trae 三个实现 + index 注册表），`lib/channels.js` 为渠道告警策略单一真源
- 渠道能力：agnes = ACP 协议可发消息；workbuddy = 本地转录直读 + 进程门禁，V4.1 起 headless CLI 可发消息；trae = 记忆转录直读、**只读**（两态 running/done，不触发即时告警，参与汇总）
- 告警四态（`lib/alerts.js`）：`running` 正在执行 / `ended` 执行完成 / `failed` 异常 / `waiting` 待确认；阻塞态 = `failed` + `waiting`
- 配置模型（V4.1）：`alerts.digestIntervalMinutes/digestTitle` 与 `board.listLimit/listLimitMax` 全渠道统一；`channels.<ch>` 每渠道仅 `enabled/digestEnabled/alertEnabled/alertPrefix`；旧 config.json 自动迁移
- License：MIT；Node.js ≥ 18；入口 `bridge.js`，默认端口 8787
- 关键文档入口：`docs/00-文档导航.md`（找任何文档从这进）

## 铁律（违反即事故）

1. **敏感文件严禁入库/外传**：`config.json`（含 SMTP 授权码、隧道令牌）与 `敏感配置备份.md` 已在 `.gitignore`，**绝不读取其内容写入任何文档、日志、回复或代码**；文档示例一律用占位符（如 `smtp.qq.com` + `你的SMTP授权码`）。
2. **只读边界是产品承诺**：对 agnesd 仅 `initialize` / `session/list` / `session/load`；唯一写方法是 `session/prompt`（手机发消息），修改它必须保留「配对令牌 + 限速 + 配置开关」三重约束。WorkBuddy/Trae 适配器只读本地转录文件；WorkBuddy 发消息（V4.1 headless CLI 续聊）与 agnes 同受三重约束；Trae 无注入通道，`sendMessage` 必须保持抛 `UNSUPPORTED`。
3. **没有演示数据机制**：不允许引入 mock/假数据（历史上已刻意移除）；harness 未运行 = 空看板 + 三处提示。
4. **离线验证/测试脚本一律不得直写真实 config.json**（历史事故：验证脚本曾短暂覆盖 watchlist）：须深拷贝 cfg 或把保存路径指向系统临时目录沙箱（见 `tests/verify-*.js` 的做法）。

## 改动权限分级

- **文档类（AI/DevRel 可直接改）**：`README.md`、`CHANGELOG.md`、`docs/`、`llms.txt`、本文件、`.github/` 模板。
- **源码类（须用户在该轮明确授权）**：`bridge.js`、`lib/`、`web/`、`tools/`、`package.json`、`config.json` 结构。
- 改 README 首段时必须保留 SEO 关键词：**AI agent / task board / email alerts / across every harness**；topics 保持：`ai-agents` `code-harness` `multi-harness` `task-board` `email-notifications` `agent-monitoring` `agent-alerts` `digest` `pwa` `cloudflare-tunnel`。

## 开源发布前检查单

- [ ] `git ls-files` 确认 `config.json`、`敏感配置备份.md`、`node_modules/`、`tools/cloudflared.exe` 均未被跟踪
- [ ] README 免责声明保留（非官方互操作工具）
- [ ] 仓库先 PRIVATE，v4.0 稳定后翻 PUBLIC

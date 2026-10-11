# AGENTS.md — AgentVigil

本仓库是 **AgentVigil** 的主开发仓库（TRAE 工作区）：AI Agent 任务的移动看板 + 邮件告警，跨 harness 聚合（当前基线：爱思办公 ACP 后端）。

## 项目事实（写文档/回答时以此为准）

- 名称：**AgentVigil**（npm 包名与目录名已统一为 `agent-vigil`）
- 标语："Keep a vigil over every agent, in every harness." / 移动看板 + 邮件告警，盯住你所有 AI Agent 的任务
- 定位：**服务层，不是插件**——不改 Agent 工具本身，把多 harness 的任务聚合成「一个看板 + 一个邮箱」
- 告警四态（`lib/alerts.js`）：`running` 正在执行 / `ended` 执行完成 / `failed` 异常 / `waiting` 待确认；阻塞态 = `failed` + `waiting`
- License：MIT；Node.js ≥ 18；入口 `bridge.js`，默认端口 8787
- 关键文档入口：`docs/00-文档导航.md`（找任何文档从这进）

## 铁律（违反即事故）

1. **敏感文件严禁入库/外传**：`config.json`（含 SMTP 授权码、隧道令牌）与 `敏感配置备份.md` 已在 `.gitignore`，**绝不读取其内容写入任何文档、日志、回复或代码**；文档示例一律用占位符（如 `smtp.qq.com` + `你的SMTP授权码`）。
2. **只读边界是产品承诺**：对 agnesd 仅 `initialize` / `session/list` / `session/load`；唯一写方法是 `session/prompt`（手机发消息），修改它必须保留「配对令牌 + 限速 + 配置开关」三重约束。
3. **没有演示数据机制**：不允许引入 mock/假数据（历史上已刻意移除）；harness 未运行 = 空看板 + 三处提示。

## 改动权限分级

- **文档类（AI/DevRel 可直接改）**：`README.md`、`CHANGELOG.md`、`docs/`、`llms.txt`、本文件、`.github/` 模板。
- **源码类（须用户在该轮明确授权）**：`bridge.js`、`lib/`、`web/`、`tools/`、`package.json`、`config.json` 结构。
- 改 README 首段时必须保留 SEO 关键词：**AI agent / task board / email alerts / across every harness**；topics 保持：`ai-agents` `code-harness` `multi-harness` `task-board` `email-notifications` `agent-monitoring` `agent-alerts` `digest` `pwa` `cloudflare-tunnel`。

## 开源发布前检查单

- [ ] `git ls-files` 确认 `config.json`、`敏感配置备份.md`、`node_modules/`、`tools/cloudflared.exe` 均未被跟踪
- [ ] README 免责声明保留（非官方互操作工具）
- [ ] 仓库先 PRIVATE，v4.0 稳定后翻 PUBLIC

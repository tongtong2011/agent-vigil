# 交叉验收报告（acceptance-report）

> 验收时间：2026-10-11 · 范围：显示名替换 + 文档体系升级（README 漏斗化 / docs 子页 / llms.txt 补全 / LICENSE）
> 说明：本次验收期间检测到并行改动（TRAE/用户侧完成了 AgentVigil 品牌定名、llms.txt 初版），本报告覆盖合并后的整体状态。

## 1. 护栏合规 ✅

`git status` 确认全部改动仅出现在允许路径：

- 源码显示名替换（用户明确授权）：`bridge.js`、`lib/mailer.js`、`lib/setupApi.js`、`package.json`、`web/index.html|manifest.json|remote.html|setup.html` —— 均为显示名字符串，无逻辑改动（diff 逐行核对：每处仅替换品牌词）
- 文档：`README.md`、`docs/internal/fact-sheet.md`、`docs/配置说明.md`、`docs/邮箱推送配置.md`、`docs/常见问题.md`
- Agent 可读文档：`llms.txt`（仅追加 Docs 链接）、`llms-full.txt`（新增）
- `LICENSE`（新增；package.json 与 README 徽章早已声明 MIT，原仓库缺文件）
- **未触碰**：`lib/` 其余模块、`package-lock.json`、`web/app.js`、`web/style.css`、`web/sw.js`、任何测试/构建配置

## 2. 事实抽查（13 条，全部通过）

| # | 声明 | 源码依据 | 结果 |
| --- | --- | --- | --- |
| 1 | 默认监听 0.0.0.0:8787 | lib/config.js DEFAULTS | ✅ |
| 2 | 配对码 TTL 5~120 分钟，默认 15 | lib/pair.js 构造器 clamp | ✅ |
| 3 | 码在有效期内可重复使用 | lib/pair.js + CHANGELOG #9 | ✅ |
| 4 | 发消息限速每分钟 10 条、429 提示 | lib/localApi.js:100,108 | ✅ |
| 5 | 阻塞检测节奏固定 60 秒 | lib/alerts.js CHECK_INTERVAL_MS | ✅ |
| 6 | 汇总间隔 10~240 默认 60 | lib/config.js + alerts.js | ✅ |
| 7 | 邮箱连续 2 次失败自动故障转移 | bridge.js:316-324 | ✅ |
| 8 | 推送失败 3 分钟重试至多 5 次 | bridge.js:326-331 | ✅ |
| 9 | 只读三方法 + 唯一写例外 session/prompt | lib/acp.js 头注释 + lib/official.js | ✅ |
| 10 | 隧道 quick/named 双模式、cloudflared 自动下载 | lib/tunnel.js 头注释 + DOWNLOAD_URL | ✅ |
| 11 | 命名隧道幂等 provision（补 CNAME/ingress） | CHANGELOG V3.1 变动十三 | ✅ |
| 12 | 前端 8 秒兜底轮询 | web/app.js:438,466 | ✅ |
| 13 | SW 缓存版本 | web/sw.js `otc-shell-v15` | ✅（修正：初稿误写 v11，已更正） |

## 3. 安全校验 ✅

- `config.json`（含 SMTP 授权码、隧道 token）与 `敏感配置备份.md`：均在 .gitignore；`git log --all` 确认从未入库
- 文档中未引用任何真实凭据；示例统一用占位符

## 4. 漏斗完整性（对照 readme-optimization 评分卡，自评）

- 一句话定位 ✅（首行）／ 30 秒理解 ✅（"它解决什么问题"对比表）／ Quickstart ✅（3 步可复制）
- 为什么选它 ✅（新增：对比远程桌面/自写脚本/CI 通知）
- 当前状态如实 ✅（新增：V4 规划、数据源绑定、无配额专项告警的边界声明）
- 徽章 ✅（仅 License）／ 深度内容下沉 docs/ ✅（内容零丢失，README 从 ~220 行减到 ~150 行）

## 5. 遗留事项（需用户决策）

1. `package.json` name 已改 `agent-vigil`，但 `package-lock.json` 的 name 字段未同步（下次 `npm install` 会自动对齐，也可手动改）——按护栏未动 lock 文件
2. `package.json` `version` 仍为 `0.1.0`，CHANGELOG 已到 V3.1.0，是否对齐？
3. 品牌写法并存：README/llms.txt 用 **AgentVigil**，界面显示名用 **agent-vigil**——建议统一（如界面标题改 `AgentVigil · Agent任务看板与监控`）
4. 根目录 `agnes-office-mobile任务会话记录 .md`（136KB）与 `技术分享素材.md` 是否随公开仓库发布？建议移出
5. 改动未提交；origin 为 github.com/tongtong2011/agent-vigil（公开前请先确认仓库为 Private）

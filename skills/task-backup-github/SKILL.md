---
name: task-backup-github
description: '一键备份当前任务到 GitHub（多平台适配）：归档当前任务（对话+文本交付物）到本地 git 仓库 D:\ai-backup\ai-workspace-backup 的对应平台一级目录——爱思办公→agnes-office、WorkBuddy→workbuddy、豆包→doubao、Trae→trae-code，三级结构 <平台目录>/<工作空间或项目名>/task-<YYYYMMDD>-<任务名>，commit 后自动 push 到 GitHub 私有仓库（直连不通自动走本地代理）。当用户说"备份"、"备份当前任务"、"推送当前任务"、"把这个对话存到备份仓库"、"归档任务"时触发。发 $task-backup-github 即执行全流程。'
metadata:
  argument-hint: '[可选: platform=<平台目录> | 任务标题/备注]'
---

# 任务一键备份到 GitHub v2.0（多平台适配 · 归档 + commit + push，断网自动走代理）

## 触发方式
- 输入 `$task-backup-github`（无参数即可）；可选参数 = 任务名/备注，或 `platform=agnes-office` 显式指定平台目录
- 或说："备份"、"备份当前任务"、"推送当前任务到 GitHub"

## 固定参数
- 仓库根目录：`D:\ai-backup\ai-workspace-backup`
- 远端：`origin` = `https://github.com/tongtong2011/ai-workspace-backup.git`（**私有**仓库；仓库名默认沿用 `ai-workspace-backup`，用户可改，以本地 remote 实际配置为准）
- 认证：一个**该仓库专属的 fine-grained token**（在仓库「Settings → Developer」创建，仅选本仓库、权限只勾 **Contents: Read and write**），存入 Windows 凭据管理器，git push/fetch 自动鉴权，不落明文
- 目标目录（**三级**）：`<平台一级目录>/<二级:工作空间或项目名>/<三级:任务目录>`
  - 一级 = 当前 Skill 所在 agent 平台绑定的目录（见下方映射表）
  - 二级 `workspace_name` = 当前任务所在工作空间/项目名：
    - harness 有「空间/工作区」命名概念时，优先取空间名（如 WorkBuddy 工作空间名）；否则取当前工作目录的最后一段文件夹名（如 `E:\me\codeTask\traeProject\agnes-office-mobile` → `agnes-office-mobile`）
    - 空格规整为 `_`，截断 40 字符；无法确定时用 `default`
  - 三级 `task_dir` 命名规则：`task-<YYYYMMDD>-<任务名称>`
    - YYYYMMDD = 备份当天日期
    - 任务名称：优先取参数值；否则取 task_title **原样保留（含中文、空格、连字符）**，只剔除 Windows 文件名不允许的 7 个字符 `\ / : * ? " < > |`（直接删去，不替换为下划线），截断 40 字符
    - 例：任务名「AI 工作区自动备份部署」→ `task-20261005-AI 工作区自动备份部署`
    - 任务名取不到时：取首条用户消息的前 20 个字符（同样清理规则），仍无则用 `未命名任务`
    - 同日已存在同名目录时，末尾追加 `-2`、`-3`… 防冲突
  - 每个新任务在该空间目录下**新建**一个任务目录，把当前任务的上下文日志与输入输出备份进去

## 首次搭建（仅当仓库/token 尚未就绪时执行；完成后每次走「前提检查」即可）
1. **建仓库**：GitHub → New repository → 名字 `ai-workspace-backup`（沿用用户命名，可改）→ 必须选 **Private**
2. **建仓库专属 token**：该仓库 Settings → Developer → Fine-grained tokens（或用户级 Developer settings → Tokens）：
   - Repository access：**只选本备份仓库**
   - Permissions：只勾 **Contents: Read and write**，其余一律不勾
3. **把 token 交给本 Skill**（一次写入 Windows 凭据管理器，不落明文）：
   ```powershell
   # 在 D:\ai-backup\ai-workspace-backup 下执行，替换 <用户名>、<token>
   "protocol=https`nhost=github.com`nusername=<用户名>`npassword=<token>" | Out-File -Encoding ASCII "$env:TEMP\cred.txt"
   Get-Content "$env:TEMP\cred.txt" | git credential approve
   Remove-Item "$env:TEMP\cred.txt" -Force
   ```
4. 验证：`git ls-remote origin`（不通则带代理，见步骤 9）返回 refs 即认证 OK
- **硬约束**：token 只进凭据管理器；**严禁**出现在备份文件、git 历史、对话记录或任何交付物中；用户粘贴 token 后立即按上面流程注入并视为已脱敏

## 平台 → 一级目录映射（本 Skill 随安装所在平台绑定其一）
| Agent 平台 | 一级目录 |
|---|---|
| 爱思办公（Agnes） | `agnes-office` |
| WorkBuddy | `workbuddy` |
| 豆包 | `doubao` |
| Trae | `trae-code` |

**平台判定优先级**（依次尝试，命中即停）：
1. 本次参数含 `platform=<值>` → 直接用该值
2. harness 可辨识特征 → 映射到对应目录（平台产品名 / 模型名 / Skill 安装路径等：如 Agnes/爱思 → `agnes-office`；WorkBuddy → `workbuddy`；豆包 → `doubao`；Trae → `trae-code`）
3. 无法判定 → **询问用户当前是哪个平台**（从映射表选择），不得猜测后继续

## 前提检查（每次执行前，缺失自动补齐）
1. `D:\ai-backup\ai-workspace-backup` 存在、是 git 仓库、远端 `origin` 指向上述私有仓库
2. 当前平台的**一级目录**已存在于仓库中（内含 `.gitkeep` 供 git 追踪空目录）；缺失则创建目录 + 写 `.gitkeep`
3. **认证自检**：`git ls-remote origin`（直连不通则带代理）能返回 refs；失败（401/403）→ 缺 token 或已过期，引导用户按「首次搭建」第 2–4 步提供仓库专属 token 并注入凭据管理器
4. 仓库尚未初始化/各平台一级目录全缺时，按「首次搭建」全流程走

## 备份边界（硬性约束）
【只备份这些】
1. 完整对话：当前任务中用户/助手每一轮的**实际内容**（用户消息逐字保留；助手回复保留实质内容，不得只写"已完成"式摘要）
2. 元数据：task_dir、任务标题、平台（一级目录值）、workspace 名称与完整路径、备份时间、交付物清单
3. 文本交付物：任务中生成/修改的 md、json、csv、代码等文本文件 → 复制到 `outputs/` 子目录

【不写入 git】
- 二进制附件（图片/PDF/压缩包/视频/音频）：只在 index.md 记录文件名与存放位置（如百度网盘链接）
- sqlite/数据库/缓存/大文件
- 敏感信息：任何 token、API key、密码、手机号、身份证号（含 GitHub PAT，如 `ghp_`/`github_pat_` 开头）、邮箱 SMTP 授权码、隧道令牌 → 一律替换为 `[REDACTED]`
- 仓库 `.gitignore` 已排除的路径（如 `敏感配置备份.md`）严禁以任何方式绕过入库

## 执行步骤（归档 → commit → push 一气呵成）
0. 判定当前平台 → `平台目录`（按映射表 + 优先级规则）；执行前提检查 1–2（缺一级目录就补 `.gitkeep`）
1. 推导 workspace_name 与 task_dir（按命名规则），生成任务目录 `<平台目录>/<workspace_name>/<task_dir>`
2. 写 `index.md`：任务摘要、来源平台（一级目录值）、工作区（名称+完整路径）、备份时间、交付物索引、跳过文件清单
3. 写 `conversation.md`：完整对话日志，按时间线排版，每轮标注 用户/助手
4. 写 `task_meta.json`：结构化元数据（task_dir、task_title、**platform**、workspace_name、workspace_path、archived_at、artifacts、skipped_binary）
5. 复制文本交付物到 `outputs/`（相对结构保持不变）
6. 脱敏：扫描上述全部内容，替换敏感字段为 `[REDACTED]`，统计替换次数
7. git：`git add <平台目录>/<workspace_name>/<task_dir>`（若步骤 0 新建过一级目录，`git add` 一并带上 `.gitkeep`）后 commit，message 固定格式：
   `YYYY-MM-DD 归档 | <平台目录>/<workspace_name>/<task_title> | 来源:<平台目录>`
   （无变更时 "nothing to commit" 属正常跳过，不是错误）
8. **push 前脱敏自查**（commit 后、push 前，在仓库根目录执行）：
   ```
   git grep -nE "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}" HEAD
   ```
   命中 → 停止 push，报告命中位置，脱敏后重新 commit 再自查；确认干净后才 push
9. **自动 push（直连 → 代理 两级兜底）**，在 `D:\ai-backup\ai-workspace-backup` 下执行：
   - 第一级（直连）：`git push origin main`，失败最多重试 2 次、间隔 5 秒
   - 第二级（本地代理，直连失败后自动启用）：
     a. 读注册表 `ProxyServer`（**不要依赖 ProxyEnabled 字段，本机 ProxyEnabled 为空但 ProxyServer 仍有效**）：
        `Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" | Select ProxyServer`（当前值 `127.0.0.1:1088`）
     b. 无值则依次探测端口 `1088` → `7890` → `7897` → `10809` → `1080`（TcpClient 连 `127.0.0.1:<port>`，取第一个开放）
     c. 带代理推送：`git -c http.proxy=http://127.0.0.1:<port> -c https.proxy=http://127.0.0.1:<port> push origin main`，重试 2 次、间隔 8 秒
     d. 只对本次 push 调用加 `-c`，**不改**全局/仓库级 git 配置、**不设**环境变量
   - 两级都失败时不阻断：本地 commit 已保留，告知用户"已归档到本地，push 失败（直连+代理均不通），可双击桌面 `C:\Users\1\Desktop\ai-backup-push.bat`（内含同样两级兜底，日志 `D:\ai-backup\logs\backup-push.log`）或等每晚 03:00 计划任务补推"
   - push 成功**不能只看 exit code**（PowerShell 中 `git push 2>&1` 的 stderr 流转会干扰退出码判断，曾出现"假成功"）；必须用 `git ls-remote --heads origin main` 读回远端 HEAD，与 `git rev-parse main` 一致才算真成功；`ls-remote` 不通时同样走代理
   - 成功则记录走的通道（direct/proxy）与远端 commit hash
10. **终态校验 + 最终报告**：
    - `git ls-files <平台目录>/<workspace_name>/<task_dir>` 应列出 index.md、conversation.md、task_meta.json、outputs/*（如有交付物）
    - 报告：平台目录、任务目录路径、本地 commit hash、push 结果（通道/失败原因）、脱敏替换次数、跳过的二进制清单

## Windows 实践要点（历史踩坑，必须遵守）
- **写含中文的文件一律 UTF-8 字节安全**：用 Write 工具或 `[System.IO.File]::WriteAllBytes/WriteAllText`（UTF8 编码）；**禁止**用 PowerShell 5.1 `Set-Content -Encoding UTF8` 修改已有中文文件（它按系统 ANSI 码页读入再写回，中文全部变乱码）。写完后自检：UTF-8 解码全文无 U+FFFD 替换符。
- 目录改名/移动用 `git mv`，保留 rename 历史。
- `.bat`/`.cmd` 文件必须 CRLF 换行且内容为 ASCII（cmd 解析 LF 会语法错误）。
- PowerShell 5.1 不支持 `<` 重定向，用 `Get-Content file | command`。
- git 的 "LF will be replaced by CRLF" 警告（autocrlf）无害，忽略。
- 终端 GBK 显示 UTF-8 内容看起来乱码不代表文件损坏，判断编码以字节解码为准。

## 不变量
- 平台目录只按映射表取用，**不得**把 A 平台任务备份进 B 平台目录；无法判定时必须问用户
- 脱敏必须在 commit 前完成，push 前 git grep 自查，任何敏感值不得进入 git 历史
- 失败时输出错误，不阻断原任务；重复备份同一任务生成新 commit（git 天然版本历史）
- 数据库/大二进制不入 git；单文件超 100MB 坚决不入
- 代理只作本次 push 的临时通道，不修改任何持久化配置
- 本 Skill 执行完毕即完成"备份到 GitHub"全部动作，不需要用户再说第二句

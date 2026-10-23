'use strict';
/**
 * WorkBuddy 适配器（lib/adapters/workbuddy.js）—— 本地文件直读，只读
 *
 * 【取证结论】（2026-10-11 本机实测，WorkBuddy=腾讯 CodeBuddy 家族，Electron + codebuddy CLI）
 * Remote Control 网关（/api/v1/runs、/api/v1/acp、SSE）全部 401、令牌无法获取 →
 * 改走本地文件直读：任务转录以 JSONL 落盘，读盘等价于读任务，无需任何鉴权。
 *
 * 【数据布局】（数据根 %USERPROFILE%\.workbuddy，非 APPDATA）
 *   sessions/<pid>.json   实例心跳 {pid, sessionId, cwd, lastHeartbeat(毫秒), url}，
 *                         活实例 = 心跳 <10 分钟 且 pid 存活
 *   projects/<工作目录转义名>/<sessionId>.jsonl  任务转录（一行一个 JSON 事件，时间戳毫秒数字）：
 *     - session-meta  {sessionId, timestamp}
 *     - ai-title      {aiTitle, sessionId, cwd}   任务标题与工作目录的可靠来源
 *     - message       {role:'user'|'assistant', content:[{type:'input_text'|'output_text', text}]}
 *     - function_call {callId, name, arguments, cwd}
 *     - function_call_result {callId, name, status:'completed'|..., output:{type:'text',text}}
 *       （与 function_call 靠 callId 关联；也有 parentId=fc.id）
 *     - reasoning / file-history-snapshot 等，看板不消费
 *   tasks/<sessionId>/N.json   任务 todo {subject, description, activeForm,
 *                              status:'completed'|'in_progress'|'pending', 时间戳毫秒}
 *   workspace-display-names.json  工作目录显示名 {workspaces:{'f:/workbuddy/异动前兆':{displayName}}}
 *   assistant-display/<sessionId>.json  智能体名 {snapshots 最后一条 .assistantDisplay.name}
 *
 * 【读盘策略】
 *   - 列表（秒级轮询）：按 mtime 缓存摘要，只读每文件头尾各 96KB（标题/cwd/尾部四态），
 *     文件未变化直接复用缓存——轮询百个会话也只是几次 stat 调用
 *   - 详情（getTask）：全量解析该 JSONL（消息流 + 工具步骤 + todo 合并）
 *   - 实时性：fs.watch 递归监听 projects 目录，JSONL 追加 → 防抖回调 onChange(sessionId)
 *   - 健康检查：WorkBuddy.exe 进程存活（tasklist，与 agnesd 同款探测）
 *
 * 【只读铁律】本适配器绝不写 .workbuddy 任何文件；远程发指令走 codebuddy CLI
 * （headless --resume 续聊，回复落回同一转录 JSONL），不直接改写转录文件。
 * CLI 未安装/未找到时 canSend=false，详情页降级为「复制指令」转交。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  BaseAdapter, AdapterError,
  mapStepStatus, isoMs, cleanUserText
} = require('./base');

const LIST_READ_BYTES = 96 * 1024;   // 列表摘要每文件头/尾读取量
const ACTIVE_WINDOW_MS = 90 * 1000;  // 「正在执行」活动窗口（与 agnes 语义一致）
const LIST_LIMIT_FLOOR = 100;        // 列表条数下限兜底（实际生效值读全局 config board.listLimit）
const TODO_STATUS = { completed: 'done', in_progress: 'running' };

function isFailedToolStatus(s) { return s === 'failed' || s === 'error' || s === 'aborted' || s === 'canceled'; }

class WorkBuddyAdapter extends BaseAdapter {
  /** @param {object} o 可选 rootDir 覆盖数据根（测试用） */
  constructor(o = {}) {
    super();
    this.root = o.rootDir || path.join(os.homedir(), '.workbuddy');
    this._cfg = o.cfg || null;   // 实时读配置用（config.save 原地 deepMerge，引用恒为最新值）
    this.ready = false;
    this._watcher = null;
    this._summary = new Map();   // jsonl 绝对路径 -> {mtimeMs, size, task(列表级统一格式)}
    this._idIndex = new Map();   // sessionId -> jsonl 绝对路径（列表扫描时建立）
    this._lastScanAt = 0;
    this._scanning = false;
    this._appAlive = false;      // 最近一次进程探测结果（health 缓存）
    this._appAliveAt = 0;
    this._cliReady = false;      // CLI 发送通道就绪（init 时探测，canSend 动态读它）
    this._cli = null;            // { node, cli } spawn 参数对
    this._modelHealth = new Map(); // 模型健康探测缓存（5 分钟；免费中转通道波动大）
    this._log = () => {};
  }

  get channel() { return 'workbuddy'; }
  get displayName() { return 'WorkBuddy'; }
  /** 可发消息：CLI（codebuddy -p --resume）探测成功才开启；否则详情页降级「复制指令」转交 */
  get canSend() { return this._cliReady === true; }
  /** 发送方式提示（/health 透传前端；canSend=false 时前端 toast 引导复制转交） */
  get sendHint() {
    return this._cliReady
      ? '指令将通过 WorkBuddy CLI（codebuddy --resume）注入该会话，AI 回复稍后回显在此对话'
      : '未检测到 WorkBuddy CLI，无法直接注入指令：已复制到剪贴板，请切换到 WorkBuddy 粘贴发送';
  }

  async init(ctx) {
    this._log = (ctx && ctx.log) || (() => {});
    if (!fs.existsSync(this.root)) {
      this._log('warn', '[WorkBuddy] 未检测到数据目录 ' + this.root + '（未安装或未运行过，看板该渠道为空）');
      return;
    }
    this.ready = true;
    this._probeCli();
    // 递归监听 projects 目录：转录追加/新建 → 防抖回调（Windows NTFS 支持递归 watch）
    const projDir = path.join(this.root, 'projects');
    try {
      this._watcher = fs.watch(projDir, { recursive: true }, (_ev, filename) => {
        if (!filename || !String(filename).endsWith('.jsonl')) return;
        const sid = String(filename).replace(/\.jsonl$/i, '');
        this._debounceChange(sid);
      });
      this._watcher.on('error', () => { /* watcher 挂了不影响读取，静默 */ });
    } catch (_) { /* 某些环境 watch 不可用：退化为纯轮询，功能不受影响 */ }
    await this.listTasks().catch(() => {}); // 预热缓存
    this._log('info', '[WorkBuddy] 就绪：' + this.taskCount() + ' 个历史会话（数据根 ' + this.root + '）');
  }

  async close() {
    if (this._watcher) { try { this._watcher.close(); } catch (_) {} this._watcher = null; }
    this.ready = false;
  }

  _debounceChange(sid) {
    clearTimeout(this._changeTm);
    this._changeTm = setTimeout(() => {
      this._summary.delete(this._idIndex.get(sid)); // 失效该文件缓存，下轮重读
      this._emitChange(sid);
    }, 400);
    if (this._changeTm.unref) this._changeTm.unref();
  }

  /** 健康检查：WorkBuddy.exe 进程存活（缓存 30 秒，tasklist 开销大不能每秒跑）。 */
  async health() {
    const now = Date.now();
    if (now - this._appAliveAt < 30000) return this._appAlive;
    this._appAlive = await new Promise((resolve) => {
      const p = spawn('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
      let out = '';
      p.stdout.on('data', (c) => { out += c; });
      p.on('error', () => resolve(false));
      p.on('close', () => resolve(/workbuddy\.exe/i.test(out)));
    });
    this._appAliveAt = now;
    return this._appAlive;
  }

  describe() {
    const n = this.taskCount();
    return '真实数据（本地转录直读 ' + this.root + '，' + (n >= 0 ? n + ' 个会话' : '未扫描') + '，应用' + (this._appAlive ? '在线' : '未检测到') + '）';
  }

  taskCount() { return this._idIndex.size || -1; }

  /** 列表条数上限（V4.1 全局统一：实时读 config board.listLimit，向导滑块/手改 config 均热生效）；下限兜底 */
  _listLimit() {
    const b = (this._cfg && this._cfg.board) || {};
    const n = Math.round(Number(b.listLimit));
    return Number.isFinite(n) ? Math.max(LIST_LIMIT_FLOOR, n) : LIST_LIMIT_FLOOR;
  }

  // ================ 任务列表（缓存摘要） ================

  async listTasks() {
    if (!this.ready) return [];
    // 进程探测前置（与 agnes「未检测到进程=空看板」语义对齐）：应用不在 = 渠道拿不到数据，
    // 返回空列表 → 服务端快照清零、看板清空只留提示条；应用重开后自动恢复（health 有 30 秒缓存）
    if (!(await this.health())) return [];
    await this._scanProjects();
    const out = [];
    for (const rec of this._summary.values()) if (rec && rec.task) out.push(rec.task);
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // 应用在线已由上方门禁保证：mtime 90 秒内有活动 → running
    for (const t of out) {
      const active = Date.now() - Date.parse(t.updatedAt) < ACTIVE_WINDOW_MS;
      if (active && t._tailStatus !== 'failed') t.status = 'running';
      delete t._tailStatus; // 内部字段不下发
    }
    return out.slice(0, this._listLimit());
  }

  /** 扫描 projects 下所有目录中的 .jsonl：mtime/size 变了才重读摘要（轮询成本 = N 次 stat）。 */
  async _scanProjects() {
    if (this._scanning) return;
    if (Date.now() - this._lastScanAt < 1000) return; // 1 秒节流
    this._scanning = true;
    try {
      const projDir = path.join(this.root, 'projects');
      const seen = new Set();
      let dirs = [];
      try { dirs = fs.readdirSync(projDir); } catch (_) { return; }
      for (const d of dirs) {
        const dd = path.join(projDir, d);
        let files;
        try { files = fs.readdirSync(dd); } catch (_) { continue; }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const p = path.join(dd, f);
          let st;
          try { st = fs.statSync(p); } catch (_) { continue; }
          if (!st.isFile()) continue;
          seen.add(p);
          this._idIndex.set(f.replace(/\.jsonl$/i, ''), p);
          const c = this._summary.get(p);
          if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue;
          try {
            this._summary.set(p, { mtimeMs: st.mtimeMs, size: st.size, task: this._summarize(p, st) });
          } catch (_) { /* 单文件损坏忽略 */ }
        }
      }
      for (const p of [...this._summary.keys()]) if (!seen.has(p)) this._summary.delete(p);
      this._lastScanAt = Date.now();
    } finally {
      this._scanning = false;
    }
  }

  /** 列表级摘要：读头尾各 96KB，产出统一格式（不含 steps/messages）。 */
  _summarize(p, st) {
    const head = this._readSlice(p, 0, LIST_READ_BYTES);
    const tail = st.size > LIST_READ_BYTES ? this._readSlice(p, Math.max(0, st.size - LIST_READ_BYTES), LIST_READ_BYTES) : head;
    const headLines = this._parseLines(head);
    const tailLines = this._parseLines(tail);

    const meta = this._scanHeadMeta(headLines);
    const tailStatus = this._deriveTailStatus(tailLines);

    const sid = path.basename(p).replace(/\.jsonl$/i, '');
    return {
      id: sid,
      title: meta.title || '未命名任务',
      status: tailStatus,                 // listTasks 会按「应用在线+mtime 新」覆写为 running
      _tailStatus: tailStatus,            // 内部保留：running 覆写不掩盖尾部失败/等待
      progress: tailStatus === 'done' ? 100 : 0,
      createdAt: isoMs(meta.createdAtMs || st.birthtimeMs),
      updatedAt: isoMs(st.mtimeMs),
      cwd: meta.cwd || '',
      group: this._groupDisplay(meta.cwd, () => path.basename(p)),
      steps: [],
      messages: []
    };
  }

  /** 头部元信息：ai-title（标题+cwd）优先，首条用户消息兜底标题。 */
  _scanHeadMeta(headLines) {
    const meta = { title: '', cwd: '', createdAtMs: 0 };
    for (const j of headLines) {
      if (!meta.createdAtMs && j.timestamp) meta.createdAtMs = Number(j.timestamp);
      if (j.type === 'ai-title') {
        if (j.aiTitle) meta.title = String(j.aiTitle).trim();
        if (j.cwd) meta.cwd = String(j.cwd);
      } else if (j.type === 'message' && j.role === 'user' && !meta._firstUser) {
        meta._firstUser = true;
        if (!meta.cwd && j.cwd) meta.cwd = String(j.cwd);
        if (!meta.title) {
          const t = cleanUserText(this._extractText(j));
          if (t) meta.title = t.replace(/\s+/g, ' ').slice(0, 80);
        }
      } else if (!meta.cwd && j.cwd) {
        meta.cwd = String(j.cwd);
      }
    }
    return meta;
  }

  /**
   * 尾部四态（语义与 alerts.js 对齐，优先级 running > failed > waiting > done）：
   *   - 最新一轮 = 最后一条用户消息之后的事件
   *   - 该轮最后一个工具结果 failed → failed（中途失败已恢复不算）
   *   - 最后一条是用户消息（AI 未响应）→ waiting
   *   - 其余（纯文本回复/工具成功收尾/纯元数据）→ done
   *   running 由 listTasks 统一叠加（应用在线 + 90 秒内有活动）
   */
  _deriveTailStatus(tailLines) {
    let lastMsg = null;
    const roundResults = [];
    for (const j of tailLines) {
      if (!j || !j.type) continue;
      if (j.type === 'message') {
        if (j.role === 'user') roundResults.length = 0; // 新一轮开始
        lastMsg = j;
      } else if (j.type === 'function_call_result') {
        roundResults.push(j);
      }
    }
    if (lastMsg && lastMsg.role === 'user') return 'waiting';
    if (roundResults.length) {
      const last = roundResults[roundResults.length - 1];
      const s = String(last.status || '').toLowerCase();
      if (isFailedToolStatus(s)) return 'failed';
      if (s && s !== 'completed') return 'running'; // 异常中断的未知态：按运行中展示
    }
    return 'done';
  }

  // ================ 任务详情（全量解析） ================

  async getTask(id) {
    if (!this.ready) return null;
    if (!(await this.health())) return null; // 应用不在 = 无数据（与 listTasks 语义一致；详情/告警均按无数据处理）
    await this._scanProjects();
    const p = this._idIndex.get(String(id));
    if (!p || !fs.existsSync(p)) return null;

    const st = fs.statSync(p);
    const steps = new Map();     // callId -> step（fc 到 fcr 状态回填）
    const messages = [];
    const meta = { title: '', cwd: '', createdAtMs: 0 };

    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (!j || !j.type) continue;
      if (!meta.createdAtMs && j.timestamp) meta.createdAtMs = Number(j.timestamp);
      if (j.cwd && !meta.cwd) meta.cwd = String(j.cwd);

      if (j.type === 'ai-title' && j.aiTitle) {
        meta.title = String(j.aiTitle).trim();
      } else if (j.type === 'message') {
        const raw = this._extractText(j);
        const t = j.role === 'user' ? cleanUserText(raw) : raw.trim();
        if (!t) continue; // 空白消息（纯上下文注入/分片残留）不入对话流
        messages.push({
          role: j.role === 'user' ? 'user' : 'agent',
          text: t.slice(0, j.role === 'user' ? 2000 : 20000),
          createdAt: isoMs(j.timestamp),
          model: (j.providerData && j.providerData.model) || undefined
        });
      } else if (j.type === 'function_call') {
        const callId = String(j.callId || j.id || '');
        if (!callId) continue;
        steps.set(callId, {
          name: String(j.name || '工具调用').replace(/\s+/g, ' ').trim().slice(0, 200),
          status: 'running',
          output: '',
          createdAt: isoMs(j.timestamp)
        });
      } else if (j.type === 'function_call_result') {
        const callId = String(j.callId || j.parentId || '');
        const s = String(j.status || '').toLowerCase();
        const status = mapStepStatus(s);
        const output = this._extractOutput(j.output);
        const step = steps.get(callId);
        if (step) { step.status = status; step.output = output; }
        else steps.set(callId || ('orphan-' + steps.size), { name: String(j.name || '工具调用'), status, output, createdAt: isoMs(j.timestamp) });
      }
    }

    const stepList = [...steps.values()];
    // 无工具调用的规划型会话：用任务 todo 充当步骤（subject 为名，状态映射）
    if (!stepList.length) {
      for (const td of this._readTodos(String(id))) {
        stepList.push({
          name: String(td.subject || '子任务').slice(0, 200),
          status: TODO_STATUS[td.status] || 'running',
          output: String(td.description || '').slice(0, 200),
          createdAt: isoMs(td.createdAt)
        });
      }
    }

    // 四态：详情以步骤流为主（与 alerts.classify 语义一致），叠加活跃性
    const appAlive = await this.health();
    const active = appAlive && Date.now() - st.mtimeMs < ACTIVE_WINDOW_MS;
    let status;
    if (active) status = 'running';
    else if (stepList.some((s) => s.status === 'running') && appAlive) status = 'running';
    else if (stepList.length && stepList[stepList.length - 1].status === 'failed') status = 'failed';
    else if (messages.length && messages[messages.length - 1].role === 'user') status = 'waiting';
    else if (stepList.length) status = 'done';
    else status = appAlive ? 'running' : 'done'; // 纯对话：离线视为结束，在线视为进行中

    const firstUser = messages.find((m) => m.role === 'user');
    return {
      id: String(id),
      title: meta.title || (firstUser ? firstUser.text.slice(0, 80) : '未命名任务'),
      status,
      progress: stepList.length
        ? (status === 'done' ? 100 : Math.min(99, Math.round(stepList.filter((s) => s.status === 'done').length / stepList.length * 100)))
        : (status === 'done' ? 100 : 0),
      createdAt: isoMs(meta.createdAtMs || st.birthtimeMs),
      updatedAt: isoMs(st.mtimeMs),
      cwd: meta.cwd,
      group: this._groupDisplay(meta.cwd, () => path.basename(p, '.jsonl')),
      agentName: this._assistantName(String(id)), // 智能体名（前端可选展示）
      instruction: firstUser ? firstUser.text.slice(0, 200) : '',
      messages,
      steps: stepList
    };
  }

  // ================ 辅助 ================

  /** 读文件片段（不整读大文件）。 */
  _readSlice(p, start, len) {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd, () => {}); }
  }

  /** 片段 → JSON 行数组（丢弃头部半行；损坏行跳过）。 */
  _parseLines(chunk) {
    const out = [];
    const lines = chunk.split('\n');
    const from = chunk.startsWith('{') ? 0 : 1; // 尾部片段首行可能是上半截
    for (let i = from; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch (_) { /* 半行/损坏行跳过 */ }
    }
    return out;
  }

  /** message 行 → 纯文本（content 数组里所有带 text 的项拼接）。 */
  _extractText(j) {
    if (!Array.isArray(j.content)) return '';
    return j.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
  }

  /** function_call_result.output → 纯文本（{type:'text',text} 或字符串，兜底 JSON）。 */
  _extractOutput(o) {
    let t = '';
    if (typeof o === 'string') t = o;
    else if (o && typeof o.text === 'string') t = o.text;
    else if (o != null) { try { t = JSON.stringify(o); } catch (_) { t = ''; } }
    return t.replace(/\r/g, '').slice(0, 500);
  }

  /** 读任务 todo（tasks/<sessionId>/*.json），按文件序号排序。 */
  _readTodos(sid) {
    const dir = path.join(this.root, 'tasks', sid);
    const out = [];
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { return out; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (_) {}
    }
    out.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    return out;
  }

  /** 智能体显示名（assistant-display/<sid>.json 最后一条 snapshot）。 */
  _assistantName(sid) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.root, 'assistant-display', sid + '.json'), 'utf8'));
      const snaps = (j && j.snapshots) || [];
      for (let i = snaps.length - 1; i >= 0; i--) {
        const n = snaps[i] && snaps[i].assistantDisplay && snaps[i].assistantDisplay.name;
        if (n) return String(n);
      }
    } catch (_) {}
    return undefined;
  }

  /** 工作目录 → 分组显示名：优先 workspace-display-names.json，兜底目录名。 */
  _groupDisplay(cwd, fallback) {
    if (!cwd) return fallback() || '默认工作区';
    const key = String(cwd).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ':');
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.root, 'workspace-display-names.json'), 'utf8'));
      const hit = j.workspaces && (j.workspaces[key] || j.workspaces[String(cwd)]);
      if (hit && hit.displayName) return String(hit.displayName);
    } catch (_) {}
    return path.basename(String(cwd)) || fallback() || '默认工作区';
  }

  // ================ 指令注入（codebuddy CLI headless resume 通道） ================

  /**
   * 探测 CLI 发送通道：node 运行时 + codebuddy 脚本都在才就绪。
   * 失败仅 warn（canSend 保持 false，详情页降级「复制指令」），不抛错不拖垮 init。
   * CLI 路径可用 cfg.workbuddy.cliPath 覆写（自定义安装位置）。
   */
  _probeCli() {
    const wcfg = (this._cfg && this._cfg.workbuddy) || {};
    // 候选次序有讲究（2026-10-17 实测）：bin/codebuddy 是给 Electron 内部用的 —— 它
    // require('../dist/codebuddy')，主包在 app.asar 里（打包态），独立 node spawn 必崩
    // MODULE_NOT_FOUND；且它 --version 照常打印，版本探测无法识别这种残缺。桌面端真正的
    // 独立入口是 dist/codebuddy-lite-wb.mjs（完整 bundle，-p/--resume/--model 实测全通）。
    const unpacked = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli');
    const candidates = [
      String(wcfg.cliPath || '').trim(),
      path.join(unpacked, 'dist', 'codebuddy-lite-wb.mjs'),
      path.join(unpacked, 'bin', 'codebuddy')
    ].filter(Boolean);
    const node = this._resolveNode();
    const hit = node ? candidates.find((c) => fs.existsSync(c)) : null;
    const cli = hit || '';
    this._cli = hit ? { node, cli: hit } : null;
    this._cliReady = !!this._cli;
    if (this._cliReady) {
      this._log('info', '[WorkBuddy] CLI 发送通道就绪（' + cli + '），支持远程注入指令');
    } else {
      this._log('warn', '[WorkBuddy] 未找到 codebuddy CLI，远程发指令不可用（详情页降级复制转交；可用 workbuddy.cliPath 指定 CLI 路径）');
    }
  }

  /** node 运行时：优先 WorkBuddy 自带（versions/current → 最新版本目录），兜底桥接自身 node */
  _resolveNode() {
    const base = path.join(this.root, 'binaries', 'node', 'versions');
    const cur = path.join(base, 'current', 'node.exe');
    if (fs.existsSync(cur)) return cur;
    try {
      const vers = fs.readdirSync(base).filter((d) => /^\d+/.test(d)).sort().reverse();
      for (const v of vers) {
        const p = path.join(base, v, 'node.exe');
        if (fs.existsSync(p)) return p;
      }
    } catch (_) { /* 目录不存在等，走兜底 */ }
    return fs.existsSync(process.execPath) ? process.execPath : null;
  }

  /** 工具权限策略：默认 acceptEdits（自动接受文件编辑、其余工具正常执行），cfg.workbuddy.sendPermissionMode 可覆写 */
  _sendPermMode() {
    const allowed = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
    const v = this._cfg && this._cfg.workbuddy && this._cfg.workbuddy.sendPermissionMode;
    return allowed.includes(v) ? v : 'acceptEdits';
  }

  /**
   * 远程发消息：spawn codebuddy -p <text> --resume <sessionId>（headless 续聊），
   * AI 回复会追加进同一转录 JSONL，现有 fs.watch/轮询自然推回看板。
   *
   * 【四个实测坑】（2026-10-13/17 逐一定位，缺一发不通）：
   *  1. CLI 默认数据根是 ~/.codebuddy，必须用 CODEBUDDY_CONFIG_DIR/WORKBUDDY_CONFIG_DIR
   *     重定向到 .workbuddy 才能找到桌面端会话（否则 resume 报 No conversation found）；
   *  2. 该 fork 各类失败（会话未找到/未登录/上游 503）退出码恒为 0 且 stdout 为空，
   *     成功唯一判据 = stdout 有 --output-format json 输出；
   *  3. 模型鉴权：内置腾讯账号鉴权 headless 不可用，必须 --model 指向 models.json 里
   *     的自定义供应商条目（标准协议 + apiKey），且 CLI 参数要带 custom-local: 前缀；
   *     auto 条目走应用内代理，headless 不可用；
   *  4. bin/codebuddy 不能当独立入口（2026-10-17）：它 require('../dist/codebuddy')，主包在
   *     app.asar 打包态内，独立 node spawn 必崩 MODULE_NOT_FOUND，而 --version 照常打印 ——
   *     独立入口用 dist/codebuddy-lite-wb.mjs（候选次序见 _probeCli）。
   *
   * 发送即确认：8 秒窗口内进程正常退出 → 立即返回结果；仍在跑 → 返回 pending 放行
   * HTTP（CLI 转后台继续，unref 不阻塞桥接退出），失败细节只记日志。
   */
  async sendMessage(id, text) {
    text = String(text || '').trim();
    if (!text) throw new AdapterError('BAD_REQUEST', '消息内容不能为空');
    if (!this._cliReady || !this._cli) {
      throw new AdapterError('UNSUPPORTED', '未检测到 WorkBuddy CLI（codebuddy），无法注入指令');
    }
    const task = await this.getTask(String(id));
    if (!task) throw new AdapterError('NOT_FOUND', '任务不存在或 WorkBuddy 未运行');

    // 模型选择：显式配置 > 健康探测通过的自定义供应商 > 第一个候选兜底（错误如实上报）
    const sid = String(id);
    let model = (this._cfg && this._cfg.workbuddy && this._cfg.workbuddy.sendModel) || '';
    let fromModelsJson = false;
    if (!model) {
      const candidates = this._pickSendModels();
      fromModelsJson = candidates.length > 0;
      for (const c of candidates) {
        if (await this._modelHealthy(c)) { model = c; break; }
      }
      if (!model && candidates.length) model = candidates[0];
    }
    if (!model) throw new AdapterError('UNAVAILABLE', 'models.json 中没有可用的自定义模型供应商，无法注入指令');
    // CLI 侧自定义供应商条目带 custom-local: 前缀（--model 帮助列示 custom-local:<id>），
    // models.json 的裸 id 必须补前缀，否则按内置模型名解析报 503/未知模型；显式配置原样透传
    const modelArg = fromModelsJson && !model.includes(':') ? 'custom-local:' + model : model;

    const args = [this._cli.cli, '-p', text, '--resume', sid, '--model', modelArg, '--output-format', 'json', '--permission-mode', this._sendPermMode()];
    const child = spawn(this._cli.node, args, {
      cwd: task.cwd || os.homedir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this._sendEnv()
    });

    return new Promise((resolve) => {
      let settled = false;
      let out = '';
      let errTxt = '';
      child.stdout.on('data', (c) => { out += c; if (out.length > 64 * 1024) out = out.slice(-32 * 1024); });
      child.stderr.on('data', (c) => { errTxt += c; if (errTxt.length > 16 * 1024) errTxt = errTxt.slice(-8 * 1024); });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        this._log('warn', '[WorkBuddy] CLI 启动失败: ' + e.message);
        resolve({ ok: false, error: 'CLI 启动失败：' + e.message });
      });
      child.on('exit', (code) => {
        if (settled) {
          // 8 秒窗口已放行（pending 已返回）：只记日志，回复靠转录 watcher 推回看板
          if (code !== 0 || !out.trim()) this._log('warn', '[WorkBuddy] CLI 后台执行疑似失败（退出码 ' + code + '）：' + (errTxt.trim() || '无输出').slice(-400));
          else this._log('info', '[WorkBuddy] CLI 后台执行完毕（会话 ' + sid + '，模型 ' + model + '）');
          return;
        }
        settled = true;
        // 退出码不可作成功依据（该 fork 失败也返回 0）：成功 = stdout 有 JSON 结果输出
        if (code === 0 && out.trim()) {
          this._log('info', '[WorkBuddy] 指令已注入并执行完毕（会话 ' + sid + '，模型 ' + model + '）');
          resolve({ ok: true });
        } else {
          const tail = (errTxt.trim() || 'CLI 无输出').split('\n').pop() || '';
          this._log('warn', '[WorkBuddy] 指令注入失败（会话 ' + sid + '，模型 ' + model + '）：' + tail.slice(0, 200));
          resolve({ ok: false, error: tail.slice(0, 160) || 'CLI 无输出' });
        }
      });
      // 8 秒确认窗口（项目约定）：进程仍在跑 → 已受理，返回 pending 并转后台
      const tm = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._log('info', '[WorkBuddy] 指令已受理，CLI 后台执行中（会话 ' + sid + '，模型 ' + model + '，' + text.length + ' 字）');
        try { child.unref(); if (child.stdout) child.stdout.unref(); if (child.stderr) child.stderr.unref(); } catch (_) {}
        resolve({ ok: true, pending: true });
      }, 8000);
      if (tm.unref) tm.unref();
    });
  }

  /** CLI 子进程环境：把 CodeBuddy 核心数据根重定向到 .workbuddy（桌面端同款，读自其子进程环境块） */
  _sendEnv() {
    const env = { ...process.env };
    env.CODEBUDDY_CONFIG_DIR = this.root;
    env.WORKBUDDY_CONFIG_DIR = this.root;
    env.WORKBUDDY_DATA_FOLDER_NAME = path.basename(this.root);
    return env;
  }

  /** 模型候选（models.json）：非 auto、标准协议、带 apiKey、支持工具调用的条目，按配置顺序 */
  _pickSendModels() {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.root, 'models.json'), 'utf8'));
      return (Array.isArray(j) ? j : [])
        .filter((m) => m && m.id && m.id !== 'auto' && m.url && m.apiKey && !m.useCustomProtocol && m.supportsToolCall !== false)
        .map((m) => String(m.id));
    } catch (_) { return []; }
  }

  /** 模型健康探测（缓存 5 分钟）：直连供应商发 1 token 请求，避免把失败注入写进真实会话转录 */
  async _modelHealthy(modelId) {
    const hit = this._modelHealth.get(modelId);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ok;
    const ok = await this._probeModel(modelId);
    this._modelHealth.set(modelId, { ok, at: Date.now() });
    return ok;
  }

  async _probeModel(modelId) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.root, 'models.json'), 'utf8'));
      const m = (Array.isArray(j) ? j : []).find((x) => x && x.id === modelId);
      if (!m || !m.url || !m.apiKey) return false;
      const url = String(m.url).replace(/\/+$/, '') + '/chat/completions';
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m.apiKey },
          body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: '1' }], max_tokens: 1 }),
          signal: ctrl.signal
        });
        return r.ok;
      } finally { clearTimeout(tm); }
    } catch (_) { return false; }
  }
}

module.exports = { WorkBuddyAdapter };

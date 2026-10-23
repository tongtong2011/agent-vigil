'use strict';
/**
 * Trae 适配器（lib/adapters/trae.js）—— 本地记忆转录直读，只读（WorkBuddy 同款模式）
 *
 * 【取证结论】（2026-10-12 本机实测，Trae CN = 字节系 AI IDE，Electron 应用）
 * - IDE 会话正文存于 %APPDATA%\Trae CN\ModularData\ai-agent\database.db，文件头为加密数据
 *   （非 SQLite 明文），且被运行中的 Trae 进程独占锁定 → 不可直读；
 * - Trae 不支持远程发指令注入（无 headless/ACP 注入通道），sendMessage 明确拒绝；
 * - 唯一稳定可读的本地数据源 = 记忆子系统转录（纯文本 JSONL，逐回合追加，无需鉴权）。
 *
 * 【数据布局】（数据根 %USERPROFILE%\.trae-cn\memory\projects）
 *   <项目转义目录>/<YYYYMMDD>/session_memory_<sessionId>.jsonl
 *     一行一个回合摘要（回合完成后异步落盘，时间戳毫秒数字）：
 *     - intent               用户本轮意图（真实需求描述）
 *     - actions[]            本轮执行动作（摘要级，等价 WorkBuddy 的步骤）
 *     - outcome              本轮结果（AI 侧结论）
 *     - learned[]            沉淀经验（看板不单独展示）
 *     - message_summary_time 'YYYY-MM-DD HH:mm:ss' 摘要时间
 *     - compact_summary_meta.created_at_ms  毫秒时间戳（回合时间可靠来源）
 *   会话跨天延续：同一 sessionId 会出现在多个日期目录，按 sessionId 聚合、全量合并读取。
 *
 * 【任务标题】= 最新一轮 intent。用户在 IDE 里改的会话名只存加密主库（database.db 为加密数据，
 *   非明文 SQLite）与云端，本地明文存储（转录/工作区库/leveldb/事件缓存）均已穷尽取证、取不到；
 *   最新指令随任务推进自动更新，比首条更贴近任务当前状态（2026-10-12 用户定稿）。
 *
 * 【任务目录 cwd/group】工作区池精确映射优先：workspaceStorage 各 hash 目录下的 workspace.json +
 *   全局 state.vscdb 明文页 file:/// URI → 真实路径池，按转义规则（非[字母数字]→'-'，小写比对）
 *   反查；未命中才退回近似还原（'-' 歧义，含连字符路径会有误差）。
 *
 * 【四态简化说明】摘要记录不携带执行状态字段（异步落盘，回合完成才写），
 *   failed/waiting 无法可靠判定，不猜测、不误报——本渠道仅两态：
 *   - running  Trae 在线 且 会话最新文件 mtime < 90 秒（活动窗口，与 workbuddy 语义一致）
 *   - done     其余（历史会话一律视为已完成）
 *   代价：该渠道不会触发「异常/待确认」即时告警（无 failed/waiting 态），汇总邮件正常参与。
 *
 * 【读盘策略】（与 workbuddy 同款）
 *   - 列表：mtime/size 缓存，文件未变化直接复用摘要；扫描 1 秒节流
 *   - 详情：按 sessionId 聚合读取其全部日期文件，构建对话流（intent→user / outcome→agent）
 *   - 实时性：fs.watch 递归监听数据根，JSONL 追加 → 防抖回调 onChange(sessionId)
 *   - 健康检查：tasklist 探测 Trae CN.exe / Trae.exe（30 秒缓存，与 agnesd/workbuddy 同款探测）
 *
 * 【只读铁律】本适配器绝不写 .trae-cn 任何文件；sendMessage 不支持。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  BaseAdapter, AdapterError,
  isoMs
} = require('./base');

const ACTIVE_WINDOW_MS = 90 * 1000;  // 「正在执行」活动窗口（与 agnes/workbuddy 语义一致）
const LIST_LIMIT_FLOOR = 100;        // 列表条数下限兜底（实际生效值读全局 config board.listLimit）
const FILE_PREFIX = 'session_memory_';
// 项目转义目录名 = 路径 \→- 转义 + 尾部画像后缀（--p2-<hash> 等），剥离后缀与首横线再反转义（近似还原，仅展示用）
const PROFILE_SUFFIX_RE = /-{1,2}p\d+-[0-9a-f]{8,}$/i;

function probeProcess(imageName) {
  return new Promise((resolve) => {
    const p = spawn('tasklist', ['/FI', 'IMAGENAME eq ' + imageName, '/FO', 'CSV', '/NH'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => resolve(false));
    p.on('close', () => resolve(new RegExp(imageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(out)));
  });
}

/** <项目转义目录> → 近似还原 cwd（'-' 歧义不可逆，路径含连字符时会有误差，仅展示用）。 */
function unescapeProjectDir(dirName) {
  const s = String(dirName || '').replace(PROFILE_SUFFIX_RE, '').replace(/^-+/, '');
  const parts = s.split('-').filter(Boolean);
  if (!parts.length) return '';
  if (parts[0].length === 1) return parts[0].toUpperCase() + ':\\' + parts.slice(1).join('\\');
  return parts.join('\\');
}

/** file:/// URI → Windows 路径（file:///e%3A/me/x → e:\me\x；解码失败返回 ''）。 */
function fileUriToWinPath(uri) {
  try {
    let p = decodeURIComponent(String(uri).replace(/^file:\/\//i, ''));
    p = p.replace(/^\/([A-Za-z]):/, '$1:').replace(/\//g, '\\');
    return p;
  } catch (_) { return ''; }
}

class TraeAdapter extends BaseAdapter {
  /** @param {object} o 可选 rootDir 覆盖数据根（测试用）；appNames 覆盖进程探测名（测试用） */
  constructor(o = {}) {
    super();
    this.root = o.rootDir || path.join(os.homedir(), '.trae-cn', 'memory', 'projects');
    // Trae 安装数据目录（工作区池数据源）：%APPDATA%\Trae CN；测试可注入
    this._appData = o.appDataDir || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Trae CN');
    this._appNames = Array.isArray(o.appNames) && o.appNames.length ? o.appNames : ['Trae CN.exe'];
    this._cfg = o.cfg || null;        // 实时读配置用（config.save 原地 deepMerge，引用恒为最新值）
    this.ready = false;
    this._watcher = null;
    this._files = new Map();          // jsonl 绝对路径 -> {mtimeMs, size, sid}
    this._sessions = new Map();       // sessionId -> {files:[绝对路径], task(列表级统一格式)|null}
    this._lastScanAt = 0;
    this._scanning = false;
    this._pathPool = new Map();       // 转义项目目录名(小写) -> 真实 cwd（工作区池精确映射）
    this._pathPoolAt = 0;
    this._appAlive = false;           // 最近一次进程探测结果（health 缓存）
    this._appAliveAt = 0;
    this._log = () => {};
  }

  get channel() { return 'trae'; }
  get displayName() { return 'Trae'; }
  /** 只读渠道：sendMessage 抛 UNSUPPORTED，前端据此将详情页输入框切换为「复制指令」转交模式 */
  get canSend() { return false; }
  /** 复制转交提示（/health 透传前端，复制成功后 toast 引导用户去 Trae 粘贴发送） */
  get sendHint() { return 'Trae 暂不支持远程注入指令：已复制到剪贴板，请切换到 Trae 粘贴发送'; }

  async init(ctx) {
    this._log = (ctx && ctx.log) || (() => {});
    if (!fs.existsSync(this.root)) {
      this._log('warn', '[Trae] 未检测到数据目录 ' + this.root + '（未安装或未运行过，看板该渠道为空）');
      return;
    }
    this.ready = true;
    // 递归监听数据根：转录追加/新建 → 防抖回调（Windows NTFS 支持递归 watch）
    try {
      this._watcher = fs.watch(this.root, { recursive: true }, (_ev, filename) => {
        if (!filename || !String(filename).endsWith('.jsonl')) return;
        const sid = path.basename(String(filename)).replace(/^session_memory_/, '').replace(/\.jsonl$/i, '');
        this._debounceChange(sid);
      });
      this._watcher.on('error', () => { /* watcher 挂了不影响读取，静默 */ });
    } catch (_) { /* 某些环境 watch 不可用：退化为纯轮询，功能不受影响 */ }
    await this.listTasks().catch(() => {}); // 预热缓存
    this._log('info', '[Trae] 就绪：' + this.taskCount() + ' 个历史会话（数据根 ' + this.root + '）');
  }

  async close() {
    if (this._watcher) { try { this._watcher.close(); } catch (_) {} this._watcher = null; }
    this.ready = false;
  }

  _debounceChange(sid) {
    clearTimeout(this._changeTm);
    this._changeTm = setTimeout(() => {
      for (const p of (this._sessions.get(sid) || { files: [] }).files) this._files.delete(p); // 失效该会话缓存，下轮重读
      this._emitChange(sid);
    }, 400);
    if (this._changeTm.unref) this._changeTm.unref();
  }

  /** 健康检查：Trae 进程存活（任一镜像名命中即在线；缓存 30 秒，tasklist 开销大不能每秒跑）。 */
  async health() {
    const now = Date.now();
    if (now - this._appAliveAt < 30000) return this._appAlive;
    const results = await Promise.all(this._appNames.map((n) => probeProcess(n)));
    this._appAlive = results.some(Boolean);
    this._appAliveAt = now;
    return this._appAlive;
  }

  describe() {
    const n = this.taskCount();
    return '真实数据（本地记忆转录直读 ' + this.root + '，' + (n >= 0 ? n + ' 个会话' : '未扫描') + '，应用' + (this._appAlive ? '在线' : '未检测到') + '）';
  }

  taskCount() { return this._sessions.size || -1; }

  /** 列表条数上限（V4.1 全局统一：实时读 config board.listLimit，向导滑块/手改 config 均热生效）；下限兜底 */
  _listLimit() {
    const b = (this._cfg && this._cfg.board) || {};
    const n = Math.round(Number(b.listLimit));
    return Number.isFinite(n) ? Math.max(LIST_LIMIT_FLOOR, n) : LIST_LIMIT_FLOOR;
  }

  /**
   * 工作区池：真实项目路径 → 转义目录名映射（60 秒缓存）。两个只读来源：
   * ① %APPDATA%\Trae CN\User\workspaceStorage\*\workspace.json 的 folder 字段（结构化权威源）
   * ② %APPDATA%\Trae CN\User\globalStorage\state.vscdb 明文页里的 file:/// URI（SQLite 明文页直接正则提，免 sqlite 依赖）
   * 记忆转录目录名 = cwd 非[字母数字]→'-' 的转义（'-' 歧义不可逆），用池反向精确匹配替代近似还原。
   */
  _buildPathPool() {
    if (Date.now() - this._pathPoolAt < 60000 && this._pathPool.size) return;
    const pool = new Map();
    const addReal = (real) => {
      const r = String(real || '').trim();
      if (!r || !/[\\/]/.test(r)) return;                 // 目录/文件路径才参与
      const esc = '-' + r.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      if (esc.length > 2 && !pool.has(esc)) pool.set(esc, r);
    };
    try {
      const wsRoot = path.join(this._appData, 'User', 'workspaceStorage');
      for (const d of fs.readdirSync(wsRoot)) {
        const wj = path.join(wsRoot, d, 'workspace.json');
        let j;
        try { j = JSON.parse(fs.readFileSync(wj, 'utf8')); } catch (_) { continue; }
        if (j && typeof j.folder === 'string' && /^file:\/\//i.test(j.folder)) addReal(fileUriToWinPath(j.folder));
      }
    } catch (_) { /* 无 workspaceStorage（未装/降级）：仅剩全局最近列表来源 */ }
    try {
      const gdb = path.join(this._appData, 'User', 'globalStorage', 'state.vscdb');
      if (fs.existsSync(gdb)) {
        const raw = fs.readFileSync(gdb).toString('latin1');   // URI 是 ASCII，latin1 切片安全
        const re = /file:\/\/\/[A-Za-z0-9%._\-/]+/g;
        let m;
        while ((m = re.exec(raw)) !== null) addReal(fileUriToWinPath(m[0]));
      }
    } catch (_) { /* 缺文件跳过 */ }
    this._pathPool = pool;
    this._pathPoolAt = Date.now();
  }

  /** 项目转义目录名 → cwd：先查工作区池精确映射，未命中退回近似还原（转义规则同构：非字母数字→'-'）。 */
  _resolveCwd(dirName) {
    this._buildPathPool();
    const raw = String(dirName || '').replace(PROFILE_SUFFIX_RE, '').toLowerCase();
    if (raw && this._pathPool.has(raw)) return this._pathPool.get(raw);
    return unescapeProjectDir(dirName);
  }

  // ================ 任务列表（缓存摘要） ================

  async listTasks() {
    if (!this.ready) return [];
    // 进程探测前置（与 agnes/workbuddy「未检测到进程=空看板」语义对齐）：IDE 不在 = 渠道拿不到数据，
    // 返回空列表 → 服务端快照清零、看板清空只留提示条；Trae 重开后自动恢复（health 有 30 秒缓存）
    if (!(await this.health())) return [];
    await this._scanProjects();
    const out = [];
    for (const rec of this._sessions.values()) if (rec && rec.task) out.push(rec.task);
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // 应用在线已由上方门禁保证：mtime 90 秒内有活动 → running
    for (const t of out) {
      const active = Date.now() - Date.parse(t.updatedAt) < ACTIVE_WINDOW_MS;
      if (active) t.status = 'running';
    }
    return out.slice(0, this._listLimit());
  }

  /** 扫描数据根：<项目转义目录>/<日期>/session_memory_<sid>.jsonl；mtime/size 变了才重建摘要。 */
  async _scanProjects() {
    if (this._scanning) return;
    if (Date.now() - this._lastScanAt < 1000) return; // 1 秒节流
    this._scanning = true;
    try {
      const seenFiles = new Set();
      const sidFiles = new Map(); // sid -> [绝对路径]
      let projs = [];
      try { projs = fs.readdirSync(this.root); } catch (_) { return; }
      for (const proj of projs) {
        const projDir = path.join(this.root, proj);
        let dates = [];
        try { dates = fs.readdirSync(projDir); } catch (_) { continue; }
        for (const date of dates) {
          const dateDir = path.join(projDir, date);
          let files;
          try { files = fs.readdirSync(dateDir); } catch (_) { continue; }
          for (const f of files) {
            if (!f.startsWith(FILE_PREFIX) || !f.endsWith('.jsonl')) continue;
            const sid = f.slice(FILE_PREFIX.length, -'.jsonl'.length);
            if (!sid) continue;
            const p = path.join(dateDir, f);
            let st;
            try { st = fs.statSync(p); } catch (_) { continue; }
            if (!st.isFile()) continue;
            seenFiles.add(p);
            this._files.set(p, { mtimeMs: st.mtimeMs, size: st.size, sid });
            if (!sidFiles.has(sid)) sidFiles.set(sid, []);
            sidFiles.get(sid).push(p);
          }
        }
      }
      // 文件已消失的会话清掉
      for (const [sid, rec] of this._sessions) {
        if (!rec.files.some((p) => seenFiles.has(p))) this._sessions.delete(sid);
      }
      for (const [sid, files] of sidFiles) {
        const rec = this._sessions.get(sid);
        const needRebuild = !rec || files.length !== rec.files.length
          || files.some((p) => {
            const meta = this._files.get(p);
            const old = rec.fileMeta && rec.fileMeta[p];
            return !old || !meta || old.mtimeMs !== meta.mtimeMs || old.size !== meta.size;
          });
        if (needRebuild) {
          this._sessions.set(sid, { files, fileMeta: Object.fromEntries(files.map((p) => [p, { ...this._files.get(p) }])), task: this._summarize(sid, files) });
        }
      }
      this._lastScanAt = Date.now();
    } finally {
      this._scanning = false;
    }
  }

  /**
   * 列表级摘要：全量合并该会话各日期文件（转录文件小，整读开销可忽略）。
   * 标题 = 最新一轮 intent（用户在 IDE 里改的任务名只存加密库/云端，本地取不到；
   * 最新指令随任务推进自动更新，比首条更能反映任务当前在干嘛）。cwd 走工作区池精确映射。
   */
  _summarize(sid, files) {
    const ordered = this._orderByDate(files);
    let title = '';
    let createdAtMs = 0;
    let latestIntent = '';
    let readOk = false;
    const all = [];
    for (const p of ordered) {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      readOk = true;
      for (const j of this._parseLines(text)) all.push(j);
    }
    if (!readOk) return null;
    for (const j of all) {
      if (!createdAtMs && j.compact_summary_meta && j.compact_summary_meta.created_at_ms) {
        createdAtMs = Number(j.compact_summary_meta.created_at_ms);
      }
      const it = typeof j.intent === 'string' ? j.intent.trim().replace(/\s+/g, ' ') : '';
      if (it) latestIntent = it;                 // 记录按时间序追加，最后一个非空 intent = 最新指令
    }
    if (!createdAtMs) {
      for (const j of all) {
        if (j.message_summary_time) { const t = Date.parse(j.message_summary_time); if (t > 0) { createdAtMs = t; break; } }
      }
    }
    title = latestIntent.slice(0, 80);

    let latestMtimeMs = 0;
    let projDir = '';
    for (const p of files) {
      const meta = this._files.get(p);
      if (meta && meta.mtimeMs > latestMtimeMs) latestMtimeMs = meta.mtimeMs;
      if (!projDir) projDir = path.dirname(path.dirname(p));
    }
    const cwd = this._resolveCwd(path.basename(projDir));
    return {
      id: sid,
      title: title || '未命名任务',
      status: 'done',               // listTasks 会按「应用在线+mtime 新」覆写为 running
      progress: 0,
      createdAt: isoMs(createdAtMs || latestMtimeMs),
      updatedAt: isoMs(latestMtimeMs),
      cwd,
      group: path.basename(cwd) || '默认工作区',
      steps: [],
      messages: []
    };
  }

  /** 文件按日期目录排序（目录名 YYYYMMDD 字典序 = 时间序），同目录按文件名兜底。 */
  _orderByDate(files) {
    return [...files].sort((a, b) => {
      const da = path.basename(path.dirname(a));
      const db = path.basename(path.dirname(b));
      return da === db ? a.localeCompare(b) : da.localeCompare(db);
    });
  }

  // ================ 任务详情（全量解析） ================

  async getTask(id) {
    if (!this.ready) return null;
    if (!(await this.health())) return null; // 应用不在 = 无数据（与 listTasks 语义一致）
    await this._scanProjects();
    const rec = this._sessions.get(String(id));
    if (!rec) return null;
    const ordered = this._orderByDate(rec.files);
    let lastStat;
    try { lastStat = fs.statSync(ordered[ordered.length - 1]); } catch (_) { return null; }

    const records = [];
    for (const p of ordered) {
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      for (const j of this._parseLines(text)) records.push(j);
    }
    if (!records.length) return null;

    const messages = [];
    const steps = [];
    let createdAtMs = 0;
    let latestIntent = '';
    for (const j of records) {
      const tsMs = (j.compact_summary_meta && Number(j.compact_summary_meta.created_at_ms)) || Date.parse(j.message_summary_time) || 0;
      if (!createdAtMs && tsMs > 0) createdAtMs = tsMs;
      const it = typeof j.intent === 'string' ? j.intent.trim().replace(/\s+/g, ' ') : '';
      if (it) latestIntent = it;                   // 时间序追加 → 最后一个非空 intent = 最新指令（标题源）
      const intent = typeof j.intent === 'string' ? j.intent.trim() : '';
      const outcome = typeof j.outcome === 'string' ? j.outcome.trim() : '';
      if (intent) messages.push({ role: 'user', text: intent.slice(0, 2000), createdAt: isoMs(tsMs) });
      if (outcome) messages.push({ role: 'agent', text: outcome.slice(0, 20000), createdAt: isoMs(tsMs) });
      for (const a of (Array.isArray(j.actions) ? j.actions : [])) {
        const name = String(a || '').replace(/\s+/g, ' ').trim();
        if (name) steps.push({ name: name.slice(0, 200), status: 'done', output: '', createdAt: isoMs(tsMs) });
      }
    }

    // 两态判定（见文件头说明）：应用在线 + 最新文件 mtime 在活动窗口内 → running，否则 done
    const latestMtimeMs = lastStat.mtimeMs;
    const status = Date.now() - latestMtimeMs < ACTIVE_WINDOW_MS ? 'running' : 'done';

    const firstUser = messages.find((m) => m.role === 'user');
    const projDir = path.dirname(path.dirname(ordered[0]));
    const cwd = this._resolveCwd(path.basename(projDir));
    return {
      id: String(id),
      title: (latestIntent || (firstUser ? firstUser.text : '')).slice(0, 80) || '未命名任务',
      status,
      progress: status === 'done' ? 100 : 0,
      createdAt: isoMs(createdAtMs || lastStat.birthtimeMs),
      updatedAt: isoMs(latestMtimeMs),
      cwd,
      group: path.basename(cwd) || '默认工作区',
      instruction: firstUser ? firstUser.text.slice(0, 200) : '',
      messages,
      steps
    };
  }

  /** 片段 → JSON 行数组（损坏行跳过；记忆转录文件小，整读成本可忽略）。 */
  _parseLines(text) {
    const out = [];
    for (const l of String(text).split('\n')) {
      const t = l.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch (_) { /* 半行/损坏行跳过 */ }
    }
    return out;
  }

  /** 远程发消息不支持：Trae 无指令注入通道（取证结论），明确拒绝而非静默失败。 */
  async sendMessage(id, text) {
    void id; void text;
    throw new AdapterError('UNSUPPORTED', 'Trae 暂不支持远程发消息（IDE 会话无本地指令注入通道）');
  }
}

module.exports = { TraeAdapter };

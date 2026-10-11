'use strict';
/**
 * 爱思办公本地后端（agnesd / goose ACP 协议）发现与只读客户端
 *
 * 【取证结论】（2026-10-05，仅本机实验验证）：
 *   - 爱思办公桌面端（AgnesCode.exe，Electron）启动本地后端 agnesd.exe，
 *     监听 https://127.0.0.1:<port>，自签名证书（客户端须跳过校验/钉扎指纹）。
 *   - 鉴权：请求头 X-Secret-Key: <secret>；WebSocket 路径 /acp?token=<secret>。
 *   - secret 由桌面端每次启动 agnesd 时随机生成（32 字节 hex），仅存在于
 *     agnesd 进程环境变量 AGNES_SERVER__SECRET_KEY，不落盘，须经
 *     ReadProcessMemory 读取（lib/get-agnes-secret.ps1）。
 *   - 端口可从日志尾部提取：日志行「Starting agnesd from: ... on port <port>」。
 *   - 协议：JSON-RPC over WebSocket（ACP）。
 *     initialize → session/list → session/load（重放为 session/update 通知流）。
 *     session/update.update.sessionUpdate ∈
 *       user_message_chunk / agent_message_chunk / agent_thought_chunk /
 *       tool_call / tool_call_update。
 *
 * 【只读铁律】本模块默认仅调用 initialize / session/list / session/load 三个读方法。
 * V2 例外：sendMessage 功能开启时（config.messages.enabled=true），额外调用
 * session/prompt 把用户在手机上输入的消息转发给会话（等价于电脑端输入框发消息），
 * 该调用仅可由已配对设备令牌触发，且有限速保护。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const AGNES_DATA_DIR = path.join(process.env.APPDATA || '', 'AgnesCode');
const MAIN_LOG = path.join(AGNES_DATA_DIR, 'logs', 'main.log');
const BACKEND_DIR = path.join(AGNES_DATA_DIR, 'backend-processes');
const SECRET_SCRIPT = path.join(__dirname, 'get-agnes-secret.ps1');

/** 发现 agnesd：返回 { pid, port, secret } 或 null（含原因）。 */
async function discoverBackend(cfg) {
  // 1) 配置直填优先
  if (cfg && cfg.acp) {
    const port = Number(cfg.acp.port) || 0;
    const secret = (cfg.acp.secret || '').trim();
    if (port && secret) return { pid: 0, port, secret, source: 'config' };
  }

  // 2) 找 agnesd pid（backend-processes/*.json 记录，校验进程存在）
  const pid = await findAgnesdPid();
  if (!pid) return { error: '未发现运行中的 agnesd 进程（请确认爱思办公桌面端已启动）' };

  // 3) 端口：优先日志；失败则 netstat 查监听端口兜底（日志轮转后不再含端口行）
  let port = cfg && Number(cfg.acp && cfg.acp.port) ? Number(cfg.acp.port) : readPortFromLog();
  let portSource = 'log';
  if (!port) {
    const ports = await readPortsFromNetstat(pid);
    port = ports[0] || 0;
    portSource = 'netstat';
  }
  if (!port) return { error: `已发现 agnesd(pid=${pid}) 但未能解析端口（日志与 netstat 均未找到）` };

  // 4) secret：读进程环境变量
  const secret = (cfg && cfg.acp && cfg.acp.secret || '').trim() || (await readSecretFromMemory(pid));
  if (!secret) return { error: `已发现 agnesd(pid=${pid}, port=${port}) 但读取密钥失败` };

  return { pid, port, secret, source: 'auto' };
}

/** 扫描 backend-processes 目录并用 tasklist 校验 agnesd 存活，返回 pid 或 0。 */
async function findAgnesdPid() {
  let records = [];
  try {
    for (const f of fs.readdirSync(BACKEND_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, f), 'utf8'));
        if (j.pid && /agnesd\.exe$/i.test(String(j.executable || ''))) records.push(j);
      } catch (_) { /* 单个记录损坏忽略 */ }
    }
  } catch (_) { return 0; }
  records.sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));
  const alive = await tasklistFilterAgnesd();
  for (const r of records) if (alive.has(r.pid)) return r.pid;
  return 0;
}

function tasklistFilterAgnesd() {
  return new Promise((resolve) => {
    const set = new Set();
    const p = spawn('tasklist', ['/FI', 'IMAGENAME eq agnesd.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => resolve(set));
    p.on('close', () => {
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^"agnesd\.exe","(\d+)"/i);
        if (m) set.add(Number(m[1]));
      }
      resolve(set);
    });
  });
}

/** 从 main.log 尾部提取最近的「on port <n>」。 */
function readPortFromLog() {
  try {
    const stat = fs.statSync(MAIN_LOG);
    const size = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(MAIN_LOG, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const ports = [...text.matchAll(/Starting agnesd from:[^\n]*? on port (\d+)/g)].map((m) => Number(m[1]));
    return ports.length ? ports[ports.length - 1] : 0;
  } catch (_) { return 0; }
}

/**
 * netstat 兜底：日志被轮转/尾部不再含端口行时，直接查 agnesd 监听的 TCP 端口。
 * 返回端口号数组（解析 netstat -ano，格式与系统语言无关：数字字段位置固定）。
 */
function readPortsFromNetstat(pid) {
  return new Promise((resolve) => {
    const p = spawn('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => resolve([]));
    p.on('close', () => {
      const ports = new Set();
      for (const line of out.split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        // TCP  127.0.0.1:50301  0.0.0.0:0  LISTENING  6808
        if (f.length >= 5 && f[0].toUpperCase() === 'TCP' && f[3].toUpperCase() === 'LISTENING' && f[4] === String(pid)) {
          const m = f[1].match(/127\.0\.0\.1:(\d+)/);
          if (m) ports.add(Number(m[1]));
        }
      }
      resolve([...ports]);
    });
  });
}

/** 调 PowerShell 读 agnesd 进程环境变量中的 secret。 */
function readSecretFromMemory(pid) {
  return new Promise((resolve) => {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SECRET_SCRIPT, '-AgnesdPid', String(pid)],
      { windowsHide: true }
    );
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      const v = out.trim();
      if (code === 0 && v && !v.startsWith('ERR:')) resolve(v);
      else resolve(null);
    });
  });
}

// ────────────────────────── ACP WebSocket 客户端 ──────────────────────────

class AcpClient {
  /**
   * @param {object} o { port, secret }
   * @param {function} onUpdate (sessionId, update, isReplay) => void  实时/重放通知
   * @param {function} log (level, msg) => void
   */
  constructor(o, onUpdate, log) {
    this.port = o.port;
    this.secret = o.secret;
    this.rediscover = o.rediscover || null; // () => {port, secret} | null：重连失败后重新发现后端（爱思重启会换端口）
    this.onUpdate = onUpdate || (() => {});
    this.log = log || (() => {});
    this.ws = null;
    this.ready = false;
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._replaying = false;
    this._closedByUs = false;
    this._backoff = 1000;
    this._failCount = 0; // 连续重连失败计数（成功清零；≥3 触发重新发现端口）
  }

  _url() {
    return `wss://127.0.0.1:${this.port}/acp?token=${encodeURIComponent(this.secret)}`;
  }

  /** 建立连接并完成 initialize 握手。成功后常驻接收通知，断线自动重连。 */
  connect() {
    return new Promise((resolve, reject) => {
      this._closedByUs = false;
      let settled = false;
      const ws = new WebSocket(this._url(), { rejectUnauthorized: false });
      this.ws = ws;
      const failTm = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch (_) {}
        reject(new Error('ACP 连接超时（8s）'));
      }, 8000);

      ws.on('open', () => {
        this._rpc('initialize', { protocolVersion: 1, clientCapabilities: {} }, 6000)
          .then(() => {
            this.ready = true;
            this._backoff = 1000;
            this._failCount = 0;
            if (!settled) { settled = true; clearTimeout(failTm); resolve(); }
            this.log('info', `ACP 已连接 127.0.0.1:${this.port}（initialize 成功）`);
          })
          .catch((e) => {
            if (!settled) { settled = true; clearTimeout(failTm); reject(e); }
          });
      });

      ws.on('message', (raw) => this._onMessage(raw));

      ws.on('close', () => {
        const wasReady = this.ready;
        this.ready = false;
        for (const [, p] of this._pending) {
          clearTimeout(p.timer);
          p.reject(new Error('ACP 连接已断开'));
        }
        this._pending.clear();
        if (!settled) { settled = true; clearTimeout(failTm); reject(new Error('ACP 连接被关闭')); return; }
        if (this._closedByUs) return;
        if (wasReady) this.log('warn', 'ACP 连接断开，准备重连');
        this._scheduleReconnect();
      });

      ws.on('error', (e) => {
        if (!settled) { settled = true; clearTimeout(failTm); reject(new Error('ACP 连接失败: ' + e.message)); }
      });
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTm || this._closedByUs) return;
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, 15000);
    this._failCount++;
    this._reconnectTm = setTimeout(async () => {
      this._reconnectTm = null;
      // 连续失败 ≥3 次：爱思重启后 agnesd 会换端口+换 secret，死守旧端口永远连不上
      // （实测 2026-10-10：重开应用 50301→60884，桥接死守旧端口导致连续多轮统计空白）。
      // 重新走发现流程（backend-processes → 日志/netstat → 环境变量 secret），拿到新端口再连。
      if (this.rediscover && this._failCount >= 3) {
        try {
          const d = await this.rediscover();
          if (d && d.port && d.secret && (d.port !== this.port || d.secret !== this.secret)) {
            this.log('info', `ACP 重新发现后端：端口 ${this.port} → ${d.port}（pid=${d.pid || '?'}），切换后重连`);
            this.port = d.port;
            this.secret = d.secret;
            this._backoff = 1000;
          }
        } catch (_) { /* 发现失败按原端口继续重试 */ }
      }
      this.log('info', 'ACP 重连中…');
      this.connect().catch((e) => this.log('warn', 'ACP 重连失败: ' + e.message));
    }, delay);
  }

  close() {
    this._closedByUs = true;
    if (this._reconnectTm) { clearTimeout(this._reconnectTm); this._reconnectTm = null; }
    this.ready = false;
    try { this.ws && this.ws.close(); } catch (_) {}
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.id && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`ACP 错误 ${msg.error.code || ''}: ${msg.error.message || JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    // 通知：session/update（load 重放与实时活动共用同一通道）
    if (msg.method === 'session/update' && msg.params) {
      const sessionId = msg.params.sessionId;
      const update = msg.params.update;
      if (sessionId && update) this.onUpdate(sessionId, update, this._replaying);
    }
  }

  _rpc(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('ACP 未连接'));
      }
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`ACP 调用超时: ${method}`));
      }, timeoutMs || 8000);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /** 会话列表（只读）。 */
  async listSessions() {
    const result = await this._rpc('session/list', {}, 10000);
    return (result && result.sessions) || [];
  }

  /**
   * 加载会话历史（只读）：session/load 会把历史消息以 session/update 通知流重放，
   * 由 onUpdate 收集聚合；这里等待 result 后再留一小段收尾窗口。
   */
  async loadSession(sessionId, cwd) {
    this._replaying = true;
    try {
      await this._rpc('session/load', { sessionId, cwd: cwd || '', mcpServers: [] }, 15000);
      await new Promise((r) => setTimeout(r, 1200)); // 等待排队中的重放通知
    } finally {
      this._replaying = false;
    }
  }

  /**
   * 向会话发送用户消息（V2，唯一写方法，须配置开关开启后由上层调用）。
   * 等价于电脑端在输入框发消息；AI 的回复经 session/update 通知流实时回来。
   * prompt 为 ContentBlock 数组（goose ACP 标准），文本块 { type:'text', text }。
   *
   * 【发送即确认】ACP 的 session/prompt 只有在 AI 完整处理完本轮对话后才返回
   * result（含 stopReason），复杂任务可达数分钟。因此只短暂等待（8 秒）：
   *   - result 正常返回 → 直接透传
   *   - 超时           → 消息已送达、AI 处理中（回复经通知流实时推送），视为成功
   *   - 明确错误响应   → 立即抛出（消息被拒）
   */
  async promptSession(sessionId, text) {
    const t = String(text || '').trim();
    if (!t) throw new Error('消息不能为空');
    try {
      const result = await this._rpc(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: t.slice(0, 4000) }] },
        8000
      );
      return result || { ok: true };
    } catch (e) {
      if (/超时/.test(String(e && e.message))) return { ok: true, pending: true };
      throw e;
    }
  }
}

module.exports = { discoverBackend, AcpClient, readPortFromLog };
module.exports.AGNES_DATA_DIR = AGNES_DATA_DIR;

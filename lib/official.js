'use strict';
/**
 * 官方数据客户端（只读）
 *
 * 【只读铁律】本模块仅实现对爱思办公数据的读取（任务列表 / 任务详情 / 进度 / 步骤），
 * 绝不实现任何写操作、登录注册、通知推送、多账号。
 *
 * 【数据源】
 *   通过 ACP 协议（JSON-RPC over WSS）读取爱思办公本地后端 agnesd 的会话列表与
 *   执行历史。发现与连接见 lib/acp.js：
 *   - 端口自动从爱思办公日志发现（应用重启会变化）
 *   - 密钥自动从 agnesd 进程内存读取，仅保存在电脑端内存，不下发手机端
 *   - 任务 = agnesd 会话（session）；步骤 = 会话内的工具调用（tool_call）
 *   - 实时活动：ACP 常驻连接收到的 session/update 通知
 *
 *   未检测到爱思办公进程时取不到任务数据，看板显示为空（绝不显示演示假数据）。
 *
 * 统一任务模型（docs/03-详细设计文档.md 4.1）：
 *   { id, title, status(running|done|failed), progress(0-100),
 *     createdAt(ISO), updatedAt(ISO), steps[{ name, status(done|running|failed), output }] }
 */

const path = require('path');

class OfficialError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ACP 工具调用状态 → 统一步骤状态
function mapStepStatus(s) {
  if (s === 'completed') return 'done';
  if (s === 'failed' || s === 'error' || s === 'aborted' || s === 'canceled') return 'failed';
  return 'running'; // pending / in_progress / 未知
}

function deriveTaskStatus(steps) {
  // V3：只看「最新结果」——历史中途失败但已恢复推进的不算异常（旧行为任一步失败即永久失败，严重失真）
  if (steps.some((s) => s.status === 'running')) return 'running';
  if (steps.length && steps[steps.length - 1].status === 'failed') return 'failed';
  return 'done';
}

function calcProgress(steps, status) {
  if (!steps.length) return status === 'done' ? 100 : 0;
  const done = steps.filter((s) => s.status === 'done').length;
  const pct = Math.round((done / steps.length) * 100);
  return status === 'done' ? 100 : Math.min(99, pct);
}

class OfficialClient {
  constructor(cfg) {
    this.cfg = cfg;
    this.mode = 'acp'; // 恒为 ACP 真实数据（mock 演示机制已移除：取不到数据时看板为空，绝不显示假数据）

    // ── ACP 真实数据状态 ──
    this.acp = null;
    this._acpInfo = null;        // { pid, port, source }
    this._acpError = null;
    this._sessions = new Map();  // sessionId -> 会话摘要（列表级）
    this._details = new Map();   // sessionId -> 对话流聚合（见 _onAcpUpdate）
    this._activity = new Map();  // sessionId -> 最近一次「非重放」通知时间戳
    this._lastListAt = 0;
    this._refreshing = false;
    this._loadAt = new Map();    // sessionId -> 上次 loadSession 时间（防抖）
    this._onChange = null;       // (sessionId) => void，实时通知回调
  }

  /** 数据源标识（供 health / 启动横幅展示） */
  describe() {
    if (!this._acpInfo) return `真实数据（ACP 未连接${this._acpError ? '：' + this._acpError : ''}）`;
    return `真实数据（爱思办公 agnesd 127.0.0.1:${this._acpInfo.port}，自动发现）`;
  }

  /** bridge 启动时调用：发现并连接 ACP。失败不抛出（轮询期 15 秒节流自动重试）。 */
  async init(log) {
    this._log = log;
    const { discoverBackend, AcpClient } = require('./acp');
    const info = await discoverBackend(this.cfg);
    if (info.error) {
      this._acpError = info.error;
      log('warn', '[ACP] ' + info.error);
      return;
    }
    this._acpInfo = { pid: info.pid, port: info.port, source: info.source };
    this.acp = new AcpClient(
      { port: info.port, secret: info.secret, rediscover: () => discoverBackend(this.cfg) },
      (sid, update, isReplay) => this._onAcpUpdate(sid, update, isReplay),
      (level, msg) => log(level, '[ACP] ' + msg)
    );
    await this.acp.connect();
    this._acpError = null;
    await this._refreshSessions();
    log('info', `[ACP] 就绪：${this._sessions.size} 个会话（pid=${info.pid} port=${info.port} 来源=${info.source}）`);
  }

  /** ACP 未就绪时自动重试发现/连接（15 秒节流；爱思办公随后启动时自动补连，无需重启桥接） */
  async _ensureAcp() {
    if (this.acp || this._reiniting) return;
    const now = Date.now();
    if (now - (this._lastReinitAt || 0) < 15000) return;
    this._lastReinitAt = now;
    this._reiniting = true;
    try {
      await this.init(this._log);
    } catch (_) { /* 保持未连接状态，下一轮再试 */ }
    finally { this._reiniting = false; }
  }

  /** 注册实时变化回调（手机端在看的任务有活动时即时推送）。 */
  setOnChange(fn) { this._onChange = fn || null; }

  // ────────────────────────── 对外接口 ──────────────────────────

  /** 任务列表（只读）。返回 Task[]，由桥接层负责排序与变化推送。 */
  async getTasks() {
    if (!this.acp) await this._ensureAcp();
    return this._acpList();
  }

  /** 任务详情（只读），含步骤。未找到返回 null。 */
  async getTask(id) {
    if (!this.acp) await this._ensureAcp();
    return this._acpDetail(String(id));
  }

  /**
   * V2：向任务（会话）发送用户消息。仅当 cfg.messages.enabled 为 true 时允许。
   * 转发 session/prompt，AI 的回复会经 session/update 通知流实时回来并自动推送到手机端。
   */
  async sendMessage(id, text) {
    const t = String(text || '').trim();
    if (!t) throw new OfficialError('BAD_REQUEST', '消息不能为空');
    if (!this.cfg.messages || this.cfg.messages.enabled === false) {
      throw new OfficialError('FORBIDDEN', '发消息功能已在配置中关闭（messages.enabled=false）');
    }
    if (!this.acp) await this._ensureAcp();
    this._assertReady();
    const s = this._sessions.get(String(id));
    if (!s) return { ok: false, error: '任务不存在' };
    const result = await this.acp.promptSession(String(id), t);
    // 发送成功后立即刷新活动状态，手机端 UI 即时反馈
    this._activity.set(String(id), Date.now());
    return { ok: true, result };
  }

  // ────────────────────────── ACP 真实数据实现 ──────────────────────────

  _assertReady() {
    if (!this.acp || !this.acp.ready) {
      throw new OfficialError('ACP_UNAVAILABLE', this._acpError || '爱思办公本地后端未连接');
    }
  }

  /** 刷新会话列表（带 2 秒节流与并发锁；失败抛 OfficialError）。 */
  async _refreshSessions() {
    const list = await this.acp.listSessions();
    const seen = new Set();
    for (const s of list) {
      const meta = s._meta || {};
      if (meta.isTemporary) continue; // 临时会话不是用户任务
      seen.add(s.sessionId);
      this._sessions.set(s.sessionId, {
        id: s.sessionId,
        title: (s.title || '').trim() || path.basename(String(s.cwd || '')) || '未命名任务',
        createdAt: meta.createdAt || s.updatedAt || new Date().toISOString(),
        updatedAt: meta.lastMessageAt || s.updatedAt || meta.createdAt || new Date().toISOString(),
        messageCount: meta.messageCount || 0,
        cwd: s.cwd || ''
      });
    }
    for (const id of [...this._sessions.keys()]) if (!seen.has(id)) this._sessions.delete(id);
    this._lastListAt = Date.now();
  }

  async _ensureFreshList() {
    this._assertReady();
    if (this._refreshing || Date.now() - this._lastListAt < 2000) return;
    this._refreshing = true;
    try { await this._refreshSessions(); }
    finally { this._refreshing = false; }
  }

  async _acpList() {
    await this._ensureFreshList();
    const out = [];
    for (const s of this._sessions.values()) {
      const d = this._details.get(s.id);
      let steps = [];
      if (d && d.steps.size) {
        steps = [...d.steps.values()].map((st) => ({ name: st.name, status: st.status, output: st.output }));
      }
      const active = (this._activity.get(s.id) || 0) > Date.now() - 90 * 1000;
      // 已加载过详情且确无工具步骤的纯对话任务 → 待确认（阻塞）；
      // 从未加载过详情的历史会话（桥接刚启动）信息不足，中性记为执行完成，打开详情后自动精确化
      const status = steps.length ? deriveTaskStatus(steps)
        : (active ? 'running' : (d ? 'waiting' : 'done'));
      out.push({
        id: s.id,
        title: s.title,
        status,
        progress: calcProgress(steps, status),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        cwd: s.cwd || '',      // 工作目录：前端按此两级分组（与电脑端「文件夹→任务」一致）
        steps
      });
    }
    return out;
  }

  async _acpDetail(id) {
    this._assertReady();
    const s = this._sessions.get(id);
    if (!s) return null;

    // 详情获取：session/load 重放聚合；2 秒防抖（手机端轮询详情页时天然节流）
    const last = this._loadAt.get(id) || 0;
    if (Date.now() - last > 2000) {
      this._loadAt.set(id, Date.now());
      this._details.delete(id); // load 是全量重放，清空后重新聚合避免重复拼接
      try {
        await this.acp.loadSession(id, s.cwd);
      } catch (e) {
        // load 失败降级：返回列表级信息（无对话），服务不 500
        if (!this._details.has(id)) {
          return {
            id: s.id, title: s.title, status: 'running', progress: 0,
            createdAt: s.createdAt, updatedAt: s.updatedAt, cwd: s.cwd || '',
            messages: [], steps: [], instruction: ''
          };
        }
      }
    }

    const d = this._details.get(id);
    if (d && d.pending.size) {
      // 兜底：仍有挂起工具（消息 id 未匹配到 AI 回合）→ 强制挂到最后一条 AI 消息，避免丢失
      let last = null;
      for (const m of d.msgs) if (m.role === 'agent') last = m;
      if (last) this._flushPendingTools(d, last, true);
    }
    const steps = d ? [...d.steps.values()].map((st) => ({ name: st.name, status: st.status, output: st.output })) : [];
    const messages = d ? d.msgs
      .filter((m) => (m.role === 'user' ? m.text.trim() : m.text.trim() || m.tools.length)) // 过滤空白消息
      .map((m) => ({
        role: m.role,
        text: m.text,
        time: m.time,
        model: m.model || undefined,
        tools: m.tools.length ? m.tools : undefined
      })) : [];
    const status = steps.length ? deriveTaskStatus(steps)
      : ((this._activity.get(id) || 0) > Date.now() - 90 * 1000 ? 'running' : 'waiting');
    const firstUser = messages.find((m) => m.role === 'user');
    return {
      id: s.id,
      title: s.title,
      status,
      progress: calcProgress(steps, status),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      cwd: s.cwd || '',     // 工作目录：告警/汇总邮件的三级定位（渠道→目录→任务）需要
      instruction: firstUser ? firstUser.text.slice(0, 200) : '',
      messages, // 对话流（与电脑端一致）：[{role:'user'|'agent', text, time, model?, tools?}]
      steps     // 兼容保留：工具调用流水（供 WebSocket step_update 与旧视图）
    };
  }

  /**
   * ACP 通知聚合（对话流）：
   * - user_message_chunk / agent_message_chunk → 按 messageId 聚合为对话消息
   * - tool_call / tool_call_update → 工具调用，归属到所属 AI 消息（_meta.agnes.messageId）
   */
  _onAcpUpdate(sessionId, update, isReplay) {
    if (!isReplay) {
      this._activity.set(sessionId, Date.now());
      if (this._onChange) { try { this._onChange(sessionId); } catch (_) {} }
    }
    let d = this._details.get(sessionId);
    if (!d) {
      d = { msgs: [], steps: new Map(), pending: new Map(), toolRefs: new Map(), lastModel: '' };
      this._details.set(sessionId, d);
    }

    const u = update.sessionUpdate;
    const meta = update._meta && update._meta.agnes ? update._meta.agnes : {};
    const created = meta.created ? new Date(meta.created).toISOString() : null;
    if (meta.modelId) d.lastModel = String(meta.modelId);

    if (u === 'user_message_chunk' || u === 'agent_message_chunk') {
      const role = u === 'user_message_chunk' ? 'user' : 'agent';
      const text = update.content && update.content.type === 'text' ? update.content.text : '';
      if (!text) return;
      const limit = role === 'user' ? 2000 : 20000;
      let m = d.msgs.length ? d.msgs[d.msgs.length - 1] : null;
      if (role === 'user') {
        // 用户消息：同一条消息的分片共享 messageId；messageId 变化 → 新一条用户消息
        if (!m || m.role !== 'user' || m.msgId !== update.messageId) {
          m = { msgId: update.messageId, role, text: '', time: created, model: '', tools: [] };
          d.msgs.push(m);
        }
        if (m.text.length < limit) m.text += text;
      } else {
        // AI 回复：回合制——连续 agent chunk 合并为一条回复（messageId 分片不稳定，不作分组依据）
        if (m && m.role === 'agent') {
          if (m.text.length < limit) m.text += text;
        } else {
          if (!text.trim()) return; // 回合开头的空白分片不新开消息
          m = { msgId: update.messageId, role: 'agent', text: '', time: created, model: '', tools: [] };
          d.msgs.push(m);
          this._flushPendingTools(d, m); // 挂起工具中属于本回合（按消息 id 匹配）的转正
          if (m.text.length < limit) m.text += text;
        }
      }
      if (!m.time && created) m.time = created;
      if (role === 'agent' && !m.model && meta.modelId) m.model = String(meta.modelId);
    } else if (u === 'tool_call') {
      const st = d.steps.get(update.toolCallId) || { name: '', status: 'running', output: '' };
      st.name = String(update.title || st.name || '工具调用').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (update.status) st.status = mapStepStatus(update.status);
      d.steps.set(update.toolCallId, st);
      this._attachTool(d, update.toolCallId, { name: st.name, status: st.status, output: '' }, meta.messageId);
    } else if (u === 'tool_call_update') {
      const st = d.steps.get(update.toolCallId) || { name: '工具调用', status: 'running', output: '' };
      if (update.status) st.status = mapStepStatus(update.status);
      if (Array.isArray(update.content)) {
        const text = update.content
          .map((c) => (c && c.content && c.content.type === 'text' ? c.content.text : ''))
          .filter(Boolean).join(' ');
        if (text) st.output = text.replace(/\r/g, '').slice(0, 500);
      }
      d.steps.set(update.toolCallId, st);
      const ref = d.toolRefs.get(update.toolCallId);
      if (ref) { ref.status = st.status; ref.output = st.output; }
    }
    // agent_thought_chunk：思考内容，电脑端折叠展示，手机端不单独呈现
  }

  /**
   * 把工具调用归属到 AI 回合：
   * 1) 携带消息 id 且已有匹配的 AI 消息 → 直接挂；2) 无消息 id → 挂最后一条 AI 消息；
   * 3) 都不行 → 挂起（带消息 id），等新 AI 回合转正。
   */
  _attachTool(d, toolCallId, tool, mid) {
    let m = null;
    if (mid) {
      for (let i = d.msgs.length - 1; i >= 0; i--) {
        if (d.msgs[i].role === 'agent' && d.msgs[i].msgId === mid) { m = d.msgs[i]; break; }
      }
    }
    if (!m) {
      for (let i = d.msgs.length - 1; i >= 0; i--) {
        if (d.msgs[i].role === 'agent') { m = d.msgs[i]; break; }
      }
    }
    if (m) {
      m.tools.push(tool);
      d.toolRefs.set(toolCallId, tool);
    } else {
      d.pending.set(toolCallId, { mid: mid || '', tool });
      d.toolRefs.set(toolCallId, tool); // 状态更新照常同步到引用对象
    }
  }

  /** 新 AI 回合开始：把挂起工具中「消息 id 匹配」或「无消息 id」的转正到该回合。force=true 时全部转正。 */
  _flushPendingTools(d, m, force) {
    if (!d.pending.size) return;
    for (const [tcId, p] of d.pending) {
      if (force || !p.mid || p.mid === m.msgId) {
        m.tools.push(p.tool);
        d.pending.delete(tcId);
      }
    }
  }

}

module.exports = OfficialClient;
module.exports.OfficialError = OfficialError;

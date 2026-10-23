'use strict';
/**
 * V4 多渠道任务告警模块（预警与告警）
 *
 * 组成：
 *  - 手机端看板为每个任务提供「邮件追踪」铃铛（localStorage 持久化），
 *    并把追踪清单同步到服务端（本模块保存副本到 config.json，桥接重启不丢）
 *  - V4：watchlist 为二元组 [{channel, taskId}]（旧格式纯 id 读取时归一成 agnes），
 *    每个渠道独立的汇总/报警开关与报警前缀（cfg.channels[ch]，agnes 回退 cfg.alerts）
 *  - V4.1：汇总间隔与汇总标题全渠道统一（cfg.alerts）；定时统计：所有启用「任务汇总」
 *    的渠道合并为一封邮件（每渠道一节，像看板 Tab 分节），统一按全局间隔发送；
 *    渠道指纹基线仍相互独立
 *  - 阻塞告警：被追踪任务「异常」或「待确认」时立即发单任务告警邮件
 *    （渠道开关开 + 任务已追踪 = 策略生效）；同一阻塞态不重复轰炸，恢复后重置
 *
 * 状态四态（只看「最新一轮交互的结果」，历史中途失败已恢复的不算）：
 *   正在执行 running / 执行完成 ended / 异常 failed / 待确认 waiting；后两者为阻塞态。
 */
const CH = require('./channels');
const path = require('path');
const CHECK_INTERVAL_MS = 60 * 1000; // 阻塞检测节奏（固定 60 秒，不受统计间隔影响）

const STATE_LABEL = { failed: '异常', running: '正在执行', ended: '执行完成', waiting: '待确认' };
const BLOCKING = new Set(['failed', 'waiting']);

function fmtNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class AlertManager {
  /**
   * @param {object} deps
   *   cfg        全局配置（带 save）
   *   adapters   V4 适配器注册表（lib/adapters）；classify 按渠道取 adapter
   *   official   （兼容保留）agnes OfficialClient，adapters 缺失时兜底
   *   getMailer  () => MailNotifier（桥接会热重建，必须走 getter 拿最新实例）
   *   getBaseUrl () => string 看板访问地址（告警邮件里的「打开看板」按钮）
   *   log        (level, msg) => void
   */
  constructor(deps) {
    this.cfg = deps.cfg;
    this.adapters = deps.adapters || null;
    this.official = deps.official;
    this.getMailer = deps.getMailer;
    this.getBaseUrl = deps.getBaseUrl || (() => '');
    this.log = deps.log || (() => {});
    // 二元组清单：内部存 {channel, taskId}（旧格式字符串自动归一成 agnes）
    this.entries = CH.normalizeWatchlist(
      Array.isArray(this.cfg.alerts && this.cfg.alerts.watchlist) ? this.cfg.alerts.watchlist : [],
      this._allowedChannels()
    );
    this._lastAlert = new Map();    // `${channel}:${taskId}` -> 上次已告警的阻塞态
    this._lastDigestSig = new Map(); // 同 key -> 上次汇总状态指纹（变化检测）
    this._digestTimers = new Map();  // V4.1：仅一个合并节拍定时器（key '*'）
    this._digestBeat = 0;            // 合并汇总节拍 = 各启用渠道间隔的最小值（分钟）
    this._checkTm = null;
    this._busy = false;
  }

  /** 当前已知渠道白名单（限制 watchlist 只接受已注册渠道；adapters 未就绪时至少放行 agnes）。 */
  _allowedChannels() {
    if (this.adapters && this.adapters.map) return [...this.adapters.map.keys()];
    return [CH.DEFAULT_CHANNEL];
  }

  _adapter(ch) {
    if (this.adapters) {
      const a = this.adapters.get(ch);
      if (a) return a;
    }
    return ch === CH.DEFAULT_CHANNEL ? this.official : null;
  }

  // ── agnes 渠道视角的开关（向后兼容：向导状态/远程配置/旧 API 仍读这些） ──

  /** 任务汇总总开关（agnes；实时读 config —— 向导/远程保存热生效） */
  get digestEnabled() { return CH.channelCfg(this.cfg, CH.DEFAULT_CHANNEL).digestEnabled; }

  /** 单任务报警总开关（agnes）；开 + 追踪标记 = 告警策略生效 */
  get alertEnabled() { return CH.channelCfg(this.cfg, CH.DEFAULT_CHANNEL).alertEnabled; }

  /**
   * 手机端追踪清单同步。两种形态：
   *   1) {watchlist:[...]} 全量覆盖（元素为 id 字符串或 {channel,taskId}）
   *   2) {channel:'workbuddy', watchlist:['id1',...]} 只覆盖该渠道条目（保留其他渠道）
   * 开关类配置（任务汇总/单任务报警）归向导管，这里不接收，避免手机端覆盖向导值。
   */
  sync(patch) {
    if (!patch || !Array.isArray(patch.watchlist)) return;
    const allowed = this._allowedChannels();
    let next;
    if (patch.channel) {
      const ch = String(patch.channel);
      if (!allowed.includes(ch)) {
        this.log('warn', `[告警] 追踪清单同步拒绝未知渠道：${ch}`);
        return;
      }
      // 只替换该渠道：其他渠道条目原样保留，本渠道用新 id 列表重建
      const keep = this.entries.filter((e) => e.channel !== ch);
      const fresh = patch.watchlist
        .map((id) => CH.normalizeEntry({ channel: ch, taskId: id }))
        .filter(Boolean)
        .slice(0, CH.PER_CHANNEL_LIMIT);
      next = CH.normalizeWatchlist([...keep, ...fresh], allowed);
    } else {
      next = CH.normalizeWatchlist(patch.watchlist, allowed);
    }
    this.entries = next;
    this.cfg.save({ alerts: { watchlist: next } }); // 深合并，不动开关字段
    const perCh = {};
    for (const e of next) perCh[e.channel] = (perCh[e.channel] || 0) + 1;
    this.log('info', `[告警] 追踪清单同步：${next.length} 个任务（${Object.entries(perCh).map(([k, v]) => `${k}=${v}`).join('，') || '空'}）`);
  }

  /** 当前追踪清单（二元组数组；服务端为唯一真源，供设备进看板时拉取对齐） */
  getWatchlist() {
    return this.entries.map((e) => ({ channel: e.channel, taskId: e.taskId }));
  }

  /** 某渠道的追踪 taskId 数组（单渠道前端/定时器用） */
  getWatchlistFor(ch) {
    return CH.idsForChannel(this.entries, ch);
  }

  /** 配置热应用（向导/远程修改渠道开关或间隔后，按各渠道重建汇总定时器） */
  applyConfig() {
    this._startDigestAll();
  }

  start() {
    this._startCheck();
    this._startDigestAll();
    this.log('info', `[告警] 已启动：阻塞检测每 60 秒；${this._digestDesc()}`);
  }

  stop() {
    if (this._checkTm) clearInterval(this._checkTm);
    for (const t of this._digestTimers.values()) clearInterval(t);
    this._digestTimers.clear();
    this._checkTm = null;
  }

  /** 全局汇总间隔（分钟；V4.1 起全渠道统一，实时读 config 热生效）。 */
  intervalMin() {
    return CH.digestInterval(this.cfg);
  }

  /** 多渠道状态（旧字段保留为 agnes 视角，新增 channels 明细与 watchlistV2）。 */
  status() {
    const ac = CH.channelCfg(this.cfg, CH.DEFAULT_CHANNEL);
    const channels = {};
    for (const ch of this._allowedChannels()) {
      const c = CH.channelCfg(this.cfg, ch);
      channels[ch] = {
        enabled: c.enabled,
        digestEnabled: c.digestEnabled,
        alertEnabled: c.alertEnabled,
        alertPrefix: CH.alertPrefixFor(this.cfg, ch, this.adapters),
        watchCount: CH.idsForChannel(this.entries, ch).length
      };
    }
    return {
      digestIntervalMinutes: CH.digestInterval(this.cfg),
      digestTitle: CH.digestTitleFor(this.cfg),
      watchCount: this.entries.length,
      digestEnabled: ac.digestEnabled,
      alertEnabled: ac.alertEnabled,
      channels,
      watchlist: this.getWatchlist()
    };
  }

  _digestDesc() {
    const ons = this._allowedChannels()
      .filter((ch) => { const c = CH.channelCfg(this.cfg, ch); return c.enabled && c.digestEnabled; })
      .map((ch) => CH.displayNameOf(ch, this.adapters));
    if (!ons.length) return '定时统计：所有渠道均关闭（开关在配置向导）';
    return `定时统计：${ons.join('、')} 每 ${this._digestBeat} 分钟合并一封（间隔/开关在配置向导）`;
  }

  _startCheck() {
    if (this._checkTm) clearInterval(this._checkTm);
    this._checkTm = setInterval(() => { this.checkBlocking().catch(() => {}); }, CHECK_INTERVAL_MS);
    if (this._checkTm.unref) this._checkTm.unref();
  }

  /** V4.1 汇总节拍：所有启用汇总的渠道合并为一封邮件，统一按全局间隔发送（先清旧）。 */
  _startDigestAll() {
    for (const t of this._digestTimers.values()) clearInterval(t);
    this._digestTimers.clear();
    const ons = this._allowedChannels().filter((ch) => {
      const c = CH.channelCfg(this.cfg, ch);
      return c.enabled && c.digestEnabled;
    });
    if (!ons.length) { this._digestBeat = 0; return; }
    this._digestBeat = CH.digestInterval(this.cfg); // V4.1：全渠道统一间隔，不再取各渠道最小值
    const tm = setInterval(() => { this.sendDigestAll().catch(() => {}); }, this._digestBeat * 60 * 1000);
    if (tm.unref) tm.unref();
    this._digestTimers.set('*', tm);
  }

  /**
   * 单个被追踪任务的状态分类（四态；getTask 为只读，失败抛给调用方处理）。
   * @param {string} channel 渠道短名（兼容旧调用：只传 id 时按 agnes）
   * @param {string} [id]
   */
  async classify(channel, id) {
    let ch = channel;
    let taskId = id;
    if (id === undefined) { ch = CH.DEFAULT_CHANNEL; taskId = channel; } // 旧签名 classify(id)
    const adapter = this._adapter(ch);
    if (!adapter) return null;
    const t = await adapter.getTask(String(taskId));
    if (!t) return null;
    const steps = Array.isArray(t.steps) ? t.steps : [];
    if (t.status === 'running' || steps.some((s) => s.status === 'running')) {
      return { task: t, key: 'running', label: STATE_LABEL.running };
    }
    // 以「最新一轮交互结果」为准：看最新一条消息（适配器已过滤空白消息）
    const ms = Array.isArray(t.messages) ? t.messages : [];
    const last = ms[ms.length - 1];
    if (last) {
      if (last.role === 'agent' || last.role === 'assistant') {
        // AI 最新回复：本轮最后一个工具调用失败 = 异常；最后成功或纯文本结论 = 执行完成。
        // agnes 的工具挂在消息 tools 上；WorkBuddy 等文件型渠道工具在独立 steps 数组。
        const tools = Array.isArray(last.tools) ? last.tools : [];
        const toolTailFailed = tools.length
          ? tools[tools.length - 1].status === 'failed'
          : (steps.length > 0 && steps[steps.length - 1].status === 'failed');
        if (toolTailFailed) return { task: t, key: 'failed', label: STATE_LABEL.failed };
        return { task: t, key: 'ended', label: STATE_LABEL.ended };
      }
      // 最新消息是用户发的而 AI 没有再回复且不在跑 → 阻塞等处理
      return { task: t, key: 'waiting', label: STATE_LABEL.waiting };
    }
    // 无对话消息：按工具流水尾部判定
    if (steps.length > 0 && steps[steps.length - 1].status === 'failed') {
      return { task: t, key: 'failed', label: STATE_LABEL.failed };
    }
    if (steps.length > 0 && steps[steps.length - 1].status === 'done') {
      return { task: t, key: 'ended', label: STATE_LABEL.ended };
    }
    return { task: t, key: 'waiting', label: STATE_LABEL.waiting };
  }

  /** 任务目录显示名（三级定位中间级：渠道→目录→任务；group 优先，回退 basename(cwd)） */
  _dirOf(t) {
    if (!t) return '';
    if (t.group) return String(t.group);
    const cwd = String(t.cwd || '');
    return cwd ? path.basename(cwd) : '';
  }

  /** 最新反馈消息摘要（AI/用户 + 截断文本；表格与告警邮件共用） */
  _latestMsg(t) {
    const ms = (t && t.messages) || [];
    for (let i = ms.length - 1; i >= 0; i--) {
      const m = ms[i];
      const text = String(m.text || '').replace(/\s+/g, ' ').trim();
      if (text) return { role: m.role === 'user' ? '用户' : 'AI', text: text.slice(0, 120) };
    }
    const step = (t.steps || []).find((s) => s.output);
    return step ? { role: 'AI', text: String(step.output).replace(/\s+/g, ' ').slice(0, 120) } : { role: '', text: '（暂无消息）' };
  }

  /** 阻塞检测（每 60 秒一轮，遍历所有渠道）：进入阻塞态且与上次不同 → 立即发单任务告警邮件 */
  async checkBlocking() {
    if (this._busy || !this.entries.length) return;
    const mailer = this.getMailer();
    if (!mailer || !mailer.configured) return;
    this._busy = true;
    try {
      for (const e of this.entries) {
        const cc = CH.channelCfg(this.cfg, e.channel);
        if (!cc.enabled || !cc.alertEnabled) continue; // 该渠道报警开关关 → 跳过
        // V4.1：所有渠道的告警邮件都标注来源渠道（用户可分辨任务来自哪个看板 Tab）
        const source = CH.displayNameOf(e.channel, this.adapters);
        let r;
        try { r = await this.classify(e.channel, e.taskId); } catch (_) { continue; } // 数据源瞬断，下轮再试
        const key = CH.entryKey(e);
        if (!r) { this._lastAlert.delete(key); continue; }                       // 任务不存在了
        const prev = this._lastAlert.get(key);
        if (BLOCKING.has(r.key)) {
          if (prev !== r.key) {
            const ok = await mailer.sendAlert({
              taskTitle: r.task.title, state: r.label,
              dir: this._dirOf(r.task),
              alertPrefix: CH.alertPrefixFor(this.cfg, e.channel, this.adapters),
              source, msg: this._latestMsg(r.task), sendTime: fmtNow(), url: this.getBaseUrl()
            });
            if (ok) {
              this._lastAlert.set(key, r.key);
              this.log('info', `[告警] [${source}${this._dirOf(r.task) ? '/' + this._dirOf(r.task) : ''}] 「${r.task.title}」${r.label}，已发告警邮件`);
            }
          }
        } else if (prev) {
          this._lastAlert.delete(key); // 恢复 → 重置，之后再次阻塞会重新告警
        }
      }
    } finally { this._busy = false; }
  }

  /** V4.1 合并定时统计：收集所有启用汇总渠道的分节内容，合到一封邮件发送。 */
  async sendDigestAll() {
    const mailer = this.getMailer();
    if (!mailer || !mailer.configured) return false;
    const sections = [];
    for (const ch of this._allowedChannels()) {
      const c = CH.channelCfg(this.cfg, ch);
      if (!c.enabled || !c.digestEnabled) continue;
      const ids = CH.idsForChannel(this.entries, ch);
      if (!ids.length) continue; // 该渠道没有追踪任务：不出节
      sections.push(await this._digestSection(ch, ids));
    }
    if (!sections.length) return false;
    const ok = await mailer.sendDigest({
      sections,
      intervalMin: this._digestBeat || 60,
      digestTitle: CH.digestTitleFor(this.cfg),
      sendTime: fmtNow(), url: this.getBaseUrl()
    });
    if (ok) {
      const parts = sections.map((s) => s.down
        ? `${s.displayName}（数据源异常）`
        : `${s.displayName} ${s.rows.length ? s.rows.length + ' 个有变化' : '均无变化'}`);
      this.log('info', `[告警] 合并定时统计已发送（${parts.join('；')}）`);
    }
    return ok;
  }

  /** 单渠道汇总分节：收集有变化任务行、更新该渠道指纹基线；数据源全挂时返回 down 节（合并邮件内提示）。 */
  async _digestSection(ch, ids) {
    const displayName = CH.displayNameOf(ch, this.adapters);
    const rows = [];
    const newSig = new Map(); // 本轮成功查询任务的新指纹（仅本渠道 key）
    let okCount = 0;
    for (const id of ids) {
      try {
        const r = await this.classify(ch, id);
        if (!r) {
          // 任务消失：视为异常状态，每轮提示直到用户取消追踪或任务恢复
          rows.push({ title: String(id) + '（任务不存在）', dir: '', label: '—', msg: { role: '', text: '' }, updatedAt: '' });
          continue;
        }
        okCount++;
        // 变化检测：状态/更新时间/最新反馈 与上次汇总一致 → 本轮不列（避免每轮重复罗列不变的任务）
        const msg = this._latestMsg(r.task);
        const sig = `${r.label}|${r.task.updatedAt || ''}|${msg && msg.text ? String(msg.text).slice(0, 40) : ''}`;
        const key = `${ch}:${id}`;
        newSig.set(key, sig);
        if (this._lastDigestSig.get(key) === sig) continue; // 无变化，跳过
        rows.push({ title: r.task.title, dir: this._dirOf(r.task), label: r.label, msg, updatedAt: r.task.updatedAt });
      } catch (_) { /* 单任务失败不阻塞整封汇总 */ }
    }
    // 更新本渠道基线：先删本渠道旧 key，再写入本轮成功的（其他渠道基线不受影响）
    for (const k of [...this._lastDigestSig.keys()]) if (k.startsWith(ch + ':')) this._lastDigestSig.delete(k);
    for (const [k, v] of newSig) this._lastDigestSig.set(k, v);
    if (!okCount) {
      // 全部查询失败（数据源故障）：不再单独发异常邮件，本节在合并邮件内提示
      this.log('warn', `[告警] [${displayName}] 本轮汇总全部任务查询失败（合并邮件内提示数据源异常）`);
      return { displayName, rows: [], total: ids.length, unchanged: 0, down: true };
    }
    return { displayName, rows, total: ids.length, unchanged: ids.length - rows.length };
  }
}

module.exports = AlertManager;
module.exports.STATE_LABEL = STATE_LABEL;
module.exports.BLOCKING = BLOCKING;

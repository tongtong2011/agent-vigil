'use strict';
/**
 * V3 任务告警模块（预警与告警）
 *
 * 组成：
 *  - 手机端看板为每个任务提供「邮件追踪」开关（localStorage 持久化，刷新/重开保持），
 *    并把追踪清单同步到服务端（本模块保存副本到 config.json，桥接重启不丢）
 *  - 定时统计：每 digestIntervalMinutes 分钟把被追踪任务的 名称/状态/最新反馈消息
 *    汇总成一封表格邮件（「任务汇总」总开关，配置向导第 4 步控制）
 *  - 阻塞告警：被追踪任务「出现异常」或「待用户确认」（任务阻塞）时立即发单任务告警
 *    邮件（「单任务报警」总开关，配置向导第 4 步控制；总开关开 + 任务已追踪 = 策略生效）；
 *    同一阻塞态不重复轰炸，状态恢复后重置（再次阻塞会重新告警）
 *
 * 状态四态（V3 改版：只看「最新一轮交互的结果」，历史中途失败已恢复的不算）：
 *   正在执行   status=running（90 秒内有活动或存在运行中步骤）
 *   执行完成   最新一条 AI 回复的最后一个工具调用成功，或最新回复为纯文本结论
 *   异常       最新结果报错——最新 AI 回复的最后一个工具调用失败，或工具流水尾部失败
 *              （如模型超时；此前无论失败多少次，只要最新结果正常就是执行完成）
 *   待确认     最新消息是用户发的而 AI 未再回复（对话阻塞，等用户处理），
 *              或无任何步骤/消息的静默纯对话任务
 * 「异常」「待确认」视为阻塞态。
 */
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
   *   official   OfficialClient（getTask 只读）
   *   getMailer  () => MailNotifier（桥接会热重建，必须走 getter 拿最新实例）
   *   getBaseUrl () => string 看板访问地址（告警邮件里的「打开看板」按钮）
   *   log        (level, msg) => void
   */
  constructor(deps) {
    this.cfg = deps.cfg;
    this.official = deps.official;
    this.getMailer = deps.getMailer;
    this.getBaseUrl = deps.getBaseUrl || (() => '');
    this.log = deps.log || (() => {});
    this.watchlist = new Set(Array.isArray(this.cfg.alerts && this.cfg.alerts.watchlist) ? this.cfg.alerts.watchlist : []);
    this._lastAlert = new Map(); // taskId -> 上次已告警的阻塞态
    this._lastDigestSig = new Map(); // taskId -> 上次汇总时的状态指纹（变化检测：只汇总有变化的任务）
    this._checkTm = null;
    this._digestTm = null;
    this._busy = false;
  }

  /** 任务汇总总开关（向导配置，实时读 config —— 向导保存热生效） */
  get digestEnabled() {
    return !!(this.cfg.alerts && this.cfg.alerts.digestEnabled);
  }

  /** 单任务报警总开关（向导配置，实时读 config）；开 + 追踪标记 = 告警策略生效 */
  get alertEnabled() {
    return !!(this.cfg.alerts && this.cfg.alerts.alertEnabled);
  }

  /** 手机端追踪清单同步（全量覆盖；副本写 config.json，重启恢复）。
   *  开关类配置（任务汇总/单任务报警）归配置向导管，这里不接收，避免手机端覆盖向导值。 */
  sync(patch) {
    if (patch && Array.isArray(patch.watchlist)) {
      this.watchlist = new Set(patch.watchlist.map(String).filter(Boolean).slice(0, 50));
      this.cfg.save({ alerts: { watchlist: [...this.watchlist] } });   // 深合并，不动向导配置的开关字段
      this.log('info', `[告警] 追踪清单同步：${this.watchlist.size} 个任务`);
    }
  }

  /** 当前追踪清单（数组；供设备进看板时拉取对齐——服务端为唯一真源） */
  getWatchlist() {
    return [...this.watchlist];
  }

  /** 配置热应用（向导修改间隔后重建定时器；开关为实时读取，无需处理） */
  applyConfig() {
    this._startDigest();
  }

  start() {
    this._startCheck();
    this._startDigest();
    this.log('info', `[告警] 已启动：阻塞检测每 60 秒；定时统计每 ${this.intervalMin()} 分钟（开关在配置向导）`);
  }

  stop() {
    if (this._checkTm) clearInterval(this._checkTm);
    if (this._digestTm) clearInterval(this._digestTm);
    this._checkTm = this._digestTm = null;
  }

  intervalMin() {
    const n = Number(this.cfg.alerts && this.cfg.alerts.digestIntervalMinutes) || 60;
    return Math.min(240, Math.max(10, n));
  }

  status() {
    return {
      digestIntervalMinutes: this.intervalMin(),
      watchCount: this.watchlist.size,
      digestEnabled: this.digestEnabled,
      alertEnabled: this.alertEnabled
    };
  }

  _startCheck() {
    if (this._checkTm) clearInterval(this._checkTm);
    this._checkTm = setInterval(() => { this.checkBlocking().catch(() => {}); }, CHECK_INTERVAL_MS);
    if (this._checkTm.unref) this._checkTm.unref();
  }

  _startDigest() {
    if (this._digestTm) clearInterval(this._digestTm);
    this._digestTm = setInterval(() => { this.sendDigest().catch(() => {}); }, this.intervalMin() * 60 * 1000);
    if (this._digestTm.unref) this._digestTm.unref();
  }

  /** 单个被追踪任务的状态分类（四态；getTask 为只读，失败抛给调用方处理） */
  async classify(id) {
    const t = await this.official.getTask(String(id));
    if (!t) return null;
    const steps = Array.isArray(t.steps) ? t.steps : [];
    if (t.status === 'running' || steps.some((s) => s.status === 'running')) {
      return { task: t, key: 'running', label: STATE_LABEL.running };
    }
    // 以「最新一轮交互结果」为准：看最新一条消息（getTask 已过滤空白消息）
    const ms = Array.isArray(t.messages) ? t.messages : [];
    const last = ms[ms.length - 1];
    if (last) {
      if (last.role === 'agent') {
        // AI 最新回复：本轮最后一个工具调用失败 = 异常（如模型超时报错）；
        // 最后一个成功或纯文本结论 = 执行完成（中途失败过但重试恢复的也算）
        const tools = Array.isArray(last.tools) ? last.tools : [];
        if (tools.length && tools[tools.length - 1].status === 'failed') {
          return { task: t, key: 'failed', label: STATE_LABEL.failed };
        }
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

  /** 阻塞检测（每 60 秒一轮）：进入阻塞态且与上次不同 → 立即发单任务告警邮件 */
  async checkBlocking() {
    if (this._busy || !this.alertEnabled || !this.watchlist.size) return;
    const mailer = this.getMailer();
    if (!mailer || !mailer.configured) return;
    this._busy = true;
    try {
      for (const id of [...this.watchlist]) {
        let r;
        try { r = await this.classify(id); } catch (_) { continue; } // ACP 瞬断等，下轮再试
        if (!r) { this._lastAlert.delete(id); continue; }            // 任务不存在了
        const prev = this._lastAlert.get(id);
        if (BLOCKING.has(r.key)) {
          if (prev !== r.key) {
            const ok = await mailer.sendAlert({
              taskTitle: r.task.title, state: r.label, alertPrefix: this._alertPrefix(),
              msg: this._latestMsg(r.task), sendTime: fmtNow(), url: this.getBaseUrl()
            });
            if (ok) {
              this._lastAlert.set(id, r.key);
              this.log('info', `[告警] 「${r.task.title}」${r.label}，已发告警邮件`);
            }
          }
        } else if (prev) {
          this._lastAlert.delete(id); // 恢复 → 重置，之后再次阻塞会重新告警
        }
      }
    } finally { this._busy = false; }
  }

  /** 定时统计邮件：被追踪任务汇总表（任务名/状态/最新消息/最近更新时间） */
  async sendDigest() {
    if (!this.digestEnabled || !this.watchlist.size) return false;
    const mailer = this.getMailer();
    if (!mailer || !mailer.configured) return false;
    const rows = [];
    const sigMap = new Map(); // 本轮成功查询任务的新指纹
    let okCount = 0;
    for (const id of [...this.watchlist]) {
      try {
        const r = await this.classify(id);
        if (!r) {
          // 任务消失：视为异常状态，每轮提示直到用户取消追踪或任务恢复
          rows.push({ title: String(id) + '（任务不存在）', label: '—', msg: { role: '', text: '' }, updatedAt: '' });
          continue;
        }
        okCount++;
        // 变化检测：状态/更新时间/最新反馈 与上次汇总一致 → 本轮不列（避免每轮重复罗列不变的任务）
        const msg = this._latestMsg(r.task);
        const sig = `${r.label}|${r.task.updatedAt || ''}|${msg && msg.text ? String(msg.text).slice(0, 40) : ''}`;
        sigMap.set(String(id), sig);
        if (this._lastDigestSig.get(String(id)) === sig) continue; // 无变化，跳过
        rows.push({ title: r.task.title, label: r.label, msg, updatedAt: r.task.updatedAt });
      } catch (_) { /* 单任务失败不阻塞整封汇总 */ }
    }
    this._lastDigestSig = sigMap; // 更新基线（仅含本轮查询成功的任务；失败的下轮重试比对）
    // 全部查询失败（环境故障如 ACP 断开/积分耗尽截断）：不发空统计，改发一封异常说明邮件
    // （每次故障只发一封，持续挂起不重复轰炸；恢复后再次故障会重新发）
    if (!okCount) {
      if (!this._acpDownNotified) {
        this._acpDownNotified = true;
        const ok = await mailer.sendAcpDown({ sendTime: fmtNow(), url: this.getBaseUrl() });
        if (ok) this.log('warn', '[告警] ACP 后端不可用（无法获取任何任务状态），已发送异常说明邮件');
        return ok;
      }
      this.log('warn', '[告警] 本轮汇总所有任务详情查询均失败（ACP 后端未连接；异常邮件已发过，不重复发送）');
      return false;
    }
    this._acpDownNotified = false; // 查询恢复，重置异常通知标记（下次故障再发）
    const allUnchanged = rows.length === 0; // 到这里的任务都查询成功：0 行 = 全部无变化
    const ok = await mailer.sendDigest({
      rows, intervalMin: this.intervalMin(), digestTitle: this._digestTitle(),
      sendTime: fmtNow(), url: this.getBaseUrl(),
      total: this.watchlist.size, unchanged: allUnchanged ? okCount : this.watchlist.size - rows.length
    });
    if (ok) {
      this.log('info', allUnchanged
        ? `[告警] 定时统计已发送（${this.watchlist.size} 个被追踪任务均无变化）`
        : `[告警] 定时统计已发送（${rows.length} 个有变化 / 共 ${this.watchlist.size} 个被追踪任务）`);
    }
    return ok;
  }

  /** 任务汇总邮件标题（向导可配，留空用默认） */
  _digestTitle() {
    return (this.cfg.alerts && String(this.cfg.alerts.digestTitle || '').trim()) || '任务汇总邮件';
  }

  /** 单任务报警邮件标题公共前缀（向导可配，留空用默认）；标题 = 前缀 + 任务名 */
  _alertPrefix() {
    return (this.cfg.alerts && String(this.cfg.alerts.alertPrefix || '').trim()) || '单任务报警-';
  }
}

module.exports = AlertManager;
module.exports.STATE_LABEL = STATE_LABEL;
module.exports.BLOCKING = BLOCKING;

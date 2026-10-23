'use strict';
/**
 * V4 AgentAdapter 公共接口约定（lib/adapters/base.js）
 *
 * 【设计目标】一个桥接服务盯多个 AI Agent：每个渠道一个适配器，实现相同接口，
 * 把各自渠道的原始数据翻译成「统一任务格式」（V4多渠道接入需求与设计文档.md 2.2）。
 * 上游 alerts.js / mailer.js / 前端只认统一格式，不认原始数据长什么样。
 *
 * 【统一任务格式】（所有适配器必须输出）
 *   {
 *     id,                 // 渠道内唯一任务标识
 *     title,              // 任务标题
 *     status,             // 'running' | 'done' | 'failed' | 'waiting' 四态
 *     progress,           // 0-100（列表摘要用）
 *     createdAt, updatedAt, // ISO 时间
 *     cwd,                // 工作目录（前端「文件夹→任务」两级分组）
 *     group,              // 渠道内分组显示名（如工作目录显示名）
 *     steps:  [{ name, status: done|running|failed, output, createdAt }],
 *     messages:[{ role: 'user'|'agent', text, createdAt }]
 *   }
 *
 * 【四态判定】（与 alerts.js 语义一致，判定优先级 running > failed > waiting > done）
 *   running  正在执行   Agent 活跃（90 秒内有活动）或存在运行中的步骤
 *   failed   出现异常   最新一轮的工具调用以失败收尾（尾部失败，中途失败已恢复不算）
 *   waiting  待用户确认 最后一条是用户消息（AI 尚未响应）
 *   done     执行完成   最新一轮以成功工具调用或纯文本回复收尾
 *
 * 【只读铁律】适配器默认只读；sendMessage 是唯一例外，且须 cfg.messages.enabled 开启、
 * 由已配对设备令牌触发（上层把关），渠道本身不支持写操作时必须抛 UNSUPPORTED。
 */

class AdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class BaseAdapter {
  /** 渠道标识（短名，config.channels / watchlist 里用），如 "agnes" / "workbuddy" */
  get channel() { throw new AdapterError('NOT_IMPLEMENTED', '子类实现 channel'); }

  /** 展示名（前端 Tab 和邮件标题里用），如 "爱思办公" / "WorkBuddy" */
  get displayName() { throw new AdapterError('NOT_IMPLEMENTED', '子类实现 displayName'); }

  /** 是否支持远程发消息（只读渠道覆写为 false；前端据此切换详情页输入框为「复制指令」模式）。 */
  get canSend() { return true; }

  /** 发送方式提示（/health 透传前端；canSend=false 时前端用它 toast 引导「复制指令转交」）。 */
  get sendHint() { return ''; }

  /**
   * 初始化（连端口 / 扫描数据目录 / 建 watcher……）。失败可抛出，由注册表捕获降级。
   * @param {object} ctx { cfg, log }
   */
  async init(ctx) { void ctx; }

  /** 关闭连接/停止 watcher（进程退出时调）。 */
  async close() {}

  /** 健康检查（轮询用，返回 true/false）：渠道 Agent 是否在线可读。 */
  async health() { return false; }

  /** 数据源描述（health/启动横幅展示），如「真实数据（agnesd 127.0.0.1:50301）」。 */
  describe() { return `${this.displayName}（未初始化）`; }

  /** 任务列表（统一格式数组）。实现须自行容错，单任务解析失败不得影响整列表。 */
  async listTasks() { return []; }

  /** 单个任务详情（统一格式，含 steps/messages）。未找到返回 null。 */
  async getTask(id) { void id; return null; }

  /**
   * 向任务发送用户消息（唯一写方法）。渠道不支持时抛 AdapterError('UNSUPPORTED')。
   * @returns {Promise<{ok:boolean, pending?:boolean}>}
   */
  async sendMessage(id, text) { void id; void text; throw new AdapterError('UNSUPPORTED', `${this.displayName} 暂不支持远程发消息`); }

  /** 注册实时变化回调（任务有活动时回调 taskId，用于 WebSocket 即时推送）。 */
  setOnChange(fn) { this._onChange = fn || null; }

  /** 当前已知任务数（health 汇总展示用；未知返回 -1）。实现应廉价（读缓存）。 */
  taskCount() { return -1; }

  _emitChange(taskId) {
    if (this._onChange) { try { this._onChange(taskId); } catch (_) {} }
  }
}

// ────────────────────────── 公共工具（各适配器复用） ──────────────────────────

/** 工具调用状态 → 统一步骤状态（completed→done；failed/error/aborted/canceled→failed；其余→running） */
function mapStepStatus(s) {
  if (s === 'completed' || s === 'success' || s === 'done') return 'done';
  if (s === 'failed' || s === 'error' || s === 'aborted' || s === 'canceled') return 'failed';
  return 'running'; // pending / in_progress / 未知
}

/** 步骤流 → 四态（只看尾部：任一步 running 即 running；最后一步 failed 即 failed；否则 done） */
function deriveTaskStatus(steps) {
  if (steps.some((s) => s.status === 'running')) return 'running';
  if (steps.length && steps[steps.length - 1].status === 'failed') return 'failed';
  return 'done';
}

/** 进度估算（列表摘要用）：有步骤按完成占比，封顶 99%；终态直接给满。 */
function calcProgress(steps, status) {
  if (!steps.length) return status === 'done' ? 100 : 0;
  const done = steps.filter((s) => s.status === 'done').length;
  const pct = Math.round((done / steps.length) * 100);
  return status === 'done' ? 100 : Math.min(99, pct);
}

/** 毫秒时间戳 → ISO（非法值回退当前时间，保证统一格式字段恒为合法 ISO 串）。 */
function isoMs(ms) {
  const d = Number(ms);
  return d > 0 ? new Date(d).toISOString() : new Date().toISOString();
}

/** 剥离 WorkBuddy/Claude 系注入的 <system-reminder>…</system-reminder> 上下文块。 */
function stripSystemReminders(text) {
  return String(text || '')
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<system-reminder[^>]*>[\s\S]*$/g, '') // 未闭合的尾部块也剥掉
    .trim();
}

/**
 * 用户消息清洗（WorkBuddy 系注入两段包装）：
 *   <system-reminder data-role="user-context">…环境/身份上下文…</system-reminder>
 *   <user_query>用户真实输入</user_query>
 * 结果 = 去掉注入块 + 解出 user_query 内层（真实输入保留，标签丢弃）。
 */
function cleanUserText(text) {
  let t = stripSystemReminders(text);
  const m = t.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) t = m[1];
  else t = t.replace(/<user_query[^>]*>/g, '').replace(/<\/user_query>/g, '');
  return t.trim();
}

module.exports = {
  BaseAdapter,
  AdapterError,
  mapStepStatus,
  deriveTaskStatus,
  calcProgress,
  isoMs,
  stripSystemReminders,
  cleanUserText
};

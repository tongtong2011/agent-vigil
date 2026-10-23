'use strict';
/**
 * V4 渠道配置解析与 watchlist 规范化（lib/channels.js）
 *
 * 单一生效源原则（V4.1）：
 *   - 渠道策略读 cfg.channels[ch]，每渠道仅 {enabled, digestEnabled, alertEnabled,
 *     alertPrefix}；agnes 未显式配置的字段回退 cfg.alerts 顶层（旧生效源，老配置零迁移）
 *   - 汇总间隔与汇总标题为全渠道统一（cfg.alerts.digestIntervalMinutes / digestTitle），
 *     不再按渠道拆分；digestInterval()/digestTitleFor() 为全局读取入口
 *   - watchlist 存储为二元组 [{channel, taskId}]；旧格式（纯 id 字符串或
 *     {taskId} 无 channel）读取时一律归一成 agnes，旧数据无需迁移
 *   - 报警前缀留空时按渠道自动带标签：agnes 保持旧默认（不带标签，零回归），
 *     新渠道默认「[渠道名] 单任务报警-」
 */

const DEFAULT_CHANNEL = 'agnes';
const PER_CHANNEL_LIMIT = 50;  // 单渠道追踪上限
const TOTAL_LIMIT = 200;      // 全渠道追踪总上限

/** 取渠道展示名（从适配器注册表，拿不到时回退渠道短名）。 */
function displayNameOf(ch, adapters) {
  const a = adapters && adapters.get && adapters.get(ch);
  return (a && a.displayName) || ch;
}

/**
 * 解析某渠道的启停与告警策略（V4.1：每渠道仅 enabled/digestEnabled/alertEnabled/
 * alertPrefix；汇总间隔与汇总标题为全局，见 digestInterval()/digestTitleFor()）。
 * @param {object} cfg 全局配置
 * @param {string} ch 渠道短名
 */
function channelCfg(cfg, ch) {
  const c = (cfg.channels && cfg.channels[ch]) || {};
  const a = cfg.alerts || {};
  const out = {
    enabled: c.enabled !== false,
    digestEnabled: !!c.digestEnabled,
    alertEnabled: !!c.alertEnabled,
    alertPrefix: String(c.alertPrefix || '')
  };
  if (ch === DEFAULT_CHANNEL) {
    // agnes：channels.agnes 显式值优先，未写则回退 V3 顶层 alerts（旧生效源）
    if (c.digestEnabled === undefined) out.digestEnabled = !!a.digestEnabled;
    if (c.alertEnabled === undefined) out.alertEnabled = !!a.alertEnabled;
    if (c.alertPrefix === undefined) out.alertPrefix = String(a.alertPrefix || '');
  }
  return out;
}

function clampInterval(n) { return Math.min(240, Math.max(10, n)); }

/** 全局汇总间隔（分钟，10~240；所有渠道统一节拍，实时读 config 热生效）。 */
function digestInterval(cfg) {
  return clampInterval(Number(cfg.alerts && cfg.alerts.digestIntervalMinutes) || 60);
}

/** 汇总邮件标题（全局统一；自定义优先，空 = 默认「任务汇总邮件」）。 */
function digestTitleFor(cfg) {
  return String((cfg.alerts && cfg.alerts.digestTitle) || '').trim() || '任务汇总邮件';
}

/** 单任务报警前缀（同上规则）。 */
function alertPrefixFor(cfg, ch, adapters) {
  const p = channelCfg(cfg, ch).alertPrefix.trim();
  if (p) return p;
  return ch === DEFAULT_CHANNEL ? '单任务报警-' : `[${displayNameOf(ch, adapters)}] 单任务报警-`;
}

/**
 * 把任意形态的 watchlist 元素规范成二元组 {channel, taskId}；非法返回 null。
 * 接受："id" / {channel,taskId} / {taskId}（旧格式归 agnes）。
 */
function normalizeEntry(x, allowed) {
  if (typeof x === 'string' || typeof x === 'number') {
    const taskId = String(x).trim();
    return taskId ? { channel: DEFAULT_CHANNEL, taskId } : null;
  }
  if (x && typeof x === 'object') {
    const taskId = String(x.taskId || x.id || '').trim();
    if (!taskId) return null;
    let channel = String(x.channel || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(channel)) return null;
    return { channel, taskId };
  }
  return null;
}

function entryKey(e) { return `${e.channel}:${e.taskId}`; }

/**
 * 规范化整份 watchlist（去重、限量、过滤非法渠道）。
 * @param {Array} list 原始数组（字符串/对象混合）
 * @param {string[]} [allowed] 允许的渠道白名单（不传则不过滤）
 */
function normalizeWatchlist(list, allowed) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const perCh = new Map();
  const out = [];
  for (const x of list) {
    const e = normalizeEntry(x, allowed);
    if (!e) continue;
    const k = entryKey(e);
    if (seen.has(k)) continue;
    const n = perCh.get(e.channel) || 0;
    if (n >= PER_CHANNEL_LIMIT) continue;
    if (out.length >= TOTAL_LIMIT) break;
    seen.add(k);
    perCh.set(e.channel, n + 1);
    out.push(e);
  }
  return out;
}

/** 从整份清单中取某渠道的 taskId 数组（给单渠道前端/定时器用）。 */
function idsForChannel(entries, ch) {
  return entries.filter((e) => e.channel === ch).map((e) => e.taskId);
}

module.exports = {
  DEFAULT_CHANNEL,
  PER_CHANNEL_LIMIT,
  TOTAL_LIMIT,
  channelCfg,
  digestInterval,
  digestTitleFor,
  alertPrefixFor,
  displayNameOf,
  normalizeEntry,
  normalizeWatchlist,
  idsForChannel,
  entryKey
};

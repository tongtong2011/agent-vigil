'use strict';
/**
 * V4 适配器注册表（lib/adapters/index.js）
 *
 * 工厂：按配置实例化各渠道适配器，统一 init/close/health 汇总。
 * - agnes（爱思办公）：默认渠道，包装现有 OfficialClient（bridge 已有的实例，零回归）
 * - workbuddy：数据根 ~/.workbuddy 存在即自动接入（channels.workbuddy.enabled=false 可关闭）
 * - V4.1 渠道启停：适配器始终注册（watchlist/状态稳定），但 enabled=false 的渠道
 *   不初始化、不预热、不出现在 /health（看板 Tab 隐藏）；向导勾选变化热启停（applyChannels）
 *
 * 【任务列表快照】（列表加载性能优化）：
 * - listTasksSnapshot(ch)：有快照立即返回（过期也先返回旧数据，后台静默刷新，stale-while-revalidate）；
 *   无快照才等待实拉。手机端进看板/切 Tab 命中快照即秒开。
 * - listTasksFresh(ch)：绕过快照强制实拉并回写（下拉刷新/手动刷新用）。
 * - init 后预热 + 60 秒常热定时器：桥接常驻期间快照始终新鲜，手机端随到随取。
 * - 渠道停用时快照立即清空（不保留旧数据，与「数据源不可用清缓存」语义一致）。
 *
 * 【隔离铁律】单个适配器 init/health/listTasks 抛错不得拖垮其他渠道与桥接主流程。
 */

const { AgnesAdapter } = require('./agnes');
const { WorkBuddyAdapter } = require('./workbuddy');
const { TraeAdapter } = require('./trae');
const CH = require('../channels');

const SNAPSHOT_TTL = 30 * 1000;   // 快照有效期：过期后请求仍先返回旧数据，同时后台静默刷新
const WARM_INTERVAL = 60 * 1000;  // 常热定时器周期：对齐阻塞检测 60 秒节奏

/**
 * @param {object} o { cfg, official(OfficialClient 实例), log }
 * @returns {{ map: Map<string, BaseAdapter>, enabled: () => BaseAdapter[], get: (ch) => BaseAdapter|undefined,
 *            initAll, applyChannels, closeAll, healthSummary, listTasksSnapshot, listTasksFresh }}
 */
function createAdapters({ cfg, official, log }) {
  const map = new Map();
  map.set('agnes', new AgnesAdapter(official, cfg));

  const wbCfg = (cfg.channels && cfg.channels.workbuddy) || {};
  map.set('workbuddy', new WorkBuddyAdapter({ rootDir: wbCfg.dataDir, cfg })); // cfg 引用实时读 board.listLimit

  // trae（Trae CN）：本地记忆转录直读（~/.trae-cn/memory/projects 存在即自动接入），WorkBuddy 同款模式
  const traeCfg = (cfg.channels && cfg.channels.trae) || {};
  map.set('trae', new TraeAdapter({ rootDir: traeCfg.dataDir, cfg }));

  // 任务列表快照（ch -> { tasks, at }）：服务端提前把看板数据备好
  const _snap = new Map();
  const _inited = new Set();  // 已初始化渠道（仅 enabled 渠道初始化）
  let _warmTm = null;

  /** 渠道是否接入（channels.<ch>.enabled，实时读配置——向导勾选后无需重启即生效） */
  function isEnabled(ch) { return CH.channelCfg(cfg, ch).enabled; }

  /** 实拉某渠道列表并回写快照；失败保留旧快照、不向上抛（隔离铁律） */
  async function _refresh(ch) {
    const a = map.get(ch);
    if (!a) return;
    try {
      const tasks = await a.listTasks();
      _snap.set(ch, { tasks, at: Date.now() });
    } catch (e) {
      log('warn', `[适配器] ${a.displayName} 任务列表刷新失败（保留旧快照）: ${e.message}`);
    }
  }

  /** 快照读：有快照立即返回（过期则同时触发后台刷新）；无快照才等待实拉 */
  async function listTasksSnapshot(ch) {
    if (!isEnabled(ch)) { _snap.delete(ch); return []; } // 停用渠道：清缓存返回空（看板不留旧数据）
    const hit = _snap.get(ch);
    if (hit) {
      if (Date.now() - hit.at > SNAPSHOT_TTL) _refresh(ch);
      return hit.tasks;
    }
    await _refresh(ch);
    const now = _snap.get(ch);
    return now ? now.tasks : [];
  }

  /** 强制实拉并回写快照（下拉刷新/手动刷新用）；失败向上抛出，保持既有错误语义 */
  async function listTasksFresh(ch) {
    if (!isEnabled(ch)) { _snap.delete(ch); return []; }
    const a = map.get(ch);
    if (!a) return [];
    const tasks = await a.listTasks();
    _snap.set(ch, { tasks, at: Date.now() });
    return tasks;
  }

  /** 初始化单个渠道（幂等；失败降级不拖垮其他渠道），并立即预热快照 */
  async function _initOne(ch) {
    if (_inited.has(ch)) return;
    _inited.add(ch);
    const a = map.get(ch);
    try {
      await a.init({ cfg, log });
    } catch (e) {
      log('warn', `[适配器] ${a.displayName} 初始化失败（已降级，不影响其他渠道）: ${e.message}`);
    }
    _refresh(ch);
  }

  async function initAll() {
    for (const ch of map.keys()) {
      if (isEnabled(ch)) await _initOne(ch);
      else _snap.delete(ch); // 停用渠道不预热、不留旧快照
    }
    startWarm();
  }

  /** V4.1 渠道启停热应用（向导复选框保存后由 bridge 调用）：新启用 → 补初始化；停用 → 清快照并释放 */
  async function applyChannels() {
    for (const ch of map.keys()) {
      if (isEnabled(ch)) {
        if (!_inited.has(ch)) {
          log('info', `[适配器] 渠道已启用，开始接入：${map.get(ch).displayName}`);
          await _initOne(ch);
        }
      } else {
        _snap.delete(ch); // 停用：清空缓存，看板不留旧数据
        if (_inited.has(ch)) {
          _inited.delete(ch);
          const a = map.get(ch);
          try { await a.close(); } catch (_) {}
          log('info', `[适配器] 渠道已停用：${a.displayName}（看板不再显示、告警忽略）`);
        }
      }
    }
  }

  /** 常热定时器：周期刷新启用渠道快照，保证手机端随时命中新鲜数据 */
  function startWarm() {
    if (_warmTm) return;
    _warmTm = setInterval(() => {
      for (const ch of map.keys()) if (isEnabled(ch)) _refresh(ch);
    }, WARM_INTERVAL);
    if (_warmTm.unref) _warmTm.unref();
  }

  async function closeAll() {
    if (_warmTm) { clearInterval(_warmTm); _warmTm = null; }
    for (const a of map.values()) {
      try { await a.close(); } catch (_) {}
    }
    _inited.clear();
  }

  /** health 汇总（/health 用）：[{channel, displayName, ok, describe, tasks}]；停用渠道不出现在结果里（Tab 隐藏） */
  async function healthSummary() {
    const out = [];
    for (const [ch, a] of map) {
      if (!isEnabled(ch)) continue;
      let ok = false;
      try { ok = await a.health(); } catch (_) {}
      out.push({ channel: a.channel, displayName: a.displayName, ok, describe: a.describe(), tasks: a.taskCount(), canSend: a.canSend !== false, sendHint: a.sendHint || '' });
    }
    return out;
  }

  return { map, enabled: () => [...map.values()], get: (ch) => map.get(ch), initAll, applyChannels, closeAll, healthSummary, listTasksSnapshot, listTasksFresh };
}

module.exports = { createAdapters, AgnesAdapter, WorkBuddyAdapter, TraeAdapter };

'use strict';
/**
 * 手机端逻辑（单页三段视图：连接态 → 列表态 → 详情态）
 * - 扫码（URL 带 ?code=）或手动输入地址 + 配对码完成配对，令牌保存到 localStorage，下次自动连接
 * - 任务列表 / 详情渲染，下拉刷新
 * - WebSocket 实时刷新：断线指数退避重连；推送不可用时降级为 2~5 秒轮询
 * - 离线时展示最后缓存列表
 */
(function () {
  const LS_CONN = 'otc.conn.v1';   // { base, deviceToken }
  const LS_WATCH = 'otc.alert.watch.v1';  // V4：追踪清单键数组（"渠道:任务id"；旧版纯 id 读取时归 agnes）
  const LS_CACHE = 'otc.cache.v1'; // 最后一次任务列表缓存（V4：{ch, tasks}，旧版纯数组=agnes）
  const FETCH_TIMEOUT = 5000;      // 网络超时统一 5 秒

  const $ = (s) => document.querySelector(s);

  const state = {
    conn: null,        // { base, token }
    channel: 'agnes',  // V4 当前渠道 Tab（单渠道时恒 agnes，不显示 Tab）
    channels: [],      // V4 渠道注册表（/health channels：[{channel,displayName,ok,canSend}]）
    watch: null,       // V4 追踪键集合（"渠道:任务id"，见下方 loadWatchLs）
    ws: null,
    wsUp: false,
    wsBackoff: 1000,   // 指数退避：1s → 30s
    reconnectTm: null,
    pollTimer: null,
    pollMs: 4000,      // 降级轮询间隔（2~5 秒）
    tasks: [],
    tasksByCh: new Map(),      // 按渠道内存缓存任务列表：切 Tab 秒显，不必重新等请求
    expandedGroups: new Set(), // 已展开的文件夹 key（cwd）；默认全部收起，重渲染时保留
    currentId: null,
    currentChannel: 'agnes',   // 详情页所属渠道（openDetail 时快照，防 Tab 状态串扰）
    detail: null
  };

  /** 追踪键：渠道与任务 id 组合成全局唯一键（同一 taskId 在不同渠道不冲突） */
  function watchKey(ch, id) { return ch + ':' + id; }

  /** 读取本地追踪清单：V4 键数组；旧版纯 taskId 数组（无冒号）归一成 agnes 渠道 */
  function loadWatchLs() {
    const raw = lsGet(LS_WATCH, []);
    return new Set((Array.isArray(raw) ? raw : []).map((k) => {
      k = String(k);
      return k.indexOf(':') >= 0 ? k : watchKey('agnes', k);
    }));
  }
  state.watch = loadWatchLs();

  const STATUS = {
    running: { text: '正在执行', cls: 'running' },
    done: { text: '执行完成', cls: 'done' },
    failed: { text: '异常', cls: 'failed' },
    waiting: { text: '待确认', cls: 'waiting' }
  };

  // ────────────────────────── 工具函数 ──────────────────────────

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function badge(st) {
    const s = STATUS[st] || { text: st || '未知', cls: 'unknown' };
    return `<span class="badge ${esc(s.cls)}">${esc(s.text)}</span>`;
  }

  let toastTm = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTm);
    toastTm = setTimeout(() => t.classList.add('hidden'), ms || 2600);
  }

  function showView(name) {
    ['connect', 'list', 'detail'].forEach((v) => {
      $('#view-' + v).classList.toggle('hidden', v !== name);
    });
    $('#topbar').classList.toggle('hidden', name === 'connect');
    // 发消息输入栏在详情页显示；canSend=false 的渠道降级为「复制指令」模式（仍显示）
    $('#composer').classList.toggle('hidden', name !== 'detail');
    if (name === 'detail') updateComposerMode();
    document.body.classList.toggle('in-detail', name === 'detail');
    if (name === 'list') setTop('任务列表');
    if (name === 'detail') setTop('任务详情');
    if (name === 'connect') setNet('');
    // 顶栏任务名（标题+创建时间小字）仅在详情页显示
    $('#top-task').classList.toggle('hidden', name !== 'detail');
    // 「全部展开」按钮仅列表页显示
    $('#btn-expand-all').classList.toggle('hidden', name !== 'list');
    syncTopbarH();
  }

  /** 同步顶栏实际高度为 CSS 变量（详情页钉住区 sticky top 依赖它） */
  function syncTopbarH() {
    const bar = $('#topbar');
    const h = bar.classList.contains('hidden') ? 0 : bar.offsetHeight;
    document.documentElement.style.setProperty('--topbar-h', h + 'px');
  }

  function setTop(t) { $('#top-title').textContent = t; }

  function setNet(text, cls) {
    const el = $('#net-status');
    el.textContent = text;
    el.className = 'chip' + (cls ? ' ' + cls : '');
    el.classList.toggle('hidden', !text);
  }

  function readConn() {
    try { return JSON.parse(localStorage.getItem(LS_CONN) || 'null'); } catch (_) { return null; }
  }

  function saveConn(conn) {
    state.conn = conn;
    try { localStorage.setItem(LS_CONN, JSON.stringify(conn)); } catch (_) {}
  }

  function lsGet(k, dft) {
    try { const v = localStorage.getItem(k); return v == null ? dft : JSON.parse(v); } catch (_) { return dft; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }

  // ────────────────────────── V3 告警追踪 ──────────────────────────
  // 开关状态存手机 localStorage（刷新/重开保持）；变化时全量同步到服务端副本，
  // 供桥接定时扫描（定时统计 + 阻塞告警）。同步失败静默，下次操作再同步。

  function syncAlerts() {
    if (!state.conn) return;
    // V4：按当前渠道同步（服务端只覆盖该渠道条目，其他渠道不受影响）
    const prefix = state.channel + ':';
    const ids = [...state.watch].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    apiFetch('/api/alerts/sync', {
      method: 'POST',
      body: JSON.stringify({ channel: state.channel, watchlist: ids })
    }).catch(() => {});
  }

  /** 切换某任务的追踪标记（列表页卡片上的铃铛；存 localStorage + 同步服务端） */
  function toggleWatch(id) {
    if (!id) return;
    const key = watchKey(state.channel, id);
    if (state.watch.has(key)) {
      state.watch.delete(key);
      toast('已关闭任务状态邮件提醒');
    } else {
      state.watch.add(key);
      toast('已开启任务状态邮件提醒');
    }
    lsSet(LS_WATCH, [...state.watch]);
    renderList();
    syncAlerts();
  }

  function normalizeBase(s) {
    s = (s || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
  }

  /** 批量开关某目录下所有任务的追踪标记（文件夹行「全开/全关」按钮） */
  function toggleGroupWatch(key, on) {
    const g = buildGroups(state.tasks).find((x) => String(x.key) === String(key));
    if (!g || !g.tasks.length) return;
    let n = 0;
    for (const t of g.tasks) {
      const wk = watchKey(state.channel, t.id);
      if (on && !state.watch.has(wk)) { state.watch.add(wk); n++; }
      if (!on && state.watch.has(wk)) { state.watch.delete(wk); n++; }
    }
    if (!n) return toast(on ? '该目录任务均已开启追踪' : '该目录任务均已关闭追踪');
    lsSet(LS_WATCH, [...state.watch]);
    toast(on ? `已开启该目录 ${n} 个任务的任务状态邮件提醒` : `已关闭该目录 ${n} 个任务的任务状态邮件提醒`);
    renderList();
    syncAlerts();
  }

  /** 带 5 秒超时的 API 请求（自动携带设备令牌） */
  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.conn && state.conn.token) opts.headers['X-Device-Token'] = state.conn.token;
    const ctrl = new AbortController();
    // 发消息等慢操作可传 timeoutMs 覆盖默认 5 秒（后端需等待 ACP 确认，约 8 秒）
    const tm = setTimeout(() => ctrl.abort(), opts.timeoutMs || FETCH_TIMEOUT);
    opts.signal = ctrl.signal;
    return fetch(state.conn.base + path, opts).finally(() => clearTimeout(tm));
  }

  function pairRequest(base, code) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    return fetch(base + '/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      signal: ctrl.signal
    }).finally(() => clearTimeout(tm))
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && j.error.message) || '配对失败，请检查地址与配对码');
        return j;
      })
      .catch((e) => {
        if (e.name === 'AbortError') throw new Error('连接超时，请确认手机与电脑在同一网络');
        throw e;
      });
  }

  // ────────────────────────── 连接逻辑 ──────────────────────────

  // 外壳版本自检：与 /health.shellVer（lib/localApi.js）不一致 → 清缓存 + 注销 SW + 强刷一次。
  // 解决「发版后手机停留在 SW 旧壳」：stale-while-revalidate 首开必然旧版，极端情况旧 SW 滞留更久。
  // sessionStorage 防循环：每个标签会话最多自动强刷一次。
  const SHELL_VER = 'v22';
  async function shellCheck() {
    try {
      if (!location.protocol.startsWith('http')) return;
      const r = await fetch('/health', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j.shellVer && j.shellVer !== SHELL_VER && !sessionStorage.getItem('shellReloaded')) {
        sessionStorage.setItem('shellReloaded', '1');
        try {
          if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
          if (navigator.serviceWorker) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((x) => x.unregister()));
          }
        } catch (_) {}
        location.reload();
      }
    } catch (_) { /* 离线跳过 */ }
  }

  async function boot() {
    bind();
    shellCheck();

    // 扫码进入：URL 含 ?code=，用当前站点地址自动配对
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code && location.protocol.startsWith('http')) {
      history.replaceState(null, '', location.pathname);
      await autoPair(location.origin, code);
      return;
    }

    // 已配对：自动连接并校验 /health
    state.conn = readConn();
    if (state.conn && state.conn.base && state.conn.token) {
      if (await checkHealth(state.conn.base)) {
        enterList();
        return;
      }
      toast('无法连接已保存的地址，请重新配对');
    }
    showConnect();
  }

  function showConnect() {
    showView('connect');
    if (state.conn && state.conn.base) $('#in-base').value = state.conn.base;
  }

  async function checkHealth(base) {
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      const r = await fetch(base + '/health', { signal: ctrl.signal });
      clearTimeout(tm);
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  /** 当前详情渠道是否支持发消息（渠道未注册时默认展示，保持旧行为） */
  function canSendCurrent() {
    const ch = state.currentChannel || state.channel;
    const cur = state.channels.find((c) => c.channel === ch);
    return !cur || cur.canSend !== false;
  }

  /** 当前详情渠道的发送方式提示（/health sendHint 透传；渠道未注册用兜底文案） */
  function sendHintCurrent() {
    const ch = state.currentChannel || state.channel;
    const cur = state.channels.find((c) => c.channel === ch);
    return (cur && cur.sendHint) || '该渠道暂不支持直接注入指令：已复制到剪贴板，请切换到对应应用粘贴发送';
  }

  /** 按渠道 canSend 切换输入栏形态：直接发送 vs 复制指令转交（进详情页/渠道注册表更新时调用） */
  function updateComposerMode() {
    const sendable = canSendCurrent();
    $('#msg-input').placeholder = sendable
      ? '发消息给这个任务，如：同意 / 继续 / 修改建议…'
      : '该渠道暂不支持直接注入，点「复制指令」后到对应应用粘贴发送';
    $('#btn-send').textContent = sendable ? '发送' : '复制指令';
  }

  /** 剪贴板写入：优先 navigator.clipboard（需 HTTPS 安全上下文），局域网 http 用 execCommand 兜底 */
  async function copyText(t) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (_) { /* 继续走兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, t.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  /** ACP/渠道健康 → 渠道注册表 + Tab 渲染 + 列表页顶部提示条（离线保持现状） */
  async function checkAcp() {
    try {
      const r = await fetch((state.conn && state.conn.base || '') + '/health', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        state.acpConnected = !!j.acpConnected;
        state.channels = Array.isArray(j.channels) ? j.channels : [];
        // 当前 Tab 不在注册表（渠道被关闭/降级移除）→ 回退第一个可用渠道
        if (state.channels.length && !state.channels.some((c) => c.channel === state.channel)) {
          state.channel = state.channels[0].channel;
          state.tasks = [];
          renderList();
          loadList();
        }
        renderTabs();
        renderBanner();
        // 详情页停留期间渠道注册表更新（如 CLI 探测结果变化）→ 重算输入栏形态
        if (!$('#view-detail').classList.contains('hidden')) updateComposerMode();
        prefetchOtherChannels(); // 渠道注册表就绪后补一次预取（首屏 loadList 时 channels 可能未到）
      }
    } catch (_) { /* 离线：保持现状 */ }
  }

  /** 顶部提示条：按当前渠道显示「数据源不可用」（渠道注册表为空时回退 agnes ACP 状态） */
  function renderBanner() {
    const el = $('#acp-banner');
    if (!el) return;
    const cur = state.channels.find((c) => c.channel === state.channel) || null;
    const bad = cur ? cur.ok === false : state.acpConnected === false;
    el.classList.toggle('hidden', !bad);
    if (bad) {
      el.innerHTML = cur && cur.channel !== 'agnes'
        ? `⚠ 暂时取不到 ${esc(cur.displayName)} 的任务数据（本地数据源不可读或应用未运行）。桥接服务会自动恢复，无需重启。`
        : '⚠ 未检测到爱思办公进程，取不到任务数据。请在电脑上启动爱思办公桌面应用，桥接服务会自动连接，无需重启。';
    }
  }

  /** 渠道 Tab：按接入渠道显示（V4.1：勾几个显示几个，只勾一个也显示标签页）；带在线状态点 */
  function renderTabs() {
    const el = $('#ch-tabs');
    if (!el) return;
    if (!state.channels || state.channels.length < 1) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = state.channels.map((c) =>
      `<button class="ch-tab${c.channel === state.channel ? ' on' : ''}" data-ch="${esc(c.channel)}" type="button">` +
      `<i class="dot ${c.ok ? 'ok' : 'bad'}"></i>${esc(c.displayName)}</button>`
    ).join('');
  }

  /** 切换渠道 Tab：优先展示该渠道内存缓存（秒显），再静默刷新对齐最新 */
  function switchChannel(ch) {
    if (!ch || ch === state.channel) return;
    state.channel = ch;
    state.expandedGroups.clear();
    const cached = state.tasksByCh.get(ch);
    state.tasks = cached ? cached.slice() : [];
    renderTabs();
    renderBanner();
    renderList();
    loadList(true);
  }

  async function autoPair(base, code) {
    try {
      const r = await pairRequest(base, code);
      saveConn({ base, token: r.deviceToken });
      toast('配对成功');
      enterList();
    } catch (e) {
      // 链接里的 code 已过期/失效（如告警邮件发出较久才点）：若本机已有有效配对则直接进入，
      // 不被旧 code 挡在门外；无本地令牌才停在配对页
      const saved = readConn();
      if (saved && saved.base && saved.token && await checkHealth(saved.base)) {
        state.conn = saved;
        enterList();
        return;
      }
      $('#in-base').value = base;
      $('#in-code').value = code;
      showConnect();
      toast(e.message);
    }
  }

  function authLost() {
    try { localStorage.removeItem(LS_CONN); } catch (_) {}
    state.conn = null;
    closeWS();
    stopPolling();
    showConnect();
    toast('配对已失效，请重新配对');
  }

  // ────────────────────────── 列表与详情 ──────────────────────────

  function enterList() {
    showView('list');
    connectWS();
    loadList();
    checkAcp();
    reconcileWatch(); // 服务端为追踪清单唯一真源：进看板先拉取对齐本地副本（替代旧的盲目全量覆盖推送，防止旧副本冲掉其他设备的改动）
  }

  /** 与服务端对齐追踪清单：拉取全渠道二元组清单重建本地键集合（服务端真源），失败（离线）保留本地不推送 */
  async function reconcileWatch() {
    try {
      const r = await apiFetch('/api/alerts/watchlist');
      if (r.status === 401) return authLost();
      if (!r.ok) return;
      const j = await r.json();
      const list = Array.isArray(j.watchlist) ? j.watchlist : [];
      // 兼容两种元素：V4 二元组 {channel,taskId}；旧桥接纯 id（=agnes）
      state.watch = new Set(list.map((e) => (e && typeof e === 'object')
        ? watchKey(e.channel || 'agnes', e.taskId)
        : watchKey('agnes', e)));
      lsSet(LS_WATCH, [...state.watch]);
      renderList(); // 用服务端状态重绘铃铛（即使 loadList 已渲染，这里保证追踪标记一致）
    } catch (_) { /* 离线：保留本地清单，不做破坏性覆盖 */ }
  }

  async function loadList(silent, fresh) {
    const ch = state.channel; // 快照当前渠道：响应回来若已切走，只更新缓存不覆盖渲染
    try {
      // fresh=1 强制服务端实拉（下拉/手动刷新）；默认走服务端快照（预热数据，秒回）
      const r = await apiFetch('/api/tasks?channel=' + encodeURIComponent(ch) + (fresh ? '&fresh=1' : ''));
      if (r.status === 401) return authLost();
      if (!r.ok) {
        if (r.status === 503) {
          // 数据源未连接（如爱思办公未启动）：有内存缓存则保留旧列表，否则空看板 + 顶部提示条
          if (state.channel === ch) {
            state.tasks = state.tasksByCh.get(ch) || [];
            renderList();
            checkAcp();
          }
          return;
        }
        throw new Error('HTTP ' + r.status);
      }
      const j = await r.json();
      // 打渠道标记（本地字段）：WS 事件按渠道门控、缓存按渠道隔离都靠它区分
      const tasks = (j.tasks || []).map((t) => Object.assign({}, t, { _ch: ch }));
      state.tasksByCh.set(ch, tasks); // 写入该渠道内存缓存：下次切回秒显
      if (state.channel !== ch) return; // 期间已切走：仅更新缓存，不干扰当前渠道渲染
      state.tasks = tasks;
      renderList();
      checkAcp();
      try { localStorage.setItem(LS_CACHE, JSON.stringify({ ch, tasks: state.tasks })); } catch (_) {}
      prefetchOtherChannels();
    } catch (e) {
      if (state.channel !== ch) return;
      if (!silent) toast('加载失败：' + (e.name === 'AbortError' ? '连接超时' : e.message));
      if (!state.tasks.length) {
        // 离线兜底：展示同渠道的最后缓存列表（旧格式数组 = agnes）
        try {
          const cached = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
          const arr = Array.isArray(cached)
            ? (ch === 'agnes' ? cached : [])
            : (cached && cached.ch === ch ? cached.tasks : []);
          if (arr.length) {
            state.tasks = arr;
            renderList();
            toast('网络异常，展示缓存列表');
          }
        } catch (_) {}
      }
    }
  }

  /** 后台静默预取其他渠道列表（当前渠道加载完成后触发）：切 Tab 时秒显 */
  const _prefetching = new Set();
  function prefetchOtherChannels() {
    if (!state.channels || state.channels.length < 2) return;
    for (const c of state.channels) {
      const ch = c.channel;
      if (ch === state.channel || state.tasksByCh.has(ch) || _prefetching.has(ch)) continue;
      _prefetching.add(ch);
      apiFetch('/api/tasks?channel=' + encodeURIComponent(ch))
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && Array.isArray(j.tasks)) {
            state.tasksByCh.set(ch, j.tasks.map((t) => Object.assign({}, t, { _ch: ch })));
          }
        })
        .catch(() => {})
        .finally(() => _prefetching.delete(ch));
    }
  }

  /** 文件夹显示名：取路径最后一段（与电脑端按工作目录分组一致） */
  function folderName(cwd) {
    if (!cwd) return '（未指定目录）';
    const parts = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || String(cwd);
  }

  /** 任务按 cwd 聚合为两级：文件夹 → 任务（组/组内均按最近更新倒序） */
  function buildGroups(tasks) {
    const map = new Map();
    for (const t of tasks) {
      const key = t.cwd || '';
      if (!map.has(key)) map.set(key, { key, name: folderName(t.cwd), cwd: t.cwd || '', tasks: [] });
      map.get(key).tasks.push(t);
    }
    const groups = [...map.values()];
    const timeOf = (t) => Date.parse(t.updatedAt || t.createdAt) || 0;
    for (const g of groups) {
      g.tasks.sort((a, b) => timeOf(b) - timeOf(a));
      g.latest = g.tasks.reduce((m, t) => Math.max(m, timeOf(t)), 0);
    }
    groups.sort((a, b) => b.latest - a.latest);
    return groups;
  }

  function taskCardHtml(t) {
    const cls = (STATUS[t.status] || { cls: 'unknown' }).cls;
    const on = state.watch.has(watchKey(state.channel, t.id));
    return `<div class="card ${esc(cls)}" data-id="${esc(t.id)}">
      <div class="row1"><span class="title">${esc(t.title)}</span>${badge(t.status)}<button class="watch-btn${on ? ' on' : ''}" data-watch="${esc(t.id)}" type="button" title="${on ? '已开启任务状态邮件提醒' : '任务状态邮件提醒'}">🔔</button></div>
      <div class="meta"><span>${esc(fmtTime(t.createdAt))}</span></div>
    </div>`;
  }

  function renderList() {
    const el = $('#task-list');
    if (!state.tasks.length) {
      el.innerHTML = '<div class="empty">暂无任务<br />电脑端创建任务后将自动出现在这里</div>';
      updateExpandBtn();
      return;
    }
    const groups = buildGroups(state.tasks);
    el.innerHTML = groups.map((g) => {
      const open = state.expandedGroups.has(g.key);
      return `<div class="fgroup ${open ? 'open' : ''}">
        <div class="fhead" data-key="${esc(g.key)}" title="${esc(g.cwd)}">
          <span class="fchev">${open ? '▾' : '▸'}</span>
          <span class="fname">${esc(g.name)}</span>
          <span class="fcount">${g.tasks.length}</span>
          <span class="fwbtns">
            <button class="fwbtn" data-watch-bulk="on" data-gkey="${esc(g.key)}" type="button" title="打开该目录下所有任务的任务状态邮件提醒">🔔全开</button>
            <button class="fwbtn" data-watch-bulk="off" data-gkey="${esc(g.key)}" type="button" title="关闭该目录下所有任务的任务状态邮件提醒">🔕全关</button>
          </span>
        </div>
        <div class="fbody">${g.tasks.map(taskCardHtml).join('')}</div>
      </div>`;
    }).join('');
    updateExpandBtn();
  }

  /** 展开/收起单个文件夹 */
  function toggleGroup(key) {
    if (state.expandedGroups.has(key)) state.expandedGroups.delete(key);
    else state.expandedGroups.add(key);
    renderList();
  }

  /** 顶栏全部展开 / 全部收起（默认收起状态） */
  function toggleExpandAll() {
    const groups = buildGroups(state.tasks);
    const allOpen = groups.length > 0 && groups.every((g) => state.expandedGroups.has(g.key));
    if (allOpen) state.expandedGroups.clear();
    else groups.forEach((g) => state.expandedGroups.add(g.key));
    renderList();
  }

  /** 同步顶栏「全部展开/收起」按钮文案与显隐（仅列表页显示） */
  function updateExpandBtn() {
    const btn = $('#btn-expand-all');
    if (!btn) return;
    const groups = buildGroups(state.tasks);
    const allOpen = groups.length > 0 && groups.every((g) => state.expandedGroups.has(g.key));
    btn.textContent = allOpen ? '全部收起' : '全部展开';
  }

  function openDetail(id) {
    state.currentId = id;
    state.currentChannel = state.channel; // 快照详情所属渠道（Tab 不会在详情页切换，双保险）
    state.detail = null;
    showView('detail');
    renderDetail();
    loadDetail();
    startDetailTimer(); // 兜底：详情页可见时每 8 秒静默刷新（实时更新主要由 task_update/step_update 触发）
  }

  let lastDetailAt = 0;
  async function loadDetail(silent, force) {
    const id = state.currentId;
    if (!id) return;
    if (!force && Date.now() - lastDetailAt < 1500) return; // 前端节流
    lastDetailAt = Date.now();
    try {
      const r = await apiFetch('/api/tasks/' + encodeURIComponent(id) + '?channel=' + encodeURIComponent(state.currentChannel));
      if (r.status === 401) return authLost();
      if (r.status === 404) { toast('任务不存在'); return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (state.currentId !== id) return; // 用户已切换
      state.detail = j.task || null;
      renderDetail();
    } catch (e) {
      if (!silent) toast('加载详情失败：' + (e.name === 'AbortError' ? '连接超时' : e.message));
    }
  }

  function startDetailTimer() {
    stopDetailTimer();
    state.detailTimer = setInterval(() => {
      if ($('#view-detail').classList.contains('hidden')) return stopDetailTimer();
      loadDetail(true);
    }, 8000);
  }

  function stopDetailTimer() {
    if (state.detailTimer) { clearInterval(state.detailTimer); state.detailTimer = null; }
  }

  // ────────────────────────── 详情渲染（对话视图，与电脑端一致） ──────────────────────────

  function hmTime(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d)) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function nl2p(s) {
    return esc(s).replace(/\n/g, '<br />');
  }

  function renderDetail() {
    const el = $('#task-detail');
    const pinBox = $('#detail-pin');
    const pinEl = $('#pin-head');
    const t = state.detail;
    if (!t) {
      pinBox.classList.add('hidden');
      el.innerHTML = '<div class="empty">加载中…</div>';
      el.dataset.key = '';
      $('#top-task').innerHTML = '';
      return;
    }
    // 任务标题+创建时间并入顶栏（小字、单行省略）；状态徽章去掉——钉住区只留首条指令卡
    $('#top-task').innerHTML = `<b>${esc(t.title)}</b><i>${esc(fmtTime(t.createdAt))}</i>`;
    const head = '';
    let body;
    let firstHtml = '';
    if (Array.isArray(t.messages)) {
      // 首条用户指令（发给 AI 的第一条消息）从对话流中提出，钉在标题框下方不随滚动
      let list = t.messages;
      const fi = list.findIndex((m) => m.role === 'user');
      if (fi >= 0) {
        // 默认收起（伸缩门）：长指令不占屏；点击展开后卡片内可滚动查看全文
        firstHtml = `<div class="chat-first collapsed" onclick="this.classList.toggle('collapsed')"><div class="first-label"><span class="fold"></span>任务指令（第一条）</div><div class="first-body">${msgHtml(list[fi])}</div></div>`;
        list = list.filter((_, idx) => idx !== fi);
      }
      body = list.length
        ? `<div class="chat">${list.map(msgHtml).join('')}</div>`
        : '<div class="empty">暂无对话内容</div>';
    } else {
      // 旧数据兜底：无对话流时沿用步骤视图
      const steps = t.steps || [];
      body = `<div class="sec-title">AI 执行步骤（${steps.length}）</div>
        <div class="steps">${steps.length ? steps.map(stepHtml).join('') : '<div class="empty">暂无步骤</div>'}</div>`;
    }
    // 内容未变化时不重建 DOM（静默刷新不打断阅读 / 折叠展开状态）
    const key = JSON.stringify(t.messages || null) + '|' + t.status + '|' + (t.steps || []).length;
    if (pinEl.dataset.key !== key) {
      pinEl.innerHTML = head + firstHtml;
      pinEl.dataset.key = key;
    }
    pinBox.classList.remove('hidden');
    if (el.dataset.key === key) return;
    const docEl = document.documentElement;
    const wasOpen = !!el.dataset.key;                       // 是否已打开过本次详情（首次渲染=刚进入）
    const nearBottom = docEl.scrollHeight - window.innerHeight - window.scrollY < 160;
    const sy = window.scrollY;
    const openProcs = [...el.querySelectorAll('details.proc')].map((d) => d.open); // 保留已展开的处理过程
    el.innerHTML = body;
    el.dataset.key = key;
    el.querySelectorAll('details.proc').forEach((d, i) => { if (openProcs[i]) d.open = true; });
    if (!wasOpen || nearBottom) {
      // 打开任务时与有新消息且正看在底部时：贴底显示最新内容（与电脑端一致）
      requestAnimationFrame(() => window.scrollTo(0, docEl.scrollHeight));
    } else {
      window.scrollTo(0, sy);
    }
  }

  function msgHtml(m) {
    const time = hmTime(m.time);
    if (m.role === 'user') {
      return `<div class="msg user">
        <div class="bubble">${nl2p(m.text)}</div>
        ${time ? `<div class="stamp">${time}</div>` : ''}
      </div>`;
    }
    const tools = m.tools || [];
    const anyFail = tools.some((s) => s.status === 'failed');
    const proc = tools.length ? `
      <details class="proc${anyFail ? ' has-fail' : ''}">
        <summary>已处理 ${tools.length} 步</summary>
        <div class="proc-list">${tools.map(toolRow).join('')}</div>
      </details>` : '';
    const meta = [m.model, time].filter(Boolean).map(esc).join(' · ');
    return `<div class="msg agent">
      <div class="bubble md">${mdRender(m.text)}</div>
      ${proc}
      ${meta ? `<div class="stamp">${meta}</div>` : ''}
    </div>`;
  }

  function toolRow(s) {
    const cls = s.status === 'done' ? 'done' : s.status === 'failed' ? 'failed' : 'running';
    const txt = { done: '已完成', failed: '失败', running: '运行中' }[cls];
    return `<div class="tool-row">
      <span class="dot ${cls}"></span>
      <div class="tb">
        <div class="tn">${esc(s.name)}</div>
        ${s.output ? `<div class="to">${esc(s.output)}</div>` : ''}
      </div>
      <span class="ts ${cls}">${txt}</span>
    </div>`;
  }

  /** 迷你 Markdown 渲染（先整体转义再转换，无外部依赖，支持标题/列表/表格/代码块/引用/行内样式） */
  function mdRender(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const inline = (s) => {
      s = esc(s);
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return s;
    };
    const special = /^(\s*```|#{1,4}\s|\s*[-*]\s+\S|\s*\d+[.、]\s+\S|\s*>\s?|\s*\|.*\|\s*|\s*(-{3,}|\*{3,})\s*$)/;
    let html = '', i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
        html += '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        const lv = h[1].length + 1;
        html += `<h${lv}>${inline(h[2])}</h${lv}>`;
        i++;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { html += '<hr />'; i++; continue; }
      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += `<blockquote>${buf.map(inline).join('<br />')}</blockquote>`;
        continue;
      }
      if (/^\s*[-*]\s+\S/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*[-*]\s+\S/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
        html += '<ul>' + buf.map((c) => `<li>${inline(c)}</li>`).join('') + '</ul>';
        continue;
      }
      if (/^\s*\d+[.、]\s+\S/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*\d+[.、]\s+\S/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+[.、]\s+/, '')); i++; }
        html += '<ol>' + buf.map((c) => `<li>${inline(c)}</li>`).join('') + '</ol>';
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const buf = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !special.test(lines[i])) { buf.push(lines[i]); i++; }
      html += `<p>${buf.map(inline).join('<br />')}</p>`;
    }
    return html;
  }

  function stepHtml(s, i) {
    const cls = STATUS[s.status] ? s.status : 'unknown';
    const st = STATUS[s.status] || { text: '未知' };
    return `<div class="step">
      <div class="idx ${esc(cls === 'unknown' ? '' : cls)}">${i + 1}</div>
      <div class="body">
        <div class="name">${esc(s.name)}<span class="st ${esc(cls === 'unknown' ? '' : cls)}">${esc(st.text)}</span></div>
        <div class="out">${esc(s.output || '')}</div>
      </div>
    </div>`;
  }

  /** 当前视图静默刷新（轮询 / 手动刷新时使用）；列表走 fresh=1 直拉最新 */
  function refreshCurrent(silent) {
    if ($('#view-detail').classList.contains('hidden')) loadList(silent, true);
    else loadDetail(silent);
  }

  // ────────────────────────── WebSocket 实时刷新 ──────────────────────────

  function wsUrl() {
    return state.conn.base.replace(/^http/i, 'ws') + '/ws?token=' + encodeURIComponent(state.conn.token);
  }

  function connectWS() {
    if (!state.conn) return;
    closeWS();
    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (_) {
      startPolling();
      scheduleReconnect();
      return;
    }
    state.ws = ws;
    // 5 秒内未建立连接视为失败，转入降级轮询
    const failTm = setTimeout(() => { try { ws.close(); } catch (_) {} }, 5000);

    ws.onopen = () => {
      clearTimeout(failTm);
      state.wsUp = true;
      state.wsBackoff = 1000;
      stopPolling();
      setNet('实时', 'ok');
      try { ws.send(JSON.stringify({ type: 'subscribe' })); } catch (_) {}
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (!m || !m.type) return;
      if (m.type === 'hello' && m.pollIntervalMs) {
        state.pollMs = Math.min(5000, Math.max(2000, m.pollIntervalMs + 1000));
      } else if (m.type === 'task_update') {
        onTaskUpdate(m.task);
      } else if (m.type === 'step_update') {
        onStepUpdate(m.taskId, m.index, m.step);
      }
      // 'subscribed' / 'pong' 无需处理
    };
    ws.onclose = () => {
      if (state.ws !== ws) return; // 已被主动关闭
      state.wsUp = false;
      setNet('重连中', 'warn');
      startPolling();
      scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  function scheduleReconnect() {
    if (state.reconnectTm || !state.conn) return;
    state.reconnectTm = setTimeout(() => {
      state.reconnectTm = null;
      connectWS();
    }, state.wsBackoff);
    state.wsBackoff = Math.min(state.wsBackoff * 2, 30000); // 指数退避，封顶 30 秒
  }

  function closeWS() {
    if (state.reconnectTm) { clearTimeout(state.reconnectTm); state.reconnectTm = null; }
    if (state.ws) {
      const ws = state.ws;
      state.ws = null;
      ws.onclose = null;
      ws.onmessage = null;
      try { ws.close(); } catch (_) {}
    }
    state.wsUp = false;
  }

  /** 降级轮询：2~5 秒刷新当前视图 */
  function startPolling() {
    if (state.pollTimer || !state.conn) return;
    setNet('轮询中', 'warn');
    state.pollTimer = setInterval(() => refreshCurrent(true), state.pollMs);
    refreshCurrent(true);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function onTaskUpdate(t) {
    if (!t || !t.id) return;
    // V4：WS 实时事件目前仅来自 agnes 渠道（桥接只接线了 agnes 的变化回调），
    // 其他渠道 Tab 不消费，避免把 agnes 任务混进当前渠道列表
    if (state.channel !== 'agnes') return;
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = Object.assign({}, state.tasks[i], t);
    else state.tasks.unshift(t);
    state.tasks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!$('#view-list').classList.contains('hidden')) renderList();
    // 正在看该任务详情：拉取最新对话（服务端 2s 防抖 + 前端 1.5s 节流）
    if (state.currentId === t.id && !$('#view-detail').classList.contains('hidden')) loadDetail(true);
  }

  function onStepUpdate(taskId) {
    if (state.channel !== 'agnes') return; // 同 onTaskUpdate：WS 事件仅 agnes
    // 工具调用有更新（对话中的「已处理」块）→ 静默拉取最新详情
    if (state.currentId === taskId && !$('#view-detail').classList.contains('hidden')) loadDetail(true);
  }

  // ────────────────────────── 下拉刷新 ──────────────────────────

  function bindPTR() {
    let startY = null;
    window.addEventListener('touchstart', (e) => {
      if ($('#view-list').classList.contains('hidden')) return;
      if (window.scrollY <= 0) startY = e.touches[0].clientY;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 0) {
        const d = Math.min(80, dy * 0.5);
        $('#ptr').style.height = d + 'px';
        $('#ptr').classList.toggle('armed', d >= 60);
        $('#ptr-label').textContent = d >= 60 ? '松开刷新' : '下拉刷新';
      }
    }, { passive: true });
    window.addEventListener('touchend', () => {
      if (startY == null) return;
      const armed = $('#ptr').classList.contains('armed');
      $('#ptr').style.height = '';
      $('#ptr').classList.remove('armed');
      $('#ptr-label').textContent = '下拉刷新';
      startY = null;
      if (armed) {
        $('#ptr-label').textContent = '刷新中…';
        loadList(true, true).then(() => { $('#ptr-label').textContent = '下拉刷新'; });
      }
    }, { passive: true });
  }

  // ────────────────────────── 事件绑定与启动 ──────────────────────────

  function bind() {
    $('#btn-connect').addEventListener('click', async () => {
      const base = normalizeBase($('#in-base').value);
      const code = $('#in-code').value.trim();
      if (!base) return toast('请输入电脑地址，如 http://192.168.1.8:8787');
      if (!/^\d{6}$/.test(code)) return toast('请输入 6 位配对码（见电脑端窗口）');
      const btn = $('#btn-connect');
      btn.disabled = true;
      btn.textContent = '连接中…';
      try {
        const r = await pairRequest(base, code);
        saveConn({ base, token: r.deviceToken });
        toast('配对成功');
        enterList();
      } catch (e) {
        toast(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '连接';
      }
    });
    $('#in-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#btn-connect').click();
    });

    $('#btn-back').addEventListener('click', () => {
      state.currentId = null;
      stopDetailTimer();
      showView('list');
    });

    window.addEventListener('resize', syncTopbarH); // 旋转/分屏时重算钉住区吸附位置

    // V2：详情页发消息（向 AI 任务发送确认/指令/修改建议）
    // V4.2：canSend=false 渠道（如 Trae / CLI 未就绪的 WorkBuddy）→「复制指令」转交：
    // 不请求后端，写入剪贴板后按渠道 sendHint 引导用户去对应应用粘贴发送
    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#msg-input');
      const text = (input.value || '').trim();
      if (!text || !state.currentId) return;
      const btn = $('#btn-send');
      if (!canSendCurrent()) {
        if (await copyText(text)) {
          input.value = '';
          toast(sendHintCurrent(), 4200);
        } else {
          toast('复制失败：文本已保留在输入框，请长按全选手动复制', 4200);
        }
        return;
      }
      btn.disabled = true;
      input.disabled = true;
      try {
        const r = await apiFetch('/api/tasks/' + encodeURIComponent(state.currentId) + '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, channel: state.currentChannel }),
          timeoutMs: 20000 // 后端需等 ACP 确认（约 8 秒），普通 5 秒超时会在中途取消请求
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) return authLost();
        if (!r.ok) throw new Error(j.error && j.error.message ? j.error.message : 'HTTP ' + r.status);
        input.value = '';
        toast(j.pending ? '指令已受理，后台执行中，回复稍后回显…' : '已发送，AI 正在处理…');
        loadDetail(true, true); // 立即刷新，用户消息会经实时通知回到对话流
      } catch (err) {
        // AbortError（请求被超时取消）与网络错误给用户能看懂的中文提示
        const msg = err.name === 'AbortError'
          ? '连接超时，请重试（AI 处理长任务时确认会稍慢）'
          : err.message;
        toast('发送失败：' + msg, 4000);
      } finally {
        btn.disabled = false;
        input.disabled = false;
        input.focus();
      }
    });
    $('#msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#btn-send').click();
      }
    });

    $('#btn-refresh').addEventListener('click', () => refreshCurrent(false));
    $('#btn-expand-all').addEventListener('click', toggleExpandAll);

    // V4：渠道 Tab 切换（仅多渠道时渲染；切渠道 = 清列表按新渠道重拉）
    $('#ch-tabs').addEventListener('click', (e) => {
      const t = e.target.closest('[data-ch]');
      if (t) switchChannel(t.getAttribute('data-ch'));
    });

    // 列表点击：文件夹头 → 展开/收起；任务卡 → 详情（事件委托）
    $('#task-list').addEventListener('click', (e) => {
      // V3.1：目录行批量追踪（全开/全关）——先于 fhead 拦截，避免触发展开
      const bulk = e.target.closest('[data-watch-bulk]');
      if (bulk) return toggleGroupWatch(bulk.getAttribute('data-gkey'), bulk.getAttribute('data-watch-bulk') === 'on');
      // V3：卡片右上铃铛 = 追踪开关（阻止冒泡，不进详情）
      const bell = e.target.closest('[data-watch]');
      if (bell) return toggleWatch(bell.getAttribute('data-watch'));
      const head = e.target.closest('.fhead');
      if (head) return toggleGroup(head.getAttribute('data-key'));
      const card = e.target.closest('[data-id]');
      if (card) openDetail(card.getAttribute('data-id'));
    });

    bindPTR();

    // 回到前台时立即刷新，并尝试恢复实时连接
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.conn && $('#view-connect').classList.contains('hidden')) {
        refreshCurrent(true);
        if (!state.wsUp) connectWS();
      }
    });

    // Service Worker：PWA 离线缓存（仅 http(s) 下注册，失败静默）
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
})();

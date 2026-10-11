'use strict';
/**
 * 本地 HTTP API（Express 路由，向手机端提供只读接口）
 * 统一 JSON 响应；错误返回 { error: { code, message } }
 *
 * 端点：
 *   GET  /health             健康检查（无需配对）
 *   POST /api/pair           配对：一次性配对码 → 设备令牌
 *   GET  /api/tasks          任务列表（按创建时间倒序，需令牌）
 *   GET  /api/tasks/:id      任务详情（含步骤，需令牌）
 */
const express = require('express');
const { OfficialError } = require('./official');

function createLocalApi(cfg, official, pair, alerts) {
  const router = express.Router();

  // 允许直接以 file:// 打开 web/index.html 的浏览器跨域访问（同源托管时无影响）
  router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Device-Token');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      mode: official.mode,
      acpConnected: !!official.acp,
      dataMode: official.describe(),
      uptime: Math.round(process.uptime())
    });
  });

  // 配对码防爆破限速（V2 公网暴露后必需）：
  // 每 IP 每 5 分钟窗口内最多 10 次尝试；失败 5 次即锁定至窗口结束
  const pairAttempts = new Map(); // ip -> { windowStart, count, fails }
  function pairRateLimit(req, res, next) {
    const ip = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const WINDOW = 5 * 60 * 1000;
    let rec = pairAttempts.get(ip);
    if (!rec || now - rec.windowStart > WINDOW) {
      rec = { windowStart: now, count: 0, fails: 0 };
      pairAttempts.set(ip, rec);
    }
    rec.count += 1;
    if (rec.fails >= 5) {
      return res.status(429).json({
        error: { code: 'TOO_MANY_ATTEMPTS', message: '尝试次数过多，请稍后再试（5 分钟窗口）' }
      });
    }
    res.locals.pairRec = rec;
    next();
  }

  router.post('/api/pair', pairRateLimit, (req, res) => {
    const code = req.body && req.body.code;
    const token = pair.pair(code);
    if (!token) {
      if (res.locals.pairRec) res.locals.pairRec.fails += 1;
      return res.status(400).json({
        error: { code: 'INVALID_CODE', message: '配对码无效或已过期，请在电脑端查看最新配对码' }
      });
    }
    res.json({ ok: true, deviceToken: token });
  });

  // 设备令牌校验（token 只存在于电脑端 config.json，手机端仅持有本服务签发的设备令牌）
  function auth(req, res, next) {
    const token = req.get('X-Device-Token') || req.query.token;
    if (!pair.verify(token)) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: '设备未配对或配对已失效，请重新扫码配对' }
      });
    }
    next();
  }

  router.get('/api/tasks', auth, async (req, res, next) => {
    try {
      const tasks = await official.getTasks();
      const sorted = [...tasks].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.json({ tasks: sorted, updatedAt: new Date().toISOString() });
    } catch (e) { next(e); }
  });

  router.get('/api/tasks/:id', auth, async (req, res, next) => {
    try {
      const task = await official.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: '任务不存在' } });
      }
      res.json({ task });
    } catch (e) { next(e); }
  });

  // V2：向任务发送用户消息（手机端输入框 → AI 会话）。带限速：每 IP 每分钟 10 条。
  const msgAttempts = new Map(); // ip -> [timestamps]
  router.post('/api/tasks/:id/messages', auth, async (req, res, next) => {
    try {
      const ip = req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const arr = (msgAttempts.get(ip) || []).filter((t) => now - t < 60 * 1000);
      if (arr.length >= 10) {
        return res.status(429).json({ error: { code: 'TOO_MANY_MESSAGES', message: '发送太频繁，请稍后再试（每分钟 10 条）' } });
      }
      arr.push(now);
      msgAttempts.set(ip, arr);
      const text = req.body && req.body.text;
      const result = await official.sendMessage(req.params.id, text);
      if (!result || !result.ok) {
        return res.status(400).json({ error: { code: 'SEND_FAILED', message: (result && result.error) || '发送失败' } });
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // V3：手机端告警开关/追踪清单同步（localStorage 为 UI 状态源，服务端保存副本供定时器使用）
  router.post('/api/alerts/sync', auth, (req, res) => {
    const b = req.body || {};
    alerts.sync({
      watchlist: Array.isArray(b.watchlist) ? b.watchlist : undefined,
      digestEnabled: b.digestEnabled,
      alertEnabled: b.alertEnabled
    });
    res.json({ ok: true, alerts: alerts.status() });
  });

  // V3：当前告警配置状态（追踪数/开关/间隔）
  router.get('/api/alerts/status', auth, (req, res) => {
    res.json({ alerts: alerts.status() });
  });

  // V3.1：获取服务端追踪清单（服务端为唯一真源，设备进看板时拉取对齐，避免本地旧副本覆盖）
  router.get('/api/alerts/watchlist', auth, (req, res) => {
    res.json({ watchlist: alerts.getWatchlist() });
  });

  // 统一错误处理
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof OfficialError) {
      const map = {
        AUTH_EXPIRED: 401,
        FORBIDDEN: 403,
        BAD_REQUEST: 400,
        OFFICIAL_NOT_CONFIGURED: 503,
        ACP_UNAVAILABLE: 503,
        NOT_IMPLEMENTED: 501
      };
      return res.status(map[err.code] || 502).json({ error: { code: err.code, message: err.message } });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '请求体不是合法 JSON' } });
    }
    console.error('[api] 内部错误:', err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '桥接服务内部错误' } });
  });

  return router;
}

module.exports = createLocalApi;

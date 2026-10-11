'use strict';
/**
 * WebSocket 推送中心
 * - 手机端连接 /ws?token=<设备令牌>，校验通过后加入广播列表
 * - 协议（见详细设计 2.5）：
 *     手机 → 桥接：{type:'subscribe'}、{type:'ping'}
 *     桥接 → 手机：{type:'hello'}、{type:'subscribed'}、
 *                {type:'task_update', task}、{type:'step_update', taskId, index, step}、
 *                {type:'pong'}
 */
const WebSocket = require('ws');

class WsHub {
  constructor(server, pair, cfg) {
    this.wss = new WebSocket.Server({ server, path: '/ws' });
    this.wss.on('connection', (ws, req) => {
      let token = '';
      try {
        const u = new URL(req.url, 'http://localhost');
        token = u.searchParams.get('token') || '';
      } catch (_) { /* 解析失败按未授权处理 */ }
      if (!pair.verify(token)) {
        try { ws.close(4001, 'unauthorized'); } catch (_) {}
        return;
      }
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      try {
        ws.send(JSON.stringify({ type: 'hello', pollIntervalMs: cfg.pollIntervalMs, ts: Date.now() }));
      } catch (_) {}
      ws.on('message', (buf) => {
        let msg;
        try { msg = JSON.parse(String(buf)); } catch (_) { return; }
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'subscribe') {
          ws.subscribed = true;
          try { ws.send(JSON.stringify({ type: 'subscribed', ts: Date.now() })); } catch (_) {}
        } else if (msg.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_) {}
        }
      });
      ws.on('error', () => { try { ws.close(); } catch (_) {} });
    });

    // 心跳：30 秒清理失效连接
    this.hb = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch (_) {}
          return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
      });
    }, 30000);
    if (this.hb.unref) this.hb.unref();
  }

  /** 向所有已连接客户端广播消息 */
  broadcast(type, payload) {
    const data = JSON.stringify(Object.assign({ type, ts: Date.now() }, payload || {}));
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch (_) { /* 单个客户端失败不影响其他 */ }
      }
    }
  }
}

module.exports = WsHub;

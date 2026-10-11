'use strict';
/**
 * V2 配置向导 API（仅限本机访问）
 *
 * 用途：开源项目首次部署时，部署者在电脑浏览器打开
 *   http://127.0.0.1:<port>/setup.html
 * 按引导完成：邮箱 SMTP 推送 → 公网隧道 → 配对策略 → 完成配对。
 * 所有配置保存到部署者自己的 config.json，绝不外传、绝不使用第三方中转。
 *
 * 安全铁律：
 *   - 全部接口仅允许本机回环地址访问（远程请求一律 403）——页面与接口
 *     涉及 SMTP 授权码等敏感凭据，绝不能暴露给局域网/公网
 *   - 授权码/Secret 永不回传前端（只返回 configured 状态与掩码摘要）
 *   - 保存使用白名单字段透传，其余字段一律忽略（防止覆盖 official.token 等）
 */
const express = require('express');
const SmtpClient = require('./smtp');
const { normalizeTo } = require('./smtp');   // 收件地址归一化（多收件人）

/** 是否本机回环请求 */
function isLocalhost(req) {
  const a = req.socket && req.socket.remoteAddress;
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** 邮箱掩码：u***@qq.com（支持逗号分隔多地址，逐个掩码；保留首字符与域名，防偷窥但可辨认） */
function maskMail(s) {
  const list = String(s || '').split(/[,，]/).map((v) => v.trim()).filter(Boolean);
  if (!list.length) return '';
  return list.map((v) => {
    const at = v.indexOf('@');
    if (at <= 0) return '***';
    return v[0] + '***' + v.slice(at);
  }).join(', ');
}

/** 凭据掩码：只显示末 4 位 */
function maskSecret(s) {
  const v = String(s || '');
  return v ? '••••' + v.slice(-4) : '';
}

module.exports = function createSetupApi(deps) {
  /**
   * @param {object} deps
   *   cfg          全局配置（带 save 方法）
   *   apply        () => void  保存后由 bridge 执行的热应用（重建 mailer/wecom/隧道/TTL）
   *   getPairInfo  () => { base, publicUrl, lanUrl, code, pairUrl, qrDataUrl, ttlMinutes, public }
   *                当前连接信息（无活跃配对码时 bridge 会补发新码并自动推送）
   *   log          (level, msg) => void
   */
  const { cfg, apply, getPairInfo, log } = deps;
  const router = express.Router();

  // ── 安全门：非本机请求一律拒绝 ──
  router.use('/api/setup', (req, res, next) => {
    if (!isLocalhost(req)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: '配置向导仅允许在本机（127.0.0.1）访问' } });
    }
    next();
  });

  /** 汇总当前配置状态（凭据掩码） */
  function status() {
    const m = cfg.mailer || {};
    const w = cfg.wecom || {};
    const tunnelCfg = cfg.tunnel || {};
    return {
      setupDone: !!(cfg.setup && cfg.setup.done),
      port: cfg.port,
      mode: cfg.mode,
      mailer: {
        configured: !!(m.smtpHost && m.user && m.pass && m.to),
        smtpHost: m.smtpHost || '',
        smtpPort: Number(m.smtpPort) || 465,
        smtpSecure: m.smtpSecure !== false,
        user: maskMail(m.user),
        to: maskMail(m.to),
        from: m.from || '',  // 发件别名地址（非凭据，回显用于编辑）
        // 已保存的发件配置档案（记忆功能）：授权码只存本机 config.json，绝不回传前端
        saved: (m.saved || []).map((p) => ({
          name: p.name, smtpHost: p.smtpHost, smtpPort: p.smtpPort,
          smtpSecure: p.smtpSecure !== false, user: maskMail(p.user),
          from: p.from || '', hasPass: !!p.pass, savedAt: p.savedAt || ''
        }))
      },
      wecom: {
        configured: !!(w.corpId && w.corpSecret && w.agentId),
        corpId: w.corpId || '',
        agentId: Number(w.agentId) || 0,
        toUser: w.toUser || '@all'
      },
      tunnel: {
        enabled: tunnelCfg.enabled !== false,
        mode: tunnelCfg.mode || 'quick',            // quick=自动测试隧道 / named=固定域名命名隧道
        hostname: tunnelCfg.hostname || '',          // named：看板访问域名（provision 成功后写入）
        tunnelName: tunnelCfg.tunnelName || 'agnes-board',
        hasToken: !!tunnelCfg.tunnelToken,           // 运行令牌是否存在（绝不回传明文）
        binaryAvailable: deps.tunnel ? deps.tunnel._binaryLooksAvailable() : false,
        url: (deps.tunnel && deps.tunnel.url) || null
      },
      pair: { codeTtlMinutes: Number(cfg.pair && cfg.pair.codeTtlMinutes) || 15 },
      alerts: {
        digestIntervalMinutes: Number(cfg.alerts && cfg.alerts.digestIntervalMinutes) || 60,
        digestEnabled: !!(cfg.alerts && cfg.alerts.digestEnabled),
        digestTitle: String((cfg.alerts && cfg.alerts.digestTitle) || ''),
        alertPrefix: String((cfg.alerts && cfg.alerts.alertPrefix) || ''),
        watchCount: (cfg.alerts && Array.isArray(cfg.alerts.watchlist) ? cfg.alerts.watchlist.length : 0),
        alertEnabled: !!(cfg.alerts && cfg.alerts.alertEnabled)
      },
      messages: { enabled: !(cfg.messages && cfg.messages.enabled === false) },
      officialDescribe: deps.official ? deps.official.describe() : ''
    };
  }

  // GET /api/setup/status —— 状态总览
  router.get('/api/setup/status', (req, res) => {
    res.json(status());
  });

  // GET /api/setup/pair-info —— 当前连接信息（完成页展示二维码/配对码）
  router.get('/api/setup/pair-info', async (req, res) => {
    try {
      const info = await getPairInfo();
      res.json(info);
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // POST /api/setup/save —— 白名单字段保存 + 热应用
  router.post('/api/setup/save', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.mailer && typeof b.mailer === 'object') {
      const m = b.mailer;
      const cur = {};
      if (m.smtpHost !== undefined) cur.smtpHost = String(m.smtpHost || '').trim();
      if (m.smtpPort !== undefined) cur.smtpPort = Number(m.smtpPort) || 465;
      if (m.smtpSecure !== undefined) cur.smtpSecure = !!m.smtpSecure;
      if (m.user !== undefined) cur.user = String(m.user || '').trim();
      if (m.pass !== undefined) cur.pass = String(m.pass || '').trim(); // 空串=清除
      if (m.to !== undefined) cur.to = normalizeTo(m.to).join(', ');   // 多收件人归一化存储
      if (m.from !== undefined) cur.from = String(m.from || '').trim(); // 发件别名（留空=同登录名）
      patch.mailer = cur;
    }
    if (b.alerts && typeof b.alerts === 'object') {
      // V3 告警：间隔/任务汇总开关/邮件标题在此配置；追踪清单与告警开关由手机端同步（alerts 模块管理）
      const a = b.alerts;
      const cur = {};
      if (a.digestIntervalMinutes !== undefined) {
        cur.digestIntervalMinutes = Math.min(240, Math.max(10, Number(a.digestIntervalMinutes) || 60));
      }
      if (a.digestEnabled !== undefined) cur.digestEnabled = !!a.digestEnabled;
      if (a.digestTitle !== undefined) cur.digestTitle = String(a.digestTitle || '').trim().slice(0, 50);
      if (a.alertEnabled !== undefined) cur.alertEnabled = !!a.alertEnabled;   // 单任务报警总开关
      if (a.alertPrefix !== undefined) cur.alertPrefix = String(a.alertPrefix || '').trim().slice(0, 30);
      patch.alerts = cur;
    }
    if (b.wecom && typeof b.wecom === 'object') {
      const w = b.wecom;
      const cur = {};
      if (w.corpId !== undefined) cur.corpId = String(w.corpId || '').trim();
      if (w.corpSecret !== undefined) cur.corpSecret = String(w.corpSecret || '').trim();
      if (w.agentId !== undefined) cur.agentId = Number(w.agentId) || 0;
      if (w.toUser !== undefined) cur.toUser = String(w.toUser || '').trim() || '@all';
      patch.wecom = cur;
    }
    if (b.tunnel && typeof b.tunnel === 'object') {
      const t = b.tunnel;
      const cur = {};
      if (t.enabled !== undefined) cur.enabled = !!t.enabled;
      if (t.cloudflaredPath !== undefined) cur.cloudflaredPath = String(t.cloudflaredPath || '').trim();
      if (t.mode !== undefined) cur.mode = t.mode === 'named' ? 'named' : 'quick'; // 双模式：quick=测试隧道 / named=固定域名
      if (t.hostname !== undefined) cur.hostname = String(t.hostname || '').trim().toLowerCase().replace(/\.$/, '');
      if (t.tunnelName !== undefined) cur.tunnelName = String(t.tunnelName || '').trim().slice(0, 50);
      // 注意：tunnelToken 不进白名单 —— 只能由 tunnel-provision 端点写入，防止前端误传覆盖
      patch.tunnel = cur;
    }
    if (b.pair && typeof b.pair === 'object') {
      const p = b.pair;
      if (p.codeTtlMinutes !== undefined) {
        patch.pair = { codeTtlMinutes: Math.min(120, Math.max(5, Number(p.codeTtlMinutes) || 15)) };
      }
    }
    if (b.messages && typeof b.messages === 'object') {
      if (b.messages.enabled !== undefined) patch.messages = { enabled: !!b.messages.enabled };
    }
    try {
      cfg.save(patch);
      if (typeof apply === 'function') apply(); // bridge 热应用（重建推送器/隧道/TTL）
      log('info', '[向导] 配置已保存并热应用');
      res.json({ ok: true, status: status() });
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // POST /api/setup/tunnel-provision —— 命名隧道一键初始化（V3 双模式）
  // 用 Cloudflare API 令牌完成：找 zone → 创建命名隧道 → 创建/更新 CNAME 记录，
  // 成功后保存 {mode:'named', hostname, tunnelName, tunnelToken} 并热重启隧道。
  // apiToken 仅本次调用使用、绝不落盘；tunnelToken 落盘 config.json 但绝不回传前端。
  router.post('/api/setup/tunnel-provision', async (req, res) => {
    const b = req.body || {};
    try {
      if (!deps.tunnel || typeof deps.tunnel.provision !== 'function') {
        return res.status(500).json({ error: { code: 'INTERNAL', message: '隧道模块不可用' } });
      }
      const r = await deps.tunnel.provision({
        apiToken: String(b.apiToken || ''),
        hostname: String(b.hostname || ''),
        tunnelName: String(b.tunnelName || '')
      });
      cfg.save({ tunnel: {
        mode: 'named',
        hostname: r.hostname,
        tunnelName: r.tunnelName,
        tunnelToken: r.token
      } });
      if (typeof apply === 'function') apply(); // 签名变更 → tunnel.restart()（bridge 实现）
      log('info', `[向导] 命名隧道已初始化并切换：${r.hostname}（隧道名 ${r.tunnelName}）`);
      res.json({ ok: true, url: 'https://' + r.hostname, tunnelName: r.tunnelName, status: status() });
    } catch (e) {
      log('warn', `[向导] 命名隧道初始化失败：${e.message}`);
      res.status(400).json({ error: { code: 'PROVISION_FAILED', message: e.message } });
    }
  });

  // POST /api/setup/mail-profiles —— 发件配置档案（记忆/切换/删除）
  // 授权码只存本机 config.json；status() 只回掩码，前端永不接触明文凭据
  router.post('/api/setup/mail-profiles', (req, res) => {
    const b = req.body || {};
    const action = String(b.action || '');
    const cur = cfg.mailer || {};
    try {
      if (action === 'save') {
        const name = String(b.name || '').trim();
        if (!name) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '请填写配置名称' } });
        const f = b.mailer || {};
        // 留空字段一律回退当前生效配置（应用档案后表单只有掩码占位，也能直接存档）
        const user = String(f.user || '').trim() || String(cur.user || '').trim();
        const prof = {
          name,
          smtpHost: String(f.smtpHost || '').trim() || String(cur.smtpHost || '').trim(),
          smtpPort: Number(f.smtpPort) || Number(cur.smtpPort) || 465,
          smtpSecure: f.smtpSecure !== undefined ? !!f.smtpSecure : cur.smtpSecure !== false,
          user,
          // 表单未重填授权码时沿用当前生效的授权码（同账号场景；换账号则必须重填）
          pass: String(f.pass || '').trim() || (user === String(cur.user || '').trim() ? String(cur.pass || '') : ''),
          from: String(f.from !== undefined ? f.from : cur.from || '').trim(),
          savedAt: new Date().toISOString()
        };
        if (!prof.smtpHost || !prof.user || !prof.pass) {
          return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '当前发件配置不完整（需服务器/发件邮箱/授权码），无法保存' } });
        }
        const list = (cur.saved || []).filter((p) => p.name !== name);
        list.push(prof);
        while (list.length > 10) list.shift(); // 最多保留 10 份档案
        cfg.save({ mailer: { saved: list } });
        log('info', `[向导] 已保存发件配置档案「${name}」（${prof.user}）`);
        return res.json({ ok: true, status: status() });
      }
      if (action === 'apply') {
        const name = String(b.name || '').trim();
        const prof = (cur.saved || []).find((p) => p.name === name);
        if (!prof) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '档案不存在' } });
        cfg.save({ mailer: {
          smtpHost: prof.smtpHost, smtpPort: Number(prof.smtpPort) || 465,
          smtpSecure: prof.smtpSecure !== false, user: prof.user, pass: prof.pass,
          from: prof.from || ''
        } });
        if (typeof apply === 'function') apply(); // 热应用（重建推送器）
        log('info', `[向导] 已切换发件配置到「${prof.name}」（${prof.user}）`);
        return res.json({ ok: true, status: status() });
      }
      if (action === 'delete') {
        const name = String(b.name || '').trim();
        const list = (cur.saved || []).filter((p) => p.name !== name);
        cfg.save({ mailer: { saved: list } });
        log('info', `[向导] 已删除发件配置档案「${name}」`);
        return res.json({ ok: true, status: status() });
      }
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '未知 action（save/apply/delete）' } });
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // POST /api/setup/mail-reset —— 重置当前发件配置（清空生效配置，保留已保存档案与收件邮箱）
  router.post('/api/setup/mail-reset', (req, res) => {
    try {
      cfg.save({ mailer: { smtpHost: '', user: '', pass: '', from: '' } }); // to 保留（收发分离）
      if (typeof apply === 'function') apply();
      log('info', '[向导] 已重置发件配置（收件邮箱与已保存档案保留）');
      res.json({ ok: true, status: status() });
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // POST /api/setup/test-mail —— 用表单里的临时配置发测试邮件（不落盘）
  router.post('/api/setup/test-mail', async (req, res) => {
    const m = (req.body && req.body.mailer) || {};
    const cur = cfg.mailer || {};
    // 表单留空的字段回退到当前生效配置（应用档案后无需重填授权码即可测试）
    const host = String(m.smtpHost || '').trim() || String(cur.smtpHost || '').trim();
    const port = Number(m.smtpPort) || Number(cur.smtpPort) || 465;
    const secure = m.smtpSecure !== undefined ? m.smtpSecure !== false : cur.smtpSecure !== false;
    const user = String(m.user || '').trim() || String(cur.user || '').trim();
    const pass = String(m.pass || '').trim() || String(cur.pass || '').trim();
    const to = String(m.to || '').trim() || String(cur.to || '').trim();
    const from = String(m.from || '').trim() || user || String(cur.user || '').trim(); // 发件别名（个别服务器要求授权身份）
    if (!host || !user || !pass || !to) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: '请先完整填写 SMTP 主机、发件邮箱、授权码与收件邮箱' } });
    }
    try {
      const client = new SmtpClient({ host, port, secure, user, pass, envelopeFrom: from });
      await client.sendMail({
        from,
        fromName: 'agent-vigil',
        to,
        subject: '【agent-vigil】测试邮件 · 配置成功',
        html: [
          '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;max-width:520px;margin:0 auto;padding:24px;">',
          '  <h2 style="margin:0 0 8px;">🎉 邮箱推送配置成功</h2>',
          '  <p style="color:#555;font-size:14px;line-height:1.8;">',
          '    这是一封测试邮件。今后配对码 / 公网地址发生变动时，<br>',
          '    桥接服务会把最新连接信息自动发到这个邮箱。',
          '  </p>',
          '  <p style="color:#999;font-size:12px;">本邮件由 agent-vigil 桥接服务发送（部署者自己的邮箱账号）。</p>',
          '</div>'
        ].join('\n')
      });
      log('info', `[向导] 测试邮件已发送至 ${to}`);
      res.json({ ok: true });
    } catch (e) {
      const raw = String(e.message);
      // 554 发件身份不匹配：解析服务器返回的授权身份列表，给出可直接照抄的提示
      const mm = raw.match(/not matching authorized user:?\s*\[([^\]]+)\]/i);
      let msg;
      if (mm) {
        const cands = mm[1].split('||').map((s) => s.trim()).filter(Boolean);
        msg = '该服务器要求发件地址必须是：' + cands.join(' 或 ')
          + '。请在「高级 → 发件地址」中填入其中一个（通常是手机号别名），再点测试。';
      } else {
        msg = /535|530|认证/i.test(raw)
          ? '认证失败：请检查授权码是否正确（授权码不是登录密码，需在邮箱设置里单独生成）'
          : /MAIL FROM/i.test(raw)
            ? '服务器在 MAIL FROM 阶段无响应/断连：多为发件地址不是授权身份（请在「高级 → 发件地址」填手机号别名试试），或该账号发送频率受限（等 30 分钟后再试）'
            : /ETIMEDOUT|ENOTFOUND|超时|连接/i.test(raw)
              ? '连接失败：请检查 SMTP 主机与端口（465=SSL，587=STARTTLS）'
              : raw;
      }
      log('warn', `[向导] 测试邮件失败: ${msg}`);
      res.status(400).json({ error: { code: 'MAIL_FAIL', message: msg } });
    }
  });

  // POST /api/setup/done —— 标记向导完成
  router.post('/api/setup/done', (req, res) => {
    try {
      cfg.save({ setup: { done: true } });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL', message: e.message } });
    }
  });

  return router;
};

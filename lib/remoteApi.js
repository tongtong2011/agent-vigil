'use strict';
/**
 * V2 手机远程配置 API（受限版，令牌鉴权）
 *
 * 用途：用户不在电脑旁时，用手机打开推送邮件里的「远程配置页」链接，
 * 直接修改收件邮箱、切换已保存的发件配置档案、发送测试邮件、调整告警/
 * 配对/隧道等非凭据类配置——不必跑回电脑。页面 /remote.html，接口 /api/remote/*。
 *
 * 安全设计（与完整向导 setup.html 的本机限制互补）：
 *   - 完整向导（改 SMTP 主机/账号/授权码/命名隧道初始化）仍仅限电脑本机 127.0.0.1
 *   - 远程页只暴露「低风险」操作：改收件人 / 切换档案 / 测试邮件 /
 *     告警开关与标题 / 配对码有效期 / 手机发消息开关 / 隧道启停与已初始化模式切换
 *   - 授权码、隧道令牌、Cloudflare API 令牌等凭据永不回传、不可远程修改
 *   - 访问凭据 = 管理令牌（随桥接重启刷新），仅通过推送邮件下发；
 *     能收到推送邮件的人 = 邮箱主人（信任链与配对码一致）
 *   - 授权码永不回传（档案列表只给名称与掩码摘要）
 *   - 令牌比较使用 timingSafeEqual，防时序攻击
 */
const express = require('express');
const crypto = require('crypto');
const { normalizeTo } = require('./smtp');   // 收件地址归一化（多收件人）
const CH = require('./channels');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 邮箱掩码：u***@126.com（支持逗号分隔多地址，逐个掩码） */
function maskMail(s) {
  const list = String(s || '').split(/[,，]/).map((v) => v.trim()).filter(Boolean);
  if (!list.length) return '';
  return list.map((v) => {
    const at = v.indexOf('@');
    if (at <= 0) return '***';
    return v[0] + '***' + v.slice(at);
  }).join(', ');
}

module.exports = function createRemoteApi(deps) {
  /**
   * @param {object} deps
   *   cfg            全局配置（带 save）
   *   log            (level, msg) => void
   *   getToken       () => string  当前管理令牌（bridge 内存态，重启刷新）
   *   getMailer      () => object  当前 MailNotifier 实例
   *   rebuildMailer  () => object  用最新配置重建 MailNotifier（热应用）并返回
   *   kickPush       () => void    立即重推一次连接信息（改收件人/切档案后，新配置马上收到最新码）
   *   apply          () => void    非凭据类设置保存后的统一热应用（向导同款：重建/隧道重启/TTL/告警定时器）
   *   tunnel         TunnelManager 隧道实例（读取当前运行 URL，只写非凭据字段）
   */
  const { cfg, log, getToken, getMailer, rebuildMailer, kickPush, apply, tunnel } = deps;
  const router = express.Router();

  /** 汇总邮箱推送状态（收件人/历史完整回显——它们不是凭据且随邮件明文可见；授权码永不回传） */
  function mailerStatus() {
    const m = cfg.mailer || {};
    const saved = Array.isArray(m.saved) ? m.saved : [];
    const curIdx = saved.findIndex((p) => p.smtpHost === m.smtpHost && p.user === m.user);
    return {
      configured: !!(m.smtpHost && m.user && m.pass && m.to),
      smtpHost: m.smtpHost || '',
      smtpPort: Number(m.smtpPort) || 465,
      smtpSecure: m.smtpSecure !== false,
      user: maskMail(m.user),
      from: m.from ? maskMail(m.from) : '',
      to: m.to || '',
      toHistory: Array.isArray(m.toHistory) ? m.toHistory.slice(0, 10) : [],
      currentProfile: curIdx >= 0 ? saved[curIdx].name : '（自定义，未对应档案）',
      saved: saved.map((p) => ({
        name: p.name, smtpHost: p.smtpHost, smtpPort: p.smtpPort,
        smtpSecure: p.smtpSecure !== false, user: maskMail(p.user), hasPass: !!p.pass
      }))
    };
  }

  // ── 安全门：管理令牌校验（支持 query ?t= 与 body.t）──
  router.use('/api/remote', (req, res, next) => {
    const t = (req.query && req.query.t) || (req.body && req.body.t);
    if (!t || !safeEqual(t, getToken())) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '管理令牌无效或已过期。桥接服务重启后令牌会刷新，请以最新推送邮件里的链接为准。' } });
    }
    next();
  });

  /** 非凭据类设置（绿档）：告警/配对/发消息/隧道——供手机远程页回显与修改 */
  function settingsStatus() {
    const a = cfg.alerts || {};
    const t = cfg.tunnel || {};
    return {
      alerts: {                                  // V4.1：汇总间隔与标题全渠道统一；开关按渠道在 channels 里
        digestIntervalMinutes: CH.digestInterval(cfg),
        digestTitle: String(a.digestTitle || '')
      },
      pair: {
        codeTtlMinutes: Number(cfg.pair && cfg.pair.codeTtlMinutes) || 15    // 配对码有效期
      },
      messages: {
        enabled: !(cfg.messages && cfg.messages.enabled === false)          // 手机发消息开关（默认允许）
      },
      tunnel: (() => {
        const mode = t.mode === 'named' ? 'named' : 'quick';
        const hostname = String(t.hostname || '');
        const canNamed = !!(t.tunnelToken && hostname);
        // named 模式下 tunnel.url 常常不回填，公网地址固定就是 https://<域名>
        const url = (tunnel && tunnel.url) || (mode === 'named' && hostname ? `https://${hostname}` : null);
        return { enabled: t.enabled !== false, mode, hostname, canNamed, url };
      })(),
      // V4.1 分渠道策略（非凭据）：手机远程页可逐渠道开关汇总/报警、改报警前缀
      channels: (() => {
        const out = {};
        const entries = CH.normalizeWatchlist(Array.isArray(cfg.alerts && cfg.alerts.watchlist) ? cfg.alerts.watchlist : []);
        for (const ch of Object.keys(cfg.channels || {})) {
          const c = CH.channelCfg(cfg, ch);
          const raw = (cfg.channels && cfg.channels[ch]) || {};
          // agnes 前缀未显式配置时回显顶层 alerts 的回退值
          const prefixRaw = raw.alertPrefix !== undefined
            ? raw.alertPrefix
            : (ch === CH.DEFAULT_CHANNEL ? String((cfg.alerts && cfg.alerts.alertPrefix) || '') : '');
          out[ch] = {
            displayName: CH.displayNameOf(ch, deps.adapters),
            enabled: c.enabled,
            digestEnabled: c.digestEnabled,
            alertEnabled: c.alertEnabled,
            alertPrefix: String(prefixRaw),
            watchCount: CH.idsForChannel(entries, ch).length
          };
        }
        return out;
      })()
    };
  }

  // GET /api/remote/status?t=xxx —— 状态总览（掩码）
  router.get('/api/remote/status', (req, res) => {
    res.json({ mailer: mailerStatus(), settings: settingsStatus() });
  });

  // POST /api/remote/save-to —— 修改收件邮箱（热应用 + 立即重推最新连接信息 + 记录历史；支持逗号分隔多收件人）
  router.post('/api/remote/save-to', (req, res) => {
    const list = normalizeTo((req.body && req.body.to) || '');
    if (!list.length || list.some((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) {
      return res.status(400).json({ error: { code: 'BAD_TO', message: '收件邮箱格式不正确（多个地址用逗号隔开）' } });
    }
    const to = list.join(', ');
    const cur = cfg.mailer || {};
    // 旧收件人入历史（去重、最多 10 个，新的在前）；历史是收件地址，非凭据
    const history = [cur.to, ...(Array.isArray(cur.toHistory) ? cur.toHistory : [])]
      .filter((v, i, a) => v && v !== to && a.indexOf(v) === i)
      .slice(0, 10);
    cfg.save({ mailer: { to, toHistory: history } });
    rebuildMailer();
    log('info', `[远程配置] 收件邮箱已改为 ${to}（历史 ${history.length} 条），立即重推连接信息`);
    kickPush();
    res.json({ ok: true, mailer: mailerStatus() });
  });

  // POST /api/remote/apply-profile —— 切换到指定发件配置档案（热应用 + 立即重推）
  router.post('/api/remote/apply-profile', (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    const saved = (cfg.mailer && cfg.mailer.saved) || [];
    const p = saved.find((x) => x.name === name);
    if (!p) return res.status(404).json({ error: { code: 'NO_PROFILE', message: '未找到该发件配置档案' } });
    cfg.save({
      mailer: {
        smtpHost: p.smtpHost, smtpPort: p.smtpPort || 465, smtpSecure: p.smtpSecure !== false,
        user: p.user, pass: p.pass || '', from: p.from || ''
      }
    });
    rebuildMailer();
    log('info', `[远程配置] 已切换发件配置 →「${p.name}」（${p.smtpHost} / ${maskMail(p.user)}）`);
    kickPush();
    res.json({ ok: true, mailer: mailerStatus() });
  });

  // POST /api/remote/save-settings —— 非凭据类设置（绿档）：告警/配对有效期/手机发消息/隧道启停与模式
  // 严格白名单 + 限幅；凭据类字段（SMTP 授权码/tunnelToken/API 令牌）一律不接收，收到也忽略
  router.post('/api/remote/save-settings', (req, res) => {
    const b = req.body || {};
    const patch = {};
    const changed = [];
    try {
      if (b.alerts && typeof b.alerts === 'object') {
        // V4.1：汇总间隔与标题全渠道统一；各渠道开关/前缀在 channels 块配置
        const a = b.alerts, cur = {};
        if (a.digestIntervalMinutes !== undefined) {
          cur.digestIntervalMinutes = Math.min(240, Math.max(10, Number(a.digestIntervalMinutes) || 60));
          changed.push(`汇总间隔${cur.digestIntervalMinutes}分钟`);
        }
        if (a.digestTitle !== undefined) {
          const t = String(a.digestTitle || '').trim().slice(0, 50);
          if (t) { cur.digestTitle = t; changed.push('汇总邮件标题'); }
        }
        if (Object.keys(cur).length) patch.alerts = cur;
      }
      // V4.1 分渠道策略：仅汇总/报警开关与报警前缀；渠道键白名单；连接参数/凭据/旧全局字段一律不收
      if (b.channels && typeof b.channels === 'object') {
        const chs = {};
        for (const ch of Object.keys(b.channels)) {
          if (!Object.prototype.hasOwnProperty.call(cfg.channels || {}, ch)) continue; // 不接受未知渠道键
          const s = b.channels[ch];
          if (!s || typeof s !== 'object') continue;
          const cur = {};
          const label = CH.displayNameOf(ch, deps.adapters);
          if (s.enabled !== undefined) cur.enabled = !!s.enabled;
          if (s.alertEnabled !== undefined) { cur.alertEnabled = !!s.alertEnabled; changed.push(`${label}单任务报警${cur.alertEnabled ? '开' : '关'}`); }
          if (s.digestEnabled !== undefined) { cur.digestEnabled = !!s.digestEnabled; changed.push(`${label}任务汇总${cur.digestEnabled ? '开' : '关'}`); }
          if (s.alertPrefix !== undefined) {
            const t = String(s.alertPrefix || '').trim().slice(0, 30);
            if (t) { cur.alertPrefix = t; changed.push(`${label}报警前缀`); }
          }
          if (Object.keys(cur).length) chs[ch] = cur;
        }
        if (Object.keys(chs).length) patch.channels = chs;
      }
      if (b.pair && typeof b.pair === 'object' && b.pair.codeTtlMinutes !== undefined) {
        patch.pair = { codeTtlMinutes: Math.min(120, Math.max(5, Number(b.pair.codeTtlMinutes) || 15)) };
        changed.push(`配对码有效期${patch.pair.codeTtlMinutes}分钟`);
      }
      if (b.messages && typeof b.messages === 'object' && b.messages.enabled !== undefined) {
        patch.messages = { enabled: !!b.messages.enabled };
        changed.push('手机发消息' + (patch.messages.enabled ? '允许' : '关闭'));
      }
      if (b.tunnel && typeof b.tunnel === 'object') {
        const t = b.tunnel, cur = {};
        if (t.enabled !== undefined) { cur.enabled = !!t.enabled; changed.push('公网隧道' + (cur.enabled ? '开' : '关')); }
        if (t.mode !== undefined) {
          const want = t.mode === 'named' ? 'named' : 'quick';
          // 安全闸：切固定域名前必须已在电脑端完成初始化（本机已有令牌+域名），否则拒绝
          if (want === 'named' && !(cfg.tunnel && cfg.tunnel.tunnelToken && cfg.tunnel.hostname)) {
            return res.status(400).json({ error: { code: 'NAMED_NOT_READY', message: '固定域名尚未在电脑端初始化，无法在手机端切换；请先在电脑端向导第 3 步完成初始化' } });
          }
          cur.mode = want;
          changed.push(want === 'named' ? '固定域名隧道' : '自动快速隧道');
        }
        // hostname/tunnelToken/cloudflaredPath 等凭据或本机字段不接收
        patch.tunnel = cur;
      }
      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: { code: 'NO_FIELDS', message: '没有可保存的设置项' } });
      }
      cfg.save(patch);
      if (typeof apply === 'function') apply(); // 向导同款热应用（隧道重启/TTL/告警定时器）
      log('info', `[远程配置] 非凭据设置已保存并热应用：${changed.join('、') || '参数调整'}`);
      res.json({ ok: true, settings: settingsStatus() });
    } catch (e) {
      res.status(500).json({ error: { code: 'INTERNAL', message: e.message } });
    }
  });

  // POST /api/remote/test —— 用当前生效配置发测试邮件
  router.post('/api/remote/test', async (req, res) => {
    const mailer = getMailer();
    try {
      await mailer.sendTestMail();
      log('info', `[远程配置] 测试邮件已发送 → ${maskMail(mailer.to)}`);
      res.json({ ok: true });
    } catch (e) {
      log('warn', `[远程配置] 测试邮件失败: ${e.message}`);
      res.status(502).json({ error: { code: 'TEST_FAIL', message: e.message } });
    }
  });

  return router;
};

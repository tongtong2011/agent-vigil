'use strict';
/**
 * V2 手机远程配置 API（受限版，令牌鉴权）
 *
 * 用途：用户不在电脑旁时，用手机打开推送邮件里的「远程配置页」链接，
 * 直接修改收件邮箱、切换已保存的发件配置档案、发送测试邮件——
 * 不必跑回电脑。页面 /remote.html（静态托管），接口 /api/remote/*。
 *
 * 安全设计（与完整向导 setup.html 的本机限制互补）：
 *   - 完整向导（改 SMTP 主机/账号/授权码/隧道/配对策略）仍仅限电脑本机 127.0.0.1
 *   - 远程页只暴露「低风险」操作：改收件人 / 切换档案 / 测试邮件
 *   - 访问凭据 = 管理令牌（随桥接重启刷新），仅通过推送邮件下发；
 *     能收到推送邮件的人 = 邮箱主人（信任链与配对码一致）
 *   - 授权码永不回传（档案列表只给名称与掩码摘要）
 *   - 令牌比较使用 timingSafeEqual，防时序攻击
 */
const express = require('express');
const crypto = require('crypto');
const { normalizeTo } = require('./smtp');   // 收件地址归一化（多收件人）

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
   */
  const { cfg, log, getToken, getMailer, rebuildMailer, kickPush } = deps;
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

  // GET /api/remote/status?t=xxx —— 状态总览（掩码）
  router.get('/api/remote/status', (req, res) => {
    res.json({ mailer: mailerStatus() });
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

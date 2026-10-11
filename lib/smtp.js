'use strict';
/**
 * 轻量 SMTP 客户端（自研，替代 nodemailer）
 *
 * 背景：实测发现部分非标 SMTP 服务器（如 2925.com 的 .NET 自研实现）在 AUTH 成功后
 * 会重置会话状态，此时直接发 MAIL FROM 会被服务器挂起/断连（nodemailer 报
 * "Connection closed unexpectedly" 的根因）。必须重新 EHLO 后才能进入邮件事务。
 * 本客户端逐条发送、每步等待响应，并在 AUTH 成功后自动重发 EHLO——该行为对
 * 标准 RFC 5321 服务器完全无害（重复 EHLO 合法），对非标服务器则必须。
 *
 * 支持：SSL 直连（465）/ STARTTLS（587）/ AUTH LOGIN / HTML 邮件 / 内嵌图片附件（cid）
 */
const net = require('net');
const tls = require('tls');
const os = require('os');

/** 收件地址归一化：支持中英文逗号分隔多个地址，去空去重，返回数组 */
function normalizeTo(to) {
  const list = String(to || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(list)];
}

class SmtpError extends Error {}

/** EHLO 参数：优先本机主机名（ASCII 时）；含非 ASCII/为空则用本机 IP 地址字面量 */
function ehloName() {
  const h = (os.hostname() || '').trim();
  if (/^[\x21-\x7E]+$/.test(h) && h.length <= 255) return h;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return `[${net.address}]`;
    }
  }
  return '[127.0.0.1]';
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
/** 邮件头非 ASCII 编码（RFC 2047） */
const encHeader = (s) => '=?UTF-8?B?' + b64(s) + '?=';
/** base64 分行（76 字符/行，RFC 2045） */
function b64wrap(content) {
  const s = Buffer.isBuffer(content) ? content.toString('base64') : b64(content);
  return s.replace(/(.{76})/g, '$1\r\n');
}

class SmtpClient {
  /**
   * @param {object} o { host, port, secure, user, pass, timeoutMs?, log? }
   */
  constructor(o) {
    this.host = o.host;
    this.port = Number(o.port) || 465;
    this.secure = o.secure !== false;
    this.user = (o.user || '').trim();
    this.pass = (o.pass || '').trim();
    // 信封发件人（MAIL FROM）：默认同登录名；个别非标服务器要求指定授权身份时传入
    this.envelopeFrom = (o.envelopeFrom || '').trim() || this.user;
    this.timeoutMs = Number(o.timeoutMs) || 20000;
    this.log = o.log || (() => {});
  }

  /** 建立连接（SSL 直连或明文） */
  _connect() {
    return new Promise((resolve, reject) => {
      const onFail = (e) => reject(new SmtpError('SMTP 连接失败: ' + e.message));
      let s;
      if (this.secure) {
        s = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false }, () => resolve(s));
      } else {
        s = net.connect({ host: this.host, port: this.port }, () => resolve(s));
      }
      s.setTimeout(this.timeoutMs + 5000, () => { try { s.destroy(); } catch (_) {} reject(new SmtpError('SMTP 连接超时')); });
      s.once('error', onFail);
    });
  }

  /** 等待一个完整 SMTP 响应；expect 不匹配则抛错 */
  _read(socket, expect, label) {
    return new Promise((resolve, reject) => {
      let buf = '';
      const finish = (fn, v) => {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onErr);
        fn(v);
      };
      const timer = setTimeout(() => finish(reject, new SmtpError(`SMTP ${label || '会话'} 响应超时`)), this.timeoutMs);
      const onData = (d) => {
        buf += d.toString('utf8');
        const lines = buf.split(/\r\n/);
        const last = lines[lines.length - 2]; // 最后一个完整行（末项为空串）
        // 最后一行形如 "250 text"（空格）= 响应结束；"250-xxx" = 还有后续行
        if (!last || !/^\d{3} /.test(last)) return;
        if (last.startsWith(expect)) return finish(resolve, buf.trim());
        finish(reject, new SmtpError(`SMTP ${label || '会话'} 失败（期望 ${expect}）: ${last}`));
      };
      const onErr = (e) => finish(reject, new SmtpError('SMTP 连接错误: ' + e.message));
      socket.on('data', onData);
      socket.on('error', onErr);
    });
  }

  _cmd(socket, line, expect, label) {
    socket.write(line + '\r\n');
    return this._read(socket, expect, label);
  }

  /** EHLO；返回能力文本（用于判断 STARTTLS） */
  async _ehlo(socket, hostname) {
    return this._cmd(socket, `EHLO ${hostname}`, '250', 'EHLO');
  }

  /** STARTTLS 升级（明文连接且服务器支持时）；返回升级后的 socket */
  async _maybeStartTls(socket, ehloResp) {
    if (this.secure || !/STARTTLS/i.test(ehloResp)) return socket;
    await this._cmd(socket, 'STARTTLS', '220', 'STARTTLS');
    return new Promise((resolve, reject) => {
      const s = tls.connect({ socket, rejectUnauthorized: false }, () => resolve(s));
      s.once('error', (e) => reject(new SmtpError('TLS 升级失败: ' + e.message)));
    });
  }

  /** AUTH LOGIN（两步交互） */
  async _auth(socket) {
    if (!this.user || !this.pass) return; // 无认证（内网中继等场景）
    await this._cmd(socket, 'AUTH LOGIN', '334', 'AUTH');
    await this._cmd(socket, b64(this.user), '334', 'AUTH 用户名');
    await this._cmd(socket, b64(this.pass), '235', 'AUTH 认证');
  }

  /**
   * 发送邮件
   * @param {object} o { from(地址), fromName(显示名，可中文), to, subject, html, attachments?: [{filename, contentType, content(Buffer), cid}] }
   */
  async sendMail(o) {
    const rcpts = normalizeTo(o.to);                     // 支持逗号分隔多收件人
    if (!rcpts.length) throw new Error('收件地址为空');
    const socket = await this._connect();
    const tag = `→ ${rcpts.join(', ')}`;
    try {
      socket.removeAllListeners('error');
      socket.on('error', () => {});
      await this._read(socket, '220', '问候');           // 服务器 220 横幅
      const hostname = ehloName();                      // 主机名/地址字面量（部分服务器对 localhost 敏感）
      const ehlo = await this._ehlo(socket, hostname);
      const upgraded = await this._maybeStartTls(socket, ehlo);
      if (upgraded !== socket) {
        socket = upgraded;
        socket.on('error', () => {});
        await this._ehlo(socket, hostname);             // TLS 升级后必须重新 EHLO
      }
      await this._auth(socket);
      // ★ 非标服务器兼容：AUTH 后会话状态被重置，必须重新 EHLO（重复 EHLO 对标准服务器无害）
      await this._ehlo(socket, hostname);
      await this._cmd(socket, `MAIL FROM:<${this.envelopeFrom}>`, '250', 'MAIL FROM');
      // 多收件人逐个 RCPT：单个被拒（地址错误/对方服务器拒收）不拖垮整封邮件，全部被拒才算失败
      const delivered = [];
      for (const r of rcpts) {
        try {
          await this._cmd(socket, `RCPT TO:<${r}>`, '250', `RCPT TO ${r}`);
          delivered.push(r);
        } catch (e) {
          this.log('warn', `[SMTP] 收件人被拒：${r}（${e.message}）`);
        }
      }
      if (!delivered.length) throw new Error(`所有收件人均被拒绝：${rcpts.join(', ')}`);
      await this._cmd(socket, 'DATA', '354', 'DATA');
      const msg = this._buildMessage({ ...o, to: delivered.map((r) => `<${r}>`).join(', ') });
      socket.write(msg + '\r\n.\r\n');                  // 结束点号
      await this._read(socket, '250', '投递');
      this.log('info', `[SMTP] 已投递 ${tag}`);
      return { ok: true };
    } finally {
      // 优雅收尾：发 QUIT 并给服务器留出释放会话的时间（部分服务器按账号维护
      // 发送会话表，粗暴断开可能占住名额导致后续 MAIL FROM 被断连）
      try { socket.write('QUIT\r\n'); } catch (_) {}
      await new Promise((r) => setTimeout(r, 500)).catch(() => {});
      try { socket.destroy(); } catch (_) {}
    }
  }

  /** 组装 MIME 报文（HTML + 可选内嵌图片，全部 base64 传输编码，规避 8bit/点号问题） */
  _buildMessage(o) {
    const fromName = o.fromName ? encHeader(o.fromName) + ' ' : '';
    const fromAddr = o.from || this.envelopeFrom;
    const domain = (fromAddr.split('@')[1] || 'localhost').replace(/[^\w.-]/g, '');
    const msgId = `<${Date.now()}.${process.pid}.${Math.random().toString(36).slice(2, 8)}@${domain}>`;
    const headers = [
      `From: ${fromName}<${fromAddr}>`,
      `To: ${o.to}`,
      `Subject: ${encHeader(o.subject || '')}`,
      'MIME-Version: 1.0',
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${msgId}`
    ];
    const atts = o.attachments || [];
    let body;
    if (!atts.length) {
      headers.push('Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '');
      body = b64wrap(o.html || '');
    } else {
      const b = '----=_Part_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      headers.push(`Content-Type: multipart/related; boundary="${b}"`, '');
      const parts = [
        `--${b}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64wrap(o.html || '')
      ];
      for (const a of atts) {
        parts.push(
          `--${b}`,
          `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename || 'file'}"`,
          'Content-Transfer-Encoding: base64',
          `Content-ID: <${a.cid || a.filename}>`,
          `Content-Disposition: inline; filename="${a.filename || 'file'}"`,
          '',
          b64wrap(a.content)
        );
      }
      parts.push(`--${b}--`, '');
      body = parts.join('\r\n');
    }
    // dot-stuffing：行首点加倍（DATA 结束符冲突防护）
    return (headers.join('\r\n') + '\r\n\r\n' + body).replace(/\r\n\./g, '\r\n..');
  }
}

module.exports = SmtpClient;
module.exports.normalizeTo = normalizeTo;

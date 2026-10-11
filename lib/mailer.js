'use strict';
/**
 * 邮箱 SMTP 推送模块（V2 主推送通道，可选）
 *
 * 用途：配对码 / 公网地址变动时，发送邮件到用户指定收件箱（手机邮件 App 可实时收到通知）。
 * 原则：免费、无需企业资质、无审核、官方 SMTP 接口零封号风险；开源部署者各自配自己的邮箱。
 *
 * 配置（config.json，全部留空 = 功能关闭，调用安静返回 false，不影响服务）：
 *   mailer: {
 *     smtpHost: 'smtp.qq.com',     // QQ 邮箱；163 用 smtp.163.com，Gmail 用 smtp.gmail.com
 *     smtpPort: 465,               // SSL 端口；587 = STARTTLS（smtpSecure 置 false）
 *     smtpSecure: true,
 *     user: 'you@qq.com',          // 发件邮箱
 *     pass: '你的SMTP授权码',       // 不是登录密码！QQ/163 在邮箱设置里开通 SMTP 后生成授权码
 *     to: 'you@qq.com'             // 收件邮箱（可逗号分隔多个地址；可填同一个邮箱，自己发给自己）
 *   }
 *
 * 邮件内容：访问地址 + 配对码 + 内嵌二维码图（手机点链接或扫码均可进入看板）。
 *
 * 【为何不用 nodemailer】实测部分非标 SMTP 服务器（如 2925.com 的 .NET 自研实现）
 * 在 AUTH 成功后重置会话状态，MAIL FROM 被挂起，nodemailer 会报
 * "Connection closed unexpectedly"。自研客户端（lib/smtp.js）在 AUTH 后自动重发
 * EHLO，已实测打通。见 CHANGELOG V2 修复记录。
 */
const SmtpClient = require('./smtp');

class MailNotifier {
  constructor(cfg, log) {
    const m = (cfg && cfg.mailer) || {};
    this.host = (m.smtpHost || '').trim();
    this.port = Number(m.smtpPort) || 465;
    this.secure = m.smtpSecure !== false; // 默认 SSL
    this.user = (m.user || '').trim();
    this.pass = (m.pass || '').trim();
    this.to = (m.to || '').trim();
    // 发件地址（信封 MAIL FROM 与 From 头一致使用）。个别非标服务器（如 2925.com）
    // 要求发件地址必须是授权身份之一（手机号别名），登录名不可用 —— 用 from 覆盖
    this.from = (m.from || '').trim() || this.user;
    this.log = log || (() => {});
    this._lastSentAt = 0;
  }

  get configured() {
    return !!(this.host && this.user && this.pass && this.to);
  }

  /**
   * 发送连接信息邮件
   * @param {object} p { title, code, url, pairUrl, public, ttlMinutes, qrDataUrl }
   * @returns {Promise<boolean>} 是否成功（未配置/失败均返回 false，不抛异常）
   */
  async sendPairInfo(p) {
    if (!this.configured) return false;
    const gap = 1000 - (Date.now() - this._lastSentAt); // SMTP 限速：1 秒/封
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    const modeText = p.public ? '公网模式：手机在任何网络都能访问' : '局域网模式：手机需与电脑同一 WiFi';
    const ttlText = `配对码 ${p.ttlMinutes || 15} 分钟内有效且仅可使用一次，过期或使用后会自动推送新码。`;
    const seqText = p.seq ? `第 ${p.seq} 次生成` : '';
    const timeText = p.sendTime ? `发送时间：${p.sendTime}（电脑本机时间，与邮件收件时间可能有差异，以此为准）` : '';
    const html = [
      '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;max-width:560px;margin:0 auto;padding:24px;">',
      '  <h2 style="margin:0 0 8px;">agent-vigil · 连接信息</h2>',
      `  <p style="color:#666;margin:0 0 4px;font-size:13px;">${[seqText, timeText].filter(Boolean).join(' · ')}</p>`,
      `  <p style="color:#666;margin:0 0 20px;font-size:13px;">${ttlText}</p>`,
      '  <div style="background:#f0f5ff;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px;">',
      `    <div style="font-size:13px;color:#555;">配对码</div>`,
      `    <div style="font-size:40px;font-weight:700;letter-spacing:8px;color:#1a66ff;margin:8px 0;">${p.code}</div>`,
      `    <div style="font-size:12px;color:#888;">${modeText}</div>`,
      '  </div>',
      `  <p><a href="${p.pairUrl}" style="display:block;background:#1a66ff;color:#fff;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-size:16px;">点击打开看板</a></p>`,
      `  <p style="font-size:13px;color:#666;word-break:break-all;">或复制地址到手机浏览器：<br><code>${p.pairUrl}</code></p>`,
      // 前置条件提醒：ACP 未连接（未检测到爱思办公进程）时附加警告 + 电脑端配置向导提示
      p.acpWarning ? [
        '  <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 16px;margin:0 0 16px;">',
        '    <div style="font-size:13px;font-weight:600;color:#9a3412;">⚠ 前置条件提醒</div>',
        `    <p style="font-size:13px;color:#7c2d12;margin:6px 0 0;line-height:1.6;">${p.acpWarning}</p>`,
        ...(p.setupUrl ? [
          `    <p style="font-size:13px;color:#7c2d12;margin:8px 0 2px;line-height:1.6;">${p.setupHint || ''}</p>`,
          `    <p style="font-size:12px;color:#9a3412;word-break:break-all;margin:0;"><code>${p.setupUrl}</code></p>`
        ] : []),
        '  </div>'
      ].join('\n') : '',
      p.qrDataUrl ? '  <p style="text-align:center;"><img src="cid:pairqr" alt="配对二维码" width="180" style="border:1px solid #eee;border-radius:8px;"></p>' : '',
      // 第二区块：手机远程配置页（带管理令牌的链接 + 二维码，手机上直接改收件人/切换发件档案）
      p.remoteUrl ? [
        '  <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">',
        '  <div style="background:#f0faf4;border-radius:12px;padding:16px;text-align:center;">',
        '    <div style="font-size:14px;font-weight:600;color:#166534;">⚙️ 手机远程配置</div>',
        '    <div style="font-size:12px;color:#888;margin:4px 0 10px;">扫码或点击可在手机上修改收件邮箱、切换发件配置档案、发测试邮件。<br>链接含管理令牌，请勿转发给他人。</div>',
        `    <a href="${p.remoteUrl}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:14px;">打开远程配置页</a>`,
        `    <p style="font-size:12px;color:#999;word-break:break-all;margin:10px 0 8px;"><code>${p.remoteUrl}</code></p>`,
        p.remoteQr ? '<img src="cid:remoteqr" alt="远程配置二维码" width="140" style="border:1px solid #eee;border-radius:8px;">' : '',
        '  </div>'
      ].join('\n') : '',
      '  <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">',
      `  <p style="font-size:12px;color:#999;">本邮件由 agent-vigil 桥接服务自动发送（只读工具，与爱思办公官方无关）。若非本人操作请忽略。</p>`,
      '</div>'
    ].filter(Boolean).join('\n');

    // 邮件标题带发送时间戳（紧凑格式 20261006-145308），邮件列表里直接辨认新旧
    const ts = p.sendTime ? p.sendTime.replace(/-|:/g, '').replace(' ', '-') : '';
    const subjParts = [p.title || `看板配对码 ${p.code}`];
    if (p.seq) subjParts.push(`第 ${p.seq} 次`);
    if (ts) subjParts.push(ts);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = new SmtpClient({
          host: this.host, port: this.port, secure: this.secure,
          user: this.user, pass: this.pass, envelopeFrom: this.from, log: this.log
        });
        await client.sendMail({
          from: this.from,
          fromName: 'agent-vigil',
          to: this.to,
          subject: subjParts.join(' · '),
          html,
          attachments: [
            ...(p.qrDataUrl ? [{ filename: 'pair-qr.png', contentType: 'image/png', content: Buffer.from(p.qrDataUrl.split(',')[1], 'base64'), cid: 'pairqr' }] : []),
            ...(p.remoteQr ? [{ filename: 'remote-qr.png', contentType: 'image/png', content: Buffer.from(p.remoteQr.split(',')[1], 'base64'), cid: 'remoteqr' }] : [])
          ]
        });
        this._lastSentAt = Date.now();
        return true;
      } catch (e) {
        if (attempt === 1) {
          this.log('warn', `[邮件] 发送失败（不影响桥接服务）: ${e.message}`);
          return false;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return false;
  }

  /**
   * 发送测试邮件（配置验证；远程配置页与向导测试按钮共用）。
   * 成功 resolve，失败抛异常（调用方展示具体原因）。
   */
  async sendTestMail() {
    if (!this.configured) throw new Error('邮箱推送未配置完整（服务器/账号/授权码/收件人）');
    const gap = 1000 - (Date.now() - this._lastSentAt); // SMTP 限速：1 秒/封
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const html = [
      '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;max-width:560px;margin:0 auto;padding:24px;">',
      '  <h2 style="margin:0 0 12px;">agent-vigil · 测试邮件</h2>',
      `  <p style="color:#333;font-size:14px;margin:0 0 6px;">发送时间：${now}（电脑本机时间）</p>`,
      `  <p style="color:#666;font-size:13px;margin:0 0 6px;">发件服务：${this.host}:${this.port}（${this.secure ? 'SSL' : 'STARTTLS'}）</p>`,
      `  <p style="color:#666;font-size:13px;margin:0;">发件账号：${this.from}</p>`,
      '  <p style="color:#16a34a;font-size:14px;margin:16px 0 0;">✅ 收到这封邮件说明邮箱推送配置可用。</p>',
      '</div>'
    ].join('\n');
    const client = new SmtpClient({
      host: this.host, port: this.port, secure: this.secure,
      user: this.user, pass: this.pass, envelopeFrom: this.from, log: this.log
    });
    await client.sendMail({
      from: this.from, fromName: 'agent-vigil', to: this.to,
      subject: `agent-vigil · 测试邮件 · ${now.replace(/-|:/g, '').replace(' ', '-')}`,
      html, attachments: []
    });
    this._lastSentAt = Date.now();
  }

  /** V3 新邮件类型通用发送：限速 + 一次重试；成功 true，失败/未配置 false（不抛异常） */
  async _send(subject, html) {
    if (!this.configured) return false;
    const gap = 1000 - (Date.now() - this._lastSentAt); // SMTP 限速：1 秒/封
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const client = new SmtpClient({
          host: this.host, port: this.port, secure: this.secure,
          user: this.user, pass: this.pass, envelopeFrom: this.from, log: this.log
        });
        await client.sendMail({ from: this.from, fromName: 'agent-vigil', to: this.to, subject, html, attachments: [] });
        this._lastSentAt = Date.now();
        return true;
      } catch (e) {
        if (attempt === 1) {
          this.log('warn', `[邮件] 发送失败（不影响桥接服务）: ${e.message}`);
          return false;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return false;
  }

  /** V3：阻塞告警邮件（单任务出现异常 / 待用户确认，及时通知；标题 = 前缀 + 任务名） */
  async sendAlert(p) {
    const isErr = p.state === '异常';
    const icon = isErr ? '🚨' : '⏸️';
    const color = isErr ? '#dc2626' : '#b45309';
    const bg = isErr ? '#fdecec' : '#fdf6ec';
    const html = [
      '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;max-width:560px;margin:0 auto;padding:24px;">',
      `  <h2 style="margin:0 0 8px;">${icon} 任务告警 · ${p.state}</h2>`,
      `  <p style="color:#666;font-size:13px;margin:0 0 16px;">${p.sendTime ? '发送时间：' + p.sendTime + '（电脑本机时间）' : ''}</p>`,
      `  <div style="background:${bg};border-radius:12px;padding:16px 18px;margin-bottom:16px;">`,
      `    <div style="font-size:15px;font-weight:600;color:${color};">${p.state}：${p.taskTitle}</div>`,
      p.msg ? `    <div style="font-size:13px;color:#555;margin-top:8px;">最新消息（${p.msg.role || '—'}）：${p.msg.text}</div>` : '',
      '  </div>',
      `  <p style="font-size:13px;color:#666;">该任务已被你设为「邮件追踪」，出现阻塞（异常或等待确认）时自动发此邮件；任务恢复后再次阻塞会重新通知。</p>`,
      p.url ? `  <p><a href="${p.url}" style="display:block;background:#1a66ff;color:#fff;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-size:15px;">打开看板处理</a></p>` : '',
      '  <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">',
      '  <p style="font-size:12px;color:#999;">本邮件由 agent-vigil 桥接服务自动发送（只读工具，与爱思办公官方无关）。</p>',
      '</div>'
    ].filter(Boolean).join('\n');
    return this._send(`${p.alertPrefix || '单任务报警-'}${p.taskTitle}`, html);
  }

  /** V3：定时统计邮件（被追踪任务汇总表格） */
  async sendDigest(p) {
    const rows = (p.rows || []).map((r) => {
      const color = r.label === '异常' ? '#dc2626' : r.label === '待确认' ? '#b45309' : r.label === '执行完成' ? '#16a34a' : '#2563eb';
      return [
        '  <tr>',
        `    <td style="padding:9px 10px;border-bottom:1px solid #eee;font-size:13.5px;">${r.title}</td>`,
        `    <td style="padding:9px 10px;border-bottom:1px solid #eee;font-size:13px;color:${color};white-space:nowrap;">${r.label}</td>`,
        `    <td style="padding:9px 10px;border-bottom:1px solid #eee;font-size:12.5px;color:#666;">${r.msg && r.msg.text ? (r.msg.role ? '<b>' + r.msg.role + '：</b>' : '') + r.msg.text : '（暂无消息）'}</td>`,
        '  </tr>'
      ].join('\n');
    }).join('\n');
    const html = [
      '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;max-width:640px;margin:0 auto;padding:24px;">',
      '  <h2 style="margin:0 0 8px;">📊 看板任务定时统计</h2>',
      `  <p style="color:#666;font-size:13px;margin:0 0 16px;">${p.sendTime ? '发送时间：' + p.sendTime + '（电脑本机时间）' : ''} · 每 ${p.intervalMin || 60} 分钟汇总一次被追踪任务</p>`,
      '  <table style="width:100%;border-collapse:collapse;background:#fff;">',
      '    <thead><tr>',
      '      <th style="text-align:left;padding:9px 10px;border-bottom:2px solid #e5e7eb;font-size:12.5px;color:#888;">任务</th>',
      '      <th style="text-align:left;padding:9px 10px;border-bottom:2px solid #e5e7eb;font-size:12.5px;color:#888;">状态</th>',
      '      <th style="text-align:left;padding:9px 10px;border-bottom:2px solid #e5e7eb;font-size:12.5px;color:#888;">最新反馈消息</th>',
      '    </tr></thead>',
      rows || `  <tr><td colspan="3" style="padding:14px 10px;font-size:13px;color:#999;">本轮 ${p.unchanged || 0} 个被追踪任务均无变化（状态与上次汇总一致）</td></tr>`,
      '  </table>',
      rows.length && p.unchanged > 0 ? `  <p style="color:#999;font-size:12px;margin:8px 0 0;">另有 ${p.unchanged} 个被追踪任务本轮无变化，未列出。</p>` : '',
      p.url ? `  <p style="margin-top:16px;"><a href="${p.url}" style="display:block;background:#1a66ff;color:#fff;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-size:15px;">打开看板查看</a></p>` : '',
      '  <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">',
      '  <p style="font-size:12px;color:#999;">本邮件由 agent-vigil 桥接服务自动发送（只读工具，与爱思办公官方无关）。间隔可在配置向导调整。</p>',
      '</div>'
    ].filter(Boolean).join('\n');
    return this._send(String(p.digestTitle || '任务汇总邮件'), html);
  }

  describe() {
    if (this.configured) return `已配置（${this.user} → ${this.to}）`;
    return '未配置（推送关闭）';
  }

  /** 异常说明邮件：定时统计时 Agnes 本地服务不可用，抓不到任何任务状态（比空表邮件有信息量） */
  async sendAcpDown(p) {
    const html = [
      '<div style="font-family:-apple-system,Segoe UI,PingFang SC,sans-serif;max-width:640px;margin:0 auto;padding:24px;">',
      '  <h2 style="margin:0 0 8px;color:#dc2626;">⚠️ 看板异常：Agnes 本地服务不可用</h2>',
      `  <p style="color:#666;font-size:13px;margin:0 0 14px;">${p.sendTime ? '发现时间：' + p.sendTime + '（电脑本机时间）' : ''}</p>`,
      '  <div style="background:#fdecec;border:1px solid #f5c2c2;border-radius:10px;padding:14px 16px;font-size:13.5px;color:#7a1f1f;line-height:1.9;">',
      '    本轮定时统计时，<b>无法从爱思办公本地服务获取任何任务的状态与消息</b>（连接被拒绝或无响应），所以本轮没有统计内容。',
      '    在服务恢复前，看板上的任务列表和详情将不可用（或停留旧数据），任务也不会有新的状态反馈。',
      '  </div>',
      '  <p style="font-size:13.5px;color:#333;margin:14px 0 6px;"><b>可能的原因（按常见程度）：</b></p>',
      '  <ul style="margin:0;padding-left:22px;font-size:13px;color:#666;line-height:2;">',
      '    <li>爱思办公客户端被关闭，或正在重启（本地 agent host 服务随之退出）</li>',
      '    <li>客户端后台的 agent host 服务崩溃或被更新中断</li>',
      '    <li><b>账号积分耗尽</b>：服务端截断了任务执行，agent 对任何消息都不再响应——请到爱思办公客户端确认账户状态</li>',
      '  </ul>',
      '  <div style="background:#f0f5ff;border-radius:10px;padding:12px 14px;font-size:13px;color:#3b5aa0;margin:14px 0;line-height:1.8;">',
      '    处理建议：打开/重启爱思办公客户端并确认已登录（积分未耗尽）。桥接服务每分钟会自动重连，',
      '    服务恢复后<b>下一轮定时统计将自动恢复正常</b>，无需重启本服务。',
      '  </div>',
      p.url ? `  <p style="margin-top:16px;"><a href="${p.url}" style="display:block;background:#1a66ff;color:#fff;text-align:center;padding:12px;border-radius:8px;text-decoration:none;font-size:15px;">打开看板查看</a></p>` : '',
      '  <hr style="border:none;border-top:1px solid #eee;margin:20px 0;">',
      '  <p style="font-size:12px;color:#999;">本邮件由 agent-vigil 桥接服务自动发送（只读工具，与爱思办公官方无关）。</p>',
      '</div>'
    ].filter(Boolean).join('\n');
    return this._send('看板异常-Agnes 本地服务不可用', html);
  }
}

module.exports = MailNotifier;

'use strict';
/**
 * agent-vigil · 桥接服务入口（MVP 实验版，只读）
 *
 * 运行：npm install && node bridge.js（默认监听 0.0.0.0:8787）
 * 启动后在控制台展示二维码（含地址 + 一次性配对码），手机扫码或手动输入即可连接。
 *
 * 职责：
 *   1. 托管手机端 PWA 静态页面（web/）
 *   2. 本地 HTTP API（见 lib/localApi.js）
 *   3. WebSocket 实时推送（见 lib/wsHub.js）：轮询官方客户端检测变化，
 *      以 task_update / step_update 推送给手机端
 *   4. 二维码配对（见 lib/pair.js）
 *
 * 只读铁律：对官方接口仅做读取；token 只存在于电脑端 config.json。
 */
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');

const cfg = require('./lib/config');
const OfficialClient = require('./lib/official');
const PairManager = require('./lib/pair');
const WsHub = require('./lib/wsHub');
const createLocalApi = require('./lib/localApi');
const createSetupApi = require('./lib/setupApi');
const createRemoteApi = require('./lib/remoteApi');
const AlertManager = require('./lib/alerts');
const TunnelManager = require('./lib/tunnel');
const WecomNotifier = require('./lib/wecom');
const MailNotifier = require('./lib/mailer');

const WEB_DIR = path.join(__dirname, 'web');

/** 统一日志前缀 */
function logf(level, msg) {
  const tag = { info: '[信息]', warn: '[警告]', error: '[错误]' }[level] || '[信息]';
  console.log(`${tag} ${msg}`);
}

/** 获取局域网 IPv4 地址，用于拼接手机访问地址 */
function lanIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

/** 列表推送仅携带摘要字段（不含 steps），减少流量 */
function pickTask(t) {
  return { id: t.id, title: t.title, status: t.status, progress: t.progress, createdAt: t.createdAt };
}

/** 服务器本机时间（YYYY-MM-DD HH:mm:ss），随推送写入邮件，供用户对齐两端时钟 */
function fmtNow(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function main() {
  const official = new OfficialClient(cfg);
  const pair = new PairManager({ ttlMinutes: cfg.pair && cfg.pair.codeTtlMinutes });
  const tunnel = new TunnelManager(cfg, logf);
  // V3 双模式：隧道配置签名（任一字段变更 → tunnel.restart() 热切换 quick/named）
  const tunnelSig = () => {
    const t = cfg.tunnel || {};
    return [t.enabled, t.mode, t.hostname, t.tunnelToken, t.cloudflaredPath].join('|');
  };
  let lastTunnelSig = tunnelSig();
  let mailer = new MailNotifier(cfg, logf);   // let：配置向导保存后热重建
  let wecom = new WecomNotifier(cfg, logf);   // let：同上
  const log = logf;
  // 手机远程配置页管理令牌（内存态：桥接重启刷新，仅通过推送邮件下发；
  // 手机可改收件人/切换发件档案，改授权码等敏感操作仍限本机向导）
  const remoteToken = crypto.randomBytes(16).toString('hex');
  // 本机排查用：打印远程配置页完整链接（仅控制台可见，等同本机权限，勿截图外传）
  const remoteLinkLocal = `http://127.0.0.1:${cfg.port}/remote.html?t=${remoteToken}`;

  // 先发现并连接爱思办公本地后端（失败不阻塞启动，轮询期自动重试恢复）。
  // 未检测到爱思办公进程时看板为空（绝不显示演示假数据），下方醒目警告告知用户。
  try {
    await official.init(log);
  } catch (e) {
    log('warn', `[ACP] 初始化失败，将自动重试恢复: ${e.message}`);
  }
  if (!official.acp) {
    log('warn', '┌──────────────────────────────────────────────');
    log('warn', '⚠ 未检测到爱思办公（agnesd）本地服务');
    log('warn', '  桥接服务继续运行，但取不到任务数据，看板显示为空。');
    log('warn', '  请先启动爱思办公桌面应用（内置 AI 后端 agnesd），');
    log('warn', '  桥接服务会自动发现并连接，无需重启。');
    log('warn', '└──────────────────────────────────────────────');
  }

  // V3 任务告警：手机端同步开关/追踪清单 → 定时统计邮件 + 阻塞（异常/待确认）即时告警
  const alerts = new AlertManager({
    cfg, official,
    getMailer: () => mailer,   // getter：故障转移/向导热重建后拿最新实例
    // 看板链接带当前配对码：未配对设备（如收到告警邮件的手机）点击即自动配对进入，
    // 不必停在配对页；已配对设备侧会忽略 code 直接进（见 app.js 处理）
    getBaseUrl: () => {
      const base = tunnel.url || `http://${lanIP()}:${cfg.port}`;
      const code = pair.currentCode();
      return code ? `${base}/?code=${code}` : base;
    },
    log
  });
  alerts.start();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  // 静态资源强制协商缓存：no-cache+private 双保险。
  // 裸 express.static 时 Cloudflare 会给 .js/.css 默认 4 小时边缘+浏览器强缓存（no-cache 会被
  // CF 当作"无有效头"回退到 zone 默认 4h；private 则明确不缓存），导致前端改动后浏览器（含无痕）看不到更新
  app.use(express.static(WEB_DIR, {
    etag: true,
    lastModified: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-cache, max-age=0')
  }));
  app.use(createLocalApi(cfg, official, pair, alerts));
  // V2 配置向导：仅允许本机 127.0.0.1 访问（模块内有安全门），页面 /setup.html 走静态托管
  app.use(createSetupApi({
    cfg, official, tunnel, pair,
    getPairInfo,
    apply: applySetupChanges,
    log
  }));
  // V2 手机远程配置（页面 /remote.html 静态托管；接口令牌鉴权，仅低风险操作）
  app.use(createRemoteApi({
    cfg, log,
    getToken: () => remoteToken,
    getMailer: () => mailer,
    rebuildMailer: () => { mailer = new MailNotifier(cfg, logf); return mailer; },
    kickPush
  }));

  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
    }
    res.status(404).send('Not Found');
  });

  const server = http.createServer(app);
  const hub = new WsHub(server, pair, cfg);

  // ===== V2：配对信息推送（邮箱 SMTP 主通道 + 企业微信可选）+ Cloudflare 隧道 =====
  // 触发源：隧道 URL 就绪/变化、配对码生成（首次启动或过期自动刷新）。
  // 去抖合并：30 秒窗口内的多次变动合并为一条推送（首推尽快，等待隧道最长 20 秒）。
  const pushEnabled = () => !!(mailer.configured || wecom.configured);
  let latestCode = null;
  let pushedOnce = false;
  let pushTimer = null;
  let codeSeq = 0; // 本次启动以来第 N 次生成配对码（邮件/页面/控制台三方同步显示，便于回溯对齐）
  let pushRetry = 0; // 推送失败自动重试计数（成功或新码后清零）
  let mailFails = 0; // 邮箱通道连续失败计数（≥2 次且有其他档案时自动故障转移）
  // 上次成功推送的内容签名（公网地址|配对码）。命名隧道地址固定，cloudflared 断连重连会
  // 反复触发 tunnel.onChange → 若不比对会向邮箱重复轰炸相同邮件（实测连发 5 封）
  let lastPushSig = '';

  /**
   * 邮箱通道故障转移：当前发件配置连续失败时，自动切换到下一份已存档案
   * （档案在向导里保存，收件人通常相同——哪套 SMTP 活着都能把推送送到同一邮箱）。
   * @returns {boolean} 是否完成切换
   */
  function switchMailProfile() {
    const m = cfg.mailer || {};
    const saved = Array.isArray(m.saved) ? m.saved : [];
    if (!saved.length) return false;
    const idx = saved.findIndex((p) => p.smtpHost === m.smtpHost && p.user === m.user);
    const next = saved[(idx + 1) % saved.length]; // 当前不在档案列表也从第一份开始轮
    cfg.save({
      mailer: {
        smtpHost: next.smtpHost, smtpPort: next.smtpPort || 465, smtpSecure: next.smtpSecure !== false,
        user: next.user, pass: next.pass || '', from: next.from || ''
      }
    });
    mailer = new MailNotifier(cfg, logf);
    log('warn', `[推送] 邮箱连续失败，已自动切换发件配置 →「${next.name}」（${next.smtpHost} / ${next.user}），立即重试`);
    return mailer.configured;
  }

  /**
   * V2 配置向导完成页取连接信息。当前码已被使用/过期时补发新码
   * （issueCode 会触发 onCodeIssued → 自动推送到邮箱，符合「有变动就推」）。
   */
  async function getPairInfo() {
    if (!pair.isActive(latestCode)) pair.issueCode();
    const lanUrl = `http://${lanIP()}:${cfg.port}`;
    const base = tunnel.url || lanUrl;
    const pairUrl = `${base}/?code=${latestCode}`;
    let qrDataUrl = null;
    try { qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 2, width: 360 }); } catch (_) {}
    return {
      base, public: !!tunnel.url,
      publicUrl: tunnel.url || null,
      lanUrl, code: latestCode, pairUrl, qrDataUrl,
      ttlMinutes: Math.round(pair.ttlMs / 60000),
      seq: codeSeq
    };
  }

  /** V2 配置向导保存后热应用：重建推送器 / 更新配对码有效期 / 启停隧道 */
  function applySetupChanges() {
    mailer = new MailNotifier(cfg, logf);
    wecom = new WecomNotifier(cfg, logf);
    pair.setTtlMinutes(cfg.pair && cfg.pair.codeTtlMinutes);
    // V3 双模式：隧道配置（开关/模式/域名/令牌/程序路径）任一变更 → 重启隧道按新配置拉起
    const sig = tunnelSig();
    if (sig !== lastTunnelSig) {
      lastTunnelSig = sig;
      if (tunnel.enabled) {
        tunnel.restart();
        log('info', '[隧道] 配置变更，已按新配置重启隧道');
      } else if (tunnel.proc) {
        tunnel.stop();
        log('info', '[隧道] 已按新配置关闭（仅局域网可用）');
      }
    } else if (tunnel.enabled && !tunnel.proc) {
      tunnel.start();
      log('info', '[隧道] 已按新配置启动');
    } else if (!tunnel.enabled && tunnel.proc) {
      tunnel.stop();
      log('info', '[隧道] 已按新配置关闭（仅局域网可用）');
    }
    log('info', `[向导] 热应用完成（邮件: ${mailer.describe()}；企微: ${wecom.describe()}；配对码有效期 ${Math.round(pair.ttlMs / 60000)} 分钟）`);
    alerts.applyConfig(); // V3：定时统计间隔可能被修改，重建定时器
    // 保存推送配置后立即推一次（向导完成页展示的地址/配对码同步进邮箱；
    // 旧码仍有效则复用，无需等它过期重发）
    kickPush();
  }

  /** 立即重推一次连接信息（向导保存、远程改收件人/切档案后复用） */
  function kickPush() {
    if (latestCode && mailer.configured) {
      pushedOnce = false; // 视为首推：立即发送，不等 30 秒去抖
      schedulePush(0);
    }
  }

  function schedulePush(delayMs) {
    if (!latestCode) return;
    if (!pushEnabled()) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      const base = tunnel.url || `http://${lanIP()}:${cfg.port}`;
      // 内容签名去重：地址与配对码都与上次成功推送相同 → 跳过（隧道断连重连不再重复轰炸）
      const pushSig = `${base}|${latestCode}`;
      if (pushSig === lastPushSig) {
        log('info', '[推送] 地址与配对码均未变化，跳过重复推送');
        return;
      }
      const pairUrl = `${base}/?code=${latestCode}`;
      const ttlMinutes = Math.round(pair.ttlMs / 60000);
      let qrDataUrl = null;
      try {
        qrDataUrl = await QRCode.toDataURL(pairUrl, { margin: 2, width: 360 });
      } catch (_) { /* 二维码可选 */ }
      const payload = {
        code: latestCode, url: base, pairUrl,
        public: !!tunnel.url, ttlMinutes, qrDataUrl,
        seq: codeSeq, sendTime: fmtNow()
      };
      // 第二区块：手机远程配置页链接 + 二维码（仅邮箱通道已配置时随邮件下发）
      if (mailer.configured) {
        payload.remoteUrl = `${base}/remote.html?t=${remoteToken}`;
        try {
          payload.remoteQr = await QRCode.toDataURL(payload.remoteUrl, { margin: 2, width: 300 });
        } catch (_) { /* 二维码可选 */ }
      }
      // ACP 未连接时附加前置条件警告与配置向导提示（随邮件下发；setup.html 是本机页面，仅电脑端能打开）
      if (!official.acp) {
        payload.acpWarning = '未检测到爱思办公本地服务（agnesd）：看板暂时取不到任务数据。请先在电脑上启动爱思办公桌面应用，桥接服务会自动发现并连接，无需重启。';
        payload.setupHint = '首次使用请先在电脑端浏览器打开配置向导完成基础配置（本机页面，手机端无法打开）：';
        payload.setupUrl = `http://127.0.0.1:${cfg.port}/setup.html`;
      }
      const desc = [
        `第 ${codeSeq} 次生成 · 发送时间：${payload.sendTime}（电脑本机时间）`,
        `配对码：${payload.code}`,
        `（${ttlMinutes} 分钟内有效，仅可使用一次；使用后或过期会自动推送新码）`,
        '',
        `访问地址：${base}`,
        tunnel.url ? '公网模式：手机在任何网络都能访问' : '局域网模式：手机需与电脑同一 WiFi',
        ...(official.acp ? [] : ['', '⚠ 未检测到爱思办公本地服务：看板暂无任务数据，请先启动爱思办公桌面应用。']),
        '',
        '点击上方卡片打开看板，输入配对码即可连接。'
      ].join('\n');
      // 多通道并发推送，各自安静失败，互不影响
      const results = await Promise.all([
        mailer.sendPairInfo(payload).catch(() => false),
        wecom.sendCard(`看板配对码 ${payload.code}`, desc, pairUrl).catch(() => false)
      ]);
      const mailOk = results[0] === true;
      // 配对码邮件发送对账日志（含精确时间戳 + TTL + 预计过期时间，用于核对 TTL 是否生效）
      const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
      const expireAt = new Date(Date.now() + pair.ttlMs).toLocaleString('zh-CN', { hour12: false });
      log('info', `[配对码邮件] 已发送 码=${payload.code} seq=${codeSeq} 发送时间=${nowStr} TTL=${ttlMinutes}分钟 预计过期=${expireAt} 地址=${base}`);
      if (results.some(Boolean)) {
        pushedOnce = true;
        pushRetry = 0;
        lastPushSig = pushSig; // 仅在至少一个通道送达时记录签名（失败重试/故障转移不受去重影响）
        log('info', `[推送] 连接信息已发送（第 ${codeSeq} 次 · ${payload.sendTime} · 通道: ${[mailer, wecom].filter((c, i) => results[i]).map((c) => (c === mailer ? '邮箱' : '企业微信')).join(' + ')}；${tunnel.url ? '公网' : '局域网'}地址）`);
      }
      if (mailOk) {
        mailFails = 0;
      } else {
        // 邮箱通道失败：累计 2 次且有其他档案 → 自动故障转移并立即重试（不等 3 分钟）
        mailFails++;
        if (mailFails >= 2 && ((cfg.mailer && cfg.mailer.saved) || []).length > 0) {
          mailFails = 0;
          if (switchMailProfile()) {
            schedulePush(0);
            return;
          }
        }
        // 全部通道失败才走 3 分钟通用重试（企微已送达时不重试——限频期重试会续期封锁）
        if (results.every((r) => !r)) {
          pushRetry++;
          if (pushRetry <= 5 && latestCode && pair.isActive(latestCode)) {
            log('warn', `[推送] 全部通道失败，3 分钟后自动重试（第 ${pushRetry}/5 次）`);
            schedulePush(3 * 60 * 1000);
          }
        }
      }
    }, Math.max(0, delayMs));
    if (pushTimer.unref) pushTimer.unref();
  }

  pair.onCodeIssued = (code) => {
    latestCode = code;
    codeSeq++; // 每次生成新码计数 +1（与推送邮件、向导完成页显示的「第 N 次」对应）
    pushRetry = 0;
    // 首推：隧道已就绪立即推；未就绪最多等 20 秒（等隧道 URL，避免推局域网地址后马上又推公网地址）
    schedulePush(pushedOnce ? 30000 : (tunnel.url ? 0 : 20000));
  };

  tunnel.onChange = (url) => {
    if (url) schedulePush(pushedOnce ? 30000 : 0);
  };

  // 配对码过期自动刷新：每 60 秒检查，全部过期则生成新码（并自动推送）
  const ttlMin = Math.round(pair.ttlMs / 60000);
  const refreshTimer = setInterval(() => {
    if (!pair.hasActiveCode()) {
      const code = pair.issueCode();
      console.log(`[配对] 配对码已过期，新配对码: ${code}（有效期 ${ttlMin} 分钟；已配置推送通道时将自动推送）`);
    }
  }, 60 * 1000);
  if (refreshTimer.unref) refreshTimer.unref();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[启动失败] 端口 ${cfg.port} 已被占用：请关闭占用该端口的程序，或修改 config.json 中的 port。`);
    } else {
      console.error('[启动失败]', err);
    }
    process.exit(1);
  });

  server.listen(cfg.port, cfg.listenHost, async () => {
    const ip = lanIP();
    const base = `http://${ip}:${cfg.port}`;
    const code = pair.issueCode(); // 触发 onCodeIssued → 首推调度
    const pairUrl = `${base}/?code=${code}`;

    console.log('');
    console.log('================================================');
    console.log('   agent-vigil · 桥接服务（只读 MVP）');
    console.log('================================================');
    console.log(`  本机地址 : ${base}`);
    console.log(`  配对码   : ${code}（第 ${codeSeq} 次生成 · ${ttlMin} 分钟内有效，仅可使用一次）`);
    console.log(`  数据模式 : ${official.describe()}`);
    console.log(`  公网隧道 : ${tunnel.describe()}`);
    console.log(`  邮件推送 : ${mailer.describe()}`);
    console.log(`  企微推送 : ${wecom.describe()}`);
    console.log('  手机访问 : 同一 WiFi 直接打开上方地址并输入');
    console.log('             配对码；公网隧道就绪后任意网络可用，');
    console.log('             或直接扫码：');
    console.log(`  远程配置 : ${remoteLinkLocal}（本机可见，勿外传）`);
    if (!(cfg.setup && cfg.setup.done)) {
      console.log('');
      console.log('  ★ 首次使用：请在电脑浏览器打开下面地址，按向导完成');
      console.log(`     邮箱推送 / 公网隧道 等基础配置（约 3 分钟）：`);
      console.log(`     http://127.0.0.1:${cfg.port}/setup.html`);
    }
    console.log('------------------------------------------------');
    try {
      const qr = await QRCode.toString(pairUrl, { type: 'terminal', small: true });
      console.log(qr);
    } catch (e) {
      console.log('  （二维码生成失败，可在手机手动输入地址与配对码）');
    }
    console.log('  按 Ctrl+C 停止服务');
    console.log('================================================');
    console.log('');

    // 端口就绪后再启动隧道（cloudflared 需要回源 127.0.0.1:port）
    if (tunnel.enabled) tunnel.start();
  });

  // 轮询爱思办公（ACP）数据并检测变化，经 WebSocket 推送给手机端。
  // 任何失败均降级处理（记录日志、跳过本轮），绝不崩溃。
  let prev = new Map();
  let lastErrAt = 0;

  async function pollOnce() {
    let tasks;
    try {
      tasks = await official.getTasks();
    } catch (e) {
      if (Date.now() - lastErrAt > 30000) {
        console.warn(`[轮询] 获取任务数据失败（已降级，服务不受影响）: ${e.message}`);
        lastErrAt = Date.now();
      }
      return;
    }
    const cur = new Map(tasks.map((t) => [t.id, t]));
    for (const t of tasks) {
      const p = prev.get(t.id);
      if (!p) {
        // 新任务出现：推送任务摘要及其当前步骤
        hub.broadcast('task_update', { task: pickTask(t) });
        (t.steps || []).forEach((s, i) => {
          hub.broadcast('step_update', { taskId: t.id, index: i, step: s });
        });
        continue;
      }
      if (p.status !== t.status || p.progress !== t.progress) {
        hub.broadcast('task_update', { task: pickTask(t) });
      }
      const len = Math.max((p.steps || []).length, (t.steps || []).length);
      for (let i = 0; i < len; i++) {
        const a = (p.steps || [])[i];
        const b = (t.steps || [])[i];
        if (!a || !b || a.status !== b.status || a.output !== b.output) {
          hub.broadcast('step_update', { taskId: t.id, index: i, step: b || null });
        }
      }
    }
    prev = cur;
  }

  const timer = setInterval(pollOnce, Math.max(1000, cfg.pollIntervalMs || 3000));
  if (timer.unref) timer.unref();
  pollOnce();

  // 实时增强：ACP 收到会话活动通知时，防抖 300ms 立即拉取一次变化并推送
  let kickTm = null;
  official.setOnChange(() => {
    if (kickTm) return;
    kickTm = setTimeout(() => { kickTm = null; pollOnce(); }, 300);
  });

  process.on('SIGINT', () => {
    console.log('\n已停止桥接服务');
    tunnel.stop();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[启动失败]', e);
  process.exit(1);
});

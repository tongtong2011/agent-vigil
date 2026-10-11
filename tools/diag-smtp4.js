'use strict';
/**
 * 2925.com SMTP 深度探测矩阵（定位 MAIL FROM 断连问题）
 * 用法：node tools/diag-smtp4.js <场景号>
 *  1  MAIL FROM:<> 空反向路径（探测 <> 分支）
 *  2  MAIL FROM:<test@example.com> 外域发件人
 *  3  MAIL FROM:<postmaster@2925.com> 同域其他用户
 *  4  MAIL FROM:<u> SIZE=1000（带 SIZE 参数）
 *  5  EHLO 2925.com（FQDN 风格）+ 标准 MAIL FROM
 *  6  不认证直接 MAIL FROM（探测处理器是否存活，期望 530）
 *  7  HELO（非 EHLO）+ AUTH + MAIL FROM
 *  8  端口 587 STARTTLS + AUTH + 完整发信
 *  9  端口 25 STARTTLS + MAIL FROM 探测
 * 10  AUTH 后延迟 1 秒再 MAIL FROM
 * 11  PIPELINING 批量：MAIL+RCPT+DATA 一次写入
 */
const tls = require('tls');
const net = require('net');
const os = require('os');
const cfg = require('../config.json');
const m = cfg.mailer || {};
const U = m.user, P = m.pass, TO = m.to;
const HN = os.hostname();
const sc = Number(process.argv[2] || 1);
const port = sc === 8 ? 587 : sc === 9 ? 25 : 465;
// 场景 12+：信封发件人用手机号别名；场景 13+：From 头也用别名
const ENV = sc >= 12 ? '18111233983@2925.com' : U;
const FROMH = sc >= 13 ? ENV : U;

const body = `From: <${FROMH}>\r\nTo: <${TO}>\r\nSubject: diag4 scenario ${sc}\r\n\r\ndiag4 scenario ${sc} test.\r\n.`;
// 认证段（MAIL FROM 挂在 235 那步之后）
const AUTH = [
  { expect: '250', send: 'AUTH LOGIN' },
  { expect: '334', send: Buffer.from(U).toString('base64') },
  { expect: '334', send: Buffer.from(P).toString('base64') },
];
const mf = (s) => ({ expect: '235', send: s });
const SEND = [
  { expect: '250', send: `RCPT TO:<${TO}>` },
  { expect: '250', send: 'DATA' },
  { expect: '354', send: body },
  { expect: '250', send: 'QUIT' },
  { expect: '221' },
];

let steps, title;
switch (sc) {
  case 1: title = 'MAIL FROM:<> 空反向路径'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, mf('MAIL FROM:<>'), ...SEND]; break;
  case 2: title = 'MAIL FROM:<test@example.com> 外域发件人'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, mf('MAIL FROM:<test@example.com>'), ...SEND]; break;
  case 3: title = 'MAIL FROM:<postmaster@2925.com> 同域其他用户'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, mf('MAIL FROM:<postmaster@2925.com>'), ...SEND]; break;
  case 4: title = 'MAIL FROM:<u> SIZE=1000'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, mf(`MAIL FROM:<${U}> SIZE=1000`), ...SEND]; break;
  case 5: title = 'EHLO 2925.com（FQDN 风格）'; steps = [{ expect: '220', send: 'EHLO 2925.com' }, ...AUTH, mf(`MAIL FROM:<${U}>`), ...SEND]; break;
  case 6: title = '不认证直接 MAIL FROM（探测处理器是否存活）'; steps = [{ expect: '220', send: 'EHLO ' + HN }, { expect: '250', send: `MAIL FROM:<${U}>` }, { expect: '*', send: 'QUIT' }, { expect: '221' }]; break;
  case 7: title = 'HELO（非 EHLO）'; steps = [{ expect: '220', send: 'HELO ' + HN }, ...AUTH, mf(`MAIL FROM:<${U}>`), ...SEND]; break;
  case 8: title = '端口 587 STARTTLS 完整发信'; steps = [{ expect: '220', send: 'EHLO ' + HN }, { expect: '250', send: 'STARTTLS' }, { expect: '220', special: 'upgrade' }, { expect: '250', send: 'EHLO ' + HN }, ...AUTH, mf(`MAIL FROM:<${U}>`), ...SEND]; break;
  case 9: title = '端口 25 STARTTLS + MAIL FROM 探测'; steps = [{ expect: '220', send: 'EHLO ' + HN }, { expect: '250', send: 'STARTTLS' }, { expect: '220', special: 'upgrade' }, { expect: '250', send: 'EHLO ' + HN }, { expect: '250', send: `MAIL FROM:<${U}>` }, { expect: '*', send: 'QUIT' }, { expect: '221' }]; break;
  case 10: title = 'AUTH 后延迟 1 秒再 MAIL FROM'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, { expect: '235', send: `MAIL FROM:<${U}>`, wait: 1000 }, ...SEND]; break;
  case 11: title = 'PIPELINING 批量 MAIL+RCPT+DATA'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, { expect: '235', special: 'batch' }, { expect: '250' }, { expect: '250' }, { expect: '354', send: body }, { expect: '250', send: 'QUIT' }, { expect: '221' }]; break;
  case 12: title = '信封=别名 / From头=主地址'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, mf(`MAIL FROM:<${ENV}>`), ...SEND]; break;
  case 13: title = '信封=别名 / From头=别名'; steps = [{ expect: '220', send: 'EHLO ' + HN }, ...AUTH, mf(`MAIL FROM:<${ENV}>`), ...SEND]; break;
  default: console.log('场景号 1..11'); process.exit(1);
}

console.log(`\n== 场景 ${sc}: ${title}（端口 ${port}）==`);
const log = (s) => process.stdout.write('  ' + s + '\n');

let sock, i = 0, buf = '', cur = '';

function attach(s) {
  sock = s;
  s.on('data', onData);
  s.on('error', (e) => { log('[错误] ' + e.message); process.exit(1); });
  s.on('close', () => {
    const done = i >= steps.length;
    log(done ? '✅ 全流程完成' : `❌ 连接被关闭（完成到第 ${i}/${steps.length} 步）`);
    process.exit(done ? 0 : 1);
  });
  s.setTimeout(20000, () => {
    const st = steps[i];
    log(`❌ 超时（卡在第 ${i + 1} 步，等待 ${st ? st.expect : '-'} 响应）`);
    try { s.destroy(); } catch (_) {}
    process.exit(2);
  });
}

function onData(d) {
  const s = d.toString('utf8');
  log('<<< ' + s.trim().split(/\r?\n/).join(' | '));
  buf += s;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    let line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    cur += line + '\n';
    if (/^\d{3} /.test(line)) { const unit = cur.trim(); cur = ''; handle(unit); }
  }
}

function handle(resp) {
  const st = steps[i];
  if (!st) { log('✅ 全流程完成'); try { sock.end(); } catch (_) {} process.exit(0); }
  const ok = st.expect === '*' || resp.startsWith(st.expect);
  if (!ok) {
    log(`❌ 第 ${i + 1} 步期望 ${st.expect}，实见 ${resp.split('\n')[0]}`);
    try { sock.destroy(); } catch (_) {}
    process.exit(1);
  }
  i++;
  const run = () => {
    if (st.special === 'upgrade') return doUpgrade();
    if (st.special === 'batch') sock.write(`MAIL FROM:<${U}>\r\nRCPT TO:<${TO}>\r\nDATA\r\n`);
    else if (st.send) sock.write(st.send + '\r\n');
  };
  if (st.wait) setTimeout(run, st.wait);
  else run();
}

function doUpgrade() {
  const raw = sock;
  raw.removeAllListeners('data');
  raw.removeAllListeners('close');
  raw.removeAllListeners('error');
  raw.setTimeout(0);
  const s2 = tls.connect({ socket: raw, rejectUnauthorized: false, servername: m.smtpHost }, () => log('   [TLS 升级完成]'));
  attach(s2);
  // 握手完成后发送下一步命令（EHLO）
  s2.once('secure', () => {
    const nx = steps[i];
    if (nx && nx.send) sock.write(nx.send + '\r\n');
  });
}

log('连接中…' + (process.env.SMTP_IP ? `（指定 IP: ${process.env.SMTP_IP}）` : ''));
const HOST = process.env.SMTP_IP || m.smtpHost;
if (port === 465) attach(tls.connect({ host: HOST, port, rejectUnauthorized: false, servername: m.smtpHost }));
else attach(net.connect({ host: HOST, port }));

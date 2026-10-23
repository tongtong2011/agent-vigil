'use strict';
/* 离线验证：V4.1 config.json 迁移（变动二十五：渠道级配置改造）
 * 规约：在系统临时目录构造 <tmp>/lib/config.js + <tmp>/config.json 沙箱——绝不读写真实 config.json。
 * 断言：①旧渠道级 listLimit/listLimitMax → 全局 board（取最大值，workbuddy 1000 行为不变）
 *       ②load 后渠道对象已剔除废弃旧键（prune）
 *       ③agnes 渠道级汇总间隔/标题仅在 alerts 顶层未显式写时提升
 *       ④save 落盘清洗：旧 config.json 随任意一次保存完成迁移，未提及字段（watchlist/mailer）原样保留
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-mig-'));
fs.mkdirSync(path.join(tmp, 'lib'));
// 沙箱内放置与真实实现一致的 config.js（其 ROOT = __dirname/.. = tmp）
fs.copyFileSync(path.join(REAL, 'lib', 'config.js'), path.join(tmp, 'lib', 'config.js'));

function writeCfg(obj) {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function freshLoad() {
  const p = require.resolve(path.join(tmp, 'lib', 'config.js'));
  delete require.cache[p];
  return require(p);
}

(async () => {
  // ── ① load 迁移：旧渠道级 listLimit → 全局 board，workbuddy 行为不变 ──
  writeCfg({
    port: 8787,
    mailer: { user: 'u@example.com', pass: 'x', to: 'to@example.com', saved: [] },
    alerts: {
      digestEnabled: false, alertEnabled: true, digestIntervalMinutes: 30,
      digestTitle: '任务汇总邮件', alertPrefix: '单任务报警-',
      watchlist: [{ channel: 'agnes', taskId: 'a1' }, { channel: 'workbuddy', taskId: 'w1' }]
    },
    // 旧版存量形态：channels 只有 workbuddy 且带旧 listLimit（与真实 config.json 对应，不含敏感值）
    channels: { workbuddy: { listLimit: 1000 } }
  });
  const cfg1 = freshLoad();
  assert.strictEqual(cfg1.board.listLimit, 1000, '旧 workbuddy.listLimit=1000 → board.listLimit（取最大）');
  assert.strictEqual(cfg1.board.listLimitMax, 1000, 'listLimitMax 无旧值 → 默认 1000');
  assert.strictEqual(cfg1.channels.workbuddy.listLimit, undefined, 'load 后渠道旧键已剔除');
  assert.strictEqual(cfg1.channels.workbuddy.enabled, true, 'workbuddy 默认启用');
  assert.strictEqual(cfg1.channels.agnes.enabled, true, 'agnes 默认启用');
  assert.strictEqual(cfg1.alerts.digestIntervalMinutes, 30, 'alerts 顶层显式值保留（渠道无旧键时不扰动）');

  // ── ② agnes 渠道级汇总间隔/标题仅在 alerts 顶层未显式写时提升 ──
  writeCfg({
    alerts: { watchlist: [] },
    channels: { agnes: { enabled: true, digestIntervalMinutes: 45, digestTitle: '渠道标题', listLimit: 200 } }
  });
  const cfg2 = freshLoad();
  assert.strictEqual(cfg2.alerts.digestIntervalMinutes, 45, '顶层未写 → agnes 渠道级 45 提升（clamp 范围内）');
  assert.strictEqual(cfg2.alerts.digestTitle, '渠道标题', '顶层未写 → agnes 渠道级标题提升');
  assert.strictEqual(cfg2.board.listLimit, 200, '旧渠道级 listLimit 200 → 全局');
  assert.strictEqual(cfg2.channels.agnes.digestIntervalMinutes, undefined, '渠道旧键 load 后剔除');

  // ── ③ save 落盘清洗 + 未提及字段原样保留 ──
  writeCfg({
    mailer: { user: 'u@example.com', pass: 'x', to: 'to@example.com' },
    alerts: {
      digestIntervalMinutes: 30, digestTitle: '任务汇总邮件', alertEnabled: true,
      watchlist: [{ channel: 'agnes', taskId: 'a1' }]
    },
    channels: {
      agnes: { digestIntervalMinutes: 999, listLimit: 500 },
      workbuddy: { listLimit: 1000 }
    }
  });
  const cfg3 = freshLoad();
  // 顶层 alerts.digestIntervalMinutes 显式写 30 → agnes 的 999 不提升，仅被 prune 清掉
  assert.strictEqual(cfg3.alerts.digestIntervalMinutes, 30, '顶层显式值不被渠道级 999 覆盖（仅顶层缺失时提升）');
  cfg3.save({ channels: { workbuddy: { enabled: true, digestEnabled: true, alertEnabled: false, alertPrefix: '' } } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.strictEqual(onDisk.channels.workbuddy.listLimit, undefined, 'save 后落盘渠道旧键已清洗');
  assert.strictEqual(onDisk.channels.workbuddy.digestEnabled, true, 'save 的新值写入');
  assert.strictEqual(onDisk.channels.workbuddy.alertEnabled, false, 'save 的新值写入（alertEnabled）');
  assert.strictEqual(onDisk.channels.agnes.listLimit, undefined, '未提及渠道的旧键同样落盘清洗');
  assert.strictEqual(onDisk.channels.agnes.digestIntervalMinutes, undefined, 'agnes 渠道级旧键落盘清洗');
  assert.deepStrictEqual(onDisk.alerts.watchlist, [{ channel: 'agnes', taskId: 'a1' }], 'watchlist 原样保留');
  assert.strictEqual(onDisk.alerts.digestIntervalMinutes, 30, 'alerts 顶层保留');
  assert.strictEqual(onDisk.mailer.user, 'u@example.com', 'mailer 原样保留');

  // ── ④ 前向兼容：未知新渠道键保留 ──
  writeCfg({ channels: { newagent: { enabled: true, alertPrefix: '[NA] ' } } });
  const cfg4 = freshLoad();
  assert.strictEqual(cfg4.channels.newagent.enabled, true, '未知新渠道保留（前向兼容）');
  assert.strictEqual(cfg4.channels.newagent.alertPrefix, '[NA] ');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('✅ 全部 4 组迁移断言通过：board提升 / agnes旧键提升 / save落盘清洗 / 未知渠道前向兼容');
})().catch((e) => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  console.error('FAIL:', e.message);
  process.exit(1);
});

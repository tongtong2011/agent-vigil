'use strict';
/* 离线验证：多渠道合并汇总邮件（变动二十二）+ V4.1 渠道级配置改造（变动二十五）
 * 规约：深拷贝 cfg、mock mailer（拦截不发送）、mock adapters——绝不直写真实 config.json、不发真实邮件。
 * 断言：①双渠道合并一封、分节像看板 Tab ②节拍 = 全局统一间隔（渠道级旧键失效）
 *       ③汇总关闭/无追踪渠道不出节 ④down 节（数据源全挂不再单独发异常邮件）
 *       ⑤渠道指纹基线独立（down 恢复只影响自己）⑥单任务报警邮件所有渠道（含 agnes）都带来源徽章
 *       ⑦渠道停用（enabled:false）→ 汇总不出节、报警不发
 */
const assert = require('assert');
const AlertManager = require('../lib/alerts');

function mkTask(id, title, updatedAt, loc) {
  // 最后一条消息为 AI 回复、步骤尾部 done → 分类为「执行完成」（非阻塞）
  // loc：目录定位字段——agnes 形态 {cwd}（走 basename 回退）/ workbuddy 形态 {group}（直取）
  return Object.assign({
    id, title, status: 'done', updatedAt,
    steps: [{ name: 's1', status: 'done', output: 'ok' }],
    messages: [{ role: 'assistant', text: '最终回复 ' + id }]
  }, loc || {});
}

function mkWaiting(id, title, loc) {
  // 最后一条消息为用户消息且 AI 未回复 → 分类为「待确认」（阻塞态）
  return Object.assign({
    id, title, status: 'waiting', updatedAt: '2026-10-11T11:00:00Z',
    steps: [],
    messages: [{ role: 'user', text: '需要确认：是否继续执行？' }]
  }, loc || {});
}

const captured = [];
const mockMailer = {
  configured: true,
  async sendAlert(p) { captured.push({ kind: 'alert', p }); return true; },
  async sendDigest(p) { captured.push({ kind: 'digest', p }); return true; }
};

// workbuddy 初始为「数据源挂了」状态（getTask 抛错），场景3 换成健康实现
// map 必须是真实 Map（AlertManager._allowedChannels 会调 map.keys()）
const mockAdapters = {
  map: new Map([
    ['agnes', {
      displayName: '爱思办公',
      async getTask(id) {
        if (id === 'ghost') return null;
        // agnes 形态：详情带 cwd（无 group）→ 目录显示名走 basename 回退
        return id === 'wait1' ? mkWaiting('wait1', '等待确认任务', { cwd: 'E:\\works\\demo-project' })
          : mkTask(id, '任务' + id, '2026-10-11T10:00:00Z', { cwd: 'E:\\works\\demo-project' });
      }
    }],
    ['workbuddy', {
      displayName: 'WorkBuddy',
      async getTask() { throw new Error('数据源挂了'); }
    }],
    ['lonely', {
      displayName: 'Lonely',
      async getTask() { return mkTask('L1', '孤独任务', '2026-10-11T10:00:00Z'); }
    }]
  ]),
  get(ch) { return this.map.get(ch) || null; }
};

const baseCfg = JSON.parse(JSON.stringify({
  alerts: { digestEnabled: true, digestIntervalMinutes: 30, digestTitle: '任务汇总邮件', alertEnabled: true, watchlist: [] },
  board: { listLimit: 100, listLimitMax: 1000 },
  channels: {
    // V4.1：渠道级仅 enabled/digestEnabled/alertEnabled/alertPrefix；
    // 故意混入旧键 digestIntervalMinutes:999 证明已失效（节拍只认全局 30）
    agnes: { enabled: true, digestEnabled: true, alertEnabled: true, alertPrefix: '单任务报警-', digestIntervalMinutes: 999 },
    workbuddy: { enabled: true, digestEnabled: true, alertEnabled: true, alertPrefix: '', digestIntervalMinutes: 999 },
    lonely: { enabled: true, digestEnabled: false, alertEnabled: false, alertPrefix: '' }
  }
}));

(async () => {
  // ── 场景1：双渠道启用汇总 → 一封邮件两节，节拍 = 全局统一间隔 30 ──
  const cfg1 = JSON.parse(JSON.stringify(baseCfg));
  const am1 = new AlertManager({
    cfg: cfg1, adapters: mockAdapters,
    getMailer: () => mockMailer, getBaseUrl: () => 'https://x.example',
    log: () => {}
  });
  am1.entries = [
    { channel: 'agnes', taskId: 'a1' },
    { channel: 'workbuddy', taskId: 'w1' },
    { channel: 'lonely', taskId: 'L1' } // lonely 汇总关 → 不出节
  ];
  am1.applyConfig(); // 计算合并节拍（等同向导保存热应用路径）
  await am1.sendDigestAll();
  assert.strictEqual(captured.length, 1, '场景1 应只发一封邮件');
  assert.strictEqual(captured[0].kind, 'digest');
  const d1 = captured[0].p;
  assert.strictEqual(d1.intervalMin, 30, '节拍 = 全局统一间隔 30（渠道级旧键 999 已失效）');
  assert.strictEqual(d1.sections.length, 2, '两节（lonely 汇总关不出节）');
  assert.strictEqual(d1.sections[0].displayName, '爱思办公');
  assert.strictEqual(d1.sections[0].rows.length, 1, 'agnes 有 1 个有变化任务');
  assert.strictEqual(d1.sections[1].displayName, 'WorkBuddy');
  assert.strictEqual(d1.sections[1].down, true, 'workbuddy 数据源全挂 → down 节');
  assert.ok(d1.digestTitle, '有主标题');
  assert.strictEqual(d1.sections[0].rows[0].dir, 'demo-project', 'agnes 行目录 = basename(cwd) 回退');
  assert.ok(!d1.sections.some((s) => s.displayName === 'Lonely'), '汇总关闭的渠道绝不出节');

  // ── 场景2：第二轮 agnes 无变化（指纹基线生效）、workbuddy 仍挂 ──
  await am1.sendDigestAll();
  assert.strictEqual(captured.length, 2, '第二轮仍是一封');
  const d2 = captured[1].p;
  assert.strictEqual(d2.sections[0].rows.length, 0, '第二轮 agnes 无变化 → 0 行');
  assert.strictEqual(d2.sections[0].total, 1);
  assert.strictEqual(d2.sections[0].unchanged, 1, '无变化数计入脚注统计');
  assert.strictEqual(d2.sections[1].down, true, 'workbuddy 第二轮仍 down');

  // ── 场景3：基线独立性——workbuddy 恢复后只影响自己，agnes 基线不受扰动 ──
  mockAdapters.map.set('workbuddy', {
    displayName: 'WorkBuddy',
    async getTask(id) {
      // workbuddy 形态：详情直接带 group 显示名
      return id === 'waitw' ? mkWaiting('waitw', 'WB等待任务', { group: 'wb-folder' })
        : mkTask(id, 'WB任务' + id, '2026-10-11T10:30:00Z', { group: 'wb-folder' });
    }
  });
  await am1.sendDigestAll();
  const d3 = captured[2].p;
  assert.strictEqual(d3.sections.length, 2);
  assert.strictEqual(d3.sections[0].rows.length, 0, 'workbuddy 挂掉两轮未清掉 agnes 基线 → agnes 仍 0 行');
  assert.strictEqual(d3.sections[0].down, undefined, 'agnes 非 down 节');
  assert.strictEqual(d3.sections[1].rows.length, 1, 'workbuddy 恢复 → 首次成功列出 1 行');
  assert.strictEqual(d3.sections[1].rows[0].dir, 'wb-folder', 'workbuddy 行目录 = group 直取');
  assert.strictEqual(d3.sections[1].down, undefined, 'workbuddy 恢复后不再 down');

  // ── 场景4：单任务报警邮件所有渠道都带来源徽章（含 agnes）──
  const cfg2 = JSON.parse(JSON.stringify(baseCfg));
  const am2 = new AlertManager({
    cfg: cfg2, adapters: mockAdapters,
    getMailer: () => mockMailer, getBaseUrl: () => 'https://x.example',
    log: () => {}
  });
  am2.entries = [
    { channel: 'agnes', taskId: 'wait1' },
    { channel: 'workbuddy', taskId: 'waitw' }
  ];
  await am2.checkBlocking();
  const alerts = captured.filter((c) => c.kind === 'alert');
  assert.strictEqual(alerts.length, 2, '两个阻塞任务各发一封告警');
  const bySrc = new Map(alerts.map((a) => [a.p.source, a.p]));
  assert.strictEqual(bySrc.get('爱思办公').state, '待确认', 'agnes 告警邮件带「爱思办公」来源徽章');
  assert.strictEqual(bySrc.get('爱思办公').taskTitle, '等待确认任务');
  assert.strictEqual(bySrc.get('WorkBuddy').state, '待确认', 'workbuddy 告警邮件带「WorkBuddy」来源徽章');
  assert.strictEqual(bySrc.get('WorkBuddy').taskTitle, 'WB等待任务');
  assert.strictEqual(bySrc.get('爱思办公').alertPrefix, '单任务报警-', 'agnes 前缀保持 V3 默认');
  assert.strictEqual(bySrc.get('WorkBuddy').alertPrefix, '[WorkBuddy] 单任务报警-', '新渠道前缀自动带渠道标签');
  assert.strictEqual(bySrc.get('爱思办公').dir, 'demo-project', 'agnes 告警带任务目录（basename 回退）');
  assert.strictEqual(bySrc.get('WorkBuddy').dir, 'wb-folder', 'workbuddy 告警带任务目录（group 直取）');

  // 同一阻塞态不重复轰炸：再跑一轮 checkBlocking 不再发
  await am2.checkBlocking();
  assert.strictEqual(captured.filter((c) => c.kind === 'alert').length, 2, '同一阻塞态不重复发告警');

  // ── 场景7：渠道停用（enabled:false）→ 报警不发、汇总不出节 ──
  const cfg3 = JSON.parse(JSON.stringify(baseCfg));
  cfg3.channels.workbuddy.enabled = false;
  const am3 = new AlertManager({
    cfg: cfg3, adapters: mockAdapters,
    getMailer: () => mockMailer, getBaseUrl: () => 'https://x.example',
    log: () => {}
  });
  am3.entries = [
    { channel: 'agnes', taskId: 'wait1' },
    { channel: 'workbuddy', taskId: 'waitw' } // 渠道已停用 → 整体跳过
  ];
  await am3.checkBlocking();
  assert.strictEqual(captured.filter((c) => c.kind === 'alert').length, 3, '停用 workbuddy 后只新增 agnes 一封告警（2+1）');
  assert.strictEqual(am3.status().channels.workbuddy.enabled, false, 'status 明示渠道停用');
  const before = captured.length;
  await am3.sendDigestAll();
  const d4 = captured[captured.length - 1].p;
  assert.strictEqual(captured.length, before + 1, '停用渠道后仍发合并汇总');
  assert.strictEqual(d4.sections.length, 1, '仅 agnes 出节（workbuddy 已停用）');
  assert.strictEqual(d4.sections[0].displayName, '爱思办公', '出节渠道正确');

  console.log('✅ 全部 7 组断言通过：合并一封两节 / 全局节拍 / down节 / 基线独立 / 告警来源徽章 / 不重复轰炸 / 渠道停用隔离');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });

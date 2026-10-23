'use strict';
/* 离线验证：Trae 渠道适配器（WorkBuddy 同款模式接入）
 * 规约：fixture 数据写入临时目录（绝不触碰真实 ~/.trae-cn 与真实 config.json），
 *       适配器用 rootDir/appNames 注入测试根与进程探测名，进程门禁关/开两条路径都验证。
 * 断言：①门禁关（假进程名）→ health=false / listTasks=[] / getTask=null
 *       ②门禁开（本机真实 Trae CN.exe 在线时才跑）→ 列表/标题/跨天聚合/排序/条数
 *       ③详情：intent→user / outcome→agent 对话流、actions→done 步骤、instruction
 *       ④两态：mtime 在 90 秒活动窗内 → running，之外 → done
 *       ⑤watch 追加 → 防抖 onChange 回调 + 下一轮列表纳入新回合
 *       ⑥注册表：createAdapters 含 trae 且 cfg.channels.trae 默认块生效
 * 运行条件：Windows + node；门禁开路径需本机 Trae CN.exe 在线（不在线则自动跳过②~⑤开路部分）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { TraeAdapter } = require('../lib/adapters/trae');
const { createAdapters } = require('../lib/adapters/index');

// ── fixture：临时数据根 + 临时 Trae 数据目录（工作区池数据源，绝不触碰真实 %APPDATA%专职% ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-adapter-test-'));
const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-appdata-test-'));
const projA = '-e-me-codeTask-traeProject-agnes-office-mobile--p2-dc30e845b58a91dc34fa';
const projB = '-d-works-demo--p2-abcdef1234567890ab';
const rec = (intent, actions, outcome, ms) => JSON.stringify({
  intent, actions, outcome,
  learned: ['经验点'],
  message_summary_time: new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
  message_id: 'm' + ms,
  compact_summary_meta: { trigger: 'auto', mode: 'async', server_history_id: 'h' + ms, summary_digest: 'd', created_at_ms: ms }
});
const dirA1 = path.join(tmpRoot, projA, '20261011');
const dirA2 = path.join(tmpRoot, projA, '20261012');
const dirB1 = path.join(tmpRoot, projB, '20261012');
for (const d of [dirA1, dirA2, dirB1]) fs.mkdirSync(d, { recursive: true });
// 工作区池 fixture：A 项目在 Trae 里打开过（workspace.json），B 没开过 → 走近似还原兜底
const wsDir = path.join(tmpAppData, 'User', 'workspaceStorage', 'ws1');
fs.mkdirSync(wsDir, { recursive: true });
fs.writeFileSync(path.join(wsDir, 'workspace.json'),
  JSON.stringify({ folder: 'file:///e%3A/me/codeTask/traeProject/agnes-office-mobile' }));
const fA1 = path.join(dirA1, 'session_memory_sessA.jsonl');
const fA2 = path.join(dirA2, 'session_memory_sessA.jsonl');
const fB1 = path.join(dirB1, 'session_memory_sessB.jsonl');
// 会话 A 跨两天：标题取最新一轮 intent（20261012 文件），创建时间取最早回合
const TITLE_A = '把显示名统一改为agent-vigil';
fs.writeFileSync(fA1, [
  rec('修复配对码一次性作废的bug', ['修改配对码逻辑', '跑6项桩测试'], '修复完成，全部测试通过', 1791648237880),
  rec('确认看板状态实时更新机制', ['对照用户设想核对实现'], '确认已实现事件驱动实时更新', 1791648492735)
].join('\n') + '\n');
fs.writeFileSync(fA2, rec('把显示名统一改为agent-vigil', ['21个文件替换显示名'], '更名完成并验证通过', 1791690547156) + '\n');
fs.writeFileSync(fB1, rec('给demo项目加个README', ['编写README草稿'], 'README已生成', 1791690000000) + '\n');
const OLD = Date.now() - 10 * 60 * 1000;   // 10 分钟前（活动窗外）
for (const f of [fA1, fA2, fB1]) fs.utimesSync(f, new Date(OLD), new Date(OLD));
const OLDER = OLD - 5000;
fs.utimesSync(fA2, new Date(OLDER), new Date(OLDER));  // A 会话最新文件更旧一点
fs.utimesSync(fB1, new Date(OLD + 30000), new Date(OLD + 30000)); // B 更新时间严格更新 → 稳定排前

const noopLog = () => {};

(async () => {
  // ── 场景1：门禁关（假进程名）→ 一律空，不抛错 ──
  const off = new TraeAdapter({ rootDir: tmpRoot, appNames: ['NoSuchTraeTest.exe'], cfg: { board: { listLimit: 100 } } });
  await off.init({ log: noopLog });
  assert.strictEqual(off.ready, true, '数据根存在 → ready');
  assert.strictEqual(await off.health(), false, '假进程名 → health=false');
  assert.deepStrictEqual(await off.listTasks(), [], '门禁关 → 列表空');
  assert.strictEqual(await off.getTask('sessA'), null, '门禁关 → 详情 null');
  await off.close();

  // ── 场景2：门禁开（真实 Trae 在线才执行；否则跳过并提示）──
  const on = new TraeAdapter({ rootDir: tmpRoot, appDataDir: tmpAppData, cfg: { board: { listLimit: 100 } } }); // 默认 appNames=['Trae CN.exe']
  await on.init({ log: noopLog });
  const alive = await on.health();
  if (!alive) {
    console.log('⚠ 本机未检测到 Trae CN.exe — 门禁开路径断言跳过（仅验证了门禁关路径）');
  } else {
    // 列表：2 个会话，sessA 最新在前（mtime 已统一拨回 OLD，A 跨天取最大 mtime 同为 OLD → 用 utimes 精确控序）
    fs.utimesSync(fA2, new Date(OLD), new Date(OLD - 5000)); // A 稍旧
    const list = await on.listTasks();
    assert.strictEqual(list.length, 2, '门禁开 → 2 个会话入列');
    assert.strictEqual(list[0].id, 'sessB', '更新时间新者在前');
    assert.strictEqual(list[0].title, '给demo项目加个README', '标题 = 最新（唯一）一轮 intent');
    assert.strictEqual(list[0].status, 'done', '活动窗外 → done');
    assert.ok(list[0].cwd.startsWith('D:\\works'), 'B 项目未入工作区池 → cwd 近似还原（' + list[0].cwd + '）');
    assert.strictEqual(list[0].group, 'demo', 'group = cwd 尾段');
    assert.strictEqual(list[1].id, 'sessA', 'A 会话在列');
    assert.strictEqual(list[1].title, TITLE_A, '标题 = 最新一轮 intent（跨天取 20261012 文件）');
    assert.strictEqual(list[1].cwd, 'e:\\me\\codeTask\\traeProject\\agnes-office-mobile', 'A 项目入工作区池 → cwd 精确映射');
    assert.strictEqual(list[1].group, 'agnes-office-mobile', 'group = 真实项目根目录名');
    assert.strictEqual(on.taskCount(), 2, 'taskCount = 2');

    // 详情：跨天聚合，2+1 条记录按时间序合并
    const dA = await on.getTask('sessA');
    assert.ok(dA, 'sessA 详情非空');
    assert.strictEqual(dA.title, TITLE_A, '详情标题 = 最新一轮 intent');
    assert.strictEqual(dA.messages.length, 6, '2+1 回合 → 6 条消息（intent→user / outcome→agent）');
    assert.strictEqual(dA.messages[0].role, 'user', '首条 = 用户意图');
    assert.strictEqual(dA.messages[0].text, '修复配对码一次性作废的bug');
    assert.strictEqual(dA.messages[1].role, 'agent', '次条 = AI 结果');
    assert.strictEqual(dA.messages[1].text, '修复完成，全部测试通过');
    assert.strictEqual(dA.messages[4].text, '把显示名统一改为agent-vigil', '第 5 条 = 第二天回合的 intent（跨天有序）');
    assert.strictEqual(dA.steps.length, 4, 'actions 摊平为 done 步骤（2+1+1）');
    assert.ok(dA.steps.every((s) => s.status === 'done'), '步骤全部 done');
    assert.strictEqual(dA.instruction, '修复配对码一次性作废的bug', 'instruction = 首条用户输入');
    assert.strictEqual(dA.status, 'done', 'mtime 旧 → done');
    assert.strictEqual(dA.progress, 100, 'done → 进度 100');

    // 两态：mtime 拨到活动窗内 → running（等待 1.1s 越过扫描节流窗）
    fs.utimesSync(fA2, new Date(), new Date());
    await new Promise((r) => setTimeout(r, 1100));
    const hot = await on.listTasks();
    assert.strictEqual(hot[0].id, 'sessA', '新活动 → A 跳到最前');
    assert.strictEqual(hot[0].status, 'running', '90 秒活动窗内 → running');
    const dHot = await on.getTask('sessA');
    assert.strictEqual(dHot.status, 'running', '详情同步 running');
    fs.utimesSync(fA2, new Date(OLD), new Date(OLD));

    // watch：追加新回合 → 防抖 onChange + 列表纳入
    let changed = null;
    on.setOnChange((sid) => { changed = sid; });
    fs.appendFileSync(fB1, rec('追加一轮新需求', ['实现新需求'], '新需求已完成', Date.now()) + '\n');
    await new Promise((r) => setTimeout(r, 900));
    assert.strictEqual(changed, 'sessB', 'watch 防抖回调带回 sessionId');
    const after = await on.getTask('sessB');
    assert.strictEqual(after.title, '追加一轮新需求', '追加新回合后标题跟随最新指令更新');
    assert.strictEqual(after.messages.length, 4, '追加后详情含新回合（2+2 条消息）');
    assert.strictEqual(after.messages[3].text, '新需求已完成', '新 outcome 入流');
  }
  await on.close();

  // ── 场景3：注册表接入 + 渠道默认配置块 ──
  const cfg = { channels: {}, board: { listLimit: 100 }, alerts: {} };
  const ad = createAdapters({ cfg, official: {}, log: noopLog });
  assert.ok(ad.map.has('trae'), '注册表含 trae 渠道');
  const inst = ad.map.get('trae');
  assert.strictEqual(inst.channel, 'trae', '渠道标识 trae');
  assert.strictEqual(inst.displayName, 'Trae', '展示名 Trae');
  assert.strictEqual(inst.canSend, false, '只读渠道 canSend=false');
  assert.ok(inst.root.endsWith(path.join('.trae-cn', 'memory', 'projects')), '默认数据根指向真实目录');

  // 清理 fixture
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpAppData, { recursive: true, force: true });
  console.log('✅ Trae 适配器全部断言通过（门禁关/开、最新轮标题、cwd 工作区池精确映射、跨天聚合、两态、watch 回调、注册表接入）');
})().catch((e) => {
  console.error('FAIL:', e.message);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch (_) {}
  process.exit(1);
});

'use strict';
/**
 * 端到端验证脚本：手机发消息链路
 * 用法：node tools/test-send-message.js <本机地址> <配对码>
 * 流程：配对 → 取任务列表 → 选最旧已完成任务 → 发送测试消息 → 查详情确认消息入列
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const CODE = process.argv[3] || '';
if (!CODE) { console.error('用法: node tools/test-send-message.js <base> <配对码>'); process.exit(1); }

async function jpost(path, body, headers) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
async function jget(path, headers) {
  const r = await fetch(BASE + path, { headers: headers || {} });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}

(async () => {
  // 1) 配对
  const pair = await jpost('/api/pair', { code: CODE });
  if (pair.status !== 200) { console.error('[失败] 配对:', JSON.stringify(pair)); process.exit(1); }
  const token = pair.j.deviceToken;
  console.log('[1/4] 配对成功, token 长度:', String(token).length);
  const H = { 'X-Device-Token': token };

  // 2) 任务列表 → 选最旧的已完成任务
  const list = await jget('/api/tasks', H);
  if (list.status !== 200) { console.error('[失败] 列表:', list.status, JSON.stringify(list.j)); process.exit(1); }
  const tasks = list.j.tasks || [];
  const done = tasks.filter((t) => t.status === 'done').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const target = done[0] || tasks[tasks.length - 1];
  if (!target) { console.error('[失败] 无任务可选'); process.exit(1); }
  console.log(`[2/4] 目标任务: id=${target.id} 标题=${target.title} 状态=${target.status}`);

  // 3) 发消息（UTF-8 由 fetch/JSON 自动保证）
  const text = '收到请回复OK（手机端发消息链路自动化测试，无需执行任何操作）';
  const t0 = Date.now();
  const send = await jpost(`/api/tasks/${encodeURIComponent(target.id)}/messages`, { text }, H);
  console.log(`[3/4] 发消息: HTTP ${send.status} 耗时 ${Date.now() - t0}ms 返回 ${JSON.stringify(send.j)}`);
  if (send.status !== 200) { console.error('[失败] 发消息被拒'); process.exit(1); }

  // 4) 查详情：确认消息已入对话流（最后一条 user 消息应包含测试文案）
  await new Promise((r) => setTimeout(r, 1500));
  const det = await jget(`/api/tasks/${encodeURIComponent(target.id)}`, H);
  if (det.status !== 200) { console.error('[失败] 详情:', det.status); process.exit(1); }
  const turns = (det.j.task && det.j.task.messages) || [];
  const last = turns[turns.length - 1];
  const ok = last && last.role === 'user' && /发消息链路自动化测试/.test(JSON.stringify(last));
  console.log(`[4/4] 详情对话回合数=${turns.length} 最后一条 role=${last && last.role}`);
  console.log(ok ? '✅ 端到端验证通过：消息已写入会话对话流' : '⚠️ 消息未出现在对话末尾，需检查聚合逻辑');
  process.exit(ok ? 0 : 2);
})().catch((e) => { console.error('[异常]', e); process.exit(1); });

'use strict';
/**
 * 配置加载模块
 * 从项目根目录读取 config.json，并与默认值合并。
 * 官方接口主机、token、复刻请求头一律为占位符，Phase 0 抓包后填写，绝不编造。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  listenHost: '0.0.0.0',
  port: 8787,
  timeoutMs: 5000,          // 对官方调用的网络超时（毫秒），可配置
  pollIntervalMs: 3000,     // 变化检测轮询间隔（毫秒）
  acp: {
    port: 0,                // agnesd 本地端口；0 = 自动从日志发现（爱思办公重启会变化）
    secret: '',             // X-Secret-Key；留空 = 自动从 agnesd 进程内存读取
    autoDiscover: true      // 启动时自动发现本地 agnesd
  },
  official: {
    baseUrl: '<API_HOST>',  // 官方 API 主机占位符，Phase 0 抓包确认后填写
    token: '<TOKEN>',       // 官方会话 token 占位符，仅保存在电脑端，绝不下发手机端
    headers: {}             // 复刻桌面端请求头（UA、设备指纹等）
  },
  tunnel: {                 // V2 公网隧道（Cloudflare Tunnel，免费）
    enabled: true,          // true = 启动时拉起 cloudflared 获得公网地址
    cloudflaredPath: '',    // cloudflared 路径；留空 = 依次找 项目 tools/ → PATH
    mode: 'quick',          // V3：quick = trycloudflare 快速隧道（默认零配置，地址每次变）；named = 命名隧道（固定域名）
    hostname: '',           // named：看板访问域名（如 kanban.xxx.dpdns.org），provision 成功后写入
    tunnelName: 'agnes-board', // named：Cloudflare 隧道名（账号内唯一，重名自动加后缀）
    tunnelToken: ''         // named：隧道运行令牌（向导初始化成功后自动写入，仅存本机，绝不回传前端）
  },
  pair: {                   // V2 配对策略（开源部署者可按需调整）
    codeTtlMinutes: 15      // 配对码有效期（分钟），范围 5~120；越小越安全，越大越方便
  },
  messages: {               // V2 手机发消息（向 AI 任务发送指令/确认/修改建议）
    enabled: true           // false = 关闭（回归纯只读看板）
  },
  mailer: {                 // V2 邮箱推送（主通道；全部留空 = 关闭）
    smtpHost: '',           // 如 smtp.qq.com / smtp.163.com / smtp.gmail.com
    smtpPort: 465,          // 465 = SSL；587 = STARTTLS（smtpSecure 置 false）
    smtpSecure: true,
    user: '',               // 发件邮箱
    pass: '',               // SMTP 授权码（不是登录密码！邮箱设置里开通 SMTP 后生成）
    to: '',                 // 收件邮箱（可填同一个邮箱，自己发给自己）
    toHistory: [],          // 收件邮箱历史（远程配置页下拉快选；最多 10 个，不含授权码等敏感信息）
    from: '',               // 发件地址别名（可选；个别服务商要求填授权身份，留空 = 同登录邮箱）
    saved: []               // 已保存的发件配置档案（切换/重置用；含授权码，仅存本机绝不回传前端）
  },
  alerts: {                 // V3 任务告警（向导配置定时策略；手机端同步追踪清单与告警开关）
    digestIntervalMinutes: 60, // 任务汇总间隔（分钟），范围 10~240
    digestEnabled: false,   // 任务汇总（定时统计邮件）总开关（配置向导第 4 步）
    digestTitle: '任务汇总邮件', // 任务汇总邮件标题（留空 = 用默认）
    alertPrefix: '单任务报警-',  // 单任务报警邮件标题公共前缀（留空 = 用默认），标题 = 前缀 + 任务名
    watchlist: [],          // 被追踪（邮件告警开关打开）的任务 id 列表（手机端 localStorage 为源，同步副本）
    alertEnabled: false     // 阻塞告警邮件总开关（异常/待确认，手机端同步）
  },
  wecom: {                  // V2 企业微信应用消息推送（可选通道；全部留空 = 关闭）
    corpId: '',             // 企业ID（我的企业 → 企业信息 → 企业ID）
    corpSecret: '',         // 应用 Secret（应用管理 → 自建应用 → Secret）
    agentId: 0,             // 应用 AgentId
    toUser: '@all'          // 接收人，@all = 应用可见范围内的全部成员
  },
  setup: {                  // V2 配置向导状态
    done: false             // 首次启动向导完成后置 true（false = 启动时提示打开向导）
  }
};

function load() {
  let file = {};
  const cfgPath = path.join(ROOT, 'config.json');
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    console.warn('[config] 读取 config.json 失败，使用默认配置：' + e.message);
  }
  const cfg = Object.assign({}, DEFAULTS, file);
  cfg.official = Object.assign({}, DEFAULTS.official, file.official || {});
  cfg.official.headers = Object.assign({}, (file.official && file.official.headers) || {});
  cfg.acp = Object.assign({}, DEFAULTS.acp, file.acp || {});
  cfg.tunnel = Object.assign({}, DEFAULTS.tunnel, file.tunnel || {});
  cfg.pair = Object.assign({}, DEFAULTS.pair, file.pair || {});
  cfg.messages = Object.assign({}, DEFAULTS.messages, file.messages || {});
  cfg.mailer = Object.assign({}, DEFAULTS.mailer, file.mailer || {});
  // 数组字段不共享默认引用，避免跨 load 串改
  cfg.mailer.saved = Array.isArray(file.mailer && file.mailer.saved) ? file.mailer.saved : [];
  cfg.alerts = Object.assign({}, DEFAULTS.alerts, file.alerts || {});
  cfg.alerts.watchlist = Array.isArray(file.alerts && file.alerts.watchlist) ? file.alerts.watchlist : [];
  cfg.mailer.toHistory = Array.isArray(file.mailer && file.mailer.toHistory) ? file.mailer.toHistory : [];
  cfg.wecom = Object.assign({}, DEFAULTS.wecom, file.wecom || {});
  cfg.setup = Object.assign({}, DEFAULTS.setup, file.setup || {});
  cfg.port = Number(cfg.port) || DEFAULTS.port;
  cfg.timeoutMs = Number(cfg.timeoutMs) || DEFAULTS.timeoutMs;
  cfg.pollIntervalMs = Number(cfg.pollIntervalMs) || DEFAULTS.pollIntervalMs;
  // mock 演示机制已移除：数据恒来自爱思办公 ACP 真实连接，取不到任务时看板为空
  return cfg;
}

/** 深合并（对象递归、标量/数组直接覆盖） */
function deepMerge(dst, src) {
  for (const k of Object.keys(src || {})) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {};
      deepMerge(dst[k], v);
    } else if (v !== undefined) {
      dst[k] = v;
    }
  }
  return dst;
}

/**
 * 保存配置到 config.json（V2 配置向导使用）。
 * 与当前文件内容合并写入（未提及的字段原样保留），并原地更新本模块导出的
 * 配置对象，使已持有 cfg 引用的模块（bridge 等）立即看到新值（热应用）。
 * @returns {object} 更新后的配置对象（即本模块导出对象）
 */
function save(patch) {
  const cfgPath = path.join(ROOT, 'config.json');
  let file = {};
  try { file = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { /* 损坏则重建 */ }
  const merged = deepMerge(file, patch);
  try {
    fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch (e) {
    throw new Error('配置写入失败：' + e.message);
  }
  // 原地刷新导出对象（跳过 save 自身）
  const fresh = load();
  for (const k of Object.keys(fresh)) {
    if (fresh[k] && typeof fresh[k] === 'object' && !Array.isArray(fresh[k])) {
      module.exports[k] = deepMerge(module.exports[k] || {}, fresh[k]);
    } else {
      module.exports[k] = fresh[k];
    }
  }
  return module.exports;
}

const config = load();
config.save = save;
module.exports = config;

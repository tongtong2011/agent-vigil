'use strict';
/**
 * Cloudflare Tunnel 隧道管理模块（可选，V2 公网访问入口）
 *
 * 原理：在电脑上启动 cloudflared（Cloudflare 官方免费工具），它会主动连接 Cloudflare
 * 服务器并获得一个公网 HTTPS 地址（形如 https://xxxx.trycloudflare.com），
 * 手机在外网访问该地址，流量经加密隧道转回本机桥接服务。
 *
 * 特性：
 *   - 免账号免域名（trycloudflare 快速隧道）；如需固定地址可在配置中填入自己的域名凭证
 *   - 从 cloudflared 输出中解析公网 URL，通过 onChange 通知（bridge 据此推送企业微信）
 *   - 进程意外退出时指数退避自动重启（5s 起，上限 5 分钟）；URL 变化时通知
 *   - cloudflared 未安装时自动从 Cloudflare 官方下载到项目 tools/（仅首次；发布包不含 exe），
 *     下载失败再降级为纯局域网模式（打印指引），绝不阻塞启动
 *
 * 查找顺序：config.tunnel.cloudflaredPath → 项目 tools/cloudflared(.exe) → PATH
 */
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const DOWNLOAD_HINT =
  'cloudflared 未安装。请下载 Windows 版并放到 项目 tools/ 目录或 PATH：\n' +
  '  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n' +
  '（直接链接：https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe）';

// 自动下载直链（GitHub 官方 releases；源码仓库不含 exe，clone/解压后首次启动自动补齐）
const DOWNLOAD_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

class TunnelManager {
  /**
   * @param cfg 全局配置（读取 cfg.tunnel / cfg.port）
   * @param log 日志函数 (level, msg)
   */
  constructor(cfg, log) {
    this.cfg = cfg;           // V3：保存引用，热应用后 _launch 实时读 cfg.tunnel（模式/令牌切换即时生效）
    this.localPort = cfg.port;
    this.log = log || (() => {});
    this.proc = null;
    this.url = null;          // 当前公网 URL（null = 未就绪）
    this.onChange = null;     // (urlOrNull) => void
    this.retryCount = 0;
    this.stopped = false;
    this.binary = null;
    this.healthTimer = null;  // 健康检查定时器（url 就绪后启动）
    this.healthFails = 0;     // 健康检查连续失败计数
  }

  get tunnelCfg() {
    return (this.cfg && this.cfg.tunnel) || {};
  }

  get enabled() {
    return !!(this.tunnelCfg && this.tunnelCfg.enabled);
  }

  /** 查找 cloudflared 可执行文件；找不到返回 null */
  findBinary() {
    const candidates = [];
    if (this.tunnelCfg.cloudflaredPath) candidates.push(this.tunnelCfg.cloudflaredPath);
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    candidates.push(path.join(__dirname, '..', 'tools', exe));
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return path.resolve(c);
      } catch (_) { /* ignore */ }
    }
    // PATH 查找交给 spawn 直接尝试（返回裸命令名）
    return exe;
  }

  /** 是否存在可执行文件（PATH 上的假定存在） */
  _binaryLooksAvailable() {
    const b = this.findBinary();
    if (path.isAbsolute(b)) return true;
    // 裸命令名：仅在 PATH 中存在时视为可用（Windows 需带 .exe）
    const dirs = (process.env.PATH || '').split(path.delimiter);
    return dirs.some((d) => {
      if (!d) return false;
      try { return fs.existsSync(path.join(d.trim(), b)); } catch (_) { return false; }
    });
  }

  /** 自动下载 cloudflared（幂等：并发调用共享同一次下载；成功后不再重复下载） */
  _ensureDownloaded() {
    if (this._downloaded) return Promise.resolve(true);
    if (this._downloading) return this._downloading;
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const dir = path.join(__dirname, '..', 'tools');
    const dest = path.join(dir, exe);
    this.log('info', '[隧道] 未检测到 cloudflared，自动从 Cloudflare 官方下载（约 18MB，仅首次）…');
    this._downloading = this._download(DOWNLOAD_URL, dest).then(() => {
      this._downloaded = true;
      this.log('info', `[隧道] cloudflared 下载完成 → tools/${exe}，继续启动隧道`);
      return true;
    }).catch((e) => {
      this.log('warn', `[隧道] 自动下载失败：${e.message}（可能被网络/代理拦截，请手动下载后放到 项目 tools/ 目录）`);
      return false;
    }).finally(() => { this._downloading = null; });
    return this._downloading;
  }

  /** HTTPS 下载文件（跟随重定向；先写临时文件，校验大小 ≥1MB 后原子改名） */
  _download(url, dest) {
    return new Promise((resolve, reject) => {
      const get = (u, redirects) => {
        if (redirects > 5) return reject(new Error('重定向次数过多'));
        const req = https.get(u, { timeout: 60 * 1000, headers: { 'User-Agent': 'agnes-board' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(new URL(res.headers.location, u).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error('HTTP ' + res.statusCode));
          }
          const tmp = dest + '.download';
          const file = fs.createWriteStream(tmp);
          res.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              try {
                if (fs.statSync(tmp).size < 1024 * 1024) throw new Error('文件过小，下载可能不完整');
                fs.renameSync(tmp, dest);
                resolve();
              } catch (e) {
                try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
                reject(e);
              }
            });
          });
          file.on('error', (e) => {
            try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
            reject(e);
          });
        });
        req.on('timeout', () => req.destroy(new Error('下载超时（60 秒）')));
        req.on('error', reject);
      };
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) { /* ignore */ }
      get(url, 0);
    });
  }

  /** 启动隧道（幂等）；失败降级为纯局域网，不抛异常 */
  start() {
    if (!this.enabled || this.proc) return;
    this.stopped = false;
    this.retryCount = 0;
    this._launch();
  }

  async _launch() {
    if (this.stopped) return;
    this.binary = this.findBinary();
    if (!this._binaryLooksAvailable()) {
      // 首次启动自动下载（GitHub 官方直链 → 项目 tools/），失败才降级纯局域网
      const ok = await this._ensureDownloaded();
      if (!ok) {
        this.log('warn', `[隧道] ${DOWNLOAD_HINT}`);
        this.log('info', '[隧道] 已降级为纯局域网模式，手机需与电脑同一 WiFi。');
        return;
      }
      this.binary = this.findBinary();
    }
    const t = this.tunnelCfg;
    let args, env, namedUrl = null;
    if (t.mode === 'named') {
      if (!t.tunnelToken) {
        this.log('warn', '[隧道] 命名隧道未初始化（缺少隧道令牌），请到配置向导第 3 步完成「初始化命名隧道」；本次回退为快速隧道');
      } else if (!t.hostname) {
        this.log('warn', '[隧道] 命名隧道缺少访问域名，请到配置向导第 3 步检查；本次回退为快速隧道');
      } else {
        // 命名隧道：token 走环境变量（不进命令行/进程列表），地址固定
        // 注意：--no-autoupdate/--protocol 是 tunnel 级 flag，必须放 run 之前（放 run 后会报 flag not defined 并打印帮助退出）
        args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run'];
        env = Object.assign({}, process.env, { TUNNEL_TOKEN: String(t.tunnelToken) });
        namedUrl = `https://${t.hostname}`;
      }
    }
    if (!args) {
      args = [
        'tunnel',
        '--url', `http://127.0.0.1:${this.localPort}`,
        '--no-autoupdate',
        '--protocol', 'http2' // http2 比 quic 在国内网络更稳
      ];
    }
    this.log('info', `[隧道] 启动 cloudflared（${namedUrl ? '命名隧道 ' + namedUrl : '快速隧道'}）: ${this.binary} ${args.join(' ')}`);
    let proc;
    try {
      proc = spawn(this.binary, args, { windowsHide: true, env: env || process.env });
    } catch (e) {
      this.log('error', `[隧道] 启动失败: ${e.message}（已降级纯局域网）`);
      return;
    }
    this.proc = proc;

    if (namedUrl) {
      // 命名隧道地址固定，进程拉起即视为地址就绪（令牌无效时进程会退出，exit 处理器清空并重试）
      this.url = namedUrl;
      this.retryCount = 0;
      this._startHealthCheck();
      if (this.onChange) this.onChange(this.url);
    }

    const bufHandler = (data) => {
      const text = data.toString();
      if (namedUrl) {
        // 命名隧道：仅记录连接日志（地址已固定）；令牌错误等会走 exit 重连
        if (/Registered tunnel connection|Starting tunnel|failed|error/i.test(text)) {
          this.log('info', `[隧道] ${text.trim().split('\n')[0].slice(0, 160)}`);
        }
        return;
      }
      // 快速隧道地址出现在输出中，形如 https://xxx.trycloudflare.com
      // 排除错误提示中出现的 api./www. 等固定子域（它们不是隧道地址）
      const m = text.match(/https:\/\/(?!api\.|www\.)[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && m[0] !== this.url) {
        this.url = m[0];
        this.retryCount = 0; // 成功获取地址，重置退避
        this.log('info', `[隧道] 公网地址就绪: ${this.url}`);
        this._startHealthCheck();
        if (this.onChange) this.onChange(this.url);
      }
    };
    proc.stdout.on('data', bufHandler);
    proc.stderr.on('data', bufHandler); // cloudflared 日志走 stderr

    proc.on('exit', (code) => {
      const wasProc = this.proc === proc;
      if (wasProc) this.proc = null;
      if (this.stopped) return;
      this._stopHealthTimer();
      const hadUrl = !!this.url;
      this.url = null;
      if (hadUrl && this.onChange) this.onChange(null);
      if (!wasProc) return;
      const delay = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, this.retryCount++));
      this.log('warn', `[隧道] cloudflared 退出（code=${code}），${Math.round(delay / 1000)} 秒后自动重连`);
      setTimeout(() => this._launch(), delay);
    });

    proc.on('error', (e) => {
      this.log('error', `[隧道] cloudflared 进程错误: ${e.message}`);
    });
  }

  /** 健康检查：每 60 秒走公网请求自己的 /health（完整链路：DNS→CF 边缘→隧道→本机），
   *  连续 2 次失败判定"进程活着但隧道已死"（如 CF 撤销快速隧道注册），
   *  强制杀掉 cloudflared 触发既有退出重连逻辑，重建隧道并推送新地址。 */
  _startHealthCheck() {
    this._stopHealthTimer();
    if (!this.url) return;
    this.healthFails = 0;
    this.healthTimer = setInterval(() => this._checkHealth(), 60 * 1000);
    this.log('info', '[隧道] 健康检查已开启（每 60 秒，连续 2 次失败自动重建）');
  }

  _stopHealthTimer() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  _checkHealth() {
    const url = this.url;
    if (!url) return this._stopHealthTimer();
    const req = https.get(url.replace(/\/+$/, '') + '/health', { timeout: 10 * 1000 }, (res) => {
      res.resume();               // 有响应即通（哪怕 5xx，说明隧道链路正常）
      if (this.healthFails) this.log('info', '[隧道] 健康检查恢复');
      this.healthFails = 0;
    });
    req.on('timeout', () => req.destroy(new Error('health check timeout')));
    req.on('error', () => {
      if (this.url !== url) return; // 地址已切换/清空，本轮结果作废
      this.healthFails++;
      if (this.healthFails === 1) {
        this.log('warn', '[隧道] 健康检查失败（第 1/2 次）：公网地址暂不可达，60 秒后复检');
      } else {
        this.log('warn', '[隧道] 健康检查连续失败：隧道假在线（进程活着但已失效），强制重建');
        this._stopHealthTimer();
        const p = this.proc;
        if (p) {
          try { p.kill(); } catch (_) { /* exit 处理器未触发时由重连兜底 */ }
        }
      }
    });
  }

  stop() {
    this.stopped = true;
    this._stopHealthTimer();
    if (this.proc) {
      try { this.proc.kill(); } catch (_) { /* ignore */ }
      this.proc = null;
    }
    if (this.url && this.onChange) {
      this.url = null;
      this.onChange(null);
    }
  }

  /** 热重建：配置（模式/域名/令牌）变更后重启隧道，按新配置拉起 */
  restart() {
    this.stop();
    this.stopped = false;
    this.retryCount = 0;
    this._launch();
  }

  /** ───────── V3 命名隧道自动初始化（Cloudflare API v4）─────────
   *  用一个 API 令牌完成三件事：
   *   1. 找到域名所在 zone（校验令牌 + 域名确实托管在该 CF 账号）
   *   2. 创建命名隧道（remotely-managed，返回运行 token）
   *   3. 创建/更新 CNAME 记录：hostname → <tunnelId>.cfargotunnel.com
   *  返回 { tunnelId, token, hostname, tunnelName }；失败抛 Error（中文消息给向导展示） */
  async provision(opts) {
    const apiToken = String(opts.apiToken || '').trim();
    const hostname = String(opts.hostname || '').trim().toLowerCase().replace(/\.$/, '');
    let tunnelName = String(opts.tunnelName || '').trim() || 'agnes-board';
    if (!apiToken) throw new Error('缺少 Cloudflare API 令牌');
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(hostname)) {
      throw new Error('域名格式不对：请填完整域名，如 kanban.myname.dpdns.org');
    }
    // 1. 逐级尝试找 zone：kanban.a.b.com → a.b.com → b.com
    const labels = hostname.split('.');
    let zone = null;
    for (let i = 0; i < labels.length - 1 && !zone; i++) {
      const candidate = labels.slice(i).join('.');
      try {
        const r = await this._cfApi('GET', `/zones?name=${encodeURIComponent(candidate)}`, apiToken);
        if (r.success && Array.isArray(r.result) && r.result.length) zone = r.result[0];
      } catch (_) { /* 下一个候选 */ }
    }
    if (!zone) throw new Error('未在该 Cloudflare 账号找到此域名的 zone——请确认域名已添加到 Cloudflare 且 NS 已生效（生效可能需要几分钟到几小时）');
    // 2. 隧道：自检式幂等初始化——先查同名隧道，已存在则复用（兼容用户手工建了一半的场景），
    //    不存在才创建。运行 token：新建时随创建响应返回；复用时向 /token 端点索取。
    let created = null;
    let nameTry = tunnelName;
    const acct = zone.account.id;
    const q = await this._cfApi('GET', `/accounts/${acct}/cfd_tunnel?name=${encodeURIComponent(nameTry)}&is_deleted=false`, apiToken);
    if (q.success && Array.isArray(q.result) && q.result.length) {
      created = q.result.find((t) => t.status !== 'deleted') || q.result[0];
      nameTry = created.name || nameTry;
      this.log('info', `[隧道] 发现同名隧道「${nameTry}」（${created.id.slice(0, 8)}…），复用并自检补齐配置`);
    }
    if (!created) {
      for (let i = 0; i < 3 && !created; i++) {
        const r = await this._cfApi('POST', `/accounts/${acct}/cfd_tunnel`, apiToken, { name: nameTry, config_src: 'cloudflare' });
        if (r.success && r.result) { created = r.result; break; }
        const code = r.errors && r.errors[0] && r.errors[0].code;
        if (code === 1009 || (r.errors && r.errors[0] && /exist|name/i.test(r.errors[0].message || ''))) {
          nameTry = `${tunnelName}-${Math.random().toString(36).slice(2, 6)}`;
          continue;
        }
        throw new Error(`创建隧道失败：${r.errors && r.errors[0] ? r.errors[0].message : '未知错误'}（请检查令牌权限：账户·Cloudflare Tunnel·编辑）`);
      }
      if (!created) throw new Error('创建隧道失败：隧道名冲突且重试用尽');
    }
    let runToken = created.token || '';
    if (!runToken) {
      const tk = await this._cfApi('GET', `/accounts/${acct}/cfd_tunnel/${created.id}/token`, apiToken);
      if (tk.success && typeof tk.result === 'string' && tk.result) runToken = tk.result;
      else throw new Error(`获取隧道运行令牌失败：${tk.errors && tk.errors[0] ? tk.errors[0].message : '未知错误'}（请检查令牌权限：账户·Cloudflare Tunnel·编辑）`);
    }
    // 3. CNAME 记录：存在则更新指向，不存在则创建
    const target = `${created.id}.cfargotunnel.com`;
    const existing = await this._cfApi('GET', `/zones/${zone.id}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`, apiToken);
    if (existing.success && Array.isArray(existing.result) && existing.result.length) {
      const rec = existing.result[0];
      if (rec.content !== target) {
        const up = await this._cfApi('PUT', `/zones/${zone.id}/dns_records/${rec.id}`, apiToken, { type: 'CNAME', name: hostname, content: target, proxied: true });
        if (!up.success) throw new Error(`更新 DNS 记录失败：${up.errors && up.errors[0] ? up.errors[0].message : '未知错误'}`);
      }
    } else {
      const add = await this._cfApi('POST', `/zones/${zone.id}/dns_records`, apiToken, { type: 'CNAME', name: hostname, content: target, proxied: true });
      if (!add.success) {
        const code = add.errors && add.errors[0] && add.errors[0].code;
        if (code !== 81057 && code !== 81053) { // 已存在类错误视为成功
          throw new Error(`创建 DNS 记录失败：${add.errors && add.errors[0] ? add.errors[0].message : '未知错误'}（请检查令牌权限：区域·DNS·编辑）`);
        }
      }
    }
    // 4. ingress 路由（remotely-managed 模式规则存 CF 云端）：把 hostname 映射到本机服务端口，
    //    缺了这步流量进隧道后无规则匹配会 503。保留隧道上其他域名的既有规则，catch-all 收尾。
    const svc = `http://localhost:${this.localPort}`;
    const cfgPath = `/accounts/${zone.account.id}/cfd_tunnel/${created.id}/configurations`;
    const curCfg = await this._cfApi('GET', cfgPath, apiToken);
    const curRules = (curCfg.success && curCfg.result && curCfg.result.config && Array.isArray(curCfg.result.config.ingress))
      ? curCfg.result.config.ingress.filter((r) => r && r.hostname && r.hostname !== hostname)
      : [];
    const putCfg = await this._cfApi('PUT', cfgPath, apiToken, {
      config: { ingress: [{ hostname, service: svc }, ...curRules, { service: 'http_status:404' }] }
    });
    if (!putCfg.success) {
      throw new Error(`配置隧道路由失败：${putCfg.errors && putCfg.errors[0] ? putCfg.errors[0].message : '未知错误'}`);
    }
    this.log('info', `[隧道] 命名隧道初始化完成：${hostname} → 隧道 ${nameTry}（${created.id.slice(0, 8)}…）→ 本机端口 ${this.localPort}`);
    return { tunnelId: created.id, token: runToken, hostname, tunnelName: nameTry, zone: zone.name };
  }

  /** Cloudflare API v4 调用（https JSON；4xx/5xx 不抛异常，返回 body 交给调用方判 success） */
  _cfApi(method, apiPath, token, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: 'api.cloudflare.com',
        path: `/client/v4${apiPath}`,
        method,
        headers: Object.assign(
          { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          data ? { 'Content-Length': Buffer.byteLength(data) } : {}
        ),
        timeout: 20 * 1000
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(buf || '{}')); } catch (_) { resolve({ success: false, errors: [{ message: '响应解析失败' }] }); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Cloudflare API 请求超时')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  describe() {
    if (!this.enabled) return '关闭（仅局域网）';
    return this.url ? `开启（${this.url}）` : '开启（地址未就绪，仅局域网可用）';
  }
}

module.exports = TunnelManager;

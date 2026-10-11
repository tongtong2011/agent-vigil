'use strict';
/**
 * 企业微信应用消息推送模块（V2，可选）
 *
 * 用途：配对码 / 公网地址变动时，把最新连接信息推送到用户的微信（经企业微信官方 API）。
 * 原则：免费、无条数上限、官方接口零封号风险；消息出现在微信「微工作台」会话中。
 *
 * 配置（config.json，全部留空 = 功能关闭，所有调用安静返回 false，不影响服务）：
 *   wecom: {
 *     corpId:     '企业ID（我的企业 → 企业信息）',
 *     corpSecret: '应用 Secret（应用管理 → 自建应用）',
 *     agentId:    1000002,
 *     toUser:     '@all'
 *   }
 *
 * 接收端设置：微信 → 通用 → 辅助功能 → 微工作台（企业微信插件）→ 关注并加入自己的企业。
 *
 * 实现：
 *   - access_token 缓存复用（企业微信返回 7200s，提前 5 分钟刷新）
 *   - token 失效（errcode 40014/42001）自动刷新重试一次
 *   - 网络失败重试 1 次；未配置时安静降级
 */
const https = require('https');

const API_HOST = 'qyapi.weixin.qq.com';
const TOKEN_TTL_MS = 7200 * 1000;
const TOKEN_REFRESH_EARLY_MS = 5 * 60 * 1000;

function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = https.request({
      host: API_HOST,
      path: pathname,
      method: 'POST',
      timeout: 8000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length
      }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`响应解析失败: ${buf.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

class WecomNotifier {
  constructor(cfg, log) {
    const w = (cfg && cfg.wecom) || {};
    this.corpId = (w.corpId || '').trim();
    this.corpSecret = (w.corpSecret || '').trim();
    this.agentId = Number(w.agentId) || 0;
    this.toUser = (w.toUser || '@all').trim();
    this.log = log || (() => {});
    this._token = null;      // { value, fetchedAt }
    this._lastSentAt = 0;    // 简单限速：两次发送至少间隔 500ms
  }

  /** 是否已配置（三项齐全才启用） */
  get configured() {
    return !!(this.corpId && this.corpSecret && this.agentId);
  }

  async _fetchToken() {
    const res = await postJson(
      `/cgi-bin/gettoken?corpid=${encodeURIComponent(this.corpId)}&corpsecret=${encodeURIComponent(this.corpSecret)}`,
      {}
    );
    if (!res || res.errcode !== 0 || !res.access_token) {
      throw new Error(`获取 access_token 失败: errcode=${res && res.errcode} errmsg=${res && res.errmsg}`);
    }
    this._token = { value: res.access_token, fetchedAt: Date.now() };
    return this._token.value;
  }

  async _getToken(force) {
    if (!force && this._token &&
        Date.now() - this._token.fetchedAt < TOKEN_TTL_MS - TOKEN_REFRESH_EARLY_MS) {
      return this._token.value;
    }
    return this._fetchToken();
  }

  /**
   * 发送文本卡片消息（点击卡片跳转 url）
   * @returns {Promise<boolean>} 是否成功（未配置/失败均返回 false，不抛异常）
   */
  async sendCard(title, description, url) {
    if (!this.configured) return false;
    const gap = 500 - (Date.now() - this._lastSentAt);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await this._getToken(!!attempt);
        const res = await postJson(`/cgi-bin/message/send?access_token=${token}`, {
          touser: this.toUser,
          msgtype: 'textcard',
          agentid: this.agentId,
          textcard: {
            title: String(title).slice(0, 128),
            description: String(description).slice(0, 512),
            url: String(url || ''),
            btntxt: '打开看板'
          }
        });
        if (res && res.errcode === 0) {
          this._lastSentAt = Date.now();
          return true;
        }
        // token 失效 → 刷新后重试一次
        if (res && (res.errcode === 40014 || res.errcode === 42001)) continue;
        this.log('warn', `[企业微信] 发送失败: errcode=${res && res.errcode} errmsg=${res && res.errmsg}`);
        return false;
      } catch (e) {
        if (attempt === 1) {
          this.log('warn', `[企业微信] 发送异常（不影响桥接服务）: ${e.message}`);
          return false;
        }
      }
    }
    return false;
  }

  /** 掩码显示配置状态（用于日志） */
  describe() {
    if (!this.configured) return '未配置（推送关闭）';
    const mask = (s) => (s.length <= 8 ? '****' : `${s.slice(0, 4)}****${s.slice(-4)}`);
    return `已配置（corpId=${mask(this.corpId)}, agentId=${this.agentId}）`;
  }
}

module.exports = WecomNotifier;

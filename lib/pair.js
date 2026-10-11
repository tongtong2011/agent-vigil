'use strict';
/**
 * 二维码配对模块
 * - 桥接启动时生成配对码（默认 15 分钟有效，可在有效期内重复使用），随二维码展示在控制台
 * - 手机提交配对码换取设备令牌（deviceToken），后续 API / WebSocket 均凭令牌访问
 * - 有效期语义：码在 TTL 内始终有效（多台设备可先后用同一码配对），过期才作废并自动换新码推送
 * - 令牌仅保存在内存：桥接重启后需重新扫码配对（MVP 策略，见 README 常见问题）
 */
const crypto = require('crypto');

class PairManager {
  /**
   * @param {object} opts { ttlMinutes: 配对码有效期（分钟），默认 15，范围 5~120 }
   */
  constructor(opts) {
    const m = Number(opts && opts.ttlMinutes) || 15;
    this.ttlMs = Math.min(120, Math.max(5, m)) * 60 * 1000; // 配对码有效期（5~120 分钟）
    this.codes = new Map();      // code -> { expires }
    this.tokens = new Set();     // 已配对设备令牌
    this.onCodeIssued = null;    // (code) => void；V2 钩子：配对码生成时通知（用于推送）
  }

  /** 生成新的一次性配对码 */
  issueCode() {
    this._gc();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.codes.set(code, { expires: Date.now() + this.ttlMs });
    if (this.onCodeIssued) {
      try { this.onCodeIssued(code); } catch (_) { /* 钩子异常不影响配对 */ }
    }
    return code;
  }

  /** 校验配对码；成功返回设备令牌（码保留至过期，有效期内可重复使用），失败返回 null */
  pair(code) {
    const key = String(code || '').trim();
    const rec = this.codes.get(key);
    if (!rec || rec.expires < Date.now()) {
      this.codes.delete(key);
      return null;
    }
    const token = crypto.randomBytes(24).toString('hex');
    this.tokens.add(token);
    return token;
  }

  verify(token) {
    return typeof token === 'string' && token.length > 0 && this.tokens.has(token);
  }

  /** 更新配对码有效期（分钟，5~120；V2 配置向导热应用）；仅影响之后新发的配对码 */
  setTtlMinutes(m) {
    const n = Number(m) || 15;
    this.ttlMs = Math.min(120, Math.max(5, n)) * 60 * 1000;
  }

  /** 指定配对码当前是否仍有效（未过期即为有效；V2 配置向导完成页使用） */
  isActive(code) {
    this._gc();
    return this.codes.has(String(code || ''));
  }

  /** 当前是否仍有未过期配对码（用于过期自动刷新） */
  hasActiveCode() {
    this._gc();
    return this.codes.size > 0;
  }

  /** 返回当前有效配对码（GC 后的第一个；无则 null）——告警/汇总邮件链接拼 code 用 */
  currentCode() {
    this._gc();
    for (const c of this.codes.keys()) return c;
    return null;
  }

  _gc() {
    const now = Date.now();
    for (const [k, v] of this.codes) {
      if (v.expires < now) this.codes.delete(k);
    }
  }
}

module.exports = PairManager;

'use strict';
/**
 * 爱思办公适配器（lib/adapters/agnes.js）
 *
 * 包装现有 OfficialClient（lib/official.js，ACP 真实数据实现，稳定运行多周）。
 * V4 Phase 1 采用委托而非重写：现有看板/告警链路零回归，同时验证 Adapter 接口
 * 的表达能力（列表/详情/发消息/健康/实时回调全部透传）。
 */

const { BaseAdapter, AdapterError } = require('./base');

class AgnesAdapter extends BaseAdapter {
  /**
   * @param {import('../official')} official 已初始化（或即将初始化）的 OfficialClient 实例
   * @param {object} cfg 全局配置（sendMessage 的 messages.enabled 开关读取用）
   */
  constructor(official, cfg) {
    super();
    this.official = official;
    this.cfg = cfg;
  }

  get channel() { return 'agnes'; }
  get displayName() { return '爱思办公'; }

  async init(ctx) {
    // OfficialClient 的发现/连接由 bridge 启动流程完成（official.init(log)）；
    // 这里只补齐日志引用，不重复连接。
    this._log = ctx && ctx.log;
  }

  async close() { /* OfficialClient 生命周期归 bridge 管（SIGINT 时随进程退出） */ }

  async health() { return !!(this.official && this.official.acp); }

  describe() { return this.official ? this.official.describe() : `${this.displayName}（未初始化）`; }

  async listTasks() { return this.official.getTasks(); }

  async getTask(id) { return this.official.getTask(id); }

  async sendMessage(id, text) {
    if (!this.cfg.messages || this.cfg.messages.enabled === false) {
      throw new AdapterError('FORBIDDEN', '发消息功能已在配置中关闭（messages.enabled=false）');
    }
    return this.official.sendMessage(id, text);
  }

  setOnChange(fn) { this.official.setOnChange(fn); }

  taskCount() { return this.official._sessions ? this.official._sessions.size : -1; }
}

module.exports = { AgnesAdapter };

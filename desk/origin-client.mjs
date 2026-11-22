// 来源联调站客户端：排期、门户网页、原件下载、终端回执与设备清单。
// 门户是有授权的网页操作，所有领取都先经选择页，再打开对应场次/用途的授权页。

import { parseChoosePage, parsePackagePage } from './portal-html.mjs';

export class OriginError extends Error {
  constructor(message, { status, url, gone } = {}) {
    super(message);
    this.name = 'OriginError';
    this.status = status;
    this.url = url;
    this.gone = gone === true;
  }
}

export class OriginClient {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
  }

  async getJson(path) {
    const res = await fetch(this.base + path);
    if (!res.ok) throw new OriginError(`来源 ${path} 返回 ${res.status}`, { status: res.status, url: path });
    return res.json();
  }

  async roster() {
    const data = await this.getJson('/schedule/roster');
    return data.events;
  }

  async terminals() {
    const [imports, inventory] = await Promise.all([
      this.getJson('/terminals/imports'),
      this.getJson('/terminals/inventory'),
    ]);
    return { receipts: imports.receipts, devices: inventory.devices };
  }

  // 打开选择页，确认该场次/用途在门户允许的选项内，并拼出授权页地址。
  async packageUrl(show, use) {
    const res = await fetch(this.base + '/portal/shows');
    if (!res.ok) throw new OriginError(`门户选择页返回 ${res.status}`, { status: res.status });
    const { action, selects } = parseChoosePage(await res.text());
    const showSelect = selects.find(s => s.name === 'show');
    const useSelect = selects.find(s => s.name === 'use');
    if (!showSelect?.options.includes(show) || !useSelect?.options.includes(use)) {
      throw new OriginError(`门户不允许领取场次 ${show} 用途 ${use}`, { status: 403 });
    }
    const url = new URL(action.startsWith('http') ? action : this.base + action);
    url.searchParams.set('show', show);
    url.searchParams.set('use', use);
    return url.pathname + url.search;
  }

  // 从授权页领取带组合号的介质清单与设备授权。
  async fetchPackage(show, use) {
    const path = await this.packageUrl(show, use);
    const res = await fetch(this.base + path);
    if (!res.ok) throw new OriginError(`授权页返回 ${res.status}`, { status: res.status, url: path });
    return { path, ...parsePackagePage(await res.text()) };
  }

  // 下载原件。临时链接关闭（410）时显式抛出 gone，调用方须重新去该场次/用途申请。
  async download(href) {
    const res = await fetch(this.base + href);
    if (res.status === 410) {
      throw new OriginError('临时链接已过期，需重新到该场次该用途下申请', { status: 410, url: href, gone: true });
    }
    if (!res.ok) throw new OriginError(`原件 ${href} 返回 ${res.status}`, { status: res.status, url: href });
    return Buffer.from(await res.arrayBuffer());
  }
}

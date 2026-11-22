// 值台放映交接工具的核心编排：
// 同步排期与门户授权、领取/复用原件、判断当前厅是否真能开场、登记并核对交接确认。

import { eventWindow, coversWindow } from './zonetime.mjs';
import { OriginClient, OriginError } from './origin-client.mjs';
import { Store } from './store.mjs';

const keyOf = (show, use) => `${show} ${use}`;

export class DeskTool {
  constructor(home, originBase) {
    this.store = new Store(home);
    this.origin = new OriginClient(originBase);
  }

  // 全量同步：排期 -> 逐场次到门户核对领用资格并取件 -> 终端回执与设备清单。
  async syncAll({ now = new Date() } = {}) {
    const events = await this.origin.roster();
    this.store.state.events = events;
    const terminals = await this.origin.terminals();
    this.store.state.terminals = { ...terminals, fetchedAt: now.toISOString() };

    const results = [];
    for (const event of events) {
      this.store.state.rosterRev[event.show] = event.rev;
      let pkg;
      try {
        pkg = await this.origin.fetchPackage(event.show, event.use);
      } catch (err) {
        results.push({ show: event.show, use: event.use, ok: false, error: err.message });
        continue;
      }
      this.store.state.packages[keyOf(event.show, event.use)] = {
        show: event.show, use: event.use, rev: event.rev,
        combo: pkg.combo, version: pkg.version, path: pkg.path,
        downloads: pkg.downloads, licenses: pkg.licenses, claimedAt: now.toISOString(),
      };
      results.push(await this.#claimDownloads(event.show, event.use, pkg.downloads, now));
    }
    this.store.state.syncedAt = now.toISOString();
    this.store.save();
    return { events, terminals, results };
  }

  // 按清单逐项取件。内容一致的缓存原件可复用；410 表示须重新申请，绝不拿别的组合文件顶替。
  // 每次领取以当前清单重建该场次用途的领用记录，旧清单里已不存在的项不得继续冒充资料。
  async #claimDownloads(show, use, downloads, now) {
    const claims = {};
    const detail = [];
    for (const item of downloads) {
      const claim = { asset: item.asset, sha: item.sha, href: item.href, at: now.toISOString() };
      if (this.store.verifyAsset(item.sha)) {
        claim.status = 'held';
        claim.reused = true;
      } else {
        try {
          const buffer = await this.origin.download(item.href);
          this.store.putAsset(buffer, item.sha);
          claim.status = 'held';
          claim.reused = false;
        } catch (err) {
          claim.status = err instanceof OriginError && err.gone ? 'expired' : 'failed';
          claim.error = err.message;
        }
      }
      claims[item.asset] = claim;
      detail.push({ ...item, status: claim.status, reused: claim.reused ?? false, error: claim.error });
    }
    this.store.state.claims[keyOf(show, use)] = claims;
    return { show, use, ok: detail.every(d => d.status === 'held'), downloads: detail };
  }

  // 单场次重新取件（排片改动后或临时链接过期后重申请）。
  async syncShow(show, use) {
    const events = await this.origin.roster();
    this.store.state.events = events;
    const event = events.find(e => e.show === show && e.use === use);
    if (!event) throw new Error(`当前排期没有场次 ${show}（${use}）`);
    this.store.state.rosterRev[show] = event.rev;
    const terminals = await this.origin.terminals();
    this.store.state.terminals = { ...terminals, fetchedAt: new Date().toISOString() };
    const pkg = await this.origin.fetchPackage(show, use);
    this.store.state.packages[keyOf(show, use)] = {
      show, use, rev: event.rev, combo: pkg.combo, version: pkg.version, path: pkg.path,
      downloads: pkg.downloads, licenses: pkg.licenses, claimedAt: new Date().toISOString(),
    };
    const result = await this.#claimDownloads(show, use, pkg.downloads, new Date());
    this.store.state.syncedAt = new Date().toISOString();
    this.store.save();
    return result;
  }

  // 开场判定：逐项指出当前实际状况与缺口。
  evaluate(show, use) {
    const s = this.store.state;
    const event = this.#event(show, use);
    const pkg = s.packages[keyOf(show, use)];
    const window = eventWindow(event);
    const checks = [];
    const gaps = [];

    // 1. 领取的清单必须对应当前排期 rev 与组合号。
    const pkgCurrent = pkg && pkg.rev === event.rev;
    checks.push({ name: '授权清单版本', ok: pkgCurrent === true,
      detail: pkg ? `rev ${pkg.rev} / 组合 ${pkg.combo} / 清单 ${pkg.version}` : '尚未领取授权页' });
    if (!pkgCurrent) gaps.push(pkg ? `授权清单停留在 rev ${pkg.rev}，当前排期为 rev ${event.rev}，须重新领取` : '尚未到该场次该用途下领取授权清单');

    const comboMatch = pkg && pkg.combo === event.combo;
    if (pkg && !comboMatch) gaps.push(`清单组合号 ${pkg.combo} 与排期组合 ${event.combo} 不一致`);

    // 2. 介质：以本次清单为准逐项核对，缺项不能用其他组合同名文件替代。
    const materials = [];
    let materialsComplete = false;
    if (pkg) {
      const claims = s.claims[keyOf(show, use)] ?? {};
      for (const item of pkg.downloads) {
        const claim = claims[item.asset];
        const held = claim?.status === 'held' && claim.sha === item.sha && this.store.verifyAsset(item.sha);
        const status = !claim ? 'missing' : claim.status === 'held' ? (held ? 'held' : 'tampered') : claim.status;
        materials.push({ asset: item.asset, label: item.label, sha: item.sha, href: item.href,
          status, reused: claim?.reused === true });
        if (!held) {
          gaps.push(status === 'expired'
            ? `介质 ${item.asset}（${item.label}）临时链接已过期，须重新到该场次该用途申请`
            : `介质 ${item.asset}（${item.label}）未收齐或摘要不符`);
        }
      }
      materialsComplete = materials.length > 0 && materials.every(m => m.status === 'held');
    }
    checks.push({ name: '介质收齐', ok: materialsComplete,
      detail: materials.map(m => `${m.asset}:${m.status === 'held' ? (m.reused ? '已复用' : '已领取') : m.status}`).join('，') || '无清单' });

    // 3. 设备在线（登记台手动下线的旧设备不得继续使用，授权不随换厅继承）。
    const device = s.terminals?.devices.find(d => d.id === event.device);
    const online = device?.online === true;
    checks.push({ name: '设备在线', ok: online, detail: `${event.device}（${event.hall}）${online ? '在线' : '已下线或不在设备清单'}` });
    if (!online) gaps.push(`当前厅设备 ${event.device} 已下线或不可用，原厅授权不能由新厅继承`);

    // 4. 授权：组合号、设备证号、用途、起止时刻四项全中，且完整覆盖整场本地换算时间。
    const license = this.#matchLicense(pkg, event, window, gaps);
    checks.push({ name: '设备授权窗', ok: license !== null,
      detail: license ? `${license.device} ${license.startUtc}–${license.endUtc} 覆盖整场` : '无覆盖整场的有效授权' });

    // 5. 导入回执：必须对得上当前设备、清单版本与用途。
    const receipt = this.#matchReceipt(event, pkg);
    checks.push({ name: '终端导入回执', ok: receipt !== null,
      detail: receipt ? `${receipt.id}（${receipt.status}）` : '当前设备缺少对得上该组合版本与用途的导入回执' });
    if (!receipt) gaps.push(`设备 ${event.device} 缺少 ${event.show} ${event.use} 清单版本 ${pkg?.version ?? '?'} 的导入回执`);

    const ready = Boolean(pkgCurrent && comboMatch && materialsComplete && online && license && receipt);
    return {
      show, use, rev: event.rev, hall: event.hall, device: event.device,
      combo: event.combo, window: { start: window.start.toISOString(), end: window.end.toISOString() },
      package: pkg ? { combo: pkg.combo, version: pkg.version, rev: pkg.rev } : null,
      materials, checks, license: license ? { ...license } : null,
      receipt: receipt ? { id: receipt.id, status: receipt.status } : null,
      ready, gaps,
    };
  }

  #event(show, use) {
    const events = this.#events();
    const event = events.find(e => e.show === show && e.use === use);
    if (!event) throw new Error(`当前排期没有场次 ${show}（${use}）`);
    return event;
  }

  #events() {
    // 排期以最近一次同步为准；状态里保留 rev 索引，实际事件由调用方同步后评估。
    return this.store.state.events ?? [];
  }

  #matchLicense(pkg, event, window, gaps) {
    if (!pkg) return null;
    let matched = null;
    for (const lic of pkg.licenses) {
      const reasons = [];
      if (lic.device !== event.device) reasons.push(`设备证号为 ${lic.device}，当前厅设备是 ${event.device}`);
      if (lic.combo !== event.combo) reasons.push(`组合号 ${lic.combo} 与排期 ${event.combo} 不符`);
      if (lic.use !== event.use) reasons.push(`授权用途「${lic.use}」不能用于「${event.use}」（试播授权不算正式场）`);
      if (reasons.length === 0 && !coversWindow(lic, window)) {
        reasons.push(`授权窗 ${lic.startUtc}–${lic.endUtc} 未覆盖整场 ${window.start.toISOString()}–${window.end.toISOString()}`);
      }
      if (!reasons.length) { matched = lic; break; }
      gaps.push(`授权 ${lic.device}/${lic.combo}/${lic.use}：${reasons.join('；')}`);
    }
    return matched;
  }

  #matchReceipt(event, pkg) {
    if (!pkg) return null;
    const receipts = this.store.state.terminals?.receipts ?? [];
    return receipts.find(r => r.status === 'imported' &&
      r.show === event.show && r.use === event.use &&
      r.device === event.device && r.version === pkg.version) ?? null;
  }

  // 接手放映员确认交接。未满足开场条件时拒绝，并给出具体缺口。
  confirmHandover(show, use, projectionist) {
    if (!projectionist || !String(projectionist).trim()) throw new Error('须填写接手放映员');
    const report = this.evaluate(show, use);
    if (!report.ready) {
      const err = new Error('当前不具备开场条件，不能确认交接');
      err.gaps = report.gaps;
      throw err;
    }
    const record = {
      id: 'HO-' + (this.store.state.handovers.length + 1),
      at: new Date().toISOString(),
      projectionist: String(projectionist).trim(),
      show, use,
      basis: {
        rev: report.rev, hall: report.hall, device: report.device,
        combo: report.package.combo, version: report.package.version,
        receiptId: report.receipt.id,
        license: { ...report.license },
        window: report.window,
        materials: report.materials.map(m => ({ asset: m.asset, sha: m.sha })),
      },
    };
    this.store.state.handovers.push(record);
    this.store.save();
    return record;
  }

  // 找出当前仍被实际接受的确认：最近一次且依据与当前排期/清单/回执全部对得上。
  currentConfirmation(show, use) {
    const report = this.evaluate(show, use);
    const records = this.store.state.handovers.filter(h => h.show === show && h.use === use);
    const stale = [];
    for (const h of [...records].reverse()) {
      const reasons = this.#basisDrift(h.basis, report);
      if (reasons.length === 0) return { accepted: h, stale, report };
      stale.push({ id: h.id, projectionist: h.projectionist, at: h.at, reasons });
    }
    return { accepted: null, stale, report };
  }

  #basisDrift(basis, report) {
    const reasons = [];
    if (basis.rev !== report.rev) reasons.push(`确认基于 rev ${basis.rev}，当前排期为 rev ${report.rev}`);
    if (basis.hall !== report.hall || basis.device !== report.device) reasons.push('换厅或更换播放终端后依据已失效');
    if (report.package && (basis.combo !== report.package.combo || basis.version !== report.package.version)) {
      reasons.push(`确认基于 ${basis.combo}/${basis.version}，当前清单为 ${report.package.combo}/${report.package.version}`);
    }
    if (!report.receipt || basis.receiptId !== report.receipt.id) reasons.push('导入回执已变化或缺失，须重新确认');
    if (!report.license) reasons.push('原授权窗已不再覆盖当前场次');
    if (!report.checks.find(c => c.name === '介质收齐')?.ok) reasons.push('介质资料已不完整');
    const currentShas = new Set(report.materials.map(m => m.sha));
    const basisShas = new Set((basis.materials ?? []).map(m => m.sha));
    if (basisShas.size !== currentShas.size || [...basisShas].some(x => !currentShas.has(x))) {
      reasons.push('确认时的介质组合与当前清单不一致');
    }
    return reasons;
  }

  handoverHistory(show, use) {
    return this.store.state.handovers.filter(h => h.show === show && h.use === use);
  }

  // 开场名单：逐场指出当前接受哪次确认，以及缺了哪些资料、时窗或回执。
  openingList(shows) {
    const wanted = shows ?? [...new Set((this.store.state.events ?? []).map(e => e.show))];
    return wanted.map(show => {
      const event = (this.store.state.events ?? []).find(e => e.show === show);
      if (!event) return { show, missing: ['排期中已无该场次'] };
      const confirmation = this.currentConfirmation(event.show, event.use);
      // 当前接受的确认之外，其余历史确认全部列为已失效/已被取代，保留可查痕迹。
      const history = this.handoverHistory(event.show, event.use)
        .filter(h => h.id !== confirmation.accepted?.id)
        .map(h => ({ id: h.id, projectionist: h.projectionist, at: h.at,
          reasons: confirmation.stale.find(s => s.id === h.id)?.reasons ?? ['已被更新的确认取代'] }));
      return { show, use: event.use, ...confirmation.report,
        acceptedConfirmation: confirmation.accepted ? confirmation.accepted.id : null,
        staleConfirmations: history };
    });
  }
}

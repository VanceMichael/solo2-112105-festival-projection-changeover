import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { origin } from '../origin/origin.mjs';
import { DeskTool } from '../desk/desk.mjs';
import { eventWindow, coversWindow } from '../desk/zonetime.mjs';
import { parseChoosePage, parsePackagePage } from '../desk/portal-html.mjs';

async function startOrigin() {
  const server = origin().listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { base, close: () => new Promise(r => server.close(r)) };
}

async function freshHome() {
  return mkdtemp(join(tmpdir(), 'desk-'));
}

async function switchRelease(base, name) {
  const res = await fetch(base + '/_desk/releases/' + encodeURIComponent(name), { method: 'POST' });
  assert.equal(res.status, 200);
}

test('本地时间按场地时区换算并处理跨午夜', () => {
  const w = eventWindow({ date: '2026-11-25', fromTime: '19:30', toTime: '21:20', zone: 'Asia/Bangkok' });
  assert.equal(w.start.toISOString(), '2026-11-25T12:30:00.000Z');
  assert.equal(w.end.toISOString(), '2026-11-25T14:20:00.000Z');

  const cross = eventWindow({ date: '2026-11-25', fromTime: '23:40', toTime: '00:20', zone: 'Asia/Bangkok' });
  assert.equal(cross.end.getTime() - cross.start.getTime(), 40 * 60_000);

  assert.equal(coversWindow(
    { startUtc: '2026-11-25T12:30:00Z', endUtc: '2026-11-25T14:20:00Z' }, w), true);
  assert.equal(coversWindow(
    { startUtc: '2026-11-25T12:31:00Z', endUtc: '2026-11-25T14:20:00Z' }, w), false);
  assert.equal(coversWindow(
    { startUtc: '2026-11-25T12:30:00Z', endUtc: '2026-11-25T14:19:00Z' }, w), false);
});

test('门户 HTML 解析出选择项、组合号、清单与授权表', () => {
  const choose = parseChoosePage(
    '<form action="/portal/package"><label>场次 <select name="show"><option>P14</option><option>P15</option></select></label></form>');
  assert.equal(choose.action, '/portal/package');
  assert.deepEqual(choose.selects[0].options, ['P14', 'P15']);

  const pkg = parsePackagePage(
    '<dl><dt>组合号</dt><dd>C-1</dd><dt>清单版本</dt><dd>v9</dd></dl>' +
    '<ul aria-label="交付件"><li><a download href="/assets/x">影片载荷</a> <span>介质编号 D1</span> <code>' +
    '982af5f6baccfabd5a45c5bd26ef766ec38a488650bf31f621e94921106ec946</code></li></ul>' +
    '<table><thead><tr><th>设备证号</th><th>组合号</th><th>用途</th><th>UTC 开始</th><th>UTC 截止</th></tr></thead>' +
    '<tbody><tr><td>DC-F</td><td>C-1</td><td>正式场</td><td>2026-11-25T12:20:00Z</td><td>2026-11-25T14:30:00Z</td></tr></tbody></table>');
  assert.equal(pkg.combo, 'C-1');
  assert.equal(pkg.version, 'v9');
  assert.equal(pkg.downloads[0].asset, 'D1');
  assert.equal(pkg.licenses[0].device, 'DC-F');
});

test('首发：两场正式场与试播均可完成取件、判定与交接，试播授权不串用', async () => {
  const { base, close } = await startOrigin();
  const home = await freshHome();
  try {
    await switchRelease(base, '首发');
    const tool = new DeskTool(home, base);
    const sync = await tool.syncAll();
    assert.ok(sync.results.every(r => r.ok));

    for (const [show, use] of [['P14', '正式场'], ['P15', '正式场'], ['P14-T', '试播']]) {
      const report = tool.evaluate(show, use);
      assert.equal(report.ready, true, show + ' ' + report.gaps.join('；'));
      const record = tool.confirmHandover(show, use, '阿婉');
      assert.match(record.id, /^HO-/);
      const current = tool.currentConfirmation(show, use);
      assert.equal(current.accepted.id, record.id);
    }

    // 试播是独立组合与用途，试播授权不能算到正式场头上。
    const trailer = tool.evaluate('P14-T', '试播');
    assert.equal(trailer.license.combo, 'FEN-trailer');
    assert.equal(trailer.license.use, '试播');
    assert.notEqual(trailer.combo, 'FEN-zh');
  } finally {
    await rm(home, { recursive: true, force: true });
    await close();
  }
});

test('换厅：旧厅设备下线、授权窗不覆盖拉长后的整场、旧回执失效，须重新判断', async () => {
  const { base, close } = await startOrigin();
  const home = await freshHome();
  try {
    await switchRelease(base, '首发');
    const tool = new DeskTool(home, base);
    await tool.syncAll();
    const first = tool.confirmHandover('P14', '正式场', '阿婉');
    const p15First = tool.confirmHandover('P15', '正式场', '阿婉');

    await switchRelease(base, '换厅');
    await tool.syncAll();
    const report = tool.evaluate('P14', '正式场');

    assert.equal(report.hall, '泥厅');
    assert.equal(report.device, 'DC-N');
    assert.equal(report.ready, false);
    // 登记台已把旧厅设备 DC-F 手动下线；旧厅授权不能由新厅 DC-N 继承。
    const dcF = tool.store.state.terminals.devices.find(d => d.id === 'DC-F');
    assert.equal(dcF.online, false);
    assert.equal(report.checks.find(c => c.name === '设备在线').ok, true);
    assert.ok(!report.gaps.some(g => g.includes('DC-F')), '旧设备授权不应再出现在当前判定里');
    // v13 授权窗 12:15–14:30 盖不到拉长到 15:05 的整场。
    assert.ok(report.gaps.some(g => g.includes('未覆盖整场')), report.gaps.join('|'));
    // 终端上只有旧设备 v12 的回执，对不上 DC-N/v13。
    assert.ok(report.gaps.some(g => g.includes('导入回执')), report.gaps.join('|'));

    // 不具备开场条件时拒绝登记新交接。
    assert.throws(() => tool.confirmHandover('P14', '正式场', '阿婉'), /不能确认交接/);

    // 原放映员签过的记录仍可查，但已不再被接受，并说明原因。
    const current = tool.currentConfirmation('P14', '正式场');
    assert.equal(current.accepted, null);
    assert.equal(current.stale[0].id, first.id);
    assert.ok(current.stale[0].reasons.some(r => r.includes('rev')));

    // 并行的石厅 P15 未受换厅影响，仍可开场且原确认继续有效。
    const p15 = tool.currentConfirmation('P15', '正式场');
    assert.equal(p15.report.ready, true);
    assert.ok(p15.accepted, '另一厅应继续接受原确认');
    assert.equal(p15.accepted.id, p15First.id);
    assert.equal(p15.report.hall, '石厅');
    assert.equal(p15.report.device, 'DC-S');
  } finally {
    await rm(home, { recursive: true, force: true });
    await close();
  }
});

test('换厅后 410 链接须重新申请，内容一致的缓存可复用且仍核对领用资格', async () => {
  const { base, close } = await startOrigin();
  const home = await freshHome();
  try {
    await switchRelease(base, '首发');
    const tool = new DeskTool(home, base);
    await tool.syncAll();
    const before = tool.store.state.claims['P14 正式场'];
    assert.equal(before.D1.status, 'held');

    await switchRelease(base, '换厅');
    const resync = await tool.syncShow('P14', '正式场');
    const d1 = resync.downloads.find(d => d.asset === 'D1');
    // 新链接 /assets/FEN-zh/a2 重新领取成功（旧 a 链接此时 410）。
    assert.equal(d1.status, 'held');
    const d2 = resync.downloads.find(d => d.asset === 'D2');
    assert.equal(d2.reused, true, '字幕内容未变，应复用缓存');

    const expired = await fetch(base + '/assets/FEN-zh/a');
    assert.equal(expired.status, 410);
    const claims = tool.store.state.claims['P14 正式场'];
    assert.equal(claims.D1.href, '/assets/FEN-zh/a2');
    assert.notEqual(claims.D1.href, before.D1.href);
    assert.equal(claims.D1.sha, before.D1.sha, '新链接交付的内容摘要未变');
  } finally {
    await rm(home, { recursive: true, force: true });
    await close();
  }
});

test('缺项不能用其他组合里同名/同摘要文件顶替，篡改缓存会被发现', async () => {
  const { base, close } = await startOrigin();
  const home = await freshHome();
  try {
    await switchRelease(base, '首发');
    const tool = new DeskTool(home, base);
    await tool.syncAll();

    // 伪造一个“别的组合”的缓存文件：摘要不在 P14 清单里，不能冒充 D1。
    const { writeFileSync } = await import('node:fs');
    const fakeSha = 'a'.repeat(64);
    writeFileSync(tool.store.assetPath(fakeSha), 'fake');
    const claims = tool.store.state.claims['P14 正式场'];
    const realD1 = claims.D1.sha;
    assert.notEqual(realD1, fakeSha);
    // 评估只认本清单 sha 对应的缓存，伪造文件不影响判定。
    assert.equal(tool.evaluate('P14', '正式场').ready, true);

    // 篡改已领取原件后，摘要核对失败并报缺口。
    writeFileSync(tool.store.assetPath(realD1), 'tampered');
    const report = tool.evaluate('P14', '正式场');
    assert.equal(report.ready, false);
    assert.ok(report.materials.find(m => m.asset === 'D1').status === 'tampered');
  } finally {
    await rm(home, { recursive: true, force: true });
    await close();
  }
});

test('新授权：授权窗覆盖拉长整场且新终端回执到位后可重新确认', async () => {
  const { base, close } = await startOrigin();
  const home = await freshHome();
  try {
    await switchRelease(base, '首发');
    const tool = new DeskTool(home, base);
    await tool.syncAll();
    tool.confirmHandover('P14', '正式场', '阿婉');

    await switchRelease(base, '换厅');
    await tool.syncAll();
    assert.equal(tool.evaluate('P14', '正式场').ready, false);

    await switchRelease(base, '新授权');
    await tool.syncAll();
    const report = tool.evaluate('P14', '正式场');
    assert.equal(report.ready, true, report.gaps.join('；'));
    assert.equal(report.license.device, 'DC-N');
    assert.equal(report.receipt.id, 'DC-N-P14-v13');
    const second = tool.confirmHandover('P14', '正式场', '阿穆');

    const current = tool.currentConfirmation('P14', '正式场');
    assert.equal(current.accepted.id, second.id);
    // 历史两次确认都在，开场名单指出当前接受第二次。
    const history = tool.handoverHistory('P14', '正式场');
    assert.equal(history.length, 2);
    const list = tool.openingList().find(x => x.show === 'P14');
    assert.equal(list.acceptedConfirmation, second.id);
    assert.equal(list.staleConfirmations.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
    await close();
  }
});

test('门户不允许的场次/用途组合不能领取', async () => {
  const { base, close } = await startOrigin();
  const home = await freshHome();
  try {
    await switchRelease(base, '首发');
    const tool = new DeskTool(home, base);
    await assert.rejects(() => tool.origin.fetchPackage('P14', '配音场'), /不允许领取/);
  } finally {
    await rm(home, { recursive: true, force: true });
    await close();
  }
});

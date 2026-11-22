import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { origin } from '../origin/origin.mjs';
import { deskServer } from '../desk/server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}

async function release(base, name) {
  const res = await fetch(base + '/_desk/releases/' + encodeURIComponent(name), { method: 'POST' });
  assert.equal(res.status, 200);
}

test('值台网页：首发可交接，换厅后指认缺口并失效旧确认，新授权后重新确认', async t => {
  const originServer = origin();
  const originBase = await listen(originServer);
  t.after(() => new Promise(r => originServer.close(r)));

  const home = await mkdtemp(join(tmpdir(), 'desk-ui-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = deskServer(home, originBase);
  const deskBase = await listen(server);
  t.after(() => new Promise(r => server.close(r)));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  // ---- 首发：同步、核对、交接 ----
  await release(originBase, '首发');
  await page.goto(deskBase + '/');
  await page.getByRole('button', { name: '按当前排期重新同步并取件' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'P14', exact: true }).click();
  await page.getByText('可开场').waitFor();
  assert.match(await page.locator('body').innerText(), /风厅/);
  assert.match(await page.locator('body').innerText(), /DC-F/);
  await page.getByLabel('接手放映员').fill('阿婉');
  await page.getByRole('button', { name: '确认当前厅与终端导入回执，完成交接' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByText('当前实际接受：HO-1').waitFor();

  // 回开场名单，P14 应显示接受 HO-1。
  await page.goto(deskBase + '/');
  assert.match(await page.locator('body').innerText(), /接受确认 HO-1/);

  // ---- 换厅：同场不可开场，旧确认失效，缺口逐项点名 ----
  await release(originBase, '换厅');
  await page.goto(deskBase + '/');
  await page.getByRole('button', { name: '按当前排期重新同步并取件' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'P14', exact: true }).click();
  await page.getByText('不可开场').waitFor();
  const bodyAfterChange = await page.locator('body').innerText();
  assert.match(bodyAfterChange, /泥厅/);
  assert.match(bodyAfterChange, /DC-N/);
  assert.match(bodyAfterChange, /未覆盖整场/);
  assert.match(bodyAfterChange, /导入回执/);
  assert.match(bodyAfterChange, /HO-1（阿婉/);
  assert.match(bodyAfterChange, /已失效/);
  // 存在缺口时不提供交接表单。
  assert.equal(await page.getByLabel('接手放映员').count(), 0);

  // 单场重新取件：410 旧链接换新链接后仍能恢复介质状态。
  await page.getByRole('button', { name: '重新到该场次该用途取件并重新判断' }).click();
  await page.waitForLoadState('networkidle');
  const materials = await page.getByRole('table').nth(1).innerText();
  assert.match(materials, /本次领取|已缓存复用/);
  assert.doesNotMatch(materials, /expired|failed/);

  // ---- 新授权：时窗与回执到位，重新确认并保留历史 ----
  await release(originBase, '新授权');
  await page.goto(deskBase + '/');
  await page.getByRole('button', { name: '按当前排期重新同步并取件' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'P14', exact: true }).click();
  await page.getByText('可开场').waitFor();
  await page.getByLabel('接手放映员').fill('阿穆');
  await page.getByRole('button', { name: '确认当前厅与终端导入回执，完成交接' }).click();
  await page.waitForLoadState('networkidle');
  const finalBody = await page.locator('body').innerText();
  assert.match(finalBody, /当前实际接受：HO-2/);
  assert.match(finalBody, /HO-1/); // 历史记录仍可查

  // 并行的石厅 P15 全程未受影响。
  await page.goto(deskBase + '/');
  const list = await page.locator('body').innerText();
  assert.match(list, /P15[\s\S]*可开场/);
});

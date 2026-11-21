import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

import { openOrigin } from './test-origin.mjs';

test('放映端从场次选择页领取介质并查看设备授权', async t => {
  const base = await openOrigin(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(base + '/portal/shows');
  await page.getByLabel('场次').selectOption('P14');
  await page.getByLabel('用途').selectOption('正式场');
  await page.getByRole('button', { name: '打开' }).click();
  await page.getByRole('heading', { name: 'P14 正式场' }).waitFor();
  assert.match(await page.getByRole('table').innerText(), /DC-F/);
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: '影片载荷' }).click();
  const contents = await readFile(await (await download).path());
  const sha = await page.getByRole('list', { name: '交付件' }).locator('code').first().innerText();
  assert.equal(createHash('sha256').update(contents).digest('hex'), sha);
  const oldLink = await page.getByRole('link', { name: '影片载荷' }).getAttribute('href');
  await fetch(base + '/_desk/releases/' + encodeURIComponent('换厅'), { method: 'POST' });
  assert.equal((await fetch(base + oldLink)).status, 410);
  await page.reload();
  assert.match(await page.getByRole('table').innerText(), /DC-N/);
  assert.notEqual(await page.getByRole('link', { name: '影片载荷' }).getAttribute('href'), oldLink);
});

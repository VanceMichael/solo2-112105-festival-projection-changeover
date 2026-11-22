// 值台 Web 界面：打开场次即可看到当前厅、介质、授权窗、回执与交接状态。
// 纯内置 http，无第三方依赖；写操作只接受表单 POST。

import { createServer } from 'node:http';
import { DeskTool } from './desk.mjs';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function badge(ok) {
  return `<span class="badge ${ok ? 'ok' : 'bad'}">${ok ? '满足' : '缺失'}</span>`;
}

function page(title, body) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;margin:24px;color:#1b2430}
table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #c7d0da;padding:6px 10px}
.badge{padding:2px 8px;border-radius:10px;font-size:12px}.ok{background:#d9f2e0}.bad{background:#f8d7da}
.gap{color:#a02020}.ready{font-size:18px;font-weight:700}.go{color:#0d7a36}.nogo{color:#a02020}
form{margin:10px 0}.small{color:#5a6b7d;font-size:13px}code{background:#eef1f4;padding:1px 4px}
</style>
<h1>${esc(title)}</h1>${body}`;
}

function formBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 8192) reject(new Error('表单过长')); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
    req.on('error', reject);
  });
}

export function deskServer(home, originBase) {
  const tool = new DeskTool(home, originBase);

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://desk.local');
    const send = (status, html) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    };
    const redirect = location => {
      res.writeHead(303, { location });
      res.end();
    };

    try {
      if (url.pathname === '/sync' && req.method === 'POST') {
        await tool.syncAll();
        redirect('/');
        return;
      }

      if (url.pathname.startsWith('/shows/') && req.method === 'POST') {
        const [show, use, action] = url.pathname.split('/').slice(2).map(decodeURIComponent);
        if (action === 'resync') {
          await tool.syncShow(show, use);
          redirect(`/shows/${encodeURIComponent(show)}/${encodeURIComponent(use)}`);
          return;
        }
        if (action === 'handover') {
          const form = await formBody(req);
          try {
            tool.confirmHandover(show, use, form.projectionist);
          } catch (err) {
            send(409, showPage(tool, show, use, err.gaps ?? [err.message]));
            return;
          }
          redirect(`/shows/${encodeURIComponent(show)}/${encodeURIComponent(use)}`);
          return;
        }
      }

      if (url.pathname.startsWith('/shows/') && req.method === 'GET') {
        const [show, use] = url.pathname.split('/').slice(2).map(decodeURIComponent);
        send(200, showPage(tool, show, use, null));
        return;
      }

      if (url.pathname === '/' && req.method === 'GET') {
        send(200, indexPage(tool));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('没有该页面');
    } catch (err) {
      send(500, page('值台交接工具', `<p class="gap">${esc(err.message)}</p><p><a href="/">返回开场名单</a></p>`));
    }
  });
}

function indexPage(tool) {
  const events = tool.store.state.events ?? [];
  const rows = events.map(event => {
    let cell;
    try {
      const c = tool.currentConfirmation(event.show, event.use);
      cell = c.accepted
        ? `<span class="ready go">可开场 · 接受确认 ${esc(c.accepted.id)}（${esc(c.accepted.projectionist)}）</span>`
        : `<span class="ready nogo">不可开场 · 缺 ${esc(c.report.gaps.join('；') || '交接确认')}</span>`;
    } catch (err) {
      cell = `<span class="gap">${esc(err.message)}</span>`;
    }
    return `<tr><td><a href="/shows/${encodeURIComponent(event.show)}/${encodeURIComponent(event.use)}">${esc(event.show)}</a></td>
      <td>${esc(event.use)}</td><td>rev ${esc(event.rev)}</td><td>${esc(event.hall)}</td><td>${esc(event.device)}</td><td>${cell}</td></tr>`;
  }).join('');

  return page('开场名单', `
    <form method="post" action="/sync"><button>按当前排期重新同步并取件</button></form>
    <p class="small">上次同步：${esc(tool.store.state.syncedAt ?? '尚未同步')}　来源：${esc(tool.origin.base)}</p>
    <table><thead><tr><th>场次</th><th>用途</th><th>排期版</th><th>当前厅</th><th>设备证号</th><th>开场判断</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6">尚未同步排期</td></tr>'}</tbody></table>`);
}

function showPage(tool, show, use, flashErrors) {
  const c = tool.currentConfirmation(show, use);
  const r = c.report;
  const checks = r.checks.map(x =>
    `<tr><td>${esc(x.name)}</td><td>${badge(x.ok)}</td><td>${esc(x.detail)}</td></tr>`).join('');
  const materials = r.materials.map(m =>
    `<tr><td>${esc(m.asset)}</td><td>${esc(m.label)}</td><td><code>${esc(m.sha.slice(0, 12))}…</code></td>
     <td>${m.status === 'held' ? (m.reused ? '已缓存复用' : '本次领取') : esc(m.status)}</td></tr>`).join('');
  const stale = c.stale.map(h =>
    `<li>${esc(h.id)}（${esc(h.projectionist)}，${esc(h.at)}）已失效：${esc(h.reasons.join('；'))}</li>`).join('');
  const accepted = c.accepted
    ? `<p class="ready go">当前实际接受：${esc(c.accepted.id)}，接手放映员 ${esc(c.accepted.projectionist)}，${esc(c.accepted.at)}</p>`
    : '<p class="ready nogo">当前没有有效的交接确认</p>';

  const handoverForm = r.ready ? `
    <form method="post" action="/shows/${encodeURIComponent(show)}/${encodeURIComponent(use)}/handover">
      <label>接手放映员 <input name="projectionist" required></label>
      <button>确认当前厅与终端导入回执，完成交接</button></form>`
    : '<p class="gap">存在缺口时不能确认交接，请先补齐后重新判断。</p>';

  return page(`${show} ${use}`, `
    <p><a href="/">← 返回开场名单</a></p>
    ${flashErrors ? `<p class="gap" role="alert">${esc(flashErrors.join('；'))}</p>` : ''}
    <p>当前厅 <strong>${esc(r.hall)}</strong>　设备 <strong>${esc(r.device)}</strong>
       排期 rev ${esc(r.rev)}　组合 ${esc(r.combo)}<br>
       <span class="small">整场本地换算 UTC：${esc(r.window.start)} 至 ${esc(r.window.end)}</span></p>
    ${accepted}
    <p class="${r.ready ? 'ready go' : 'ready nogo'}">${r.ready ? '可开场' : '不可开场'}</p>
    <h2>逐项核对</h2><table><tbody>${checks}</tbody></table>
    <h2>介质清单（组合 ${esc(r.package?.combo ?? '—')} / 清单 ${esc(r.package?.version ?? '—')}）</h2>
    <table><thead><tr><th>介质编号</th><th>交付件</th><th>摘要</th><th>状态</th></tr></thead><tbody>${materials || '<tr><td colspan="4">未领取</td></tr>'}</tbody></table>
    ${r.license ? `<p>有效授权：${esc(r.license.device)} / ${esc(r.license.combo)} / ${esc(r.license.use)} / ${esc(r.license.startUtc)}–${esc(r.license.endUtc)}</p>` : ''}
    ${r.receipt ? `<p>导入回执：<code>${esc(r.receipt.id)}</code></p>` : ''}
    <h2>缺口</h2>${r.gaps.length ? `<ul class="gap">${r.gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : '<p>无</p>'}
    <h2>交接确认</h2>${handoverForm}
    <form method="post" action="/shows/${encodeURIComponent(show)}/${encodeURIComponent(use)}/resync">
      <button>重新到该场次该用途取件并重新判断</button></form>
    <h2>历史交接记录</h2>
    ${stale ? `<ul>${stale}</ul>` : ''}
    <ul>${tool.handoverHistory(show, use).map(h => `<li>${esc(h.id)} ${esc(h.at)} ${esc(h.projectionist)}（依据 ${esc(h.basis.hall)} ${esc(h.basis.device)} ${esc(h.basis.version)}）</li>`).join('') || '<li>无</li>'}</ul>`);
}

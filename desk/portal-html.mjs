// 片方门户只提供网页操作，这里解析其固定结构的 HTML：
// 场次/用途选择页（choose）与授权交付页（package，含清单、下载链接、设备授权表）。

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '').trim());
}

// 解析选择页：表单 action 及每个 select 的参数名与选项。
export function parseChoosePage(html) {
  const formMatch = html.match(/<form\b[^>]*\baction="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) throw new Error('门户选择页缺少表单');
  const action = decodeEntities(formMatch[1]);
  const selects = [...formMatch[2].matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)]
    .map(([, rawName, body]) => ({
      name: decodeEntities(rawName),
      options: [...body.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)]
        .map(m => stripTags(m[1])),
    }));
  return { action, selects };
}

// 解析授权交付页。
export function parsePackagePage(html) {
  const dl = {};
  for (const m of html.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/gi)) {
    dl[stripTags(m[1])] = stripTags(m[2]);
  }
  const combo = dl['组合号'];
  const version = dl['清单版本'];
  if (!combo || !version) throw new Error('授权页缺少组合号或清单版本');

  const downloads = [...html.matchAll(
    /<li>\s*<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<span>介质编号\s*([^<]+)<\/span>\s*<code>([0-9a-f]{64})<\/code>/gi,
  )].map(([, href, labelHtml, asset, sha]) => ({
    href: decodeEntities(href),
    label: stripTags(labelHtml),
    asset: stripTags(asset),
    sha,
  }));
  if (!downloads.length) throw new Error('授权页缺少交付件清单');

  const licenses = parseTable(html).map(cells => ({
    device: cells[0], combo: cells[1], use: cells[2],
    startUtc: cells[3], endUtc: cells[4],
  }));
  if (!licenses.length) throw new Error('授权页缺少设备授权表');

  return { combo, version, downloads, licenses };
}

function parseTable(html) {
  const table = html.match(/<table>[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)]
    .slice(1) // 跳过表头
    .map(([, row]) => [...row.matchAll(/<td>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1])))
    .filter(cells => cells.length === 5);
}

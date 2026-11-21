function escape(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function choice(name, label, values) {
  return '<label>' + escape(label) + ' <select name="' + escape(name) + '">' +
    values.map(x => '<option>' + escape(x) + '</option>').join('') + '</select></label>';
}

function table(headings, rows) {
  return '<table><thead><tr>' + headings.map(x => '<th>' + escape(x) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(x => '<td>' + escape(x) + '</td>').join('') +
      '</tr>').join('') + '</tbody></table>';
}

function choosePage(source) {
  return '<form action="' + escape(source.path) + '">' + source.params.map((name, i) =>
    choice(name, source.labels[i], source.options[i])).join(' ') + ' <button>打开</button></form>';
}

function packagePage(source) {
  const items = source.downloads.map(({ label, asset, sha, href }) =>
    '<li><a download href="' + escape(href) + '">' + escape(label) + '</a> ' +
    '<span>介质编号 ' + escape(asset) + '</span> <code>' + escape(sha) + '</code></li>').join('');
  const licences = table(['设备证号', '组合号', '用途', 'UTC 开始', 'UTC 截止'],
    source.licenses.map(x => [x.device, x.combo, x.use, x.startUtc, x.endUtc]));
  return '<dl><dt>组合号</dt><dd>' + escape(source.combo) + '</dd><dt>清单版本</dt><dd>' +
    escape(source.version) + '</dd></dl><ul aria-label="交付件">' + items + '</ul>' + licences +
    '<p><a href="/portal/shows">回到场次选择</a></p>';
}

function scoringPage(source, entries, error) {
  const form = '<form method="post">' + choice('seal', '封签', source.seals) + ' ' +
    choice('item', '评项', source.items) +
    ' <label>分数 <input name="points" type="number" min="0" max="100" required></label>' +
    ' <button name="action" value="draft">暂存</button> <button name="action" value="submit">提交</button></form>';
  const correction = '<form method="post" aria-label="更正登记">' +
    '<label>原回执 <input name="previous" required></label> ' + choice('seal', '当前封签', source.seals) +
    ' <label>更正分数 <input name="points" type="number" min="0" max="100" required></label>' +
    ' <button name="action" value="correct">送交更正</button></form>';
  const rows = table(['封签', '评分项', '分数', '状态', '回执', '原回执'],
    entries.map(x => [x.seal, x.item, x.points, x.status, x.receipt ?? '', x.previous ?? '']));
  return (error ? '<p role="alert">' + escape(error) + '</p>' : '') + form + correction + rows;
}

export function renderPage(source, entries, error) {
  const layouts = { choose: choosePage, package: packagePage, scoring: scoringPage };
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>' + escape(source.title) +
    '</title><body><h1>' + escape(source.title) + '</h1>' + layouts[source.layout](source, entries, error) +
    '</body></html>';
}

export function scoringPortal() {
  const saved = new Map();
  let receipt = 0;
  const entries = desk => saved.get(desk) ?? [];

  async function submit(req, board) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > 4096) return { status: 413, error: '表单过长' };
    }

    const form = Object.fromEntries(new URLSearchParams(raw));
    const points = Number(form.points);
    if (!board.seals.includes(form.seal) || !form.points || !Number.isInteger(points) ||
        points < 0 || points > 100) {
      return { status: 422, error: '封签或分数超出登记范围' };
    }

    const rows = entries(board.desk);
    const previous = rows.find(x => x.receipt === form.previous);
    const item = form.action === 'correct' ? previous?.item : form.item;
    if (!board.items.includes(item)) return { status: 422, error: '评项或原回执无效' };

    const existing = rows.find(x => x.seal === form.seal && x.item === item && x.receipt);
    if (existing && form.action !== 'correct') {
      return { status: 409, error: '该封签评项已有回执' };
    }

    if (form.action === 'correct' && rows.some(x => x.previous === form.previous)) {
      return { status: 409, error: '该回执已有更正' };
    }

    if (!['draft', 'submit', 'correct'].includes(form.action)) return { status: 422, error: '未选登记方式' };

    const row = { seal: form.seal, item, points };
    if (form.action === 'draft') {
      row.status = '草稿';
    } else {
      row.status = form.action === 'correct' ? '更正已受理' : '已受理';
      row.receipt = 'PG-' + ++receipt;
      if (form.action === 'correct') row.previous = previous.receipt;
    }
    saved.set(board.desk, [...rows.filter(x => x.receipt || x.seal !== row.seal || x.item !== row.item), row]);
    return {};
  }

  return { entries, submit };
}

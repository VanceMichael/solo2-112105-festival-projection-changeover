#!/usr/bin/env node
// 值台放映交接工具 CLI。
// 用法：
//   desk <状态目录> sync [--origin URL]               按当前排期同步并取件
//   desk <状态目录> list [--origin URL]               开场名单
//   desk <状态目录> show <场次> <用途> [--origin URL] 单场核对明细
//   desk <状态目录> resync <场次> <用途>              重新领取该场次用途的清单与原件
//   desk <状态目录> handover <场次> <用途> <接手放映员> 确认交接
//   desk <状态目录> history <场次> <用途>             交接记录
//   desk serve <状态目录> [--origin URL] [--port N]   启动值台网页

import { mkdirSync } from 'node:fs';
import { deskServer } from './server.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const origin = flags.origin ?? process.env.ORIGIN ?? 'http://127.0.0.1:4178';

  const { DeskTool } = await import('./desk.mjs');

  if (positional[0] === 'serve') {
    const home = positional[1];
    if (!home) throw new Error('需要状态目录');
    mkdirSync(home, { recursive: true });
    const server = deskServer(home, origin);
    const port = Number(flags.port ?? process.env.PORT ?? 4180);
    server.listen(port, '127.0.0.1', () => {
      console.log(`值台交接工具 http://127.0.0.1:${port}（来源 ${origin}）`);
    });
    return;
  }

  // 统一形式：desk <状态目录> <命令> [参数…]
  const home = positional[0];
  const [command, ...rest] = positional.slice(1);
  if (!home || !command) throw new Error('用法：desk <状态目录> <命令>，命令见文件头注释');
  mkdirSync(home, { recursive: true });
  const tool = new DeskTool(home, origin);

  switch (command) {
    case 'sync': {
      const r = await tool.syncAll();
      for (const x of r.results) {
        console.log(`${x.show} ${x.use}: ${x.ok ? '介质齐全' : '有缺口'}`);
        for (const d of x.downloads ?? []) {
          console.log(`  - ${d.asset} ${d.label} ${d.status}${d.reused ? '（复用缓存）' : ''}${d.error ? '：' + d.error : ''}`);
        }
      }
      break;
    }
    case 'list': {
      for (const item of tool.openingList()) {
        const line = item.missing ? `场次 ${item.show}：${item.missing.join('，')}`
          : `${item.show} ${item.use} [${item.hall}/${item.device}] ${item.ready ? '可开场' : '不可开场'}` +
            (item.acceptedConfirmation ? `，接受确认 ${item.acceptedConfirmation}` : '') +
            (item.gaps.length ? `，缺口：${item.gaps.join('；')}` : '');
        console.log(line);
      }
      break;
    }
    case 'show': {
      const [show, use] = rest;
      const c = tool.currentConfirmation(show, use);
      console.log(JSON.stringify(c, null, 2));
      break;
    }
    case 'resync': {
      const [show, use] = rest;
      const r = await tool.syncShow(show, use);
      console.log(`${r.show} ${r.use}: ${r.ok ? '介质齐全' : '有缺口'}`);
      for (const d of r.downloads) console.log(`  - ${d.asset} ${d.status}${d.reused ? '（复用）' : ''}${d.error ? '：' + d.error : ''}`);
      break;
    }
    case 'handover': {
      const [show, use, projectionist] = rest;
      if (!projectionist) throw new Error('需要接手放映员姓名');
      const record = tool.confirmHandover(show, use, projectionist);
      console.log(`已登记交接 ${record.id}：${record.show} ${record.use} ${record.basis.hall}/${record.basis.device}`);
      break;
    }
    case 'history': {
      const [show, use] = rest;
      for (const h of tool.handoverHistory(show, use)) {
        console.log(`${h.id} ${h.at} ${h.projectionist} 依据 rev${h.basis.rev} ${h.basis.hall} ${h.basis.device} ${h.basis.version}`);
      }
      break;
    }
    default:
      throw new Error(`未知命令：${command}`);
  }
}

main().catch(err => {
  console.error(err.gaps ? `${err.message}\n- ${err.gaps.join('\n- ')}` : err.message);
  process.exitCode = 1;
});

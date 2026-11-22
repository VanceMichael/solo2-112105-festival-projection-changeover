// 值台本地状态：原件缓存（按 sha256 内容寻址）与业务状态 JSON。
// 同一文件可被多个组合引用；但某组合缺项时，不能拿别的组合里同名文件顶替——
// 是否属于该组合只以本次授权页清单里的 (asset, sha, href) 为准，缓存只解决“内容一致可复用”。

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export class Store {
  constructor(home) {
    this.home = home;
    this.assetDir = join(home, 'assets');
    this.stateFile = join(home, 'state.json');
    mkdirSync(this.assetDir, { recursive: true });
    this.state = existsSync(this.stateFile)
      ? JSON.parse(readFileSync(this.stateFile, 'utf8'))
      : { rosterRev: {}, packages: {}, claims: {}, handovers: [], syncedAt: null };
  }

  assetPath(sha) {
    return join(this.assetDir, sha);
  }

  hasAsset(sha) {
    return existsSync(this.assetPath(sha));
  }

  // 入库前核对摘要；内容与清单不一致一律拒收。
  putAsset(buffer, expectedSha) {
    const actual = sha256(buffer);
    if (actual !== expectedSha) {
      throw new Error(`原件摘要不符：期望 ${expectedSha}，实得 ${actual}`);
    }
    writeFileSync(this.assetPath(actual), buffer);
    return actual;
  }

  // 复用已缓存原件时仍重新计算摘要，确保内容一致。
  verifyAsset(expectedSha) {
    const path = this.assetPath(expectedSha);
    if (!existsSync(path)) return false;
    return sha256(readFileSync(path)) === expectedSha;
  }

  save() {
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.stateFile);
  }
}

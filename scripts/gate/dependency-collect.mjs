// 基底ブランチとの差分から、依存の追加・更新の一覧(entries)を集める。git を読むが、ネットワークは使わない(G-5 基準8)。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, DEPENDENCY_MANIFESTS as MANIFESTS } from './config.mjs';
import { diffNpmLock, diffPackageJson } from './dependency-parse.mjs';

export function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function show(rev, file) {
  try {
    return execFileSync('git', ['show', `${rev}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

export function changedManifests(base) {
  const changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
  return changed.filter((f) => MANIFESTS.includes(path.basename(f)));
}

/**
 * entries: 解析できた追加・更新。unparsed: 解析を降ろしていない・読めなかったファイル(理由つき)。
 * node 以外(python・go ほか)の解析は降ろしていない(undelivered)。この事実を一覧に出す
 */
export function collectEntries(base, touched = changedManifests(base)) {
  const entries = [];
  const unparsed = [];
  const lockDirs = new Set();
  for (const f of touched) {
    if (path.basename(f) === 'package-lock.json') {
      lockDirs.add(path.posix.dirname(f));
      const r = diffNpmLock(show(base, f), show('HEAD', f));
      if (r.ok) entries.push(...r.entries.map((e) => ({ ...e, file: f })));
      else unparsed.push({ file: f, reason: '読めなかった(package-lock.json の形式が v2・v3 でない、または JSON でない)' });
    }
  }
  for (const f of touched) {
    const b = path.basename(f);
    if (b === 'package-lock.json') continue;
    if (b === 'package.json') {
      const dir = path.posix.dirname(f);
      const lock = dir === '.' ? 'package-lock.json' : `${dir}/package-lock.json`;
      if (lockDirs.has(dir) || show('HEAD', lock)) continue;
      const r = diffPackageJson(show(base, f), show('HEAD', f));
      if (r.ok) entries.push(...r.entries.map((e) => ({ ...e, file: f })));
      else unparsed.push({ file: f, reason: '読めなかった(JSON でない)' });
      continue;
    }
    unparsed.push({ file: f, reason: '解析せず(node の package-lock.json・package.json 以外の解析は降ろしていない。差分の行だけを出す)' });
  }
  return { entries, unparsed };
}

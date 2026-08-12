// 構成ファイルとアダプタの読み込み。ゲートのスクリプトが共通で使う。
// 依存パッケージなし。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadConfig() {
  const p = path.join(ROOT, 'process.config.json');
  if (!fs.existsSync(p)) {
    throw new Error('process.config.json がありません。/process-init を実行してください');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function loadAdapter(config) {
  const stack = config.adapters?.stack ?? 'none';
  const p = path.join(ROOT, 'adapters', `${stack}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`adapters/${stack}.json がありません。process.config.json の adapters.stack を確認してください`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** ゲートが有効か(required / simplified を有効とみなす) */
export function isGateActive(config, key) {
  const s = config.gates?.[key]?.state;
  return s === 'required' || s === 'simplified';
}

export function gateState(config, key) {
  return config.gates?.[key]?.state ?? 'required';
}

/** GitHub Actions の注釈として出す(ローカル実行では素の行として出る) */
export function notice(msg) {
  console.log(`::notice::${msg}`);
}
export function warn(msg) {
  console.log(`::warning::${msg}`);
}
export function fail(msg) {
  console.log(`::error::${msg}`);
}

export function hasTarget(adapter) {
  const adapterId = adapter.id;
  if (adapterId === 'node') {
    return fs.existsSync(path.join(ROOT, 'package.json'));
  }
  if (adapterId === 'python') {
    const pyFiles = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
    return pyFiles.some((f) => fs.existsSync(path.join(ROOT, f)));
  }
  if (adapterId === 'go') {
    return fs.existsSync(path.join(ROOT, 'go.mod'));
  }
  if (adapterId === 'none') {
    const cmds = Object.values(adapter.commands ?? {});
    return cmds.some((c) => (c ?? '').trim().length > 0);
  }
  if (adapterId === 'undetermined') {
    return false;
  }
  return true;
}

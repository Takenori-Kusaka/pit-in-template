// 未達(unmet)ゲートの、確認者(作成を指示した本人以外の人)の調達先を安全に記入するためのユーティリティ。
//
//   node scripts/init/set-review-sourcing.mjs --gate g6 --sourcing "コミュニティレビュー"
//
// 調達先の記入は未達を解消しません。確認者を置けたら、人の名簿(people[])へ記入し、
// /process-change で独立レビュアの席の責任者として反映します。
//
// 構成(process.config.json)を書き換えるのは /process-change だけです。このスクリプトは、
// 種別 settings の変化点の入力を組み立てて generate-profile.mjs へ渡します。構成を直接は書きません。
// 記入は変化点の記録(changeLog[])へ残り、要約値の連鎖が保たれます。
//
// 依存パッケージなし。Node 22 以上で動く。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiNameReason } from '../gate/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function getArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

/** 調達先の記入を、種別 settings の変化点の入力として組み立てる。受け付けない調達先は例外にする */
export function sourcingChange({ gate, sourcing, date = null }) {
  // AI の確認は検出の層であり、未達を埋めない。AI を示す調達先を受け付けない
  const ai = aiNameReason(sourcing, { account: true });
  if (ai) {
    throw new Error(`調達先 "${sourcing}" は ${ai}。確認者は、作成を指示した本人以外の人に限ります。AI の確認は未達を埋めません。`);
  }
  if (!String(sourcing ?? '').trim()) throw new Error('調達先が空です。');
  return {
    kind: 'settings',
    ...(date ? { date } : {}),
    summary: `${gate.toUpperCase()} の確認者の調達先を記入した`,
    settings: { reviewSourcing: { [gate.toLowerCase()]: sourcing } },
  };
}

// ---------------------------------------------------------------- セルフテスト用
function runSelfTest() {
  console.log('Running self test...');
  const c = sourcingChange({ gate: 'G6', sourcing: 'GitHub コミュニティレビュー' });
  if (c.kind !== 'settings' || c.settings.reviewSourcing.g6 !== 'GitHub コミュニティレビュー') {
    throw new Error('変化点の入力が正しく組み立てられていません: ' + JSON.stringify(c));
  }
  let refused = false;
  try {
    sourcingChange({ gate: 'g6', sourcing: 'Reviewer-Agent (gpt-9)' });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error('AI を示す調達先が拒否されませんでした');
  console.log('Self test passed!');
}

// ---------------------------------------------------------------- 実行
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);

  if (argv.includes('--test')) {
    runSelfTest();
    process.exit(0);
  }

  const gate = getArg(argv, '--gate');
  const sourcing = getArg(argv, '--sourcing');

  if (!gate || sourcing === null) {
    console.error('[エラー] 引数が不足しています。');
    console.error('使用方法: node scripts/init/set-review-sourcing.mjs --gate <g6> --sourcing "<調達先>"');
    process.exit(1);
  }

  let file = null;
  try {
    const change = sourcingChange({ gate, sourcing });
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'review-sourcing-')), 'change.json');
    fs.writeFileSync(file, JSON.stringify(change, null, 2), 'utf8');
    execFileSync(process.execPath, [path.join(HERE, 'generate-profile.mjs'), '--change', file], { stdio: 'inherit' });
    console.log('完了しました。');
  } catch (e) {
    // generate-profile.mjs が拒否した場合、理由はそのスクリプトが出力している
    if (e.status === undefined) console.error(`[エラー] ${e.message}`);
    process.exit(1);
  } finally {
    if (file) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

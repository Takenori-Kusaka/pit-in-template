// 依存関係のライセンス検査の実施記録(evidence/license-scan.json)を書く。
//
//   node scripts/gate/license-scan-record.mjs --outcome <steps.lic.outcome>
//
// gate-g5.yml の ip-clearance ジョブの「検査の実施記録」の段が呼ぶ。アダプタの licenses は、コマンドが空のとき・検査対象が
// 存在しないときも終了コード 0 で通る(adapter.mjs。構成で選んだ未実施を失敗にしない。標準 ADR-0151)。その通過を
// 「実施した」と記録すると、保証の開示 項目4 が実施(success)と出して通過と取り違えさせる。ここで、実際に検査が走ったかを
// 決定可能な条件(コマンドが空か・対象があるか)で判定して記録する(process-compass #330 T-8 / IMPL-0995)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, loadAdapter, hasTarget, ALWAYS_PHASES } from './config.mjs';

export const REASON_NO_COMMAND = 'コマンドが未設定';
export const REASON_NO_TARGET = '検査対象が存在しない';

/**
 * 記録の中身を作る(純関数。git も時計も呼ばない)。
 *   outcome: 検査の段の結論(success / failure / cancelled / skipped)
 *   command: アダプタの licenses のコマンド(未定義は空として扱う)
 *   target: 検査対象(製品のコード)があるか
 *   at: 記録の時刻(文字列)
 */
export function buildLicenseScanRecord({ outcome, command, target, at }) {
  if (!String(command ?? '').trim()) return { scanRun: false, result: 'skipped', reason: REASON_NO_COMMAND, scannedAt: at };
  if (!target && !ALWAYS_PHASES.has('licenses')) return { scanRun: false, result: 'skipped', reason: REASON_NO_TARGET, scannedAt: at };
  return { scanRun: true, result: outcome, scannedAt: at };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const i = process.argv.indexOf('--outcome');
  const outcome = i >= 0 ? process.argv[i + 1] : undefined;
  if (!outcome) {
    console.error('使い方: node scripts/gate/license-scan-record.mjs --outcome <success|failure|cancelled|skipped>');
    process.exit(2);
  }
  const config = loadConfig();
  const adapter = loadAdapter(config);
  const record = buildLicenseScanRecord({
    outcome,
    command: adapter.commands?.licenses,
    target: hasTarget(adapter),
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  });
  fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'evidence/license-scan.json'), `${JSON.stringify(record)}\n`);
  console.log(`ライセンス検査の記録: ${JSON.stringify(record)}`);
}

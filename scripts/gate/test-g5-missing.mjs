// ホスティングから gate-g5 の結果を読めない PR の欠落の文の試験(process-compass #333 / ADR-0135。IMPL-0244)
//
//   node scripts/gate/test-g5-missing.mjs
//
// 固定する決定:
//   - 写しが gate-g5 の結論を持つ(found: true)なら保持切れの可能性、写しにも check run が無い(found: false)なら
//     必須チェックを経ていない可能性、写しの欄が無い・読めなかった(found: null)なら区別できない旨を出す
//   - どの場合も欠落に数える。写しの値で G-5 の充足に数えない(文にそう書く)
//   - 日数は表示にだけ使う(分岐に使わない)。時刻は引数で渡す(時計に依らない)
//   - record-copy.yml は checks: read を持ち、head の gate-g5 の check run を読み、読めなくても写しの手順を失敗させない

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { g5MissingText } from './aggregate-evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
}

const base = { number: 12, recordFound: true, mergedAt: '2026-08-01T00:00:00Z', now: '2026-11-15T00:00:00Z' };

// IMPL-0244:ng(違反側。読めない G-5 を書き分けず、または充足に数える形を出さない)
{
  const t = g5MissingText({ ...base, copyG5: { found: true, id: 99, status: 'completed', conclusion: 'success', completed_at: '2026-08-01T00:10:00Z', head_sha: 'abc' } });
  check('IMPL-0244:ng 写しに結論がある: 保持切れの可能性の文が出る', /保持期間を過ぎて消えた可能性/.test(t) && /success/.test(t) && /check run 99/.test(t));
  check('IMPL-0244:ng 写しに結論がある: 充足に数えない旨が出る', /充足には数えません/.test(t) && /マージから 106 日/.test(t));
}
{
  const t = g5MissingText({ ...base, copyG5: { found: false } });
  check('IMPL-0244:ng 写しにも check run が無い: 必須チェックを経ていない可能性の文が出る', /必須チェックを経ずにマージされた可能性/.test(t) && /写しにも gate-g5 の check run がありません/.test(t) && !/保持期間を過ぎて消えた可能性があります/.test(t));
}
{
  const t = g5MissingText({ ...base, copyG5: null });
  check('IMPL-0244:ng 写しの欄が無い: 区別できない旨が出る', /区別できません/.test(t) && /写しが無い/.test(t));
  const t2 = g5MissingText({ ...base, copyG5: { found: null, read_error: 'HTTP 403' } });
  check('IMPL-0244:ng 写しの取り出しで読めなかった: 区別できない旨が出る', /区別できません/.test(t2));
}
{
  const t = g5MissingText({ number: 7, recordFound: false, fetchError: 'HTTP 502', copyG5: { found: true, conclusion: 'success' } });
  check('IMPL-0244:ng PR の記録を取得できない場合の文は従来どおり(写しで分岐しない)', /PR の記録を gh で取得できず\(HTTP 502\)/.test(t) && !/保持期間/.test(t));
}
{
  const t = g5MissingText({ ...base, mergedAt: null, copyG5: { found: true, conclusion: 'success' } });
  check('IMPL-0244:ng マージの時刻が無ければ日数の括弧を省く(分岐に使わない)', /保持期間を過ぎて消えた可能性があります。/.test(t) && !/マージから/.test(t));
}

// IMPL-0244:ok(適合側。文は gaps の入口でだけ使う。成功を読めた PR は集約が文を呼ばない)
{
  const src = fs.readFileSync(path.join(here, 'aggregate-evidence.mjs'), 'utf8');
  check("IMPL-0244:ok 集約は g5 が 'unknown' のときだけ g5MissingText を呼び、欠落に入れる", /if \(p\.g5 === 'unknown'\) gaps\.push\(g5MissingText\(/.test(src));
  check('IMPL-0244:ok 集約は写しの結論で g5 を success にしない(g5 は rollup と check-runs だけから決める)', !/g5: g5 ?.*g5AtMerge/.test(src));
}

// record-copy.yml の静的な確認
{
  const y = fs.readFileSync(path.join(here, '..', '..', '.github', 'workflows', 'record-copy.yml'), 'utf8');
  check('record-copy.yml: permissions に checks: read がある', /^ {2}checks:\s*read\s*$/m.test(y));
  check('record-copy.yml: head の gate-g5 の check-runs を読む', /commits\/\$HEAD_SHA\/check-runs\?check_name=gate-g5/.test(y));
  check('record-copy.yml: 写しへ checks.gate_g5 を足す', /checks:\s*\{gate_g5:\s*\$g5\}/.test(y));
  check('record-copy.yml: 読めなかったとき found: null を写し、手順を失敗させない', /found: null, read_error/.test(y) && !/g5raw=.*\|\| exit/.test(y));
  check('record-copy.yml: 比べる欄(shape)に checks を入れない', !/shape='[^']*checks/.test(y));
}

if (failed) {
  console.error(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log('\ngate-g5 を読めない PR の欠落の文の試験: すべて通過');

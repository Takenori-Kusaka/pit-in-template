// env-check の所見(findings)の読み取りと、CODEOWNERS の案の試験(pit-in-template #54。process-compass #321 段階 2 の後続)。
//
//   node scripts/gate/test-env-findings.mjs
//
// 所見は項目(ENV_CHECK_ITEMS)へ昇格させず、確認済みの判定(confirmed)に入れない。/pit の注記と出荷の集約(項目4 の表)が
// 所見として出す。この試験は、記録(docs/adoption-trial/env-check.json)の有無・所見の有無・一致しない所見が、readEnvCheck の
// findings・attention・findingsText にどう現れるかを一時のディレクトリで確かめる。gh は呼ばない。
// CODEOWNERS の案(codeownersProposal)は、席の責任者と名簿のアカウントから起こし、書けない行は # で出すことを確かめる。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_CHECK_FILE, ENV_CHECK_ITEMS, ENV_CHECK_FINDINGS, FINDING_STATUS_LABEL, readEnvCheck, envFindingsOf, envFindingsText } from './org-assurance.mjs';
import { codeownersProposal, CODEOWNER_RECORD_PATHS } from '../init/generate-profile.mjs';

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};

const config = { configured: true, review: { reviewerCount: 1 }, ruleset: 'team', gates: { g6: { state: 'required' } } };
const confirmedItems = Object.fromEntries(
  ENV_CHECK_ITEMS.map(([id]) => [
    id,
    {
      status: 'confirmed',
      detail: '確認済み',
      evidence: { rulesetIds: [1], pr: 3, reviewIds: [10], runId: 5, runUrl: 'https://example.com/run/5', fetchedAt: '2026-10-24T09:00:00+09:00' },
    },
  ])
);
const baseRecord = { checkedAt: '2026-10-24T09:00:00+09:00', checkedBy: '鈴木 一郎', repo: 'o/r', branch: 'main', config: { reviewerCount: 1, ruleset: 'team', g6: 'required' }, items: confirmedItems };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-env-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** 記録をコミット済みの一時のリポジトリに置く(readEnvCheck は記録のコミットの有無も読む) */
const repoWith = (name, record) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, path.dirname(ENV_CHECK_FILE)), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'tester');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (record !== null) {
    fs.writeFileSync(path.join(dir, ENV_CHECK_FILE), typeof record === 'string' ? record : JSON.stringify(record, null, 2) + '\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'docs: env-check');
  }
  return dir;
};

try {
  // ---------------------------------------------------------------- 所見の一覧
  check('ENV_CHECK_FINDINGS: 5 件の所見(records の保護・record-copy・写しの到着・既定ブランチの bypass・承認の数え方)', ENV_CHECK_FINDINGS.map(([id]) => id).join(',') === 'recordsBranch,recordCopy,recordsCopy,defaultBypass,approvalCounting');
  check('ENV_CHECK_FINDINGS は項目(ENV_CHECK_ITEMS)と重ならない', !ENV_CHECK_FINDINGS.some(([id]) => ENV_CHECK_ITEMS.some(([i]) => i === id)));
  check('FINDING_STATUS_LABEL: 4 つの状態の語', Object.keys(FINDING_STATUS_LABEL).sort().join(',') === 'confirmed,mismatch,unconfirmed,unknown');

  const none = envFindingsOf(null, { recordMissing: true });
  check('envFindingsOf: 記録なし → 全所見が未確認「記録なし」', none.length === 5 && none.every((f) => f.status === 'unconfirmed' && f.detail === '記録なし'));
  const old = envFindingsOf({ items: {} });
  check('envFindingsOf: findings の無い記録(段階 2 より前) → 未確認と理由', old.every((f) => f.status === 'unconfirmed' && /段階 2 より前/.test(f.detail)));
  const mixed = envFindingsOf({
    findings: {
      recordsBranch: { status: 'mismatch', detail: 'bypass actor がある', evidence: { rulesetIds: [9] } },
      recordCopy: { status: 'confirmed', detail: '成功' },
      recordsCopy: { status: 'bogus', detail: '?' },
      approvalCounting: { status: 'unknown', detail: 'API で取れない' },
    },
  });
  check('envFindingsOf: 状態の語は 3 つ + unconfirmed に正規化し、evidence を保つ', mixed.find((f) => f.id === 'recordsBranch').status === 'mismatch' && mixed.find((f) => f.id === 'recordsBranch').evidence.rulesetIds[0] === 9 && mixed.find((f) => f.id === 'recordsCopy').status === 'unconfirmed' && mixed.find((f) => f.id === 'approvalCounting').status === 'unknown');
  check('envFindingsOf: 記録に無い所見の項目 → 未確認', mixed.find((f) => f.id === 'defaultBypass').status === 'unconfirmed' && /項目が無い/.test(mixed.find((f) => f.id === 'defaultBypass').detail));
  const text = envFindingsText(mixed);
  check('envFindingsText: 一致しない所見を先頭に、状態の語と詳細を 1 行に', text.startsWith('記録用ブランチ **一致しない**(bypass actor がある)') && /API で取れない/.test(text) && / \/ /.test(text), text);
  check('envFindingsText: 空なら null', envFindingsText([]) === null && envFindingsText(null) === null);

  // ---------------------------------------------------------------- readEnvCheck と所見
  const r0 = readEnvCheck(config, { root: repoWith('none', null) });
  check('readEnvCheck: 記録なし → findings は「記録なし」、attention は空、confirmed は偽', r0.present === false && r0.findings.length === 5 && r0.attention.length === 0 && r0.confirmed === false && r0.findingsText !== null);

  const r1 = readEnvCheck(config, { root: repoWith('ok', { ...baseRecord, findings: Object.fromEntries(ENV_CHECK_FINDINGS.map(([id]) => [id, { status: id === 'approvalCounting' ? 'unknown' : 'confirmed', detail: 'ok' }])) }) });
  check('readEnvCheck: 項目が確認済みなら所見に依らず confirmed(所見は確認済みの判定に入れない)', r1.confirmed === true && r1.attention.length === 0, JSON.stringify({ confirmed: r1.confirmed, problems: r1.problems, items: r1.items.map((i) => [i.id, i.status]) }));
  check('readEnvCheck: 所見の unknown はそのまま残る', r1.findings.find((f) => f.id === 'approvalCounting').status === 'unknown');

  const r2 = readEnvCheck(config, {
    root: repoWith('bypass', {
      ...baseRecord,
      findings: { recordsBranch: { status: 'mismatch', detail: 'bypass actor がある: ルールセット 9: Integration #1(always)' }, defaultBypass: { status: 'mismatch', detail: '既定ブランチ main のルールセットに bypass actor がある' }, recordCopy: { status: 'confirmed', detail: 'ok' } },
    }),
  });
  check('readEnvCheck: 一致しない所見があっても confirmed は項目で決まる(所見は欠落にも未確認にもしない)', r2.confirmed === true, JSON.stringify({ confirmed: r2.confirmed, problems: r2.problems }));
  check('readEnvCheck: attention に一致しない所見(records の保護・既定ブランチの bypass)が入る', r2.attention.map((f) => f.id).sort().join(',') === 'defaultBypass,recordsBranch');
  check('readEnvCheck: findingsText が一致しない所見を先頭に出す', r2.findingsText.startsWith('記録用ブランチ **一致しない**') || r2.findingsText.startsWith('既定ブランチのルールセットの bypass actor **一致しない**'), r2.findingsText);

  const r3 = readEnvCheck(config, { root: repoWith('old', baseRecord) });
  check('readEnvCheck: findings の無い記録 → 所見は未確認(実行し直す)。項目の判定は変わらない', r3.confirmed === true && r3.findings.every((f) => f.status === 'unconfirmed' && /実行し直す/.test(f.detail)));

  const r4 = readEnvCheck(config, { root: repoWith('broken', '{') });
  check('readEnvCheck: 読めない記録 → 所見も「記録を読めない」', r4.findings.every((f) => f.detail === '記録を読めない') && r4.confirmed === false);

  // ---------------------------------------------------------------- CODEOWNERS の案
  check('CODEOWNER_RECORD_PATHS: 記録の置き場 3 つは出荷判定者の席、台帳は価値責任者の席', CODEOWNER_RECORD_PATHS.filter(([, role]) => role === 'qa-gatekeeper').map(([p]) => p).join(',') === '/docs/gates/,/docs/records/,/docs/evidence/' && CODEOWNER_RECORD_PATHS.find(([p]) => p === '/docs/debt-ledger.md')[1] === 'value-owner');
  const seats = [
    { role: 'qa-gatekeeper', name: '品質保証(出荷判定者)', accountable: 'p-suzuki' },
    { role: 'value-owner', name: '価値責任者(Value Owner)', accountable: null },
  ];
  const people = [{ id: 'p-suzuki', name: '鈴木 一郎', accounts: ['@suzuki-ichiro', 'suzuki-work'] }];
  const prop = codeownersProposal({ seats, people });
  check('codeownersProposal: 席の責任者の全アカウントを所有者にし、@ を 1 つに揃える', prop[0].owner === '@suzuki-ichiro @suzuki-work' && prop[0].line.startsWith('/docs/gates/') && /@suzuki-ichiro @suzuki-work/.test(prop[0].line), prop[0].line);
  check('codeownersProposal: 行に席の名前と置き場の説明を添える', /品質保証\(出荷判定者\)/.test(prop[0].line) && /判定記録/.test(prop[0].line));
  const ledger = prop.find((r) => r.path === '/docs/debt-ledger.md');
  check('codeownersProposal: 責任者が未記入の席の行は # で出し、理由を書く(推測で埋めない)', ledger.owner === null && ledger.line.startsWith('# /docs/debt-ledger.md') && /責任者が未記入/.test(ledger.line), ledger.line);
  const noAcct = codeownersProposal({ seats: [{ role: 'qa-gatekeeper', name: '品質保証(出荷判定者)', accountable: 'p-yamada' }], people: [{ id: 'p-yamada', name: '山田 太郎' }] });
  check('codeownersProposal: アカウントが名簿に無い責任者の行は # で出し、氏名と理由を書く', noAcct[0].owner === null && /山田 太郎 のアカウントが名簿/.test(noAcct[0].line), noAcct[0].line);
  check('codeownersProposal: 席が構成に無ければ KB の席名で未記入の行にする', codeownersProposal({ seats: [], people: [] }).every((r) => r.owner === null && /の席の責任者が未記入/.test(r.line)));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`env-check の所見と CODEOWNERS の案の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`env-check の所見と CODEOWNERS の案の試験: ${n} 件が期待と一致しました`);

// 記録用ブランチの読み取り(records.mjs)の試験(process-compass #321 / #54 段階 2)。
//
//   node scripts/gate/test-records.mjs
//
// 前半は fixtures/records/ の写しと様式を直接読み、git を使わずに宣言行・判定の取り出し・head の一致・帰属の裏づけを
// 期待と比べます。後半は一時のリポジトリに記録用ブランチ(orphan)を作り、readRecordsBranch の読み取りを確かめます。
// GitHub へ問い合わせません。record-copy.yml が実際に置く写しの形は、この試験では確かめていません(fixtures は
// record-copy.yml の jq の出力に合わせて手で起こしたもの)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECORDS_REF,
  REVIEWS_DIR,
  GATES_DIR,
  DECLARATION_RE,
  parseDeclaration,
  readRecordsBranch,
  judgementsFromCopy,
  headMatches,
  recordAttribution,
  gateOfRecord,
  summarizeRecords,
  lastCommitOf,
  parseCopy,
  headOfCopy,
  formCellRaw,
  formCell,
  normalizeCell,
  targetOfForm,
  judgeOfForm,
  recordFromForm,
} from './records.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'records');
const readFixture = (...rel) => fs.readFileSync(path.join(FIXTURES, ...rel), 'utf8');
const copyOf = (n) => JSON.parse(readFixture('reviews', `pr-${n}.json`));

let failures = 0;
let n = 0;
const check = (name, ok, detail = '') => {
  n++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok ? '' : `\n       ${detail}`}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- 宣言行
{
  check('定数: 置き場の名前', RECORDS_REF === 'records' && REVIEWS_DIR === 'records/reviews' && GATES_DIR === 'records/gates');
  check('宣言行: 通過', same(parseDeclaration('G-4: 通過\n確認した項目: 基準1'), { gate: 'G-4', result: '通過', criteria: [], deadline: null }));
  const d = parseDeclaration('G-4: 差し戻し / 基準 2 / 期限 2026-10-30\n確認した項目: 基準1、基準3');
  check('宣言行: 差し戻し + 基準 + 期限', same(d, { gate: 'G-4', result: '差し戻し', criteria: [2], deadline: '2026-10-30' }), JSON.stringify(d));
  const d2 = parseDeclaration('G-6: 差し戻し / 基準 3, 5、7');
  check('宣言行: 基準の区切り(, と 、と空白)', same(d2?.criteria, [3, 5, 7]), JSON.stringify(d2));
  check('宣言行: SG', parseDeclaration('SG: 通過')?.gate === 'SG');
  check('宣言行: 前後の空白と引用記号を除いて読む', parseDeclaration('  > G-6: 通過  \n本文')?.result === '通過');
  check('宣言行: CRLF の本文', parseDeclaration('G-2: 通過\r\n確認した項目: 基準1')?.gate === 'G-2');
  check('宣言行: 先頭の空行は飛ばす', parseDeclaration('\n\nG-2: 通過')?.gate === 'G-2');
  check('宣言行: 注記を足した結果は通さない(2 値の完全一致)', parseDeclaration('G-4: 通過(判定者の申告を転記)') === null);
  check('宣言行: 2 行目にあっても読まない', parseDeclaration('確認した項目: 基準1\nG-4: 通過') === null);
  check('宣言行: G-9 は無い', parseDeclaration('G-9: 通過') === null);
  check('宣言行: 承認の語だけ', parseDeclaration('LGTM') === null && parseDeclaration('') === null && parseDeclaration(null) === null);
  check('宣言行: 期限の無い基準・基準の無い期限', parseDeclaration('G-4: 差し戻し / 期限 2026-11-01')?.deadline === '2026-11-01' && same(parseDeclaration('G-4: 差し戻し / 基準 1')?.criteria, [1]));
  check('宣言行: DECLARATION_RE は差し戻しの順序(基準 → 期限)を固定する', !DECLARATION_RE.test('G-4: 差し戻し / 期限 2026-11-01 / 基準 1'));
}

// ---------------------------------------------------------------- 写しから判定を取り出す
{
  const j12 = judgementsFromCopy(copyOf(12));
  check('写し pr-12: 同じ (gate, login) は submitted_at が最後の 1 件だけ(差し戻し → 通過)', j12.length === 1 && j12[0].result === '通過' && j12[0].reviewId === 5627536939, JSON.stringify(j12));
  check('写し pr-12: 宣言行の無い APPROVED(LGTM)は判定に数えない', !j12.some((j) => j.login === 'suzuki'));
  check('写し pr-12: 欄の写し(prNumber・userId・commitId・state・submittedAt)', j12[0].prNumber === 12 && j12[0].userId === 22556919 && j12[0].commitId === 'bc4ea26f0e1d2c3b4a5968778695a4b3c2d1e0f9' && j12[0].state === 'COMMENTED' && j12[0].submittedAt === '2026-10-23T11:22:51Z', JSON.stringify(j12[0]));

  const j13 = judgementsFromCopy(copyOf(13));
  check('写し pr-13: 差し戻し + 基準 [3, 5] + 期限(引用記号つきの 1 行目)', j13.length === 1 && j13[0].gate === 'G-6' && j13[0].result === '差し戻し' && same(j13[0].criteria, [3, 5]) && j13[0].deadline === '2026-10-30' && j13[0].state === 'CHANGES_REQUESTED', JSON.stringify(j13));

  const j14 = judgementsFromCopy(copyOf(14));
  check('写し pr-14: 宣言行なし(承認の本文、注記つきの結果)は 0 件', j14.length === 0, JSON.stringify(j14));

  check('judgeLogins で絞る: yamada', judgementsFromCopy(copyOf(12), { judgeLogins: new Set(['yamada']) }).length === 1);
  check('judgeLogins で絞る: suzuki は pr-12 に判定を持たない', judgementsFromCopy(copyOf(12), { judgeLogins: new Set(['suzuki']) }).length === 0);
  check('judgeLogins で絞る: 空の Set は全員を外す', judgementsFromCopy(copyOf(13), { judgeLogins: new Set() }).length === 0);

  // 同じ人の 2 件が配列の逆順(新しいものが先)でも、submitted_at で選ぶ
  const reversed = { ...copyOf(12), reviews: [...copyOf(12).reviews].reverse() };
  const jr = judgementsFromCopy(reversed);
  check('同一 login の最後: 配列の順序に依らず submitted_at で選ぶ', jr.length === 1 && jr[0].result === '通過', JSON.stringify(jr));
  // ゲートが違えば別の判定として両方残る
  const twoGates = { pr: 99, reviews: [
    { id: 1, state: 'COMMENTED', commit_id: 'a', submitted_at: '2026-10-01T00:00:00Z', user: { id: 1, login: 'yamada' }, body: 'G-2: 通過' },
    { id: 2, state: 'COMMENTED', commit_id: 'a', submitted_at: '2026-10-02T00:00:00Z', user: { id: 1, login: 'yamada' }, body: 'G-4: 通過' },
  ] };
  check('同じ人でもゲートが違えば両方残る', judgementsFromCopy(twoGates).length === 2);
  check('写しでないもの(reviews が無い)は空', judgementsFromCopy({}).length === 0 && judgementsFromCopy(null).length === 0);
}

// ---------------------------------------------------------------- head の一致
{
  const c12 = copyOf(12);
  const [j] = judgementsFromCopy(c12);
  const h = headMatches(c12, j);
  check('head の一致: 通過の commit_id == head_sha_at_merge', h.match === true && h.head === c12.head_sha_at_merge, JSON.stringify(h));
  const c13 = copyOf(13);
  const [j13] = judgementsFromCopy(c13);
  const h13 = headMatches(c13, j13);
  check('head の不一致: レビューの後に push があった(確定していない版を取り込んだ)', h13.match === false && h13.head === c13.head_sha_at_merge, JSON.stringify(h13));
  const noHead = { ...c12 };
  delete noHead.head_sha_at_merge;
  const hn = headMatches(noHead, j);
  check('写しに head が無ければ判定できない(match=false, head=null)', hn.match === false && hn.head === null, JSON.stringify(hn));
  check('head_sha の欄名でも読む', headMatches({ head_sha: j.commitId }, j).match === true);
}

// ---------------------------------------------------------------- 帰属の裏づけ
{
  const rec = (commit) => ({ file: 'records/gates/g7-v1.2.0-2026-10-20.md', text: readFixture('gates', 'g7-v1.2.0-2026-10-20.md'), commit });
  const base = { hash: 'abcdef0123456789', authorName: '鈴木 一郎', authorEmail: '30000001+suzuki@users.noreply.github.com', authorLogin: 'suzuki', date: '2026-10-20T14:00:00+09:00' };
  const a1 = recordAttribution(rec({ ...base, signed: false }), { judgeName: '鈴木 一郎' });
  check('帰属: 名前の一致だけ → 自己申告(backed=false, author-name)', a1.backed === false && a1.how === 'author-name', JSON.stringify(a1));
  const a2 = recordAttribution(rec({ ...base, signed: false }), { judgeName: '鈴木 一郎', judgeLogin: 'suzuki' });
  check('帰属: 署名なし + login の一致 → 弱い裏づけ(author-login)', a2.backed === true && a2.how === 'author-login', JSON.stringify(a2));
  const a3 = recordAttribution(rec({ ...base, signed: false }), { judgeEmail: '30000001+SUZUKI@users.noreply.github.com' });
  check('帰属: 署名なし + email の一致(大文字小文字を問わない) → author-email', a3.backed === true && a3.how === 'author-email', JSON.stringify(a3));
  const a4 = recordAttribution(rec({ ...base, signed: true }), { judgeName: '鈴木 一郎', judgeLogin: 'suzuki' });
  check('帰属: 署名あり + author が記名者 → signed-commit', a4.backed === true && a4.how === 'signed-commit', JSON.stringify(a4));
  const a5 = recordAttribution(rec({ ...base, signed: true }), { judgeName: '鈴木 一郎', judgeLogin: 'sato' });
  check('帰属: 署名ありでも login が別人なら、名前の一致は自己申告', a5.backed === false && a5.how === 'author-name', JSON.stringify(a5));
  const a6 = recordAttribution(rec({ ...base, signed: true }), { judgeName: '鈴木 一郎' });
  check('帰属: 署名あり + 名前だけを渡した(login・email を知らない) → signed-commit', a6.backed === true && a6.how === 'signed-commit', JSON.stringify(a6));
  const a7 = recordAttribution(rec({ ...base, signed: false }), { judgeName: '佐藤 花子', judgeLogin: 'sato', judgeEmail: 'sato@example.com' });
  check('帰属: 何も一致しない → backed=false, how=null', a7.backed === false && a7.how === null, JSON.stringify(a7));
  const a8 = recordAttribution(rec(null), { judgeName: '鈴木 一郎' });
  check('帰属: コミットを読めない → backed=false, how=null', a8.backed === false && a8.how === null && /読めない/.test(a8.note), JSON.stringify(a8));
  check('様式のゲート欄: G-7 / G-8', gateOfRecord(readFixture('gates', 'g7-v1.2.0-2026-10-20.md')) === 'G-7' && gateOfRecord(readFixture('gates', 'g8-v1.2.0-2026-10-21.md')) === 'G-8');
  check('様式のゲート欄: 表が無ければ null', gateOfRecord('# 何か\n') === null);
  check('様式のゲート欄: 空の欄は null', gateOfRecord('| ゲート |  |\n') === null);
}

// ---------------------------------------------------------------- 写しと様式の読み方(集約・next・config が共有する。#54)
{
  const text12 = readFixture('reviews', 'pr-12.json');
  const p = parseCopy('records/reviews/pr-12.json', text12);
  check('parseCopy: 写しを読み、PR 番号をファイル名から取る', p.copy !== null && p.prNumber === 12 && p.reason === null, JSON.stringify({ prNumber: p.prNumber, reason: p.reason }));
  check('parseCopy: Windows の区切りの所在でも読む', parseCopy('docs\\records\\reviews\\pr-12.json', text12).prNumber === 12);
  check('parseCopy: 名前の形でない', parseCopy('records/reviews/review-12.json', text12).copy === null && /名前の形/.test(parseCopy('x.json', text12).reason));
  check('parseCopy: JSON として読めない', parseCopy('pr-1.json', '{').copy === null && /JSON/.test(parseCopy('pr-1.json', '{').reason));
  check('parseCopy: reviews の配列が無い', parseCopy('pr-1.json', '{"pr":1}').copy === null && /reviews/.test(parseCopy('pr-1.json', '{"pr":1}').reason));
  check('parseCopy: ファイル名と pr の不一致', parseCopy('pr-2.json', '{"pr":1,"reviews":[]}').copy === null && /一致しない/.test(parseCopy('pr-2.json', '{"pr":1,"reviews":[]}').reason));
  check('parseCopy: pr の無い写しはファイル名の番号で読む', parseCopy('pr-7.json', '{"reviews":[]}').prNumber === 7 && parseCopy('pr-7.json', '{"reviews":[]}').copy !== null);
  check('headOfCopy: head_sha を優先し、旧い head_sha_at_merge も読む', headOfCopy({ head_sha: 'a', head_sha_at_merge: 'b' }) === 'a' && headOfCopy({ head_sha_at_merge: 'b' }) === 'b' && headOfCopy({}) === null && headOfCopy(null) === null);

  const g4 = readFixture('gates', 'g4-F-002-2026-10-22.md');
  check('formCellRaw: 欄の記載そのもの', formCellRaw(g4, 'ゲート') === 'G-4 機能仕様承認' && formCellRaw(g4, '無い欄') === null);
  check('formCell: 対象だけ " / " を許す', formCell(g4, '対象') === 'F-002 / 7a8b9c0' && formCell('| 結果 | 通過 / 差し戻し |\n', '結果') === null);
  check('formCell: 様式の文言のまま・空は未記入', formCell('| 判定者 | <氏名> |\n', '判定者') === null && formCell('| 判定者 |  |\n', '判定者') === null);
  check('targetOfForm / judgeOfForm: 欄の値', targetOfForm(g4) === 'F-002 / 7a8b9c0' && judgeOfForm(g4) === '山田 太郎');
  check('judgeOfForm: 注記(。以降)を除き、様式の説明は未記入', judgeOfForm('| 判定者 | 鈴木 一郎。出所: レビュー user.id 12 |\n') === '鈴木 一郎' && judgeOfForm('| 判定者 | <氏名> |\n') === null);
  const r = recordFromForm(g4, 'records/gates/g4-F-002-2026-10-22.md', 'records-branch');
  check(
    'recordFromForm: 欄を揃えた記録(file・source・gate・target・result・resultRaw・mode・riskConfirmedBy・d0Version・judgedAt)',
    same(r, {
      file: 'records/gates/g4-F-002-2026-10-22.md',
      source: 'records-branch',
      gate: 'G-4 機能仕様承認',
      target: 'F-002 / 7a8b9c0',
      result: '通過',
      resultRaw: '通過',
      mode: '人確定',
      riskConfirmedBy: '—',
      d0Version: '3',
      judgedAt: '2026-10-22 10:00',
    }),
    JSON.stringify(r)
  );
  check('recordFromForm: 結果欄に選択肢が残っていれば result=null、resultRaw に記載', (() => {
    const x = recordFromForm('| 結果 | 通過 / 差し戻し |\n', 'f.md', 'base');
    return x.result === null && x.resultRaw === '通過 / 差し戻し';
  })());

  // 採用先の記録は欄を太字・コード表記・リンクで書くことがある。比べる前に装飾を除く。結果欄の完全一致は緩めない
  const decorated = [
    '| ゲート | **G-1 企画承認(再判定)** |',
    '| 対象 | **P-001 Filetto** / `specs/F-001` |',
    '| 結果 | **通過** |',
    '| 判定者 | **山田 太郎**。出所: レビュー |',
    '',
  ].join('\n');
  const d = recordFromForm(decorated, 'docs/gates/g1.md', 'base');
  check('装飾: ゲート欄の太字を除く', d.gate === 'G-1 企画承認(再判定)' && gateOfRecord(decorated) === 'G-1', JSON.stringify(d));
  check('装飾: 結果欄の太字を除き、通過と読む。resultRaw は記載のまま', d.result === '通過' && d.resultRaw === '**通過**', JSON.stringify(d));
  check('装飾: 対象欄の太字・コード表記を除き、区切ると F-001 を含む', d.target === 'P-001 Filetto / specs/F-001' && d.target.split(/[\s,、/]+/).includes('F-001') && targetOfForm(decorated) === d.target, JSON.stringify(d));
  check('装飾: 判定者の太字を除く', judgeOfForm(decorated) === '山田 太郎');
  check('装飾: 注記のある結果(**通過**(転記))は通過と読まない', recordFromForm('| 結果 | **通過**(転記) |\n', 'f.md', 'base').result !== '通過');
  check('装飾: 除いた後も、対象以外の " / " は未記入', formCell('| 結果 | **通過** / **差し戻し** |\n', '結果') === null);
  check('装飾: コード表記の様式の文言(`<氏名>`)は未記入', formCell('| 判定者 | `<氏名>` |\n', '判定者') === null);
  check('normalizeCell: 強調 ** と __、バッククォートを除き、リンクは文字だけ残す', normalizeCell('__G-4__ [F-002](specs/F-002.md) `7a8b9c0`') === 'G-4 F-002 7a8b9c0' && normalizeCell(null) === null);
}

// ---------------------------------------------------------------- 記録用ブランチの読み取り(一時のリポジトリ)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-records-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const initRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'tester');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'chore: base');
};
// fixtures を記録用ブランチへ置く。改行は LF 固定(fixtures は LF で保存されている。autocrlf を切った上で、念のため揃える)
const putFixture = (dir, rel) => {
  const dest = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(path.join(FIXTURES, rel.replace(/^records\//, '')), 'utf8').replace(/\r\n/g, '\n'));
};
try {
  // --- ブランチがある場合(refs/heads/records)
  const A = path.join(TMP, 'a');
  initRepo(A);
  git(A, 'checkout', '-q', '--orphan', RECORDS_REF);
  git(A, 'rm', '-rfq', '.');
  fs.writeFileSync(path.join(A, 'README.md'), '# 記録用ブランチ\n');
  git(A, 'add', '-A');
  git(A, 'commit', '-q', '-m', 'chore: 記録用ブランチを初期化する');
  for (const f of ['records/reviews/pr-12.json', 'records/reviews/pr-13.json', 'records/reviews/pr-14.json']) putFixture(A, f);
  git(A, 'add', '-A');
  git(A, 'commit', '-q', '-m', 'records: 写しを置く', '--author=github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
  putFixture(A, 'records/gates/g7-v1.2.0-2026-10-20.md');
  git(A, 'add', '-A');
  git(A, 'commit', '-q', '-m', 'records: G-7 の判定記録', '--author=鈴木 一郎 <30000001+suzuki@users.noreply.github.com>');
  putFixture(A, 'records/gates/g8-v1.2.0-2026-10-21.md');
  // 名前の形が違う写しと、壊れた JSON は skipped に出る
  fs.mkdirSync(path.join(A, 'records', 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(A, 'records', 'reviews', 'pr-15.json'), '{ "pr": 15, "reviews": [\n');
  fs.writeFileSync(path.join(A, 'records', 'reviews', 'notes.json'), '{}\n');
  git(A, 'add', '-A');
  git(A, 'commit', '-q', '-m', 'records: G-8 の判定記録', '--author=佐藤 花子 <sato@example.com>');
  git(A, 'checkout', '-q', 'main');
  check('一時のリポジトリ: main に records/ は無い', !fs.existsSync(path.join(A, 'records')));

  const r = readRecordsBranch({ cwd: A, fetch: false });
  check('読み取り: available', r.available === true && r.reason === null && r.ref === RECORDS_REF, JSON.stringify({ available: r.available, reason: r.reason }));
  check('読み取り: head はブランチの先頭', r.head === git(A, 'rev-parse', `refs/heads/${RECORDS_REF}`));
  check('読み取り: 写し 3 件を PR 番号で引ける', r.reviews.size === 3 && r.reviews.get(12)?.pr === 12 && r.reviews.get(13)?.head_sha_at_merge === 'daad05c1b2c3d4e5f60718293a4b5c6d7e8f9a0b', [...r.reviews.keys()].join(','));
  check('読み取り: 壊れた JSON と名前の形が違うファイルは skipped', r.skipped.length === 2 && r.skipped.some((s) => s.file.endsWith('pr-15.json') && /JSON/.test(s.reason)) && r.skipped.some((s) => s.file.endsWith('notes.json')), JSON.stringify(r.skipped));
  check('読み取り: 様式 2 件', r.gates.length === 2 && r.gates.every((g) => g.file.startsWith(`${GATES_DIR}/`) && g.text.includes('| ゲート |')), r.gates.map((g) => g.file).join(','));
  const g7 = r.gates.find((g) => g.file.endsWith('g7-v1.2.0-2026-10-20.md'));
  const g8 = r.gates.find((g) => g.file.endsWith('g8-v1.2.0-2026-10-21.md'));
  check('読み取り: 様式の commit(author の名前・email・noreply から login)', g7?.commit?.authorName === '鈴木 一郎' && g7.commit.authorEmail === '30000001+suzuki@users.noreply.github.com' && g7.commit.authorLogin === 'suzuki' && /^[0-9a-f]{40}$/.test(g7.commit.hash) && /^\d{4}-\d{2}-\d{2}T/.test(g7.commit.date), JSON.stringify(g7?.commit));
  check('読み取り: 署名の無いコミットは signed=false', g7?.commit?.signed === false, JSON.stringify(g7?.commit));
  check('読み取り: noreply でない email は authorLogin=null', g8?.commit?.authorLogin === null && g8.commit.authorName === '佐藤 花子', JSON.stringify(g8?.commit));
  check('読み取り: 様式のファイルごとに、そのファイルを最後に触ったコミット', g7.commit.hash !== g8.commit.hash);
  check('読み取り: 様式の text は LF のまま', !g7.text.includes('\r'));

  // 読み取り → 判定 → 帰属まで、一続きで使える
  const [j12] = judgementsFromCopy(r.reviews.get(12));
  check('一続き: 写しの判定と head の一致', j12?.result === '通過' && headMatches(r.reviews.get(12), j12).match === true);
  const att = recordAttribution(g7, { judgeName: '鈴木 一郎', judgeLogin: 'suzuki' });
  check('一続き: 様式の帰属(署名なし + login) → author-login', att.how === 'author-login' && att.backed === true, JSON.stringify(att));
  const attSelf = recordAttribution(g8, { judgeName: '佐藤 花子', judgeLogin: 'sato' });
  check('一続き: 様式の帰属(名前だけ) → 自己申告', attSelf.how === 'author-name' && attSelf.backed === false, JSON.stringify(attSelf));
  const s = summarizeRecords(r);
  check('要約: 件数とゲートごとの内訳', s.reviewCount === 3 && s.judgementCount === 2 && s.gateCount === 2 && same(s.byGate, { 'G-4': 1, 'G-6': 1, 'G-7': 1, 'G-8': 1 }), JSON.stringify(s));

  // --- refs/remotes/origin/records だけがある場合(clone した側の手元)
  const B = path.join(TMP, 'b');
  initRepo(B);
  git(B, 'fetch', '-q', A, `refs/heads/${RECORDS_REF}:refs/remotes/origin/${RECORDS_REF}`);
  const rb = readRecordsBranch({ cwd: B, fetch: false });
  check('読み取り: refs/remotes/origin/<ref> から読める', rb.available === true && rb.reviews.size === 3 && rb.gates.length === 2 && rb.head === r.head, JSON.stringify({ available: rb.available, reason: rb.reason }));

  // --- ブランチが無い場合
  const C = path.join(TMP, 'c');
  initRepo(C);
  const rc = readRecordsBranch({ cwd: C, fetch: false });
  check('ブランチ無し(fetch=false): available=false と理由', rc.available === false && typeof rc.reason === 'string' && rc.reason.includes(RECORDS_REF) && rc.reviews.size === 0 && rc.gates.length === 0, JSON.stringify(rc.reason));
  const rcf = readRecordsBranch({ cwd: C, fetch: true });
  check('ブランチ無し(fetch=true、origin も無い): fetch の失敗を理由に含め、例外にしない', rcf.available === false && /fetch/.test(rcf.reason), JSON.stringify(rcf.reason));

  // --- fetch=true で origin から取れる場合(手元に無いが origin にある)
  const D = path.join(TMP, 'd');
  initRepo(D);
  git(D, 'remote', 'add', 'origin', A);
  const rd = readRecordsBranch({ cwd: D, fetch: true });
  check('fetch=true: origin にあるブランチを 1 回の fetch で読む', rd.available === true && rd.reviews.size === 3, JSON.stringify({ available: rd.available, reason: rd.reason }));

  // --- lastCommitOf(様式を最後に触ったコミット。集約が基底の様式にも同じ形で使う)
  const lc = lastCommitOf(A, 'refs/heads/records', 'records/gates/g7-v1.2.0-2026-10-20.md');
  // 様式 g7 は、帰属の試験のために記名者(鈴木 一郎。noreply の email)を author にして置いてある。login を email から読めること
  check('lastCommitOf: hash・author・email の login・署名なし(signed=false)を読む', lc !== null && /^[0-9a-f]{40}$/.test(lc.hash) && lc.authorName === '鈴木 一郎' && lc.authorLogin === 'suzuki' && lc.signed === false && lc.signature === 'N', JSON.stringify(lc));
  check('lastCommitOf: 無いファイルは null', lastCommitOf(A, 'refs/heads/records', 'records/gates/nothing.md') === null);
  check('lastCommitOf: 読めない参照は null', lastCommitOf(A, 'refs/heads/no-such-branch', 'README.md') === null);

  // --- 別の名前のブランチ
  const re = readRecordsBranch({ cwd: A, ref: 'main', fetch: false });
  check('ref を変えると、そのブランチを読む(main には記録が無い)', re.available === true && re.reviews.size === 0 && re.gates.length === 0);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.log(`記録用ブランチの読み取りの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`記録用ブランチの読み取りの試験: ${n} 件が期待と一致しました`);

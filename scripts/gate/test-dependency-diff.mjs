// 依存の一覧(G-5 基準8)の解析・照会・表示を試験する。ネットワークを使わない(照会は差し替えた応答で確かめる)。
//
//   node scripts/gate/test-dependency-diff.mjs
//
// 確かめること(process-compass #455 / ADR-0261):
//   - 解析: package-lock.json の追加・更新、初出の名前、直接と推移、解決元の分類(公開・私設・git・workspace)、ロックファイルの無い構成
//   - 照会: 公開日時・初回公開日時・公開者・証明の有無。不達は「照会せず」、404 は「取得できず」、私設は「対象外」。合否を返さない
//   - 印: 初出の名前・公開者の変更・証明の退行・検証の失敗・照会せず・取得できず・対象外
//   - 表示: 状態行(依存の解決・照会・検証)、省略の件数を必ず出す、印の付いた行は切らない、解析と照会の入力は切らない

import {
  diffNpmLock,
  diffPackageJson,
  marksOf,
  MARK,
  parseAuditSignatures,
  classifySource,
} from './dependency-parse.mjs';
import { queryEntry, queryAll } from './dependency-provenance.mjs';
import { buildReport, resolutionState, UNMARKED_ROW_LIMIT } from './dependency-diff.mjs';

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(0, 8).join('\n       ')}`}`);
}

const pub = (n, v) => ({ version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`, integrity: 'sha512-x' });
function lock(pkgs, rootDeps = {}) {
  const packages = { '': { name: 't', dependencies: rootDeps } };
  for (const [k, v] of Object.entries(pkgs)) packages[k] = v;
  return JSON.stringify({ name: 't', lockfileVersion: 3, packages });
}

// ---------------------------------------------------------------- 1. 解析
{
  const base = lock({ 'node_modules/a': pub('a', '1.0.0') }, { a: '^1' });
  const head = lock(
    {
      'node_modules/a': pub('a', '1.1.0'),
      'node_modules/b': pub('b', '2.0.0'),
      'node_modules/a/node_modules/c': pub('c', '3.0.0'),
      'node_modules/@s/d': { version: '1.0.0', resolved: 'https://npm.corp.example/@s/d/-/d-1.0.0.tgz' },
      'node_modules/e': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/e.git#abc' },
      'node_modules/w': { resolved: 'packages/w', link: true },
    },
    { a: '^1', b: '^2' }
  );
  const r = diffNpmLock(base, head);
  const by = Object.fromEntries(r.entries.map((e) => [e.name, e]));
  check('解析: 更新の行は前の版を持ち、初出の名前ではない', by.a?.from === '1.0.0' && by.a?.to === '1.1.0' && by.a?.firstSeen === false, JSON.stringify(by.a));
  check('解析: 追加の行は初出の名前で、直接の依存', by.b?.firstSeen === true && by.b?.direct === true && by.b?.from === null, JSON.stringify(by.b));
  check('解析: 入れ子の依存は推移', by.c?.direct === false && by.c?.firstSeen === true, JSON.stringify(by.c));
  check('解析: 解決元の分類(公開・私設・git・workspace)', by.b.source === 'public' && by['@s/d']?.source === 'private' && by['@s/d']?.host === 'npm.corp.example' && by.e?.source === 'git' && by.w?.source === 'workspace', JSON.stringify(r.entries.map((e) => [e.name, e.source])));
  check('解析: 変わらない依存は出さない', !r.entries.some((e) => e.name === 'a' && e.to === '1.0.0'));
  check('解析: 読めないロックファイルは ok: false', diffNpmLock(base, '{ not json').ok === false);
  check('解析: 基底の無い新規のロックファイルは全件が初出', diffNpmLock('', head).entries.every((e) => e.firstSeen));
  check('分類: 解決元が読めない行は不明', classifySource({ version: '1' }).kind === 'unknown');
}
{
  const r = diffPackageJson('{"dependencies":{"a":"^1"}}', '{"dependencies":{"a":"^1","b":"^2"},"devDependencies":{"c":"1.0.0"}}');
  check('ロックファイルの無い構成: 直接の依存の宣言だけを出し、lockless を立てる', r.entries.map((e) => e.name).join() === 'b,c' && r.entries.every((e) => e.lockless && e.direct), JSON.stringify(r.entries));
}

// ---------------------------------------------------------------- 2. 照会(応答の差し替え)
const doc = {
  time: { created: '2020-01-01T00:00:00Z', '1.0.0': '2020-02-01T00:00:00Z', '1.1.0': '2026-11-01T00:00:00Z' },
  versions: {
    '1.0.0': { _npmUser: { name: 'alice' }, dist: { attestations: { url: 'x' }, signatures: [{ sig: 's' }] } },
    '1.1.0': { _npmUser: { name: 'mallory' }, dist: { signatures: [{ sig: 's' }] } },
  },
};
const fetchOk = async () => ({ ok: true, status: 200, json: doc });
const E = { ecosystem: 'npm', name: 'a', from: '1.0.0', to: '1.1.0', direct: true, source: 'public', host: 'registry.npmjs.org', firstSeen: false, lockless: false };
{
  const q = await queryEntry(E, fetchOk);
  check('照会: 公開日時・初回公開日時・公開者・証明の有無を取る', q.status === 'queried' && q.publishedAt === '2026-11-01T00:00:00Z' && q.firstPublishedAt.startsWith('2020') && q.publisher === 'mallory' && q.attestation === false && q.prevAttestation === true, JSON.stringify(q));
  const m = marksOf(E, q);
  check('印: 公開者の変更と証明の退行', m.includes(MARK.PUBLISHER_CHANGED) && m.includes(MARK.ATTESTATION_LOST), m.join());
}
{
  const q = await queryEntry(E, async () => {
    throw new Error('ECONNREFUSED');
  });
  check('照会: 不達は「照会せず」で、例外にならない(合否を返さない)', q.status === 'skipped' && /不達/.test(q.reason), JSON.stringify(q));
  check('印: 照会せず', marksOf(E, q).includes(MARK.NOT_QUERIED));
  const q5 = await queryEntry(E, async () => ({ ok: false, status: 503, json: null }));
  check('照会: HTTP 503 も「照会せず」', q5.status === 'skipped');
  const q4 = await queryEntry(E, async () => ({ ok: false, status: 404, json: null }));
  check('照会: 404 は「取得できず」(未登録の名前の兆候)', q4.status === 'unavailable' && marksOf(E, q4).includes(MARK.UNAVAILABLE));
  const qe = await queryEntry(E, async () => ({ ok: true, status: 200, json: {} }));
  check('照会: 応答に欄の値が無ければ「取得できず」', qe.status === 'unavailable');
}
{
  let called = 0;
  const q = await queryEntry({ ...E, source: 'private', host: 'npm.corp.example' }, async () => {
    called++;
    return { ok: true, status: 200, json: doc };
  });
  check('照会: 私設・ミラーは対象外で、レジストリへ問い合わせない', q.status === 'out-of-scope' && called === 0 && marksOf(E, q).includes(MARK.OUT_OF_SCOPE), JSON.stringify(q));
  const ql = await queryEntry({ ...E, lockless: true }, fetchOk);
  check('照会: ロックファイルの無い行(版が未確定)は照会せず', ql.status === 'skipped');
}
{
  const entries = Array.from({ length: 12 }, (_, i) => ({ ...E, name: `p${i}` }));
  let n = 0;
  const qs = await queryAll(entries, async () => {
    n++;
    return { ok: true, status: 200, json: doc };
  });
  check('照会: 入力の全件を照会する(切らない)', qs.length === 12 && n === 12);
}
check('印: 検証の失敗(名前の一致)', marksOf(E, { status: 'queried', publisher: 'alice', prevPublisher: 'alice', attestation: true, prevAttestation: true }, new Set(['a'])).join() === MARK.VERIFY_FAILED);
{
  const p = parseAuditSignatures('audited 3 packages\n\n1 package has an invalid registry signature:\n\n  evil@1.0.0 (https://registry.npmjs.org/)\n', 1);
  check('検証の出力: 失敗の名前を取る', p.status === 'failed' && p.failedNames.join() === 'evil', JSON.stringify(p));
  check('検証の出力: 終了コード 0 は成功', parseAuditSignatures('ok', 0).status === 'passed');
}

// ---------------------------------------------------------------- 3. 表示
const resolution = { done: true, reason: 'install: npm ci' };
{
  const rows = Array.from({ length: UNMARKED_ROW_LIMIT + 7 }, (_, i) => ({ ...E, name: `u${i}` }));
  const okQ = { status: 'queried', publishedAt: '2026-01-01', firstPublishedAt: '2020-01-01', publisher: 'alice', prevPublisher: 'alice', attestation: true, prevAttestation: true };
  const qs = rows.map(() => okQ);
  rows.push({ ...E, name: 'zz-new', firstSeen: true, from: null });
  qs.push(okQ);
  const { md, json } = buildReport({ base: 'origin/main', details: [{ file: 'package-lock.json', added: Array.from({ length: 100 }, (_, i) => `x${i}`), removed: [] }], entries: rows, unparsed: [], queries: qs, verification: { status: 'passed', failedNames: [], kinds: ['署名'] }, resolution });
  check('表示: 状態行(依存の解決・照会・検証)を出す', /依存の解決: 実施\(install: npm ci\)/.test(md) && /照会: 48 件中 0 件を照会せず/.test(md) && /検証: 実施\(失敗なし\)/.test(md), md.slice(0, 600));
  check('表示: 省略の件数を出す(印の無い行・差分の行)', /表示の省略: 印の無い行 7 件、差分の行 60 件/.test(md), md.split('\n').filter((l) => /省略/.test(l)).join('|'));
  check('表示: 印の付いた行は省略しない', md.includes('`zz-new`') && /初出の名前/.test(md));
  check('表示: 解析と照会は表示で切った後の行でなく全件(JSON は全行を持つ)', json.entries.length === rows.length && json.summary.omittedRows === 7 && json.summary.rawOmitted === 60);
}
{
  const { md } = buildReport({ base: 'b', details: [], entries: [{ ...E, name: 'pv', source: 'private', host: 'npm.corp.example' }, { ...E, name: 'nq' }], unparsed: [{ file: 'requirements.txt', reason: '解析せず(node 以外)' }], queries: [{ status: 'out-of-scope', reason: '私設・ミラーのレジストリ(npm.corp.example)' }, { status: 'skipped', reason: '不達(HTTP 503)' }], verification: { status: 'not-run', reason: '依存を導入していない', kinds: [] }, resolution: { done: false, reason: 'install が空' } });
  check('表示: 照会せず・対象外の件数と理由を一覧の頭に出す', /照会: 2 件中 2 件を照会せず\(.*対象外.*不達/.test(md), md.split('\n').filter((l) => /照会:/.test(l)).join());
  check('表示: 依存の解決の未実施と理由、検証の未実施と理由、解析せずのファイル', /依存の解決: 未実施\(install が空\)/.test(md) && /検証: 未実施\(依存を導入していない\)/.test(md) && /解析せず: `requirements.txt`/.test(md));
  check('表示: 照会せず・対象外の行にも印が出る', /対象外/.test(md.split('| `pv`')[0].split('\n').at(-1) ?? '') || md.includes('対象外 | `pv`'), md.split('\n').filter((l) => /pv|nq/.test(l)).join('\n'));
  check('表示: 完全性を来歴と数えない旨を、種類の記載が無いときに出す', /完全性\(go mod verify\)を来歴と数えない/.test(md));
}
{
  const { md } = buildReport({ base: 'b', details: [], entries: [{ ...E, lockless: true, name: 'll' }], unparsed: [], queries: [{ status: 'skipped', reason: '版が未確定' }], resolution });
  check('表示: ロックファイルの無い構成は「推移的な依存は見えない」を出す', /推移的な依存は見えない/.test(md));
  check('状態: install が空のアダプタは未実施として理由を出す', resolutionState({ id: 'x', commands: { install: '' } }).done === false && resolutionState({ id: 'node', commands: { install: 'npm ci' } }).done === true);
}

console.log('');
if (failures) {
  console.log(`依存の一覧の試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`依存の一覧の試験: ${checks} 件が期待と一致しました`);

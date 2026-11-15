// 委任の期間ごとの保証の開示の通しの試験(標準 第4章 G-7・G-8「期間ごとの保証の開示」/ 第5章 5.5.4。process-compass #355 束4。IMPL-0048)
//
//   TZ=UTC node scripts/gate/test-assurance-period.mjs
//
// 一時のリポジトリに template の全ファイルを写し(test-direct-commit-rules.mjs と同じ足場)、集約(aggregate-evidence.mjs)を
// --period-from / --period-to で実際に動かす。GitHub へ問い合わせない(GH_TOKEN・GITHUB_REPOSITORY を空にする)。
// コミットの日付は GIT_*_DATE で固定する(時計に依らない)。次を確かめる。
//   - 違反側: 委任の席の構成・期間中にコミット・G-8 の記録なし → 「期間の開示(起点〜終点)に対応する受容と異議の記録がありません」を
//     出力と evidence.json の欠落に出し、終了コードは 0 でない。差し戻しの記録 → 「受容されていません」。別の期間を対象にした通過の記録、
//     起点と終点を「と」で並べた対象 → 対応づけず、記録がありません
//   - 適合側: 対象が同じ期間で結果が通過、判定者が名簿の人の記録 → 期間の欠落の行が 0 件で、欠落の件数が違反側よりちょうど 1 少ない
//   - period-needed.mjs: 委任なし → needed=false で終了 0。委任の席・期間の途中で委任をやめた構成・トレーラ Delegated だけ → true。
//     起点 > 終点・実在しない日付 → 終了コード 2
//   - assurance-period.yml: 「期間を決める」の run を bash で動かす(不正な日付で終了 2、省略で前月の1日と末日)。集約の手順の if、
//     `|| true` と continue-on-error が無いこと、on.schedule、permissions の checks: read
//
// 確かめない: 定期の起動(cron)と手動の起動が実際の GitHub 上で動くこと、GITHUB_TOKEN の権限(EV-0270 で開示)。
// 期間が過ぎたのに開示が出ていないことは検出しない(期間の開示を突合する出荷判定者が確かめる)。
// この足場では D-0 などが無いため、期間と無関係の欠落が残り、集約の終了コードは適合側でも 1 のまま。適合側は欠落の件数の差で確かめる。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-8).join('\n       ')}`}`);
}
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const ANSWERS = {
  'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free',
  'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes', 'q-biz-phase': 'growth',
};
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊'[i]}`, accounts: [`acc${i}`] }));
const SEATS = Object.entries({ 'value-owner': 'p0', 'tech-lead': 'p4', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' }).map(([role, accountable]) => ({ role, accountable }));
const FROM = '2026-10-01';
const TO = '2026-10-31';
const IN_PERIOD = '2026-10-15T12:00:00Z';
const BEFORE = '2026-09-15T12:00:00Z';
const AFTER = '2026-11-10T12:00:00Z';

function workspace({ delegated }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-period-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const base = quiet(() => buildConfig(ANSWERS, { generatedAt: '2026-09-01T09:00:00+09:00', d0Version: null, people: PEOPLE, seats: SEATS }).config);
  const withMode = (on) => ({ ...base, seats: (base.seats ?? []).map((s, i) => (i === 0 && on ? { ...s, mode: 'delegated' } : { ...s, mode: s.mode === 'delegated' ? 'direct' : s.mode })) });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const json = (c) => JSON.stringify(c, null, 2) + '\n';
  write('process.config.json', json(withMode(delegated)));
  const git = (date, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: 'UTC', GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  git(BEFORE, 'init', '-q', '-b', 'main');
  git(BEFORE, 'config', 'user.email', 't@example.com');
  git(BEFORE, 'config', 'user.name', 'tester');
  git(BEFORE, 'config', 'core.autocrlf', 'false');
  git(BEFORE, 'config', 'gc.auto', '0');
  git(BEFORE, 'config', 'maintenance.auto', 'false');
  git(BEFORE, 'add', '-A');
  git(BEFORE, 'commit', '-q', '-m', 'chore: fixture');
  const commit = (date, subject, trailers, files) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git(date, 'add', '-A');
    git(date, 'commit', '-q', '-m', `${subject}\n\n${trailers}\nVerification: 手元で試験を実行し、通過を確かめた`);
  };
  const run = (script, args, env = {}) => {
    const out = path.join(dir, 'github-output.txt');
    fs.rmSync(out, { force: true });
    const r = spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, TZ: 'UTC', GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_OUTPUT: out, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, needed: fs.existsSync(out) ? /needed=(true|false)/.exec(fs.readFileSync(out, 'utf8'))?.[1] ?? null : null };
  };
  const aggregate = () => {
    const r = run('scripts/gate/aggregate-evidence.mjs', ['--period-from', FROM, '--period-to', TO]);
    let ev = null;
    try {
      ev = JSON.parse(fs.readFileSync(path.join(dir, `evidence/period-${FROM}_${TO}/evidence.json`), 'utf8'));
    } catch {
      ev = null;
    }
    const find = (o, k, acc = []) => {
      if (o && typeof o === 'object') for (const [a, b] of Object.entries(o)) {
        if (a === k) acc.push(b);
        find(b, k, acc);
      }
      return acc;
    };
    const gaps = (find(ev, 'gaps')[0] ?? []).filter((x) => typeof x === 'string');
    return { ...r, ev, gaps };
  };
  const needed = () => run('scripts/gate/period-needed.mjs', ['--period-from', FROM, '--period-to', TO]);
  const done = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { commit, run, aggregate, needed, done, write, exists: (rel) => fs.existsSync(path.join(dir, rel)), read: (rel) => fs.readFileSync(path.join(dir, rel), 'utf8'), json, withMode, base };
}

const record = ({ target, result = '通過', judge = '名簿 甲' }) =>
  `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | G-8 リリース決裁 |\n| 対象 | ${target} |\n| 判定者 | ${judge} |\n| 判定日時 | 2026-11-02 10:00 |\n| 結果 | ${result} |\n| 確定の形態 | 人確定 |\n| 参照した D-0 の版 | 3 |\n| 変更のリスク区分 | — |\n| リスク区分を確定した者 | — |\n| 期限内か | はい |\n\n## 決断の記録\n\n| 欄 | 記載 |\n| --- | --- |\n| 確認した事項 | 期間の開示 |\n| 確認していない事項 | なし |\n| 判断が変わる条件 | なし |\n| 受容したリスク | なし |\n| 出荷判定者の異議 | 異議なし |\n| 照らした層1 の版 | 2 |\n| 上申 | 該当なし |\n| 品質保証の対象外として出荷することの受容 | 名簿 戊 |\n`;
const PERIOD_GAP_RE = /期間の開示\(2026-10-01〜2026-10-31\)に対応する受容と異議の記録がありません/;
const periodLines = (gaps) => gaps.filter((g) => /期間の開示|期間の G-8/.test(g));

// 集約の通し。委任の席の構成・期間中にコミット 1 件
{
  const w = workspace({ delegated: true });
  w.commit(IN_PERIOD, 'feat: delegated change', 'Risk: R3\nDelegated: rule-1', { 'src/a.js': 'export const a = 1;\n' });

  // IMPL-0048:ng(違反側。期間の開示に対応する G-8 の記録が無い)
  const v0 = w.aggregate();
  check('IMPL-0048:ng 記録なし: 出力に「記録がありません」の欠落が出る', PERIOD_GAP_RE.test(v0.out), v0.out.slice(-600));
  check('IMPL-0048:ng 記録なし: evidence.json の欠落に同じ文が出る', v0.gaps.some((g) => PERIOD_GAP_RE.test(g)), JSON.stringify(v0.gaps.slice(0, 3)));
  check('IMPL-0048:ng 記録なし: 終了コードは 0 でない(足場の欠落を含む。期間の欠落だけが終了コードを変えることは、この場面では固定しない)', v0.status !== 0 && v0.status !== null, String(v0.status));
  const n0 = v0.gaps.length;

  // 差し戻し
  w.write('docs/gates/g8-period.md', record({ target: `委任の期間 ${FROM}〜${TO}`, result: '差し戻し' }));
  const v1 = w.aggregate();
  check('IMPL-0048:ng 差し戻しの記録: 「受容されていません」の欠落が出て、記録がありませんの欠落は出ない', v1.gaps.some((g) => /受容されていません/.test(g)) && !v1.gaps.some((g) => PERIOD_GAP_RE.test(g)), JSON.stringify(periodLines(v1.gaps)));

  // 別の期間を対象にした通過
  w.write('docs/gates/g8-period.md', record({ target: '委任の期間 2026-09-01〜2026-09-30' }));
  const v2 = w.aggregate();
  check('IMPL-0048:ng 別の期間を対象にした通過の記録: 対応づけず「記録がありません」', v2.gaps.some((g) => PERIOD_GAP_RE.test(g)), JSON.stringify(periodLines(v2.gaps)));

  // 起点と終点を「と」で並べた対象
  w.write('docs/gates/g8-period.md', record({ target: `${FROM} と ${TO} の障害` }));
  const v3 = w.aggregate();
  check('IMPL-0048:ng 起点と終点を「と」で並べた対象: 対応づけず「記録がありません」', v3.gaps.some((g) => PERIOD_GAP_RE.test(g)), JSON.stringify(periodLines(v3.gaps)));

  // 判定者が名簿の人でない
  w.write('docs/gates/g8-period.md', record({ target: `委任の期間 ${FROM}〜${TO}`, judge: '名簿にない人' }));
  const v4 = w.aggregate();
  check('IMPL-0048:ng 判定者が名簿の人でない通過の記録: 判定者を受け付けられない欠落が出る', v4.gaps.some((g) => /期間の G-8 の記録の判定者を受け付けられません/.test(g)), JSON.stringify(periodLines(v4.gaps)));

  // 結果の欄が空欄の記録・判定の値でない記録(保留)は、受容として扱わない
  for (const [label, result] of [['結果が空欄', ''], ['結果が保留', '保留']]) {
    w.write('docs/gates/g8-period.md', record({ target: `委任の期間 ${FROM}〜${TO}`, result }));
    const vr = w.aggregate();
    check(`IMPL-0048:ng ${label}の記録: 「結果が未記入、または判定の値(通過 / 差し戻し)でありません」の欠落が出る`, vr.gaps.some((g) => /期間の G-8 の記録の結果が未記入、または判定の値/.test(g)), JSON.stringify(periodLines(vr.gaps)));
  }

  // IMPL-0048:ok(適合側。対象が同じ期間で結果が通過、判定者が名簿の人)
  w.write('docs/gates/g8-period.md', record({ target: `委任の期間 ${FROM}〜${TO}` }));
  const ok = w.aggregate();
  check('IMPL-0048:ok 通過の記録: 期間の欠落の行が 0 件', periodLines(ok.gaps).length === 0, JSON.stringify(periodLines(ok.gaps)));
  check('IMPL-0048:ok 通過の記録: 欠落の件数は違反側(記録なし)よりちょうど 1 少ない', ok.gaps.length === n0 - 1, `${ok.gaps.length} / ${n0}`);
  const expectedGaps = v0.gaps.filter((g) => !PERIOD_GAP_RE.test(g)).sort();
  check('IMPL-0048:ok 通過の記録: 欠落の集合は「違反側の集合 − 期間の欠落の1文」と一致する(対は期間の欠落だけで分かれる)', JSON.stringify([...ok.gaps].sort()) === JSON.stringify(expectedGaps), JSON.stringify(ok.gaps.filter((g) => !expectedGaps.includes(g))));
  check('IMPL-0048:ok 期間の開示の 3 ファイルが出る', ['evidence.json', 'quality-report.md', 'assurance-disclosure.external.md'].every((f) => w.exists(`evidence/period-${FROM}_${TO}/${f}`)));
  w.done();
}

// period-needed.mjs
{
  const none = workspace({ delegated: false });
  none.commit(IN_PERIOD, 'feat: x', 'Risk: R3', { 'src/a.js': 'export const a = 1;\n' });
  const r0 = none.needed();
  check('period-needed: 委任なし → needed=false・終了コード 0', r0.status === 0 && r0.needed === 'false', `${r0.status} ${r0.needed} ${r0.out.slice(-200)}`);
  for (const [name, from, to] of [['起点 > 終点', '2026-10-31', '2026-10-01'], ['実在しない日付', '2026-02-30', '2026-10-31'], ['形が違う日付', 'abc', '2026-10-31']]) {
    const r = none.run('scripts/gate/period-needed.mjs', ['--period-from', from, '--period-to', to]);
    check(`period-needed: ${name} → 終了コード 2`, r.status === 2, String(r.status));
  }
  none.done();

  const del = workspace({ delegated: true });
  del.commit(IN_PERIOD, 'feat: x', 'Risk: R3', { 'src/a.js': 'export const a = 1;\n' });
  const r1 = del.needed();
  check('period-needed: 委任の席 → needed=true', r1.status === 0 && r1.needed === 'true', `${r1.status} ${r1.needed}`);
  del.done();

  const mid = workspace({ delegated: false });
  mid.commit(IN_PERIOD, 'chore: delegate', 'Risk: R3', { 'process.config.json': mid.json(mid.withMode(true)) });
  mid.commit(AFTER, 'chore: undelegate', 'Risk: R3', { 'process.config.json': mid.json(mid.withMode(false)) });
  const r2 = mid.needed();
  check('period-needed: 期間の途中で委任をやめた構成(起点の時点も現在も委任なし)→ needed=true', r2.status === 0 && r2.needed === 'true', `${r2.status} ${r2.needed} ${r2.out.slice(-200)}`);
  mid.done();

  const tr = workspace({ delegated: false });
  tr.commit(IN_PERIOD, 'feat: x', 'Risk: R3\nDelegated: rule-1', { 'src/a.js': 'export const a = 1;\n' });
  const r3 = tr.needed();
  check('period-needed: 構成は委任なしでも、期間中のトレーラ Delegated があれば needed=true', r3.status === 0 && r3.needed === 'true', `${r3.status} ${r3.needed}`);
  tr.done();
}

// assurance-period.yml の結線
{
  const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'assurance-period.yml'), 'utf8').replace(/\r\n/g, '\n');
  const stepBlocks = WF.split(/\n(?=      - )/).filter((b) => /^ {6}- /.test(b));
  const stepNamed = (name) => stepBlocks.find((b) => b.includes(`- name: ${name}`)) ?? '';
  const bodyOf = (block) => {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
    if (i < 0) return null;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') body.push('');
      else if (lines[j].startsWith('          ')) body.push(lines[j].slice(10));
      else break;
    }
    return body.join('\n');
  };
  const agg = stepNamed('期間の保証の開示を集約する');
  const needed = stepNamed('期間の開示が要るかを判定する');
  check('workflow: 集約の手順は steps.needed.outputs.needed == \'true\' のときだけ動く', /^ {8}if: steps\.needed\.outputs\.needed == 'true'$/m.test(agg), agg);
  check('workflow: 集約の手順は --period-from / --period-to を渡す', /aggregate-evidence\.mjs --period-from "\$PERIOD_FROM" --period-to "\$PERIOD_TO"/.test(agg));
  check('workflow: period-needed の手順は id: needed で、期間を渡す', /id: needed/.test(needed) && /period-needed\.mjs --period-from "\$PERIOD_FROM" --period-to "\$PERIOD_TO"/.test(needed));
  const runLines = (b) => b.split('\n').filter((l) => /^ {8}run:/.test(l));
  check('workflow: 集約の run は node scripts/gate/aggregate-evidence.mjs --period-from/--period-to の形と完全一致する(||・;・&& を足して失敗を握りつぶさない)', runLines(agg).length === 1 && /^ {8}run: node scripts\/gate\/aggregate-evidence\.mjs --period-from "\$PERIOD_FROM" --period-to "\$PERIOD_TO"$/.test(runLines(agg)[0]), JSON.stringify(runLines(agg)));
  check('workflow: period-needed の run も完全一致する', runLines(needed).length === 1 && /^ {8}run: node scripts\/gate\/period-needed\.mjs --period-from "\$PERIOD_FROM" --period-to "\$PERIOD_TO"$/.test(runLines(needed)[0]), JSON.stringify(runLines(needed)));
  check('workflow: `|| true` が無い(集約と period-needed の失敗を握りつぶさない)', !/\|\|\s*true/.test(agg) && !/\|\|\s*true/.test(needed) && !/\|\|\s*true/.test(WF.replace(/^\s*#.*$/gm, '')));
  check('workflow: continue-on-error が無い', !/continue-on-error/.test(WF.replace(/^\s*#.*$/gm, '')));
  check('workflow: on.schedule に cron がある', /^on:\n {2}schedule:\n {4}- cron: '[^']+'/m.test(WF));
  check('workflow: on.workflow_dispatch がある', /^ {2}workflow_dispatch:/m.test(WF));
  check('workflow: permissions に checks: read', /^permissions:\n(?: {2}.*\n)*? {2}checks: read$/m.test(WF));

  const body = bodyOf(stepNamed('期間を決める'));
  check('workflow: 「期間を決める」の run を取り出せる', Boolean(body), 'run が見つからない');
  const bash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (body && process.platform !== 'win32' && bash.status === 0) {
    const go = (env) => {
      const out = path.join(os.tmpdir(), `period-range-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(out, '');
      const r = spawnSync('bash', ['-e', '-c', body], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', GITHUB_OUTPUT: out, ...env } });
      const text = fs.readFileSync(out, 'utf8');
      fs.rmSync(out, { force: true });
      return { status: r.status, text, msg: `${r.stdout}${r.stderr}` };
    };
    for (const bad of ['abc', '2026-1-01', '2026-10-01; echo x']) {
      const r = go({ IN_FROM: bad, IN_TO: '2026-10-31' });
      check(`workflow: 不正な起点「${bad}」→ 終了コード 2、出力へ書かない`, r.status === 2 && !/from=/.test(r.text), `${r.status} ${r.msg}`);
    }
    const rt = go({ IN_FROM: '2026-10-01', IN_TO: 'xyz' });
    check('workflow: 不正な終点 → 終了コード 2', rt.status === 2, String(rt.status));
    const given = go({ IN_FROM: FROM, IN_TO: TO });
    check('workflow: 指定した期間はそのまま出力へ書く', given.status === 0 && given.text.includes(`from=${FROM}`) && given.text.includes(`to=${TO}`), given.text);
    const dflt = go({ IN_FROM: '', IN_TO: '' });
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
    check('workflow: 省略すると前月の1日と末日(UTC)', dflt.status === 0 && dflt.text.includes(`from=${first}`) && dflt.text.includes(`to=${last}`), `${dflt.text} / 期待 ${first} ${last}`);
  } else {
    console.log('SKIP 「期間を決める」の run を bash で動かす確認(Windows など bash の無い環境。CI の ubuntu-latest で動く)');
  }
}

console.log('');
if (failures) {
  console.log(`委任の期間ごとの保証の開示の通しの試験: ${failures} / ${checks} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`委任の期間ごとの保証の開示の通しの試験: ${checks} 件が期待と一致しました`);

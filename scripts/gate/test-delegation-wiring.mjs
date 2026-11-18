// 委任の停止と案件の登録の結線の試験(process-compass #448 / 束 B20 の独立の突合 1巡目 R1-04・R1-13)。
//
//   node scripts/gate/test-delegation-wiring.mjs
//
// IMPL-0919: D-0 表10 の F.2 の Q1 を判定のたびに読み、「いいえ」と読めないときは委任を止める。単体の試験は Q1 の値を引数で渡した関数だけを見るので、
// 実物の D-0 を置いた使い捨てのリポジトリで、(1) 記録の読み(readAutonomyRecords)から停止の判定(autonomyState)まで、(2) /process-change の入口
// (generate-profile.mjs --change --dry-run)の登録の拒否、(3) D-0 の表の生成(applyD0Sections)、(4) 生成区間の検査(d0SectionProblems)を通す。
// IMPL-0883: 案件の登録の検査(check-g1.mjs)で、G-1 通過済みの案件が注意の分岐(警告)に届き、G-1 の前は失敗になる。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { makeRepo, buildCfg, checker } from './e2e-fixture.mjs';
import { readAutonomyRecords, autonomyState } from './autonomy.mjs';
import { applyD0Sections, d0SectionProblems } from '../init/generate-profile.mjs';

const { check, finish } = checker();
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/gate/fixtures/delegation-eligible.json'), 'utf8'));

const BASIS = {
  detection: { rejectionRate: 'docs/metrics/q3.md(差し戻しの件数から算出)', reworkRate: 'docs/metrics/q3.md(14日以内の書き換えの行数から算出)' },
  rollback: 'docs/rollback/2026-09.md(文言の取り消しを3回実行)',
  tests: 'tests/i18n/*.spec.ts が全キーの表示を確かめる',
};
const REGISTER = (day) => ({ kind: 'mode', summary: '変更種別の登録', delegation: { changeTypes: [{ id: '表示文言', registeredBy: '名簿 戊', registeredAt: day, basis: BASIS }] }, decidedBy: '名簿 戊', reason: '表示文言を登録する' });
const REFUSAL = /変更種別の登録は L3 の適用であり、止める案件では登録しない/;

// D-0 の Q1 の記入ごとの場面。stop は委任が止まるべきか
const CASES = [
  { label: 'はい', q1: 'はい。人身への危害が生じうる制御を含む', d0: true, stop: true },
  { label: '未定', q1: '未定', d0: true, stop: true },
  { label: '様式のまま(未記入)', q1: null, d0: true, stop: true },
  { label: 'D-0 が無い', q1: null, d0: false, stop: true },
  { label: 'いいえ', q1: 'いいえ。人身への危害は生じない', d0: true, stop: false },
];

const r = makeRepo({ config: buildCfg({}, { stack: 'node' }) });
const day = new Date().toISOString().slice(0, 10);
for (const c of CASES) {
  r.resetTo('base');
  if (c.d0) r.setD0Q1(c.q1);
  else fs.rmSync(r.abs('docs/D-0-governance.md'), { force: true });
  const cfg = JSON.parse(JSON.stringify(FIXTURE.config));
  // (1) 記録の読み → 停止の判定
  const records = readAutonomyRecords({ config: cfg, root: r.dir, fetch: false });
  const st = autonomyState(cfg, records);
  const stopped = st.types.length > 0 && st.types.every((t) => t.stops.some((s) => s.kind === 'safety-part'));
  const tag = c.stop ? 'IMPL-0919:ng' : 'IMPL-0919:ok';
  check(`${tag} 結線(${c.label}): readAutonomyRecords が D-0 の Q1 を読み、autonomyState が安全関連部で${c.stop ? '止める' : '止めない'}`, c.stop ? stopped : st.types.length > 0 && st.types.every((t) => !t.stops.some((s) => s.kind === 'safety-part')), JSON.stringify(st.types.map((t) => t.stops.map((s) => s.kind))));
  // (2) /process-change の入口(--change --dry-run)の登録の拒否
  const ch = r.runChange(REGISTER(day), { dryRun: true });
  check(`${tag} 結線(${c.label}): /process-change の登録は${c.stop ? '拒否される' : '安全関連部では拒否されない'}`, c.stop ? !ch.ok && REFUSAL.test(ch.out) : !REFUSAL.test(ch.out), ch.out.slice(-400));
  // (3) D-0 の表の生成: 登録した変更種別の行の段階
  const text = c.d0 ? r.read('docs/D-0-governance.md') : r.read('templates/00-d0-governance.md');
  const applied = applyD0Sections(text, cfg).text ?? applyD0Sections(text, cfg);
  const rowLevels = String(applied).split('\n').filter((l) => /^\| 登録した変更種別 /.test(l)).map((l) => l.split('|')[2].trim());
  check(`${tag} 結線(${c.label}): applyD0Sections の表の登録した変更種別は${c.stop ? ' L1' : ' L3'}`, rowLevels.length > 0 && rowLevels.every((l) => (c.stop ? /^L1/.test(l) : /^L3/.test(l))), rowLevels.join(' / '));
  check(`${tag} 結線(${c.label}): D-0 の表に、安全関連部で登録を適用しない理由の行が${c.stop ? '出る' : '出ない'}`, /^- 安全関連部: /m.test(String(applied)) === c.stop, String(applied).split('\n').filter((l) => /安全関連部/.test(l)).join('\n').slice(0, 200));
  // (4) 生成区間の検査: いいえで生成した区間(L3 の表)は、Q1 が止める回答のとき食い違いとして検出される
  const generatedUnderNo = String(applyD0Sections(text.replace(/(\| 附属書F F\.2 の回答 \|)[^\n]*/, '$1 いいえ。人身への危害は生じない |'), cfg).text ?? applyD0Sections(text.replace(/(\| 附属書F F\.2 の回答 \|)[^\n]*/, '$1 いいえ。人身への危害は生じない |'), cfg));
  const withQ1 = c.d0 ? (c.q1 === null ? generatedUnderNo.replace(/(\| 附属書F F\.2 の回答 \|)[^\n]*/, '$1 |') : generatedUnderNo.replace(/(\| 附属書F F\.2 の回答 \|)[^\n]*/, `$1 ${c.q1} |`)) : null;
  if (withQ1 !== null) {
    const probs = d0SectionProblems(withQ1, cfg);
    check(`${tag} 結線(${c.label}): d0SectionProblems は L3 の表を${c.stop ? '食い違いとして検出する' : '一致として受け付ける'}`, c.stop ? probs.length > 0 && probs.some((p) => /構成.*と一致しません/.test(p)) : probs.length === 0, probs.join('\n').slice(0, 300));
  }
}
r.done();

// ---------------------------------------------------------------- IMPL-0883(案件の登録。G-1 通過済みは警告、G-1 の前は失敗)
{
  const w = makeRepo({ config: buildCfg({}, { stack: 'node' }) });
  const brief = (id) => `---\nproject_id: ${id}\nversion: 1\napprover: 承認 太郎\nstatus: draft\n---\n\n${w.read('templates/06-project-brief.md')}`;
  const cfg = w.readJson('process.config.json');
  cfg.projectId = 'P-001';
  w.writeConfig(cfg);
  w.write('docs/project-brief.md', brief('P-001'));
  const g1 = () => w.node('scripts/gate/check-g1.mjs');
  const MSG = /案件の記録 context\/projects\/P-001\.md がありません/;
  const classify = (out) => ({
    error: out.split('\n').some((l) => /^::error/.test(l) && MSG.test(l)),
    warning: out.split('\n').some((l) => /^::warning/.test(l) && MSG.test(l)),
    any: MSG.test(out),
  });
  const before = classify(g1().out);
  check('IMPL-0883:ng 結線: G-1 の前に案件の記録が無ければ、エラー(失敗)として出る', before.any && before.error && !before.warning, g1().out.slice(-400));
  w.write('docs/gates/g1.md', ['# ゲート判定記録', '', '| 項目 | 値 |', '| --- | --- |', '| ゲート | G-1 企画承認 |', '| 対象 | P-001 |', '| 判定者 | 名簿 戊 |', '| 判定日時 | 2026-11-04 10:00 |', '| 結果 | 通過 |', ''].join('\n'));
  const after = classify(g1().out);
  check('IMPL-0883:ok 結線: G-1 通過済みの案件では、同じ不在が警告として出て、エラーにならない', after.any && after.warning && !after.error, g1().out.slice(-400));
  w.write('context/projects/P-001.md', '# 案件\n');
  check('IMPL-0883:ok 結線: 記録があれば、どちらの指摘も出ない', !classify(g1().out).any);
  w.done();
}

finish();

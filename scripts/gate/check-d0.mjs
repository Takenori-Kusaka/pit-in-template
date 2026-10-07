// D-0(意思決定・エスカレーション体制図)の前提条件を検査する。
//
//   node scripts/gate/check-d0.mjs
//
// D-0 は規模によらず必須で、企画承認(G-1)の前提条件です。
// 未承認・期限切れの状態では、G-1 の審議を開始できません。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT, fail, notice, warn, chainStarted, structureDeciderSeat, structureDeciderLabel, personName, resolveSigner } from './config.mjs';
import { d0SectionProblems, d0GovernanceProblems, d0OptionalSectionProblems, D0_VERSION_FORMAT } from '../init/generate-profile.mjs';
import { readPolicy, continuityState } from './org-assurance.mjs';

const config = loadConfig();
const D0 = path.join(ROOT, 'docs/D-0-governance.md');

if (config.configured === false) {
  notice('プロセス構成が未設定のため、D-0 の検査は実施しません');
  process.exit(0);
}

if (!fs.existsSync(D0)) {
  fail(
    'docs/D-0-governance.md がありません。templates/00-d0-governance.md を写して作成してください。' +
      '責任者の表・担い手と運用形態・改訂履歴(生成区間)は、`node scripts/init/generate-profile.mjs --answers process.config.json` と /process-change が書き込みます'
  );
  process.exit(1);
}

const text = fs.readFileSync(D0, 'utf8');
const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!m) {
  fail('D-0 に frontmatter がありません');
  process.exit(1);
}

/** 依存パッケージを持たないため、frontmatter は key: value の平坦な形だけを読む */
const fm = {};
const noSpace = [];
for (const line of m[1].split(/\r?\n/)) {
  const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
  if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  // `approver:氏名`(コロンの後に空白が無い)は、ここでは読めるが YAML の鍵と値にならない。生成側は空白を置く(#288 第5巡 J の付記)
  if (kv && kv[2] && /^[a-z_]+:\S/i.test(line)) noSpace.push(kv[1]);
}

const problems = [];
for (const k of ['project_id', 'version', 'approver', 'approved_at', 'approval_scope', 'next_review']) {
  if (!fm[k]) problems.push(`frontmatter の ${k} が空です`);
}
if (noSpace.length) warn(`frontmatter の ${noSpace.join('・')} は、コロンの後に空白がありません(YAML として読めない書き方)。「key: 値」の形に直してください`);

// 承認者(approver)は D-0 の承認権限者、すなわち表1「体制と運用形態」の決定者の席の責任者である(標準 第6章 テンプレ0)。
// 変化点の決定者は節13 の列と last_change_decided_by にある。承認者が決定者の席の責任者と一致しない D-0 は、
// /process-change が書いた D-0(last_change_decided_by を持つ)では失敗、旧い様式では注意にとどめる(#288 第5巡 J)
{
  const deciderSeat = (config.seats ?? []).find((s) => s.role === structureDeciderSeat(config));
  const decider = deciderSeat?.accountable ? personName(config, deciderSeat.accountable) : null;
  const approverPerson = fm.approver ? resolveSigner(config, fm.approver) : null;
  if (decider && fm.approver && (!approverPerson || approverPerson.name !== decider)) {
    const msg =
      `frontmatter の approver(${fm.approver})が、表1「体制と運用形態」の決定者の席の責任者(${decider}。D-0 の承認権限者。${structureDeciderLabel(config)})と一致しません。` +
      '承認者は変化点の決定者の氏名ではなく、D-0 の承認権限者です。変化点の決定者は節13 と last_change_decided_by に残ります。次の /process-change で生成し直すか、approver を承認権限者に直してください';
    if (fm.last_change_decided_by !== undefined) problems.push(msg);
    else warn(`${msg}(旧い様式のため注意にとどめています。last_change_decided_by の行を持つ D-0 では失敗します)`);
  }
}

if (fm.next_review) {
  const due = Date.parse(fm.next_review);
  if (Number.isNaN(due)) problems.push(`next_review "${fm.next_review}" を日付として読めません`);
  else if (due < Date.now()) problems.push(`next_review ${fm.next_review} が過ぎています。体制図の見直しを行ってください`);
}

// 版の形式は N.N に限る(構成を生成する側と同じ検査。1.0.0・v1.1 は前後を比べられない)
if (fm.version && !D0_VERSION_FORMAT.test(fm.version)) {
  problems.push(`frontmatter の version "${fm.version}" は、版の形式(N.N。例: 1.3)ではありません`);
}

// 構成が追随している D-0 の版とのずれ(標準 第3章 3.13.5)。D-0 を改訂したら、
// 最初のゲート判定より前に構成を再生成する。ずれたままの構成は、改訂前の体制で判定させる
if (fm.version && config.d0Version && String(config.d0Version) !== fm.version) {
  problems.push(
    `D-0 の版(${fm.version})と、構成が追随している版(${config.d0Version})が一致しません。` +
      '体制の変化点として /process-change で構成を再生成してください'
  );
} else if (fm.version && !config.d0Version) {
  warn(
    '構成が D-0 の版に追随していません(d0Version が未取得)。D-0 を作成した直後は、`node scripts/init/generate-profile.mjs --answers process.config.json` を実行すると、版を取得し、生成区間を書き込みます。席の責任者と人の名簿は /process-change(種別 accountable)で反映します'
  );
}

// 生成区間(席・責任者・担い手・運用形態の表、委任の範囲、改訂履歴)が、構成と一致するか。
// 構成から導ける欄は /process-change が書く。構成を正とし、体制図との二重記入を無くす。
// D-0 を改訂せずに変化点を適用した状態と、D-0 だけを手で書き換えた状態を、ここで検出する。
// 要約値の連鎖を持たない旧い構成は、最初の /process-change までは注意にとどめる
const generated = [...d0SectionProblems(text, config), ...d0GovernanceProblems(text, config)];
if (chainStarted(config)) problems.push(...generated);
else for (const p of generated) warn(`${p}(旧い構成のため注意にとどめています。最初の /process-change の後は失敗します)`);

// 節9 の「席の責任者本人の力量の確認」の生成区間(第3章 3.4.3 要求事項1。#288 第6巡 R)。目印の無い旧い様式は注意にとどめ、
// 目印があって構成と一致しない体制図は、ほかの生成区間と同じ扱い
{
  const opt = d0OptionalSectionProblems(text, config);
  if (opt.missing.length) {
    warn(
      'D-0 の節9 に「席の責任者本人の力量の確認」の生成区間の目印(<!-- generated:d0-competence start --> / end)がありません(第6巡より前の様式)。' +
        'templates/00-d0-governance.md の節9 から目印の行を写し、`node scripts/init/generate-profile.mjs --answers process.config.json` で区間を書き込んでください。' +
        '目印が無いあいだも、出荷の証跡の集約と next.mjs は構成(seats[].competence)から未確認・失効を出します'
    );
  }
  if (chainStarted(config)) problems.push(...opt.problems);
  else for (const p of opt.problems) warn(`${p}(旧い構成のため注意にとどめています)`);
}

// 案件 ID(frontmatter の project_id)と構成(projectId)の一致(#288 第6巡 P)。生成側が様式の初期値を構成の値で埋める。
// 人が別の値を書いた D-0 は上書きされないため、ここで注意を出す(失敗にはしない。CLAUDE.md・判定記録が指す案件 ID は構成の値)
if (fm.project_id && config.projectId && fm.project_id !== String(config.projectId)) {
  warn(`frontmatter の project_id(${fm.project_id})が、構成の案件 ID(${config.projectId})と一致しません。CLAUDE.md と構成書が指す案件 ID は構成の値です。D-0 を直すか、構成を種別 settings の projectId で改めてください`);
}

// 本文の表に空欄が残っていないか(| — | や | | を空欄とみなす)
const emptyCells = text
  .split(/\r?\n/)
  .filter((l) => /^\|/.test(l) && /\|\s*(TBD|未定|\?\?\?)\s*\|/i.test(l));
if (emptyCells.length) {
  problems.push(`本文に未記入の欄が ${emptyCells.length} 件あります(TBD / 未定 / ???)`);
}

// 有事の決定者(節7 の4つの事象 × 3つの決定)の空欄は記載の欠落(標準 第6章 テンプレ0「有事の決定者を決めておく」)。
// G-1 の前提条件は止めず、出荷判定(G-7)の基準9 で差し戻される旨を表示する。止めるのは出荷の証跡の集約である
{
  const ct = continuityState(config, readPolicy(config));
  if (ct.emergencyMissing.length) {
    warn(
      `D-0 節7 の有事の決定者に空欄が ${ct.emergencyMissing.length} 欄あります(${ct.emergencyMissing.slice(0, 4).join(' / ')}${ct.emergencyMissing.length > 4 ? ' ほか' : ''})。` +
        '記載の欠落として、出荷判定の証跡の集約が失敗させます(G-7 の基準9)。該当しない事象は「層1 の項目4 による」と書く'
    );
  }
}

// 出荷できない状態は、体制図の検査でも表示する(体制が最小体制を割っている)
if (config.shipBlocked) warn(`出荷できない状態です(${config.shipBlocked.since} から): ${config.shipBlocked.reason}`);

for (const p of problems) fail(p);
if (problems.length) {
  console.log('');
  console.log('D-0 が承認済みでない状態では、企画承認(G-1)の審議を開始できません');
  process.exit(1);
}

const days = Math.round((Date.parse(fm.next_review) - Date.now()) / 86400000);
if (days < 30) warn(`D-0 の見直し期限まで ${days} 日です`);
notice(`D-0 は承認済みです(承認者: ${fm.approver}${fm.last_change_decided_by ? ` / 最後の変化点の決定者: ${fm.last_change_decided_by}` : ''} / 見直し: ${fm.next_review})`);

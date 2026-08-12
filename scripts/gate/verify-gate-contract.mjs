// プロセス構成と、実際の CI・ブランチ保護・アダプタの整合を検査する。
//
//   node scripts/gate/verify-gate-contract.mjs
//
// テンプレートが「設定したつもり」で運用されることを防ぐための検査です。
// 構成ファイルに書いた要求が、実際の設定に現れていなければ失敗させます。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadAdapter, ROOT, fail, warn, notice } from './config.mjs';

const config = loadConfig();
const problems = [];
const notes = [];

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// ---------------------------------------------------------- 未設定の扱い

if (config.configured === false) {
  notice('プロセス構成が未設定です。Claude Code で /process-init を実行してください');
  notice('未設定のあいだ、契約検査は構成の妥当性を判定しません');
  process.exit(0);
}

// ---------------------------------------------------------- 1. 状態の値

const VALID = /^(required|simplified|omitted|unmet|merged-into-g[1-8])$/;
for (const [key, g] of Object.entries(config.gates ?? {})) {
  if (!VALID.test(g.state)) {
    problems.push(`${key}: 状態 "${g.state}" は不正です。required / simplified / omitted / unmet / merged-into-gN のいずれかにしてください`);
  }
}

// G-4 と G-5 はどの構成でも省略できない(附属書A / 第2章 2.5)
for (const key of ['g4', 'g5']) {
  const s = config.gates?.[key]?.state;
  if (s !== 'required' && s !== 'simplified') {
    problems.push(`${key} は、どの事業ステージでも省略できません(現在: ${s})`);
  }
}

// ---------------------------------------------------------- 2. 未達の整合

for (const u of config.unmet ?? []) {
  const s = config.gates?.[u.gate]?.state;
  if (s !== 'unmet') {
    problems.push(
      `unmet に ${u.gate} があるのに、gates.${u.gate}.state が "${s}" です。未達は省略と区別して記録してください`
    );
  }
  if (!u.reason) problems.push(`unmet の ${u.gate} に reason がありません`);
  if (!u.reviewSourcing) {
    notes.push(
      `${u.gate}(${u.label ?? ''}) の外部レビューの調達先が未記入です。この状態は出荷判定の証跡にも残ります`
    );
  }
}
for (const [key, g] of Object.entries(config.gates ?? {})) {
  if (g.state === 'unmet' && !(config.unmet ?? []).some((u) => u.gate === key)) {
    problems.push(`gates.${key} が unmet ですが、unmet[] に理由の記録がありません`);
  }
}

// -------------------------------------------------- 2.5 代償措置つきの逸脱

// 逸脱はゲートを実施したうえで属性を欠く状態のため、state は required のままになる。
// 「逸脱の記録を消して普通の required に見せる」書き換えを検出する(第3章 3.5.2 / ADR-0029)
for (const d of config.deviations ?? []) {
  const s = config.gates?.[d.gate]?.state;
  if (s !== 'required') {
    problems.push(
      `deviations に ${d.gate} があるのに、gates.${d.gate}.state が "${s}" です。逸脱は実施を伴います`
    );
  }
  if (!d.reason) problems.push(`deviations の ${d.gate} に reason がありません`);
  if (!(d.compensation ?? []).length) {
    problems.push(`deviations の ${d.gate} に代償措置がありません。代償措置のない逸脱は認められません`);
  }
  if (!d.resolveWhen) problems.push(`deviations の ${d.gate} に解消の時点(resolveWhen)がありません`);
}
if (
  config.gates?.g7?.params?.approverMode === 'value-owner-merged' &&
  !(config.deviations ?? []).some((d) => d.gate === 'g7')
) {
  problems.push(
    'G-7 の判定者が価値責任者との兼務ですが、deviations[] に逸脱の記録がありません(第3章 3.5.2)'
  );
}

// ---------------------------------------------------------- 3. 不変条件

const a = config.answers ?? {};
if (a['q-team-size'] === 'size-1-2' && ['cl1', 'cl2', 'cl3'].includes(a['q-criticality'])) {
  problems.push('安全重要度 CL1 以上を 1〜2名の体制で扱う構成は認められません(第8章 軸E)');
}
if (a['q-team-size'] === 'size-1-2' && a['q-quality'] === 'quality-regulated') {
  problems.push('規制業を 1〜2名の体制で扱う構成は認められません(第8章 軸A)');
}
if (a['q-criticality'] === 'cl3' && (config.review?.reviewerCount ?? 0) < 2) {
  problems.push('CL3 では独立レビューを2名で行います(第8章 軸E)');
}

// ---------------------------------------------------------- 4. AI レビュー

if (config.aiReview?.canApprove) {
  problems.push('aiReview.canApprove を true にできません。AI を独立レビュアの代替に置かない規定によります');
}
if (config.aiReview?.requiredCheck) {
  problems.push(
    'aiReview.requiredCheck を true にできません。AI の判定を合否条件にすると自動化バイアスを招きます'
  );
}

// ---------------------------------------------------------- 5. アダプタ

let adapter = null;
try {
  adapter = loadAdapter(config);
} catch (e) {
  problems.push(e.message);
}

if (adapter) {
  const testCmd = (adapter.commands?.test ?? '').trim();
  if (!testCmd) {
    problems.push(
      `アダプタ ${adapter.id} の "test" が空です。G-5 は全テストの通過を合否条件にするため、` +
        '実行するコマンドが必要です。adapters/ のファイルへ書いてください'
    );
  }
  if (!(adapter.commands?.licenses ?? '').trim()) {
    notes.push(`アダプタ ${adapter.id} の "licenses" が空です。依存関係のライセンス検査を実施しない扱いになります`);
  }
  if (!(adapter.commands?.secretScan ?? '').trim()) {
    notes.push(
      `アダプタ ${adapter.id} の "secretScan" が空です。秘匿情報の検査は台帳記録による通過を認めない唯一の基準のため、別の手段で実施してください`
    );
  }
}

// ---------------------------------------------------------- 6. CI の設定

const g5wf = read('.github/workflows/gate-g5.yml');
if (config.gates?.g5?.state !== 'omitted') {
  if (!g5wf) {
    problems.push('gate-g5 が有効ですが .github/workflows/gate-g5.yml がありません');
  } else if (!/^\s{2}gate-g5:/m.test(g5wf)) {
    problems.push('gate-g5.yml に集約ジョブ "gate-g5" がありません。必須ステータスチェックの名前は gate-g5 に固定です');
  }
}

// ---------------------------------------------------------- 7. ブランチ保護

const rulesetDir = path.join(ROOT, '.github/rulesets');
const rulesets = fs.existsSync(rulesetDir)
  ? fs.readdirSync(rulesetDir).filter((f) => f.endsWith('.json'))
  : [];
const activeRuleset = rulesets
  .map((f) => JSON.parse(fs.readFileSync(path.join(rulesetDir, f), 'utf8')))
  .find((r) => r.name === config.ruleset);

if (config.gates?.g6?.state === 'required') {
  if (!config.ruleset) {
    problems.push(
      'G-6 が有効ですが、適用するブランチ保護(config.ruleset)が指定されていません。' +
        '作成者の自己承認を止める設定は強制層に置く必要があります'
    );
  } else if (!activeRuleset) {
    problems.push(`config.ruleset "${config.ruleset}" に一致するルールセットが .github/rulesets にありません`);
  } else {
    const pr = (activeRuleset.rules ?? []).find((r) => r.type === 'pull_request');
    const count = pr?.parameters?.required_approving_review_count ?? 0;
    if (count < Math.max(1, config.review?.requiredApprovals ?? 1)) {
      problems.push(
        `G-6 は承認 ${config.review?.requiredApprovals} 件を要求しますが、ルールセットは ${count} 件です`
      );
    }
    if (pr?.parameters?.require_last_push_approval !== true) {
      problems.push(
        'ルールセットの require_last_push_approval が true ではありません。最後に push した本人の承認を無効化する設定です'
      );
    }
    const checks = (activeRuleset.rules ?? []).find((r) => r.type === 'required_status_checks');
    const names = (checks?.parameters?.required_status_checks ?? []).map((c) => c.context);
    if (!names.includes('gate-g5')) {
      problems.push('ルールセットの必須ステータスチェックに gate-g5 が含まれていません');
    }
  }
} else if (config.gates?.g6?.state === 'unmet') {
  notes.push('G-6 は未達です。ブランチ保護による承認の強制は行いません');
}

// ---------------------------------------------------------- 出力

for (const n of notes) warn(n);
for (const p of problems) fail(p);

if (problems.length) {
  console.log('');
  console.log(`契約検査: ${problems.length} 件の不整合があります`);
  process.exit(1);
}
console.log(`契約検査: 整合しています(注意 ${notes.length} 件)`);

// 回答からプロセス構成を導出し、PROCESS-PROFILE.md と process.config.json を書き出す。
//
//   node scripts/init/generate-profile.mjs --answers answers.json [--stack node] [--project-id P-001] [--dry-run]
//
// answers.json の例:
//   {
//     "q-team-size": "size-1-2",
//     "q-biz-phase": "poc",
//     "q-quality": "quality-standard",
//     "q-criticality": "cl0",
//     "q-dev-form": "inhouse",
//     "q-external-reviewer": "reviewer-no",
//     "q-existing-gates": "gates-none",
//     "q-ai-constraint": "ai-free"
//   }
//
// 依存パッケージなし。Node 22 以上で動く。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, visibleQuestions } from '../vendor/tailoring-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KB = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/vendor/tailoring-kb.json'), 'utf8'));

/** engine のゲート id → 構成ファイルの短縮キー */
const GATE_KEY = Object.fromEntries(KB.gates.map((g) => [g.id, g.label.replace('-', '').toLowerCase()]));
const GATE_BY_KEY = Object.fromEntries(KB.gates.map((g) => [GATE_KEY[g.id], g]));

/** どの構成でも省略できないゲート(附属書A / 第2章 2.5) */
const NEVER_OMITTABLE = new Set(['g4', 'g5']);

/** engine の state → 構成ファイルのゲート状態 */
function toGateState(state) {
  if (!state || state === 'standard' || state === 'strengthen') return 'required';
  if (state === 'simplify') return 'simplified';
  if (state === 'omit') return 'omitted';
  if (state.startsWith('merged-into:')) {
    const target = state.slice('merged-into:'.length);
    return `merged-into-${GATE_KEY[target] ?? target}`;
  }
  return 'required';
}

function readAnswers(argv) {
  const i = argv.indexOf('--answers');
  if (i < 0) throw new Error('--answers <file> が必要です');
  const raw = JSON.parse(fs.readFileSync(argv[i + 1], 'utf8'));
  return raw.answers ?? raw;
}

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

function labelOf(qid, oid) {
  const q = KB.questions.find((x) => x.id === qid);
  const o = q?.options.find((x) => x.id === oid);
  return o ? o.label : oid;
}

/**
 * 不変条件の検査。テーラリングで外してはならない条件に触れる回答を拒否する。
 * 標準の禁止事項(第8章)と constraints.yaml に対応する。
 */
export function checkConstraints(answers) {
  const errors = [];
  const size = answers['q-team-size'];
  const cl = answers['q-criticality'];
  const quality = answers['q-quality'];

  if (size === 'size-1-2' && ['cl1', 'cl2', 'cl3'].includes(cl)) {
    errors.push(
      `安全重要度 ${cl.toUpperCase()} を 1〜2名の体制で扱えません。危害の深刻度は体制の都合で下がりません。` +
        '外部の評価者を含めて体制を確保するか、当該の機能を実施しないかの二択です(第8章 軸E)。'
    );
  }
  if (size === 'size-1-2' && quality === 'quality-regulated') {
    errors.push(
      '規制業では判定の時点そのものが監査要件になるため、1〜2名の体制で成立しません(第8章 軸A)。'
    );
  }
  if (['cl2', 'cl3'].includes(cl) && answers['q-ai-constraint'] === 'ai-unavailable') {
    errors.push('AI を利用しない構成では、本テンプレートの前提が成立しません。');
  }
  return errors;
}

/**
 * 未達(unmet)の判定。
 *
 * 独立レビュー(G-6)は、作成を指示した本人以外が挙動を確認することを求める。
 * 1〜2名で外部のレビュアがいない場合、この条件を満たす構成が存在しない。
 * 標準は AI を独立レビュアの代替に置くことを認めないため、省略ではなく未達として扱う。
 */
export function detectUnmet(answers, gates, stack) {
  const unmet = [];
  const noReviewer =
    answers['q-team-size'] === 'size-1-2' && answers['q-external-reviewer'] === 'reviewer-no';

  if (noReviewer && gates.g6.state === 'omitted') {
    gates.g6.state = 'unmet';
    unmet.push({
      gate: 'g6',
      label: 'G-6 独立レビュー',
      reason:
        '作成を指示した本人以外が挙動を確認する条件を満たす構成が存在しない(最小体制3名未満、かつ外部のレビュアが不在)',
      whyNotAi:
        '同一のモデルを用いる限り、エージェントを分けても事前学習の知識という共通の原因が残る。生成物の確認を生成器へ委ねる構成は自動化バイアスによって見落としを増やす',
      compensation: ['ci-strict', 'post-release-audit'],
      reviewSourcing: null,
      howToResolve: [
        'リポジトリを公開し、コミュニティのレビューを受ける',
        '他の個人開発者と相互レビューの取り決めをする',
        '有償のコードレビューを利用する',
        '体制が3名以上になったら /process-init を再実行する',
      ],
    });
  }

  if (stack === 'undetermined' && answers['q-biz-phase'] !== 'poc') {
    if (gates.g3) gates.g3.state = 'unmet';
    unmet.push({
      gate: 'g3',
      label: 'G-3 技術設計判断',
      reason: 'MVP構築（S1以降）フェーズに入っていますが、技術スタックが未確定（undetermined）のままです',
      whyNotAi: '技術スタックの決定および技術設計の判断は、AIに意思決定を委譲することができない極めて重要な設計・技術判断です。',
      compensation: [],
      reviewSourcing: null,
      howToResolve: [
        '技術的な検証（S0探索）を終え、採用する技術スタック（node, python, go, none）を決定する',
        '決定したアダプタスタックを process.config.json に反映し、generate-profile.mjs を再実行する',
      ],
    });
  }
  return unmet;
}

export function buildConfig(answers, opts = {}) {
  const errors = checkConstraints(answers);
  if (errors.length) {
    const e = new Error('不変条件に反する回答です');
    e.details = errors;
    throw e;
  }

  const result = evaluate(KB, answers);

  const gates = {};
  for (const g of KB.gates) {
    const key = GATE_KEY[g.id];
    const p = result.profile[`gate:${g.id}`];
    let state = toGateState(p?.state);
    if (NEVER_OMITTABLE.has(key) && state !== 'required' && state !== 'simplified') state = 'required';
    gates[key] = {
      label: `${g.label} ${g.name}`,
      approver: g.approver ?? null,
      state,
      params: p?.params ?? {},
      why: (p?.notes ?? []).filter(Boolean),
    };
  }

  const unmet = detectUnmet(answers, gates, opts.stack ?? 'none');

  // CI の強度。g-ci に strengthen が乗った場合、既定値を引き上げる
  const ciStrengthened = result.profile['gate:g-ci']?.state === 'strengthen';
  const reviewerCount =
    gates.g6.params.reviewerCount ?? (gates.g6.state === 'required' ? 1 : 0);

  // 適用するブランチ保護。G-6 が有効な構成でのみ置く
  const strict =
    answers['q-quality'] === 'quality-regulated' ||
    ['cl2', 'cl3'].includes(answers['q-criticality']) ||
    reviewerCount >= 2;
  const ruleset = gates.g6.state === 'required' ? (strict ? 'regulated' : 'team') : null;

  const config = {
    schemaVersion: 0,
    configured: true,
    profileName: opts.profileName ?? null,
    projectId: opts.projectId ?? 'P-001',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    answers,
    answerLabels: Object.fromEntries(
      Object.entries(answers).map(([k, v]) => [k, labelOf(k, v)])
    ),
    adapters: { stack: opts.stack ?? 'none' },
    ruleset,
    gates,
    unmet,
    ci: {
      coverageThreshold: ciStrengthened ? 90 : 80,
      failOnSeverity: ['critical', 'high'],
      allowedLicenses: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'],
      strengthened: ciStrengthened,
    },
    review: {
      requiredApprovals: gates.g6.state === 'required' ? Math.max(1, reviewerCount) : 0,
      reviewerCount,
      mode: gates.g6.params.reviewMode ?? null,
      recordFormat: gates.g6.params.recordFormat ?? 'standard',
    },
    aiReview: { enabled: true, canApprove: false, requiredCheck: false },
    task: { maxChangedLines: 400, maxChangedFiles: 15, selfHealMaxIterations: 3 },
    matchedRuleIds: result.matchedRuleIds,
    warnings: result.warnings,
  };

  return { config, result };
}

// ---------------------------------------------------------------- 出力の整形

const STATE_LABEL = {
  required: '適用する',
  simplified: '簡略化して適用する',
  omitted: '適用しない',
  unmet: '**未達**',
};

function stateLabel(state) {
  if (state.startsWith('merged-into-')) {
    const t = state.slice('merged-into-'.length);
    return `${GATE_BY_KEY[t]?.label ?? t} へ統合する`;
  }
  return STATE_LABEL[state] ?? state;
}

export function renderProfileMd(config, result) {
  const L = [];
  const a = config.answerLabels;

  L.push('# プロセス構成書');
  L.push('');
  L.push('このファイルは `/process-init` が生成しました。**手での直接編集は行わず、調達先の記入は `node scripts/init/set-review-sourcing.mjs` を使用してください**。');
  L.push('構成を変えるときは `/process-init` を再実行してください。');
  L.push('');
  L.push(`- 案件 ID: \`${config.projectId}\``);
  L.push(`- 生成日時: ${config.generatedAt}`);
  L.push(`- 機械可読の構成: [\`process.config.json\`](./process.config.json)`);
  L.push('');

  // --- 未達(最上部に置く。隠す経路を持たない) ---
  if (config.unmet.length) {
    L.push('## 未達のゲート');
    L.push('');
    L.push('次のゲートは、**目的を達成する構成を示せていません**。省略ではありません。');
    L.push('');
    L.push('| ゲート | 未達の理由 | 代償措置 | 外部レビューの調達先 |');
    L.push('| --- | --- | --- | --- |');
    for (const u of config.unmet) {
      L.push(
        `| ${u.label} | ${u.reason} | ${u.compensation.join(' / ')} | ${u.reviewSourcing ?? '**未記入**'} |`
      );
    }
    L.push('');
    for (const u of config.unmet) {
      L.push(`### ${u.label} を AI で埋めない理由`);
      L.push('');
      L.push(u.whyNotAi);
      L.push('');
      L.push('埋める方法:');
      L.push('');
      for (const h of u.howToResolve) L.push(`- ${h}`);
      L.push('');
      L.push('調達先が決まったら、次のコマンドを実行して記入してください。');
      L.push('```bash');
      L.push(`node scripts/init/set-review-sourcing.mjs --gate ${u.gate} --sourcing "ここに調達先を記入"`);
      L.push('```');
      L.push('');
      L.push('未記入のまま運用している状態は、出荷判定の証跡にも残ります。');
      L.push('');
    }
  }

  // --- 事業ステージとステージ移行ゲート(SG) ---
  L.push('## 事業ステージとステージ移行ゲート(SG)');
  L.push('');
  L.push('標準プロセスには、開発の工程ゲート(G-1〜G-8)とは別に、投資継続を判断する**ステージ移行ゲート(SG-0〜SG-2)**が定義されています。');
  L.push('');
  L.push('| ステージ | 目的 | 移行ゲート | 対象とする状態 |');
  L.push('| --- | --- | --- | --- |');
  L.push('| **S0 探索** | 事業仮説と技術的実現性の検証 | **SG-0** | 技術的実現性が確認され、次ステージの投資・体制が示されている |');
  L.push('| **S1 構築** | 最初の顧客向け(MVP)の構築とビジネス検証 | **SG-1** | 期待効果の検証、初期顧客の獲得、継続的な開発体制の確立 |');
  L.push('| **S2 拡大・運用** | プロダクトの成長、組織拡大、安定運用 | **SG-2** | 投資対効果の最大化、非機能要件 of ... |');
  L.push('');

  const phase = config.answers['q-biz-phase'];
  L.push('### 現在のステージ判定と確認');
  L.push('');
  if (config.adapters.stack === 'undetermined') {
    L.push('> ⚠️ **警告: 開発技術スタックが未確定です。SG-0 (技術的実現性の確認)を通過するまでに、技術スタックを確定させ、アダプタを設定してください。**');
    L.push('');
  }
  if (phase === 'poc') {
    L.push('- **現在の想定ステージ**: `S0 探索` (検証中(PoC)段階)');
    L.push('- **目指すゲート**: **SG-0** (技術的実現性の確認)');
    L.push('- **確認事項**: PoCは使い捨てる前提で最速で学ぶ段階です。次の MVP 構築へ移る前に、必ず技術的実現性と事業仮説の検証を終え、SG-0 の判定を受けてください。');
  } else if (phase === 'mvp') {
    L.push('- **現在の想定ステージ**: `S1 構築` (最初の顧客向け(MVP)段階)');
    L.push('- **通過済みの前提**: **SG-0** (技術的実現性の確認)');
    L.push('- **目指すゲート**: **SG-1** (ビジネス実証)');
    L.push('- **注意**: 技術的実現性(採用技術が自社ドメインで実用精度を出すことなど)が未検証のまま MVP 工程に入ると、大きな手戻りリスクがあります。**「まだ一度も技術的実現性を検証していない(SG-0を通せる状態にない)」場合は、実態は S0 探索ステージです。** その場合、先に PoC(検証中) として `/process-init` を再実行し、SG-0 を目指すことを強く推奨します。');
  } else {
    L.push(`- **現在の想定ステージ**: \`S2 拡大・運用\` (${a['q-biz-phase'] || 'グロース/安定運用'} 段階)`);
    L.push('- **通過済みの前提**: **SG-1** (ビジネス実証)');
    L.push('- **目指すゲート**: **SG-2** (持続的な価値最大化)');
    L.push('- **注意**: すでに顧客へ価値が届き、ビジネスモデルが実証されている(SG-1通過済み)ことを想定しています。もし初期の顧客価値やリリース後の効果検証が未完了の場合は、まず \`S1 構築\` として MVP での検証を終える必要があります。');
  }
  L.push('');

  // --- ブロック1: 診断結果の要約 ---
  L.push('## あなたの状況');
  L.push('');
  L.push('| 軸 | 回答 |');
  L.push('| --- | --- |');
  L.push(`| A. チーム規模 | ${a['q-team-size']} |`);
  L.push(`| B. 事業ステージ | ${a['q-biz-phase']} |`);
  L.push(`| C. 期待品質・規制 | ${a['q-quality']} |`);
  L.push(`| D. 開発形態 | ${a['q-dev-form']} |`);
  L.push(`| E. 安全重要度 | ${a['q-criticality']} |`);
  if (a['q-external-reviewer']) L.push(`| 外部のレビュア | ${a['q-external-reviewer']} |`);
  L.push(`| 既存の承認ゲート | ${a['q-existing-gates']} |`);
  L.push(`| AI 利用の制約 | ${a['q-ai-constraint']} |`);
  L.push('');
  L.push('成熟度やスコアは出しません。評価ではなく構成の導出です。');
  L.push('');

  // --- ブロック2: 標準からの差分 ---
  L.push('## 標準からの差分');
  L.push('');
  L.push('標準どおりの項目も省かずに載せます。載っていない項目があると、検討したのか漏れたのかを区別できません。');
  L.push('');
  L.push('| ゲート | 判定 | 判定者 |');
  L.push('| --- | --- | --- |');
  for (const [key, g] of Object.entries(config.gates)) {
    L.push(`| ${g.label} | ${stateLabel(g.state)} | ${g.approver ?? '—'} |`);
  }
  L.push('');

  // --- ブロック3: 各判定の理由 ---
  L.push('## 各判定の理由');
  L.push('');
  for (const [key, g] of Object.entries(config.gates)) {
    if (!g.why.length && !Object.keys(g.params).length) continue;
    L.push(`### ${g.label}`);
    L.push('');
    for (const w of g.why) L.push(`- ${w}`);
    for (const [p, v] of Object.entries(g.params)) L.push(`- 設定: \`${p}\` = \`${v}\``);
    L.push('');
  }

  // --- ブロック4: 外せない下限 ---
  L.push('## 外せない下限');
  L.push('');
  L.push('どの構成でも、次は調整で外せません。');
  L.push('');
  for (const c of KB.constraints) L.push(`- **${c.name}** — ${c.description}`);
  L.push('');
  L.push('- **G-4(機能仕様承認)と G-5(自動検証)はどのステージでも省略できない**');
  L.push('');

  // --- CI の設定値 ---
  L.push('## CI の設定値');
  L.push('');
  L.push('| 項目 | 値 |');
  L.push('| --- | --- |');
  L.push(`| カバレッジの下限 | ${config.ci.coverageThreshold}% |`);
  L.push(`| 失敗させる重大度 | ${config.ci.failOnSeverity.join(' / ')} |`);
  L.push(`| 許可するライセンス | ${config.ci.allowedLicenses.join(', ')} |`);
  L.push(`| 必須の承認数 | ${config.review.requiredApprovals} |`);
  L.push(`| アダプタ | \`${config.adapters.stack}\` |`);
  L.push('');
  L.push(
    'カバレッジの下限は初期値です。**実測に基づく値ではありません**。企画承認(G-1)で自組織の値を定めて置き換えてください。'
  );
  L.push('');

  // --- ブロック5: 変更の手順 ---
  L.push('## 構成を変える');
  L.push('');
  L.push('- 体制・ステージが変わったら `/process-init` を再実行する');
  L.push('- **厳しくする方向の変更は自由**。緩める方向の変更は、理由を判断記録(`context/decisions/`)へ残す');
  L.push('- 個別の値だけを変える場合は `process.config.json` を編集し、CI の契約検査を通す');
  L.push('');
  L.push('```bash');
  L.push('node scripts/gate/verify-gate-contract.mjs');
  L.push('```');
  L.push('');

  if (config.answers['q-biz-phase'] === 'poc') {
    L.push('## PoC から MVP へ移るときに戻すもの');
    L.push('');
    L.push('PoC がそのまま本番化する事故は、最も多い失敗のかたちです。次を企画承認(G-1)の条件に含めてください。');
    L.push('');
    for (const [key, g] of Object.entries(config.gates)) {
      if (g.state === 'omitted' || g.state.startsWith('merged-into-') || g.state === 'simplified') {
        L.push(`- [ ] ${g.label} を復活させる(現在: ${stateLabel(g.state)})`);
      }
    }
    L.push('- [ ] コア機能の指定をやり直す');
    L.push('- [ ] 技術負債台帳の返却目安を設定する');
    L.push('');
  }

  if (result.warnings.length) {
    L.push('## 規則の衝突');
    L.push('');
    for (const w of result.warnings) L.push(`- ${w.message}`);
    L.push('');
  }

  L.push('## 根拠');
  L.push('');
  L.push('この構成は [ピットイン方式 第8章 テーラリング](https://takenori-kusaka.github.io/process-compass/phase4-process-design/tailoring-guide/) の規則から導出しました。');
  L.push('');
  L.push(`適用した規則: ${config.matchedRuleIds.map((r) => `\`${r}\``).join(', ')}`);
  L.push('');

  return L.join('\n');
}

// ---------------------------------------------------------------- 実行

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const answers = readAnswers(argv);

  // 表示条件を満たさない質問への回答は落とす(engine と同じ扱い)
  const visible = new Set(visibleQuestions(KB.questions, answers).map((q) => q.id));
  for (const k of Object.keys(answers)) if (!visible.has(k)) delete answers[k];

  let built;
  try {
    built = buildConfig(answers, {
      stack: arg(argv, '--stack', 'none'),
      projectId: arg(argv, '--project-id', 'P-001'),
      profileName: arg(argv, '--profile-name', null),
    });
  } catch (e) {
    console.error(`[エラー] ${e.message}`);
    for (const d of e.details ?? []) console.error(`  - ${d}`);
    process.exit(1);
  }

  const { config, result } = built;
  const md = renderProfileMd(config, result);

  if (argv.includes('--dry-run')) {
    console.log(md);
    console.log('\n--- process.config.json ---\n');
    console.log(JSON.stringify(config, null, 2));
  } else {
    fs.writeFileSync(path.join(ROOT, 'process.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(ROOT, 'PROCESS-PROFILE.md'), md, 'utf8');
    console.log('wrote process.config.json / PROCESS-PROFILE.md');
    if (config.unmet.length) {
      console.log('');
      console.log('[未達] 次のゲートは目的を達成する構成を示せていません:');
      for (const u of config.unmet) console.log(`  - ${u.label}: ${u.reason}`);
    }
  }
}

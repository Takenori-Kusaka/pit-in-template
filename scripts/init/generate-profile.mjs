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

/**
 * D-0 体制図の版を読む。実行主体のロール宣言が体制図の改訂に追随しているかを
 * 機械的に検査するための基準点になる(ADR-0035)。D-0 は G-1 の前提条件であり、
 * 初期化の時点では存在しないことがある。その場合は null を返す。
 */
function readD0Version() {
  const file = path.join(ROOT, 'docs/D-0-governance.md');
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m?.[1].match(/^version:\s*(.+)$/m)?.[1].trim() ?? null;
}

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
      `安全重要度 ${cl.toUpperCase()} を 1〜2名の体制で扱えません。危害の深刻度は体制の都合で下がりません(第8章 軸E)。\n` +
        '    選択肢は3つです。\n' +
        '      1. 設計を変えて危害の帰結そのものを下げる(例: 物理削除を取り消し可能な方式へ変える)。\n' +
        '         区分が実際に下がった場合に限り、下げた区分で回答し直せます。次の記録が必要です。\n' +
        '           - 低減の前後の区分と根拠となる設計(CL2 以上は安全リスクアセスメント、CL1 以下は ADR)\n' +
        '           - 設計上の制約を、該当機能の受入基準へ必須制約として書き込む\n' +
        '           - 採らなかった選択肢(体制の確保・機能の非実施)とその理由を ADR へ含める\n' +
        '         人体への危害・外部へ出た情報・確定した取引は、この経路で下げられません。\n' +
        '      2. 外部の評価者を含めて体制を確保する。\n' +
        '      3. 当該の機能を実施しない。\n' +
        '    記録を伴わない引き下げは、回答の書き換えです。'
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
      source: 'ADR-0028(未達と省略の区別)',
      sourceUrl: 'https://takenori-kusaka.github.io/process-compass/adr/0028-unmet-gate-distinct-from-omitted/',
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

/**
 * 代償措置つきの逸脱(deviation)の判定。
 *
 * 未達(unmet)と区別する。未達はゲートの目的を達成する構成が存在しない状態を指す。
 * 逸脱は判定そのものは実施できるが、要求される属性(独立性など)を欠く状態を指す。
 * 出荷判定(G-7)は、1〜2名の体制では価値責任者が兼ねる構成になる。判定と突合は
 * 単独で実行できるため未達ではないが、開発ラインからの独立は失われる(第3章 3.5.2)。
 */
export function detectDeviations(answers, gates) {
  const deviations = [];

  if (gates.g7?.params?.approverMode === 'value-owner-merged' && gates.g7.state === 'required') {
    deviations.push({
      gate: 'g7',
      label: 'G-7 出荷判定',
      rule: '開発ライン × 出荷判定者(同一案件)の兼務の禁止(第3章 3.5)',
      reason:
        '3名未満の体制では、開発ラインから独立した出荷判定者を置けない。判定と基準の突合は単独で実行できるため未達ではないが、判定者の独立性は失われる',
      compensation: [
        'G-7 の判定記録を必須とし、基準の各項目との突合を記録に残す',
        'リリース後の抜き取り確認を定常作業として置く',
        '兼務の事実と代償措置を D-0 体制図へ明記する',
      ],
      resolveWhen: '体制が3名以上になり、開発ラインの外から出荷判定者を置けるようになった時点',
      source: '第3章 3.5.2 / ADR-0029',
      sourceUrl: 'https://takenori-kusaka.github.io/process-compass/adr/0029-shipping-approver-merge-exception/',
    });
  }
  return deviations;
}

/**
 * ロールの構成を導出する。
 *
 * 役割の割り当てを人へ書いただけでは実行主体に届かないため、判定してよいゲートと
 * 担ってはならない工程を機械可読の形で出す(標準 第3章 3.5.3 / ADR-0035)。
 * 「担ってはならない工程」は知識ベースの兼務禁止表(separations)から**導出する**。
 * 手で書かせる欄にしない。
 */
export function buildRoles(gates) {
  const separations = KB.separations ?? [];
  const gateKeyById = Object.fromEntries(KB.gates.map((g) => [g.id, GATE_KEY[g.id]]));
  const owner = {};
  const notes = {};
  for (const g of KB.gates) {
    if (g.approverRole) (owner[g.approverRole] ??= []).push(GATE_KEY[g.id]);
  }

  // 出荷判定者の兼務(3名未満の例外)。判定者が価値責任者へ移ることを構成へ反映する。
  // 反映しないと、体制図の兼務不可と構成の導出が衝突したまま可視化されない(第3章 3.5.2 / ADR-0029)
  if (gates.g7?.params?.approverMode === 'value-owner-merged') {
    owner['qa-gatekeeper'] = (owner['qa-gatekeeper'] ?? []).filter((k) => k !== 'g7');
    (owner['value-owner'] ??= []).push('g7');
    notes['value-owner'] = ['G-7 を兼務する(代償措置つきの逸脱。判定記録と抜き取り確認を要する)'];
    notes['qa-gatekeeper'] = ['この構成では分離できていない。判定は価値責任者が兼ねる'];
  }

  const isActive = (key) => {
    const s = gates[key]?.state;
    return s === 'required' || s === 'simplified' || String(s ?? '').startsWith('merged-into-');
  };

  return (KB.roles ?? []).map((r) => {
    const owned = owner[r.id] ?? [];
    const pairs = separations.filter((s) => (s.roles ?? []).includes(r.id));

    // 相手方が判定するゲート。このロールは判定者になれない
    const mustNotJudge = [];
    for (const s of pairs) {
      const key = s.gate ? gateKeyById[s.gate] : null;
      if (key && !owned.includes(key)) mustNotJudge.push(key);
    }
    // AI はどのゲートの判定者にもなれない(第5章 役割境界。提案はするが承認しない)
    if (r.id === 'ai-agent') mustNotJudge.push(...KB.gates.map((g) => GATE_KEY[g.id]));

    return {
      id: r.id,
      name: r.name,
      responsibility: r.responsibility,
      source: r.source ?? null,
      gatesOwned: owned.filter(isActive),
      gatesUnmet: owned.filter((k) => gates[k]?.state === 'unmet'),
      mustNotAlso: pairs.map((s) => ({
        separationId: s.id,
        role: (s.roles ?? []).find((x) => x !== r.id) ?? null,
        scope: s.scope,
        reason: s.reason,
        exception: s.exception ?? 'none',
      })),
      mustNotJudge,
      selfApproval: 'forbidden',
      notes: notes[r.id] ?? [],
    };
  });
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
      source: g.source ?? null,
      state,
      params: p?.params ?? {},
      why: (p?.notes ?? []).filter(Boolean),
    };
  }

  const unmet = detectUnmet(answers, gates, opts.stack ?? 'none');
  const deviations = detectDeviations(answers, gates);

  // 兼務を認めた場合、判定者の表示も移す。表示が分離されたままだと、構成と体制図が
  // 食い違ったまま可視化されない(#209)
  if (gates.g7?.params?.approverMode === 'value-owner-merged') {
    gates.g7.approver = '価値責任者(出荷判定者を兼務。代償措置つきの逸脱)';
  }

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

  const derivedCoverage = ciStrengthened ? 90 : 80;
  const coverageThreshold = opts.coverageThreshold ?? derivedCoverage;
  if (opts.coverageThreshold !== undefined && opts.coverageThreshold !== derivedCoverage) {
    console.log(`[較正引き継ぎ] 既存の較正設定（ci.coverageThreshold: ${opts.coverageThreshold}%）を検出し、引き継ぎました（標準の導出初期値: ${derivedCoverage}%）`);
  }

  const derivedAllowedLicenses = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Python-2.0', 'MPL-2.0'];
  const allowedLicenses = opts.allowedLicenses ?? derivedAllowedLicenses;
  if (opts.allowedLicenses !== undefined && JSON.stringify(opts.allowedLicenses) !== JSON.stringify(derivedAllowedLicenses)) {
    console.log(`[較正引き継ぎ] 既存の較正設定（ci.allowedLicenses: ${JSON.stringify(opts.allowedLicenses)}）を検出し、引き継ぎました（標準の導出初期値: ${JSON.stringify(derivedAllowedLicenses)}）`);
  }

  const derivedFailOnSeverity = ['critical', 'high'];
  const failOnSeverity = opts.failOnSeverity ?? derivedFailOnSeverity;
  if (opts.failOnSeverity !== undefined && JSON.stringify(opts.failOnSeverity) !== JSON.stringify(derivedFailOnSeverity)) {
    console.log(`[較正引き継ぎ] 既存の較正設定（ci.failOnSeverity: ${JSON.stringify(opts.failOnSeverity)}）を検出し、引き継ぎました（標準の導出初期値: ${JSON.stringify(derivedFailOnSeverity)}）`);
  }

  const derivedMaxChangedLines = 400;
  const maxChangedLines = opts.maxChangedLines ?? derivedMaxChangedLines;
  if (opts.maxChangedLines !== undefined && opts.maxChangedLines !== derivedMaxChangedLines) {
    console.log(`[較正引き継ぎ] 既存の較正設定（task.maxChangedLines: ${opts.maxChangedLines}）を検出し、引き継ぎました（標準の導出初期値: ${derivedMaxChangedLines}）`);
  }

  const derivedMaxChangedFiles = 15;
  const maxChangedFiles = opts.maxChangedFiles ?? derivedMaxChangedFiles;
  if (opts.maxChangedFiles !== undefined && opts.maxChangedFiles !== derivedMaxChangedFiles) {
    console.log(`[較正引き継ぎ] 既存の較正設定（task.maxChangedFiles: ${opts.maxChangedFiles}）を検出し、引き継ぎました（標準の導出初期値: ${derivedMaxChangedFiles}）`);
  }

  const derivedSelfHealMaxIterations = 3;
  const selfHealMaxIterations = opts.selfHealMaxIterations ?? derivedSelfHealMaxIterations;
  if (opts.selfHealMaxIterations !== undefined && opts.selfHealMaxIterations !== derivedSelfHealMaxIterations) {
    console.log(`[較正引き継ぎ] 既存の較正設定（task.selfHealMaxIterations: ${opts.selfHealMaxIterations}）を検出し、引き継ぎました（標準の導出初期値: ${derivedSelfHealMaxIterations}）`);
  }

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
    roles: buildRoles(gates),
    separations: KB.separations ?? [],
    d0Version: opts.d0Version ?? readD0Version(),
    unmet,
    deviations,
    ci: {
      coverageThreshold,
      failOnSeverity,
      allowedLicenses,
      strengthened: ciStrengthened,
    },
    review: {
      requiredApprovals: gates.g6.state === 'required' ? Math.max(1, reviewerCount) : 0,
      reviewerCount,
      mode: gates.g6.params.reviewMode ?? null,
      recordFormat: gates.g6.params.recordFormat ?? 'standard',
    },
    aiReview: { enabled: true, canApprove: false, requiredCheck: false },
    task: { maxChangedLines, maxChangedFiles, selfHealMaxIterations },
    matchedRuleIds: result.matchedRuleIds,
    warnings: result.warnings,
  };

  if (opts.guard) {
    config.guard = opts.guard;
  }

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

/** 標準の該当節へのリンク。参照先がない項目は素のまま出す(#221) */
function link(text, url) {
  return url ? `[${text}](${url})` : text;
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
    L.push('| ゲート | 未達の理由 | 代償措置 | 外部レビューの調達先 | 根拠 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const u of config.unmet) {
      L.push(
        `| ${u.label} | ${u.reason} | ${u.compensation.join(' / ')} | ${u.reviewSourcing ?? '**未記入**'} | ${link(u.source ?? '—', u.sourceUrl)} |`
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

  // --- 代償措置つきの逸脱(未達の直下に置く。下位の節へ送らない) ---
  if (config.deviations?.length) {
    L.push('## 代償措置つきの逸脱');
    L.push('');
    L.push('次のゲートは**実施しますが、標準が要求する属性を欠いています**。未達ではありません。');
    L.push('');
    L.push('| ゲート | 抵触する規則 | 欠けるもの | 解消の時点 | 根拠 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const d of config.deviations) {
      L.push(`| ${d.label} | ${d.rule} | ${d.reason} | ${d.resolveWhen} | ${link(d.source, d.sourceUrl)} |`);
    }
    L.push('');
    for (const d of config.deviations) {
      L.push(`### ${d.label} の代償措置`);
      L.push('');
      L.push('次をすべて満たす場合に限り、この構成で運用できます。');
      L.push('');
      for (const c of d.compensation) L.push(`- [ ] ${c}`);
      L.push('');
      L.push(
        `**代償措置は独立性の回復ではありません**。判定が甘くなる可能性は残ります。記録と抜き取りが行うのは、甘さを後から検出できる状態にすることだけです(${d.source})。`
      );
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
    L.push(`| ${link(g.label, g.source)} | ${stateLabel(g.state)} | ${g.approver ?? '—'} |`);
  }
  L.push('');
  L.push('ゲート名は標準の該当節へのリンクです。**構成の根拠は標準にあります**。');
  L.push('');

  // --- ブロック2.5: ロールと担ってはならない工程 ---
  if (config.roles?.length) {
    L.push('## ロールの構成');
    L.push('');
    L.push(
      '**役割の割り当てを人へ書いただけでは、実行主体には届きません**。' +
        '各セッション・作業領域は、自分が判定してよいゲートと、担ってはならない工程を起動時に参照してください' +
        '(標準 第3章 3.5.3)。この表は兼務禁止表から導出したものです。**手で編集しないでください**。'
    );
    L.push('');
    L.push(`- 追随している D-0 体制図の版: ${config.d0Version ? `\`${config.d0Version}\`` : '**未取得**(D-0 が未作成、または版の記載がない)'}`);
    L.push('');
    L.push('| ロール | 判定するゲート | 兼ねてはならない役割 | 判定してはならないゲート |');
    L.push('| --- | --- | --- | --- |');
    for (const r of config.roles) {
      const owned = r.gatesOwned.map((k) => GATE_BY_KEY[k]?.label ?? k);
      const unmetOwned = r.gatesUnmet.map((k) => `${GATE_BY_KEY[k]?.label ?? k}(**未達**)`);
      const cells = [...owned, ...unmetOwned];
      const also = r.mustNotAlso
        .map((s) => {
          const name = config.roles.find((x) => x.id === s.role)?.name ?? s.role ?? 'すべての役割';
          return s.exception === 'none' ? name : `${name}(例外あり)`;
        })
        .filter(Boolean);
      const notJudge = r.mustNotJudge.map((k) => GATE_BY_KEY[k]?.label ?? k);
      const owns = [...(cells.length ? [cells.join(' / ')] : []), ...(r.notes ?? [])].join('。') || '—';
      L.push(
        `| ${link(r.name, r.source)} | ${owns} | ${also.join(' / ') || '—'} | ${notJudge.join(' / ') || '—'} |`
      );
    }
    L.push('');
    L.push(
      '**起案した主体は、その成果物の判定者になりません**。役割の組み合わせによらず成立しない禁止です。' +
        '分離は、作業領域・セッション・認証情報の3つがすべて分かれている場合にのみ成立します。'
    );
    L.push('');
  }

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
  L.push('### 実装スタックの確定時期');
  L.push('');
  L.push(
    '**実装スタックは探索ステージ(S0)の出力であり、入力ではありません**。' +
      'アダプタが `none` のままでも構成を初期化してかまいません。'
  );
  L.push('');
  L.push('| 時点 | 扱い |');
  L.push('| --- | --- |');
  L.push('| S0 の期間中 | 未確定でよい。**未確定は未達ではない** |');
  L.push('| SG-0 の判定時 | 確定させる。判定基準「技術的実現性が確認されている」に含む |');
  L.push('| SG-0 の通過後 | 未確定が残る場合は未達として扱う |');
  L.push('');
  L.push(
    '記録済みのスタックを S0 の結果に基づいて変更する場合は、**技術判断者の判断とし、判断記録(ADR)を残します**。' +
      '企画承認の判定基準は実装スタックを含まないため、**G-1 の再判定は要しません**。'
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

// ------------------------------------------------ CLAUDE.md の構成依存部分

export const RULES_BEGIN = '<!-- generated:process-rules start -->';
export const RULES_END = '<!-- generated:process-rules end -->';

/**
 * ロールと Label Mailbox の対応(第5章 4.3 / 4.3.1)。
 * ラベルは状態であり、常に「次に動く人」を指す。
 */
const MAILBOX = {
  'value-owner': { inbox: ['state:needs-po'], hands: ['state:needs-dev', 'state:needs-tech', 'state:needs-audit', 'state:needs-platform', 'state:needs-owner'] },
  'tech-lead': { inbox: ['state:needs-tech'], hands: ['state:needs-dev', 'state:needs-po', 'state:needs-owner'] },
  'dev-verifier': { inbox: ['state:needs-dev', 'state:qm-blocked'], hands: ['state:dev-done', 'state:needs-po', 'state:needs-tech', 'state:needs-owner', 'state:needs-platform'] },
  'independent-reviewer': { inbox: ['state:dev-done'], hands: ['state:qm-blocked', 'state:ready-to-merge'] },
  'qa-gatekeeper': { inbox: ['state:dev-done', 'state:ready-to-merge'], hands: ['state:qm-blocked', 'state:ready-to-merge'] },
  'ai-maintainer': { inbox: ['state:needs-platform'], hands: ['state:dev-done'] },
  'biz-approver': { inbox: ['state:needs-owner'], hands: ['state:needs-po', 'state:needs-dev'] },
};

/**
 * エスカレーションの段階とラベルの対応(第7章 7.6 / 第5章 4.5.2)。
 * 閾値は案件が企画承認(G-1)で確定するため、ここでは持たない。
 */
const ESCALATION = [
  ['段階1', 'プロジェクト責任者', 'state:needs-po'],
  ['段階2', '部門責任者・PMO', 'state:needs-owner'],
  ['段階3', 'ステアリングコミッティ(B-2)', 'state:needs-owner'],
  ['不可逆4操作', 'オーナー(事業決裁者)', 'state:needs-owner'],
];

/**
 * CLAUDE.md へ差し込む構成依存部分を組み立てる。
 *
 * エージェントが起動時に読む文書は CLAUDE.md である。手書きのままでは標準の改訂も
 * 案件の構成も届かないため、構成へ依存する部分は導出物として差し替える(#220 / ADR-0035)。
 */
export function renderProcessRules(config) {
  const L = [];
  L.push('## このプロジェクトの構成(自動生成)');
  L.push('');
  L.push(
    'この節は `process.config.json` から生成しています。**手で編集しないでください**。' +
      '内容を変えるときは `/process-init` を再実行します。手で編集すると `check-process-rules` が失敗します。'
  );
  L.push('');
  L.push(`- 案件 ID: \`${config.projectId}\``);
  L.push(`- 追随している D-0 体制図の版: ${config.d0Version ? `\`${config.d0Version}\`` : '**未取得**(D-0 が未作成、または版の記載がない)'}`);
  L.push('');

  L.push('### 有効なゲートと判定者');
  L.push('');
  L.push('| ゲート | 判定 | 判定者 |');
  L.push('| --- | --- | --- |');
  for (const g of Object.values(config.gates)) {
    L.push(`| ${link(g.label, g.source)} | ${stateLabel(g.state)} | ${g.approver ?? '—'} |`);
  }
  L.push('');
  L.push('**判定の基準を確認するときは、ゲート名のリンク先(標準の該当節)を読んでください**。');
  L.push('');

  if (config.unmet?.length) {
    L.push('**未達のゲート**: ' + config.unmet.map((u) => `${u.label}(${u.reason})`).join(' / '));
    L.push('');
    L.push('未達は省略ではありません。**AI で埋めてはなりません**。');
    L.push('');
  }
  if (config.deviations?.length) {
    L.push('**代償措置つきの逸脱**: ' + config.deviations.map((d) => `${d.label}(${d.rule})`).join(' / '));
    L.push('');
  }

  L.push('### ロールごとの権限');
  L.push('');
  L.push('**自分がどのロールのセッションかを確認してから作業を始めてください**。');
  L.push('分離は、作業領域・セッション・認証情報の3つがすべて分かれている場合にのみ成立します(標準 第3章 3.5.3)。');
  L.push('');
  L.push('| ロール | 判定するゲート | 判定してはならないゲート | 受信箱 | 引き渡しに使うラベル |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const r of config.roles ?? []) {
    const mb = MAILBOX[r.id];
    if (!mb && !r.gatesOwned.length && !r.gatesUnmet.length) continue;
    const owned = [...r.gatesOwned, ...r.gatesUnmet.map((k) => `${k}*`)]
      .map((k) => GATE_BY_KEY[k.replace('*', '')]?.label + (k.endsWith('*') ? '(未達)' : ''))
      .join(' / ');
    const notJudge = r.mustNotJudge.map((k) => GATE_BY_KEY[k]?.label ?? k).join(' / ');
    const inbox = (mb?.inbox ?? []).map((s) => `\`${s}\``).join(' ');
    const hands = (mb?.hands ?? []).map((s) => `\`${s}\``).join(' ');
    const ownedCell = [...(owned ? [owned] : []), ...(r.notes ?? [])].join('。') || '—';
    L.push(`| ${link(r.name, r.source)} | ${ownedCell} | ${notJudge || '—'} | ${inbox || '—'} | ${hands || '—'} |`);
  }
  L.push('');
  L.push('- **起案した主体は、その成果物の判定者になりません**。役割の組み合わせによらない禁止です');
  L.push('- **自分のロールの受信箱以外を拾わないでください**。ディレクトリが分かれていても、複数のレーンの受信箱を見た時点で文脈は合流します');
  L.push('- エージェント指示資産(強制層。`.claude/**`)の統合・削除は AI維持管理者へ集約します。変更が必要な場合は `state:needs-platform` を付与します([第5章 Label Mailbox](https://takenori-kusaka.github.io/process-compass/phase5-implementation/label-mailbox/))');
  L.push('');
  L.push('#### 標準の条項を課す前に、適用範囲を確認する');
  L.push('');
  L.push(
    '**条項番号だけを根拠にしないでください**。適用範囲を書けない条項は課さないでください。' +
      '箇条書きだけを読んで限定を落とすと、適用されない条項を課すことになります' +
      '([適用範囲の書き方](https://takenori-kusaka.github.io/process-compass/community/scope-marking/))。'
  );
  L.push('');
  const scopes = KB.clauseScopes ?? [];
  if (scopes.length) {
    L.push('| 条項 | 適用範囲 | 判定の単位 |');
    L.push('| --- | --- | --- |');
    for (const s of scopes) {
      const unit = s.unit === 'per-change' ? '**変更ごと**' : s.unit === 'per-project' ? '案件ごと' : 'その他';
      L.push(`| [${s.title}](${s.source}) | ${s.range} | ${unit} |`);
    }
    L.push('');
  }
  L.push(
    '**リスク区分(R)は変更ごとに判定します**。この案件の安全重要度から「適用されない」を導いてはなりません。' +
      'CL0 の案件でも、認証・認可・個人データ・外部インタフェースに触れる変更は R1 です。'
  );
  L.push('');
  L.push('#### 統制の弱化を見つけたら');
  L.push('');
  L.push(
    '**遮断の解除・閾値の緩和・強制層の縮小**を見つけた場合は、差分が変更の主張と一致するかまでを確認し、' +
      '**許容してよいかは判断しないでください**。'
  );
  L.push('');
  L.push('| 対象 | 付与するラベル |');
  L.push('| --- | --- |');
  L.push('| 強制層(`.claude/**` 等)の縮小 | `state:needs-platform` |');
  L.push('| 不可逆4操作に該当する(ガード・検証ゲート・重要テストの削除を含む) | 上に加えて `state:needs-owner` |');
  L.push('| 弱化の範囲そのものの適否 | `state:needs-po` |');
  L.push('');
  L.push(
    '**引き渡し先が分からないことを、自分で決める理由にしないでください**。特定できない場合は `state:needs-po` を付与します。' +
      '兼務していても、ラベルを経由させて引き渡しを記録します' +
      '([第5章 4.7](https://takenori-kusaka.github.io/process-compass/phase5-implementation/label-mailbox/))。'
  );
  L.push('');
  L.push('**規定の全文は標準にあります**。判断に迷ったら、表のリンク先を読んでから進めてください。推測で補わないでください。');
  L.push('');
  for (const r of config.roles ?? []) {
    if (!r.mustNotAlso?.length) continue;
    const names = r.mustNotAlso.map((s) => {
      const n = config.roles.find((x) => x.id === s.role)?.name ?? s.role;
      return s.exception === 'none' ? n : `${n}(例外: ${s.exception})`;
    });
    L.push(`- **${r.name}** が兼ねてはならない役割: ${names.join(' / ')}`);
  }
  L.push('');

  // --- 受信箱(ポーリングの範囲) ---
  const polling = (config.roles ?? []).filter((r) => MAILBOX[r.id]);
  if (polling.length) {
    L.push('### 自分の受信箱を見る');
    L.push('');
    L.push(
      '**自分のロールのブロックだけを実行してください**。他のロールの受信箱を見た時点で文脈は合流し、' +
        '分離は成立しなくなります([第5章 4.5.1](https://takenori-kusaka.github.io/process-compass/phase5-implementation/label-mailbox/))。'
    );
    L.push('');
    L.push('```bash');
    polling.forEach((r, i) => {
      if (i) L.push('');
      // 未達のロールは担い手がいない。受信箱を出すと、誰かが見ているように読める
      if (r.gatesUnmet.length && !r.gatesOwned.length) {
        L.push(`# ${r.name}: この構成では未達。担い手がいないため受信箱を置かない`);
        return;
      }
      L.push(`# ${r.name}`);
      for (const label of MAILBOX[r.id].inbox) {
        L.push(`gh issue list --label "${label}" --state open`);
        L.push(`gh pr list --label "${label}" --state open`);
      }
    });
    L.push('```');
    L.push('');
    L.push(
      '状態ラベルの付いていない Issues/PRs(孤児)の再配分は価値責任者の義務です。' +
        '**再配分した仕事を自ら拾わないでください**。再配分の権限と、仕事を拾う権限は別です。'
    );
    L.push('');
  }

  // --- エスカレーション ---
  L.push('### エスカレーションの段階とラベル');
  L.push('');
  L.push('| 段階 | 報告先 | 付与するラベル |');
  L.push('| --- | --- | --- |');
  for (const [stage, to, label] of ESCALATION) L.push(`| ${stage} | ${to} | \`${label}\` |`);
  L.push('');
  L.push(
    '発火条件と閾値は[第7章 7.6](https://takenori-kusaka.github.io/process-compass/phase4-process-design/exception-escalation/)、' +
      '実際の宛先は D-0 体制図の第4節によります。**ラベルの付与だけで報告を済ませないでください**。' +
      'エスカレーションレポートの5項目(状態・原因・事業影響・リカバリ選択肢3案・推奨と決裁事項)を書きます。' +
      '**推奨と決裁事項は人が記入します**。'
  );
  L.push('');
  return L.join('\n');
}

/** CLAUDE.md のマーカー区間を差し替える。マーカーがなければ null を返す */
export function applyProcessRules(text, config) {
  const b = text.indexOf(RULES_BEGIN);
  const e = text.indexOf(RULES_END);
  if (b < 0 || e < 0 || e < b) return null;
  const body = renderProcessRules(config);
  return text.slice(0, b) + RULES_BEGIN + '\n\n' + body + '\n' + text.slice(e);
}

// ---------------------------------------------------------------- 実行

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const answers = readAnswers(argv);

  // 表示条件を満たさない質問への回答は落とす(engine と同じ扱い)
  const visible = new Set(visibleQuestions(KB.questions, answers).map((q) => q.id));
  for (const k of Object.keys(answers)) if (k !== 'q-product-type' && !visible.has(k)) delete answers[k];

  let guardOverride = null;
  let allowedLicensesOverride = null;
  let coverageThresholdOverride = null;
  let failOnSeverityOverride = null;
  let maxChangedLinesOverride = null;
  let maxChangedFilesOverride = null;
  let selfHealMaxIterationsOverride = null;

  try {
    const configPath = path.join(ROOT, 'process.config.json');
    if (fs.existsSync(configPath)) {
      const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (existing.guard) {
        guardOverride = existing.guard;
      }
      if (existing.ci) {
        if (existing.ci.allowedLicenses) allowedLicensesOverride = existing.ci.allowedLicenses;
        if (existing.ci.coverageThreshold !== undefined) coverageThresholdOverride = existing.ci.coverageThreshold;
        if (existing.ci.failOnSeverity) failOnSeverityOverride = existing.ci.failOnSeverity;
      }
      if (existing.task) {
        if (existing.task.maxChangedLines !== undefined) maxChangedLinesOverride = existing.task.maxChangedLines;
        if (existing.task.maxChangedFiles !== undefined) maxChangedFilesOverride = existing.task.maxChangedFiles;
        if (existing.task.selfHealMaxIterations !== undefined) selfHealMaxIterationsOverride = existing.task.selfHealMaxIterations;
      }
    }
  } catch (e) {
    // ignore
  }

  let built;
  try {
    built = buildConfig(answers, {
      stack: arg(argv, '--stack', 'none'),
      projectId: arg(argv, '--project-id', 'P-001'),
      profileName: arg(argv, '--profile-name', null),
      guard: guardOverride,
      allowedLicenses: allowedLicensesOverride,
      coverageThreshold: coverageThresholdOverride,
      failOnSeverity: failOnSeverityOverride,
      maxChangedLines: maxChangedLinesOverride,
      maxChangedFiles: maxChangedFilesOverride,
      selfHealMaxIterations: selfHealMaxIterationsOverride,
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

    // .claude/guard.json & settings.json の自動テーラリング（Issue #19）
    try {
      const guardPath = path.join(ROOT, '.claude/guard.json');
      const settingsPath = path.join(ROOT, '.claude/settings.json');
      
      if (fs.existsSync(guardPath) && fs.existsSync(settingsPath)) {
        const guardObj = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
        const settingsObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        
        // 1. 最小限の保護パターン（Category A & B）
        const baseProtectedPatterns = [
          { "pattern": ".claude/settings.json", "reason": "遮断の定義そのもの。書き換えられると他がすべて無効になります" },
          { "pattern": ".claude/guard.json", "reason": "遮断の定義そのもの。書き換えられると他がすべて無効になります" },
          { "pattern": ".claude/hooks/**", "reason": "書き込み遮断フック。書き換えられると遮断が無効になります" },
          { "pattern": "process.config.json", "reason": "有効なゲートと品質閾値（カバレッジ等）の正本" },
          { "pattern": "PROCESS-PROFILE.md", "reason": "人間向けのプロセス構成正本（ゲート、未達、逸脱の記録）" },
          { "pattern": "CODEOWNERS", "reason": "PR の自動アサインと承認ルール" },
          { "pattern": ".github/CODEOWNERS", "reason": "PR の自動アサインと承認ルール" }
        ];
        
        const standardSecrets = [
          "Read(./.env)",
          "Read(./.env.*)",
          "Read(./**/*.pem)",
          "Read(./**/*.key)",
          "Read(./**/id_rsa*)",
          "Read(./**/.aws/**)",
          "Read(./**/.ssh/**)"
        ];

        const standardCategoryAB = [
          "Edit(./.claude/settings.json)",
          "Edit(./.claude/guard.json)",
          "Edit(./.claude/hooks/**)",
          "Edit(./process.config.json)"
        ];

        const standardCategoryC = [
          "Edit(./.github/rulesets/**)",
          "Edit(./.github/workflows/**)",
          "Edit(./adapters/**)",
          "Edit(./scripts/gate/**)",
          "Edit(./scripts/vendor/**)",
          "Write(./scripts/vendor/**)"
        ];

        const standardBash = [
          "Bash(git push --force:*)",
          "Bash(git push -f:*)",
          "Bash(gh pr review:*)",
          "Bash(gh pr merge:*)",
          "Bash(gh api repos/*/rulesets:*)"
        ];

        // テンプレート標準プロセスが管理する全遮断パターンの集合
        const allStandardRules = [
          ...standardSecrets,
          ...standardCategoryAB,
          ...standardCategoryC,
          ...standardBash
        ];

        // 既存の deny リストを取得し、カスタム（手動追加）されたルールを抽出（Issue #23 解決）
        const existingDeny = Array.isArray(settingsObj.permissions?.deny) ? settingsObj.permissions.deny : [...standardSecrets];
        const customDenyRules = existingDeny.filter(rule => !allStandardRules.includes(rule));
        
        // 2. guard.enabled の設定。process.config.json の上書き設定があればそれを最優先する
        let guardEnabled = answers['q-biz-phase'] !== 'poc';
        let isOverridden = false;
        
        if (config.guard && typeof config.guard.enabled === 'boolean') {
          guardEnabled = config.guard.enabled;
          isOverridden = true;
        }
        
        if (!guardEnabled) {
          guardObj.enabled = false;
          guardObj.protectedPatterns = baseProtectedPatterns;
          
          // guard.enabled: false（一時緩和・探索フェーズ）の時は、標準の編集・書き込み遮断や Bash 遮断を一切適用せず、
          // 最小限の秘匿ファイル Read 遮断および利用者が手動で追加したカスタムルールのみを残します（Issue #23 解決）。
          settingsObj.permissions.deny = [
            ...standardSecrets,
            ...customDenyRules
          ];
          
          if (isOverridden) {
            console.log(`[プロセス構成] process.config.json の上書き設定を検出したため、ガードを無効化（enabled: false）状態のまま維持しました。settings.json の編集遮断や Bash 遮断も一時的に解放されています。理由: ${config.guard.reason || '未記入'}`);
          } else {
            console.log('[プロセス構成] 探索ステージ（PoC）のため、エージェント用書き込み遮断ガードを無効化（enabled: false）し、settings.json の編集遮断や Bash 遮断も一時的に解放しました。');
          }
        } else {
          // S1/S2（構築・拡大ステージ）では、エージェント用ガードを有効化（enabled: true）し、
          // 標準規定に基づき検査コードやワークフロー（Category C）への厳格な書き込み制限（ロックダウン）を有効にします
          guardObj.enabled = true;
          
          guardObj.protectedPatterns = [
            ...baseProtectedPatterns,
            { "pattern": ".github/rulesets/**", "reason": "ブランチ保護ルール。書き換えられると独立レビューの強制力が失われます" },
            { "pattern": ".github/workflows/**", "reason": "CI ワークフロー定義。書き換えられると自動検証がバイパスされます" },
            { "pattern": "adapters/**", "reason": "スタック別アダプタ定義。書き換えられると検査コマンドの偽装が可能です" },
            { "pattern": "scripts/gate/**", "reason": "ゲート検証コード。書き換えられると合否判定ロジックの書き換えが可能です" },
            { "pattern": "scripts/vendor/**", "reason": "テーラリング規則。書き換えられると不変条件の無効化が可能です" }
          ];
          
          settingsObj.permissions.deny = [
            ...standardSecrets,
            ...standardCategoryAB,
            ...standardCategoryC,
            ...standardBash,
            ...customDenyRules
          ];
          
          if (isOverridden) {
            console.log(`[プロセス構成] process.config.json の上書き設定を検出したため、ガードを有効化（enabled: true）状態に維持し、全ファイルを厳格にロックダウン（遮断）しました。理由: ${config.guard.reason || '未記入'}`);
          } else {
            console.log('[プロセス構成] 構築・拡大ステージのため、エージェント用ガードを有効化（enabled: true）し、検査コードやワークフロー（Category C）への直接編集をロックダウン（遮断）しました。');
          }
        }
        
        fs.writeFileSync(guardPath, JSON.stringify(guardObj, null, 2) + '\n', 'utf8');
        fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2) + '\n', 'utf8');
      }
    } catch (e) {
      console.warn(`[警告] .claude/guard.json または settings.json のカスタマイズ中にエラーが発生しました: ${e.message}`);
    }

    // 3. 案件タイプ (revenue, internal, oss) に応じた 06-project-brief.md テンプレートの選択的コピー（Issue #21）
    try {
      const productType = answers['q-product-type'] || 'revenue';
      const sourceBrief = path.join(ROOT, `profiles/${productType}/templates/06-project-brief.md`);
      const targetBrief = path.join(ROOT, 'templates/06-project-brief.md');
      
      if (fs.existsSync(sourceBrief)) {
        fs.copyFileSync(sourceBrief, targetBrief);
        console.log(`[プロセス構成] 案件タイプ "${productType}" に合わせた 06-project-brief.md テンプレートを配置しました。`);
      }
    } catch (e) {
      console.warn(`[警告] 案件タイプ別テンプレートのコピー中にエラーが発生しました: ${e.message}`);
    }

    // エージェントが起動時に読む文書へ、構成から導出した権限と経路を差し込む
    const claudeMd = path.join(ROOT, 'CLAUDE.md');
    if (fs.existsSync(claudeMd)) {
      const applied = applyProcessRules(fs.readFileSync(claudeMd, 'utf8'), config);
      if (applied === null) {
        console.warn(`[警告] CLAUDE.md に ${RULES_BEGIN} / ${RULES_END} がありません。構成依存部分を差し込めませんでした`);
      } else {
        fs.writeFileSync(claudeMd, applied, 'utf8');
        console.log('wrote CLAUDE.md (構成依存部分)');
      }
    }
    if (config.unmet.length) {
      console.log('');
      console.log('[未達] 次のゲートは目的を達成する構成を示せていません:');
      for (const u of config.unmet) console.log(`  - ${u.label}: ${u.reason}`);
    }
    if (config.deviations.length) {
      console.log('');
      console.log('[逸脱] 次のゲートは実施しますが、標準が要求する属性を欠いています:');
      for (const d of config.deviations) console.log(`  - ${d.label}: ${d.rule}`);
    }
  }
}

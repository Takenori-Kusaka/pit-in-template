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
  return JSON.parse(fs.readFileSync(argv[i + 1], 'utf8'));
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
export function detectUnmet(answers, gates) {
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
      state,
      params: p?.params ?? {},
      why: (p?.notes ?? []).filter(Boolean),
    };
  }

  const unmet = detectUnmet(answers, gates);
  const deviations = detectDeviations(answers, gates);

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
    roles: buildRoles(gates),
    separations: KB.separations ?? [],
    d0Version: opts.d0Version ?? readD0Version(),
    unmet,
    deviations,
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
  L.push('このファイルは `/process-init` が生成しました。**手で編集してよいのは「未達」節の調達先だけです**。');
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
      L.push(
        '調達先が決まったら `process.config.json` の `unmet[].reviewSourcing` へ記入してください。' +
          '未記入のまま運用している状態は、出荷判定の証跡にも残ります。'
      );
      L.push('');
    }
  }

  // --- 代償措置つきの逸脱(未達の直下に置く。下位の節へ送らない) ---
  if (config.deviations?.length) {
    L.push('## 代償措置つきの逸脱');
    L.push('');
    L.push('次のゲートは**実施しますが、標準が要求する属性を欠いています**。未達ではありません。');
    L.push('');
    L.push('| ゲート | 抵触する規則 | 欠けるもの | 解消の時点 |');
    L.push('| --- | --- | --- | --- |');
    for (const d of config.deviations) {
      L.push(`| ${d.label} | ${d.rule} | ${d.reason} | ${d.resolveWhen} |`);
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
        `| ${r.name} | ${owns} | ${also.join(' / ') || '—'} | ${notJudge.join(' / ') || '—'} |`
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
    if (config.deviations.length) {
      console.log('');
      console.log('[逸脱] 次のゲートは実施しますが、標準が要求する属性を欠いています:');
      for (const d of config.deviations) console.log(`  - ${d.label}: ${d.rule}`);
    }
  }
}

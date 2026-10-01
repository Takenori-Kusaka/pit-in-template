// 回答からプロセス構成を導出し、PROCESS-PROFILE.md と process.config.json を書き出す。
//
//   node scripts/init/generate-profile.mjs --answers answers.json [--stack node] [--project-id P-001] [--dry-run]
//
// 体制の変化点を反映するとき(標準 第3章 3.13 / 第8章「再テーラリングの契機」):
//
//   node scripts/init/generate-profile.mjs --change change.json [--dry-run]
//
// change.json の書式は .claude/skills/process-change/SKILL.md にあります。
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
import {
  SEAT_CEILING,
  MODE_LABEL,
  CHANGE_KINDS,
  KIND_NOTE,
  OUTAGE_HANDLING,
  DIRECTION_LABEL,
  modeRank,
  performerKey,
  qualificationProblems,
  readGateRecords,
  personKey,
  personName,
  nameProblems,
  namingProblems,
  headcountProblems,
  allowedDeciders,
  ruleDeciderProblems,
  ruleApprovalProblems,
  RULE_APPROVER_SEAT,
  belowMinimumStaffing,
  nameOverrides,
  delegationRuleProblems,
  ruleChangeDirection,
  findPerson,
  aiNameReason,
  structureDeciderSeat,
  structureDeciderLabel,
  DEFAULT_STRUCTURE_DECIDER,
  qualificationAuthorityProblems,
  changeTypeProblems,
  protectedPathsProblems,
  CHAINED_SCHEMA_VERSION,
  configDigest,
  chainProblems,
  sealChangeLog,
  pendingNotices,
  outagePeriods,
  SEAT_MODES,
  localIso,
  localDay,
  isRealDay,
  isAppointer,
  SHIPPING_BUSINESS_SEPARATION,
  g6Established,
  NEVER_DELEGATED,
  matchGlob,
  SIGNED_DIRECTIONS,
  answersRosterProblems,
  resolveSigner,
  accountKey,
} from '../gate/config.mjs';

const normName = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/** 名簿の行の種別の表記(変化点の差分に出す) */
const rosterTag = (x) => (x.appointer === true ? '(組織上の任命権者)' : x.external ? '(外部の確認者)' : '');
/** アカウントの並びを比べるためのキー(配列、または変更記録の「a, b」の文字列。大文字と小文字・並び順を区別しない) */
const accountSetKey = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((a) => accountKey(String(a)))
    .filter(Boolean)
    .sort()
    .join(', ');

/**
 * 名簿の行を、名簿へ足したときの氏名とアカウント(K74)。変更記録の表記の変更(rosterEdits)を新しい順に
 * 戻し、その行の追加の記録(差分「人の名簿: 追加 …」)に当たったところで止める。同じ id を消して足し直した
 * 行は、足し直したときの値になる。変更記録に表記の変更が残っていない旧い構成では、残っている範囲で戻す
 */
export function rosterOrigin(config, row) {
  let name = row.name;
  let accounts = accountSetKey(row.accounts);
  const log = Array.isArray(config.changeLog) ? config.changeLog : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i] ?? {};
    for (const x of e.rosterEdits ?? []) {
      if (x?.id !== row.id) continue;
      if (x.field === 'name' && normName(x.to) === normName(name)) name = x.from;
      if (x.field === 'accounts' && accountSetKey(x.to) === accounts) accounts = accountSetKey(x.from);
    }
    const added = new Set(['', '(組織上の任命権者)', '(外部の確認者)'].map((t) => `人の名簿: 追加 ${name}${t}`));
    if ((e.diff ?? []).some((l) => added.has(String(l)))) break;
  }
  return { name, accounts };
}

/** 名簿の表記の変更1件の表示(変化点の記録・D-0 の改訂履歴・品質レポートの項目7) */
export function rosterEditText(x) {
  return (
    `${x.id} の${x.field === 'name' ? '氏名' : 'アカウント'} ${x.from ?? '未記入'} → ${x.to ?? '未記入'}` +
    (x.seats?.length ? `(席の責任者の行: ${x.seats.join('・')})` : '')
  );
}
/** 即時通知の通知先が1つも定まらない場合に、通知先の欄へ記録する値(K70 / 第3章 3.13.6) */
const NO_NOTICE_TARGET = '通知先なし(出荷判定者の席・前任者・D-0 表1 の決定者・品質保証部門の通知先がいずれも無い)';

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
  return m?.[1].match(/^version:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '') ?? null;
}

/** D-0 の版の形式。N.N に限る(1.0.0・v1.1・全角数字は、前後を比べられないため受け付けない。K75) */
export const D0_VERSION_FORMAT = /^\d+\.\d+$/;

/** どの構成でも省略できないゲート(附属書A / 第2章 2.5) */
const NEVER_OMITTABLE = new Set(['g4', 'g5']);

/** 判定を実施する状態か(簡略化も実施に含む) */
const isActiveState = (s) => s === 'required' || s === 'simplified';

/** 逸脱1件を識別するキー。ゲートの逸脱はゲート、兼務の逸脱は兼務禁止表の id */
const deviationKey = (d) => d.gate ?? d.separationId;

const ROLES_URL = 'https://takenori-kusaka.github.io/process-compass/phase4-process-design/roles-responsibilities/';

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
export function checkConstraints(answers, { reflectBelowMinimum = false } = {}) {
  const errors = [];
  // 設定済みの構成で最小体制を割った場合は、拒否せず、出荷できない状態として反映する
  if (reflectBelowMinimum && belowMinimumStaffing(answers)) {
    if (['cl2', 'cl3'].includes(answers['q-criticality']) && answers['q-ai-constraint'] === 'ai-unavailable') {
      errors.push('AI を利用しない構成では、本テンプレートの前提が成立しません。');
    }
    return errors;
  }
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
 * 独立は人の単位で定義するため、2名体制では作成を指示していない側の確認で成立する。
 * 1〜2名で、作成を指示した本人以外の確認者がいない場合、この条件を満たす構成が存在しない。
 * 標準は AI の確認を独立した人の確認に数えないため、省略ではなく未達として扱う。
 */
export function detectUnmet(answers, gates, stack, { reviewerIsAuthor = null, soleAuthor = null } = {}) {
  const unmet = [];
  const small = answers['q-team-size'] === 'size-1-2';
  const noReviewer = small && answers['q-external-reviewer'] === 'reviewer-no';
  // 確認者がいると回答していても、独立レビュアの席の責任者が開発者の席と同一人物なら、
  // 1〜2名の体制では確認者がいないことが確定する。人の離脱で生じた場合も、決定を待たずに
  // 未達として反映する(第3章 3.13.3)
  const sameReviewer = small && reviewerIsAuthor && isActiveState(gates.g6.state);
  // 名簿に、開発者の席の責任者のほかに人がいない(外部の確認者も含めて)。独立レビュアの席を空けたままでも、
  // 確認者を置けないことが確定する
  const noConfirmer = small && !sameReviewer && soleAuthor && isActiveState(gates.g6.state);

  if ((noReviewer && gates.g6.state === 'omitted') || sameReviewer || noConfirmer) {
    gates.g6.state = 'unmet';
    unmet.push({
      gate: 'g6',
      label: 'G-6 独立レビュー',
      reason: sameReviewer
        ? `作成を指示した本人以外が挙動を確認する条件を満たす構成が存在しない(独立レビュアの席の責任者が、開発者の席の責任者と同一人物: ${reviewerIsAuthor})`
        : noConfirmer
          ? `作成を指示した本人以外が挙動を確認する条件を満たす構成が存在しない(人の名簿に、開発者の席の責任者(${soleAuthor})のほかに確認できる人がいない)`
          : '作成を指示した本人以外が挙動を確認する条件を満たす構成が存在しない(最小体制3名未満、かつ作成を指示した本人以外の確認者がいない)',
      whyNotAi:
        '独立は責任者(人)の単位で定義する。責任者が同一人物なら、AI を何体に分けても、モデルの系統を変えても独立は成立しない。AI の確認は検出の層であり、判定に数えない。生成物の確認を生成器へ委ねる構成は自動化バイアスによって見落としを増やす',
      compensation: ['ci-strict', 'post-release-audit'],
      reviewSourcing: null,
      source: 'ADR-0028(未達と省略の区別)',
      sourceUrl: 'https://takenori-kusaka.github.io/process-compass/adr/0028-unmet-gate-distinct-from-omitted/',
      howToResolve: [
        '2名体制では、作成を指示していない側の人が確認する(相手も作成の指示に関与した変更は除く)',
        'リポジトリを公開し、コミュニティのレビューを受ける',
        '他の個人開発者と相互レビューの取り決めをする',
        '有償のコードレビューを利用する',
        '確認者を置けたら、/process-change で変化点として反映する(確認者は人の名簿 people[] へ記入する)',
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
        '決定したスタックを、/process-change(種別 settings の settings.stack)で構成へ反映する。process.config.json を手で編集しない',
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
 * 簡略化して適用する構成(simplified)でも判定は実施するため、逸脱として記録する。
 */
export function detectDeviations(answers, gates) {
  const deviations = [];

  if (gates.g7?.params?.approverMode === 'value-owner-merged' && isActiveState(gates.g7.state)) {
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
export function buildRoles(gates, separations = KB.separations ?? []) {
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

/**
 * 席(ロール)ごとの責任者・担い手・運用形態を導出する(標準 第5章 5.5 / ADR-0054)。
 *
 * 席は体制が変わっても変わらない。変わるのは責任者と担い手であり、再生成のたびに
 * 既存の記入を引き継ぐ。AI は担い手であって席ではないため、席の一覧に入れない。
 * 運用形態(mode)は上限の宣言であり、変更ごとのリスク区分の判定がそれを下げる。
 */
export function buildSeats(prevSeats = []) {
  const prev = Object.fromEntries((prevSeats ?? []).map((s) => [s.role, s]));
  return (KB.roles ?? [])
    .filter((r) => r.id !== 'ai-agent')
    .map((r) => {
      const p = prev[r.id] ?? {};
      const ceiling = SEAT_CEILING[r.id] ?? 'delegated';
      return {
        role: r.id,
        name: r.name,
        accountable: p.accountable ?? null,
        mode: p.mode ?? (ceiling === 'human' ? 'human' : 'collab'),
        modeCeiling: ceiling,
        delegable: ceiling === 'delegated',
        performer: p.performer ?? null,
        fallback: p.fallback ?? null,
        qualification: p.qualification ?? null,
        // 席の責任者が委任を宣言し、規則が AI維持管理者の承認待ちであるあいだ、宣言した意図と決定者を保持する。
        // 承認が入った変化点で、委任を有効にする(再宣言を要求しない)
        ...(p.intent ? { intent: p.intent } : {}),
      };
    });
}

/**
 * 委任の範囲を定める機械の規則の置き場(標準 第5章 5.5.4)。
 *
 * 規則が空なら委任は無い。安全重要度が CL1 以上、または規制業では委任を適用できない
 * (条件1)。該当の判定は機械の規則で行い、行為する AI 自身に判定させない(条件2)。
 */
export function buildDelegation(answers, prev = {}) {
  const blockedBy = [];
  if (answers['q-criticality'] !== 'cl0') blockedBy.push('安全重要度が CL1 以上');
  if (answers['q-quality'] === 'quality-regulated') blockedBy.push('規制業に該当する');
  return {
    allowed: blockedBy.length === 0,
    blockedBy,
    rules: prev?.rules ?? [],
    // 標準変更カタログへ登録した変更種別(第3章 3.7.4)。規則の changeType は、この一覧にあるものだけを受け付ける
    changeTypes: prev?.changeTypes ?? [],
    // 確約範囲とコア指定のパス(第5章 5.5.4 条件5)。触れる変更は委任の対象にしない。
    // キーが無いあいだは未宣言であり、条件5 を判定できないため、どの変更も委任に該当しない。
    // 該当するパスが無い案件は、空の配列を宣言する。宣言するのは人である
    ...(Array.isArray(prev?.protectedPaths) ? { protectedPaths: prev.protectedPaths } : {}),
    source: 'https://takenori-kusaka.github.io/process-compass/phase4-process-design/human-ai-boundary/',
  };
}

/**
 * 委任の規則1件が、有効に成立しているかを確かめる。問題の一覧を返す(空なら有効)。
 * pending は、AI維持管理者の承認が未記入なだけで、ほかの要件は満たしている規則(承認待ち)
 */
export function ruleStanding(ctx, rule) {
  const formal = [
    ...delegationRuleProblems(rule, ctx),
    ...ruleDeciderProblems(ctx, rule),
    // 変更種別を登録した者が、いまも登録の権限を持つ者であること(離任・交代で外れたら、登録し直すまで無効)
    ...changeTypeProblems(ctx, { only: new Set([String(rule.changeType ?? '').trim()]) }),
  ];
  const approval = ruleApprovalProblems(ctx, rule);
  return { problems: [...formal, ...approval], pending: !formal.length && approval.length > 0 && !rule.approvedBy };
}

/**
 * 上限を超える運用形態を引き下げる。厳しくする向きは判定を待たずに適用する(第5章 5.5.7)。
 * 引き下げた席と理由を返す。返り値の inactiveRules は、有効でない規則(席は委任のままでも、
 * その規則では委任は働かない)。
 *
 * 席を委任にできるのは、有効な規則が1つ以上ある場合である。未承認の規則を足しても、承認済みの
 * 既存の規則による委任は協働へ落とさない。承認待ちになるのは、足した・広げた規則だけである
 */
export function clampSeats(seats, delegation, people = [], governance = null) {
  const clamps = [];
  clamps.inactiveRules = [];
  const ctx = { seats, people, delegation, governance };
  for (const s of seats) {
    let limit = s.modeCeiling;
    let why = '席の上限(第5章 5.5.6)';
    let pendingApproval = false;
    if (limit === 'delegated') {
      const rules = delegation.rules.filter((r) => r.seat === s.role);
      // 委任の範囲を定めるのは人である。規則の形式、決定した者の記名、AI維持管理者の承認を確かめる
      const standing = rules.map((r) => ({ id: r.id ?? '(id なし)', ...ruleStanding(ctx, r) }));
      const inactive = standing.filter((x) => x.problems.length);
      for (const x of inactive) clamps.inactiveRules.push({ id: x.id, seat: s.role, seatName: s.name, reason: x.problems[0], pending: x.pending });
      let block = null;
      if (!delegation.allowed) block = `委任を適用できない案件(${delegation.blockedBy.join('、')})`;
      else if (!s.accountable) block = '責任者が未記入';
      else if (nameProblems(ctx, s.accountable, { requireRoster: true }).length) {
        block = `責任者の記名を受け付けられない(${nameProblems(ctx, s.accountable, { requireRoster: true })[0]})`;
      } else if (!s.performer) block = 'AI の担い手の識別が未記入';
      else if (qualificationProblems(s).length) block = qualificationProblems(s)[0];
      // 実施者が名簿から外れても、確認の記録は有効なまま残る(第3章 3.4.2)。現在の名簿とは照合しない
      else if (nameProblems(ctx, s.qualification.performedBy, { checkRoster: false }).length) {
        block = `適合性確認の実施者の記名を受け付けられない(${nameProblems(ctx, s.qualification.performedBy, { checkRoster: false })[0]})`;
      } else if (nameProblems(ctx, s.qualification.approvedBy, { requireRoster: true }).length) {
        block = `適合性確認の承認者の記名を受け付けられない(${nameProblems(ctx, s.qualification.approvedBy, { requireRoster: true })[0]})`;
      } else if (personKey(ctx, s.qualification.approvedBy) !== personKey(ctx, s.accountable)) {
        block = '適合性確認の承認者が、この席の責任者ではない(承認者が交代したため、承認が失効。記録は有効。新しい責任者の承認を要する)';
      } else if (!rules.length) block = '委任の範囲を定める機械の規則が未登録';
      else if (!s.fallback) block = 'AI が使えないときの扱いが未記入';
      else if (inactive.length === standing.length) {
        // 有効な規則が1つも無い。規則の追加・拡大は統制の弱化であり、AI維持管理者の承認を要する(ADR-0038)。
        // 承認が未記入なだけなら、承認待ちとして扱う。委任するという決定は拒否しない
        block = `委任の規則 ${inactive[0].id}: ${inactive[0].problems[0]}`;
        pendingApproval = inactive.every((x) => x.pending);
      }
      if (block) {
        limit = 'collab';
        why = block;
      }
    }
    if (modeRank(s.mode) > modeRank(limit)) {
      clamps.push({ role: s.role, name: s.name, from: s.mode, to: limit, reason: why, pendingApproval });
      s.mode = limit;
    }
  }
  return clamps;
}

export function buildConfig(answers, opts = {}) {
  const errors = checkConstraints(answers, { reflectBelowMinimum: opts.reflectBelowMinimum === true });
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

  // 人の名簿。初期化では空。人が /process-change で記入する(D-0 体制図の節1 は、構成から生成する)
  const people = (opts.people ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    external: p.external === true,
    // リポジトリ上のアカウント。承認したアカウントを名簿の人へ対応づける(保証の開示)
    accounts: p.accounts === undefined ? [] : p.accounts,
    // 名義の機械検査に当たる氏名を、人が確認した旨。真の人だけに持たせる
    ...(p.nameConfirmed === true ? { nameConfirmed: true } : {}),
    // 組織上の任命権者(体制の外の人。第3章 3.13.3)。前任の決定者が体制から外れたとき、決定者の任命を記名する
    ...(p.appointer !== undefined ? { appointer: p.appointer } : {}),
  }));
  // D-0 表1 の2行の決定者の席。標準変更カタログへの登録は、リリース判定会(B-4)を置く体制では
  // B-4('b4')、置かない体制では「体制と運用形態」の決定者が行う(第3章 3.7.4 / 第8章 軸A)
  const structureDecider = opts.governance?.structureDecider ?? DEFAULT_STRUCTURE_DECIDER;
  const governance = {
    structureDecider,
    catalogRegistrar: opts.governance?.catalogRegistrar ?? (answers['q-team-size'] === 'size-1-2' ? structureDecider : 'b4'),
    // 品質保証部門の通知先(任意。第3章 3.13.6)。定めた場合は、すべての即時通知をここへも送る
    ...(opts.governance?.qaNotice ? { qaNotice: opts.governance.qaNotice } : {}),
  };
  const delegation = buildDelegation(answers, opts.delegation);
  const seats = buildSeats(opts.seats);
  const clamps = clampSeats(seats, delegation, people, governance);

  const accountableOf = (role) => seats.find((s) => s.role === role)?.accountable ?? null;
  const author = personKey({ people }, accountableOf('dev-verifier'));
  const reviewerIsAuthor =
    author && author === personKey({ people }, accountableOf('independent-reviewer'))
      ? personName({ people }, accountableOf('dev-verifier'))
      : null;
  // 名簿に、開発者の席の責任者のほかに確認できる人がいない(組織上の任命権者は確認者に数えない)。
  // 人の離脱で確認者を置けなくなった場合も、席の入力を待たずに未達へ反映する(K70 / 第3章 3.13.3)
  const authorRow = people.find((p) => p.id === author);
  const soleAuthor = authorRow && !people.some((p) => p.id !== author && p.appointer !== true) ? authorRow.name : null;
  const unmet = detectUnmet(answers, gates, opts.stack ?? 'none', { reviewerIsAuthor, soleAuthor });
  // 記入済みの調達先は再生成で失わない
  for (const u of unmet) u.reviewSourcing = opts.reviewSourcing?.[u.gate] ?? u.reviewSourcing;
  const deviations = detectDeviations(answers, gates);
  // 1〜2名の体制で成立しない兼務禁止は、拒否せず逸脱として記録する(第3章 3.5)。
  // 規模の規則が分離を必須とした組(10名以上の価値責任者 × 技術判断者。第8章 軸A)を、兼務禁止表へ足す
  // 出荷判定者 × 事業決裁者は、知識ベースが同じ組を持たない版でも兼務禁止表へ足す(第3章 3.5)
  const kbSeparations = KB.separations ?? [];
  const samePair = (s, pair) => (s.roles ?? []).length === 2 && pair.every((r) => s.roles.includes(r));
  const separations = [
    ...kbSeparations,
    ...(kbSeparations.some((s) => samePair(s, SHIPPING_BUSINESS_SEPARATION.roles)) ? [] : [SHIPPING_BUSINESS_SEPARATION]),
    ...sizeSeparations(result),
  ];
  deviations.push(...seatDeviations({ answers, gates, seats, people, separations, deviations }));
  // 呼び出し側が版を渡した場合(null を含む)は、それを使う。変化点を経ない再生成では、版を進めない
  const d0Version = opts.d0Version !== undefined ? opts.d0Version : readD0Version();
  // 手元の時刻帯の時刻(オフセットつき)。先頭の10文字が、手元の日付になる
  const generatedAt = opts.generatedAt ?? localIso();

  // 兼務を認めた場合、判定者の表示も移す。表示が分離されたままだと、構成と体制図が
  // 食い違ったまま可視化されない(#209)
  if (gates.g7?.params?.approverMode === 'value-owner-merged') {
    gates.g7.approver = '価値責任者(出荷判定者を兼務。代償措置つきの逸脱)';
  }

  // CI の強度。g-ci に strengthen が乗った場合、既定値を引き上げる。未達の代償措置として ci-strict を
  // 表示する構成(席の責任者が同一人物になって未達が生じた場合を含む)でも引き上げる。
  // 代償措置の表示と、実際の下限を食い違わせない
  const ciStrengthened =
    result.profile['gate:g-ci']?.state === 'strengthen' || unmet.some((u) => (u.compensation ?? []).includes('ci-strict'));
  const reviewerCount =
    gates.g6.params.reviewerCount ?? (gates.g6.state === 'required' ? 1 : 0);

  // 適用するブランチ保護。G-6 が有効な構成でのみ置く
  const strict =
    answers['q-quality'] === 'quality-regulated' ||
    ['cl2', 'cl3'].includes(answers['q-criticality']) ||
    reviewerCount >= 2;
  const ruleset = gates.g6.state === 'required' ? (strict ? 'regulated' : 'team') : null;

  const derivedCoverage = ciStrengthened ? 90 : 80;
  // 較正していない下限(導出値のまま引き継いだ値)は、導出値が上がれば追随する。厳しくする向きであり、
  // 即時に適用する。導出値が下がっても、自動では下げない(下げるのは緩める向きの決定。種別 settings)
  const coverageThreshold =
    opts.coverageThreshold === undefined || (opts.coverageUncalibrated && opts.coverageThreshold < derivedCoverage)
      ? derivedCoverage
      : opts.coverageThreshold;
  // 代償措置(ci-strict)の表示と、実際の下限を食い違わせない。較正で導出値を下回る場合は、その旨を理由へ出す
  if (coverageThreshold < derivedCoverage) {
    for (const u of unmet) {
      if ((u.compensation ?? []).includes('ci-strict')) {
        u.compensationNote = `ci-strict の導出値はカバレッジ下限 ${derivedCoverage}% だが、較正により ${coverageThreshold}% を適用している`;
      }
    }
  }
  if (opts.coverageThreshold !== undefined && coverageThreshold !== derivedCoverage) {
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
    schemaVersion: CHAINED_SCHEMA_VERSION,
    configured: true,
    profileName: opts.profileName ?? null,
    projectId: opts.projectId ?? 'P-001',
    generatedAt,
    answers,
    answerLabels: Object.fromEntries(
      Object.entries(answers).map(([k, v]) => [k, labelOf(k, v)])
    ),
    adapters: { stack: opts.stack ?? 'none' },
    platform: {
      host: opts.platformHost ?? 'local-markdown',
      hostUrl: opts.platformHostUrl ?? null,
    },
    ruleset,
    gates,
    roles: buildRoles(gates, separations),
    separations,
    governance,
    d0Version,
    unmet,
    deviations,
    // 出荷できない状態。CL1 以上・規制業で体制が3名を割っているあいだ立つ。3名以上へ戻すと消える
    shipBlocked: belowMinimumStaffing(answers)
      ? {
          reason: belowMinimumStaffing(answers, opts.shipBlockedCause ?? 'headcount'),
          since: opts.shipBlockedSince ?? generatedAt.slice(0, 10),
          // 原因。headcount は人数の減少、criticality は 1〜2名の体制のまま区分が上がった場合
          cause: opts.shipBlockedCause ?? 'headcount',
        }
      : null,
    people,
    seats,
    delegation,
    ci: {
      coverageThreshold,
      derivedCoverageThreshold: derivedCoverage,
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
    // 体制の変化点の記録(第3章 3.13.4)。構成の生成そのものを最初の1件とする
    changeLog: opts.changeLog ?? [
      // date は他の記録と同じく日付だけにする。時刻は at に残す
      changeLogEntry({ kind: 'init', date: generatedAt.slice(0, 10), at: generatedAt, summary: '構成を生成した', d0After: d0Version }),
    ],
  };

  if (opts.guard) {
    config.guard = opts.guard;
  }

  return { config, result, clamps };
}

/**
 * 席の責任者が、兼務禁止の組を同一人物で占めていないかを調べる(標準 第3章 3.5 / 3.13.3)。
 *
 * 成果物単位の禁止(作成を指示した本人 × 独立レビュア)は、席の単位では抵触を確定できない。
 * 同一人物であれば、その2席のあいだで独立が成立しない事実だけを返す。
 */
export function seatSeparationFindings(config) {
  const seats = config.seats ?? [];
  const seatOf = (id) => seats.find((s) => s.role === id);
  const who = Object.fromEntries(seats.map((s) => [s.role, personKey(config, s.accountable)]));
  const nameOf = (id) => seatOf(id)?.name ?? id;
  const small = config.answers?.['q-team-size'] === 'size-1-2';
  const violations = [];
  const excepted = [];
  const notIndependent = [];
  // 1〜2名の体制で、同一人物が占めた兼務禁止の組。拒否せず逸脱として記録する
  const deviated = [];
  for (const sep of config.separations ?? []) {
    const [a, b] = sep.roles ?? [];
    if (!a || !b || !who[a] || who[a] !== who[b]) continue;
    const person = personName(config, seatOf(a).accountable);
    const pair = `${nameOf(a)} × ${nameOf(b)}(${person})`;
    const key = sep.gate ? GATE_KEY[sep.gate] : null;
    // 成果物単位の禁止(作成を指示した本人 × 独立レビュア)。1〜2名では未達として扱う(detectUnmet)。
    // 3名以上では、別の人を置けるため、同一人物にする変更を拒否する
    if (sep.scope === 'same-work-product') (small ? notIndependent : violations).push(pair);
    // 代償措置つきの例外は、ゲートの逸脱として記録された組に限る(第3章 3.5.2)
    else if (key && sep.exception !== 'none' && (config.deviations ?? []).some((d) => d.gate === key)) excepted.push(pair);
    // 判定を実施しない構成(省略・統合)では、その判定者との兼務は生じない
    else if (small && key && !isActiveState(config.gates?.[key]?.state)) continue;
    else if (small) deviated.push({ id: sep.id, roles: [a, b], pair, person, names: [nameOf(a), nameOf(b)], reason: sep.reason });
    else violations.push(pair);
  }
  const blank = seats.filter((s) => !s.accountable).length;
  return { violations, excepted, notIndependent, deviated, blank };
}

/**
 * 1〜2名の体制で成立しない兼務禁止を、逸脱の記録へ変える(標準 第3章 3.5)。
 *
 * 出荷判定者の兼務の例外(3.5.2)と違い、代償措置は定められていない。標準が求めるのは、
 * 逸脱として D-0 体制図へ記録し、表示し続けることである。3名以上では拒否する。
 */
export function seatDeviations(config) {
  return seatSeparationFindings(config).deviated.map((d) => ({
    gate: null,
    separationId: d.id,
    label: `${d.names.join(' × ')} の兼務`,
    rule: `${d.names.join(' × ')} の兼務の禁止(第3章 3.5)`,
    // 出荷判定者 × 事業決裁者は、保証の開示の項目1 へ「異議を書く者と、残存リスクを受容する者が同一である」と出す(K50)
    reason:
      `1〜2名の体制で、同じ人(${d.person})が両方の席の責任者になっている。` +
      (SHIPPING_BUSINESS_SEPARATION.roles.every((r) => d.roles.includes(r)) ? '異議を書く者と、残存リスクを受容する者が同一である。' : '') +
      d.reason,
    compensation: [],
    record: '兼務の事実を D-0 体制図(節2)へ記録し、表示し続ける。出荷判定者の兼務の例外(第3章 3.5.2)を、この組へ広げない',
    resolveWhen: '2つの席の責任者を別の人にできた時点。3名以上の体制では、この兼務を拒否する',
    source: '第3章 3.5',
    sourceUrl: ROLES_URL,
  }));
}

/**
 * 規模の規則が分離を必須とした役割の組を、兼務禁止表の形で返す(第8章 軸A「10名以上は分離必須」)。
 * 規則の mustSplitFrom から導出する。手で書かせる欄にしない
 */
export function sizeSeparations(result) {
  const out = [];
  for (const r of KB.roles ?? []) {
    const other = result.profile[`role:${r.id}`]?.params?.mustSplitFrom;
    if (!other) continue;
    out.push({
      id: `sep-size-${r.id}-${other}`,
      roles: [r.id, other],
      scope: 'team-size',
      reason: '10名以上の体制では、価値と技術の相互チェックを保つため、分離を必須とする',
      exception: 'none',
      gate: null,
      source: 'https://takenori-kusaka.github.io/process-compass/phase4-process-design/tailoring-guide/',
    });
  }
  return out;
}

export function separationSummary(config) {
  const f = seatSeparationFindings(config);
  return (
    `兼務禁止への抵触 ${f.violations.length} 件 / 代償措置つきの例外 ${f.excepted.length} 件 / ` +
    `逸脱として記録した兼務 ${f.deviated.length} 件 / ` +
    `同一人物のため独立が成立しない組 ${f.notIndependent.length} 件 / 責任者が未記入の席 ${f.blank} 席`
  );
}
/** 変化点の記録1件。記録する内容は標準 第3章 3.13.4 の5点による */
export function changeLogEntry(e) {
  return {
    // date は発効日(手元の時刻帯の日付。入力で指定できる)。at は記録した時刻(オフセットつき。順序の比較に使う)
    date: e.date,
    at: e.at ?? localIso(),
    kind: e.kind,
    changePoint: CHANGE_KINDS[e.kind] ?? null,
    summary: e.summary ?? null,
    result: e.result ?? 'changed',
    direction: e.direction ?? 'none',
    d0Before: e.d0Before ?? null,
    d0After: e.d0After ?? null,
    diff: e.diff ?? [],
    // 未達・逸脱の発生。決定ではなく事実であり、記名を待たずに反映する(第3章 3.13.3)
    arising: e.arising ?? [],
    separationRecheck: e.separationRecheck ?? null,
    invalidatedChecks: e.invalidatedChecks ?? [],
    expired: e.expired ?? [],
    recheckDue: e.recheckDue ?? null,
    decidedBy: e.decidedBy ?? null,
    reason: e.reason ?? null,
    // 前任の決定者が体制から外れ、組織上の任命権者の記名で任免を決定した(第3章 3.13.3 / 3.13.4 記録5)
    ...(e.appointerSigned ? { appointerSigned: true } : {}),
    // 人の名簿の表記の変更(同じ人の氏名またはアカウント)。旧い値と新しい値を残す(K67)
    ...(e.rosterEdits?.length ? { rosterEdits: e.rosterEdits } : {}),
    // 承認待ちのあいだ保持していた委任の宣言を、この変化点で有効にした席(宣言した時点の決定者と理由)
    ...(e.intentApplied?.length ? { intentApplied: e.intentApplied } : {}),
    // 委任の規則の追加・拡大を承認した者(AI維持管理者の席の責任者)と、対象の規則(ADR-0038)
    ruleApprovedBy: e.ruleApprovedBy ?? null,
    ruleApproval: e.ruleApproval ?? null,
    // 名義の機械検査を人が上書きした氏名(その時点の名簿による)
    nameOverrides: e.nameOverrides ?? [],
    // ステージを前へ戻す変更は、ステージ移行ゲート(SG)の判定による
    sgRecord: e.sgRecord ?? null,
    // AI が使えない期間(変化点に数えない。保証の開示の項目7 へ出す)
    outage: e.outage ?? null,
    // 即時通知(第3章 3.13.6)。対象でなければ null。通知先と通知日が未記入の記録は、証跡の集約が欠落として扱う
    notice: e.notice ?? null,
    // 種別 notice の記録が、どの記録の通知を埋めるか(changeLog の添字)
    ...(e.noticeFor != null ? { noticeFor: e.noticeFor } : {}),
    // 要約値の連鎖(sealChangeLog が書く)。stateHash は changeLog を除いた構成、prevHash は直前の記録
    prevHash: null,
    stateHash: null,
  };
}

// ---------------------------------------------------------------- 体制の変化点

const GATE_RANK = { required: 3, simplified: 2, unmet: 1, omitted: 0 };
const gateRank = (s) => (String(s ?? '').startsWith('merged-into-') ? 1 : GATE_RANK[s] ?? 3);
const RULESET_RANK = { regulated: 2, team: 1 };

/**
 * 変化点の前後の構成を比べる(標準 第8章「準拠テンプレートが備える手段」)。
 *
 * 出力は3つ。構成の差分、失効と発生の一覧、残作業。
 * 統制を緩める向きの変更は loosens へ入れる。緩める向きを、この手段の側で確定させない。
 * 確定は、記名した者の決定による。決定できるのは、対象の席の責任者、または事業決裁者の
 * 席の責任者(D-0 表1「体制と運用形態」の決定者。governance.structureDecider)に限る
 * (loosenItems の seat。null は後者に限る)。
 *
 * 人の離脱などで統制が成立しなくなった変化は、緩める向きの決定ではなく、未達・逸脱の
 * 発生である。arising へ入れ、記名を待たずに反映する(第3章 3.13.3)。
 */
export function diffConfig(before, after) {
  const diff = [];
  const loosenItems = [];
  const tightens = [];
  const expired = [];
  const arising = [];
  const resolved = [];
  const candidates = [];
  const remaining = [];
  // 任免の決定(席の責任者の任命・交代、D-0 表1 の決定者の変更)。緩める向きとは別に、決定者の記名を要する
  const appointItems = [];
  const push = (line, b, a, seat = null, extra = {}) => {
    diff.push(line);
    if (a < b) loosenItems.push({ line, seat, ...extra });
    else if (a > b) tightens.push(line);
  };
  const seatIn = (c, role) => (c.seats ?? []).find((s) => s.role === role);

  // 人が実際に減ったか。未達・逸脱を「発生」(決定ではない事実)として扱えるのは、名簿の体制内の人が
  // 減った場合、または席の責任者が名簿から外れた場合に限る。人が減っていないのに、回答や席の入力で
  // 独立レビューや承認数を下げる変更は、緩める向きの決定である(第3章 3.13.2 / 3.13.3)
  const insiders = (c) => (c.people ?? []).filter((p) => p?.external !== true);
  const afterIds = new Set((after.people ?? []).map((p) => p.id));
  const heldBefore = new Set((before.seats ?? []).map((s) => findPerson(before, s.accountable)?.id).filter(Boolean));
  const left = (before.people ?? []).filter((p) => !afterIds.has(p.id));
  const departure = insiders(after).length < insiders(before).length || left.some((p) => heldBefore.has(p.id));

  // 軸の入力。統制が下がる向きへ戻す入力は、ゲートの状態が変わらなくても緩める向きとして扱う
  const AXIS_ORDER = {
    'q-biz-phase': ['poc', 'mvp', 'growth', 'stable'],
    'q-criticality': ['cl0', 'cl1', 'cl2', 'cl3'],
    'q-quality': ['quality-standard', 'quality-high', 'quality-regulated'],
  };
  let stageBack = false;
  for (const [k, v] of Object.entries(after.answers ?? {})) {
    const b = before.answers?.[k];
    if (b === v) continue;
    const order = AXIS_ORDER[k];
    const lowered = order && order.indexOf(b) >= 0 && order.indexOf(v) >= 0 && order.indexOf(v) < order.indexOf(b);
    if (!lowered) {
      diff.push(`回答 ${k}: ${b ?? '(なし)'} → ${v}`);
    } else if (k === 'q-biz-phase') {
      stageBack = true;
      push(
        `回答 ${k}: ${b} → ${v}(事業ステージを前へ戻す。ステージ移行ゲート(SG)の判定による。${structureDeciderLabel(after)}の記名を要する)`,
        1,
        0,
        null,
        { stageBack: true }
      );
    } else {
      push(`回答 ${k}: ${b} → ${v}(区分を下げる。根拠の記録を要する)`, 1, 0);
    }
  }

  const becameUnmet = (key) => after.gates?.[key]?.state === 'unmet' && before.gates?.[key]?.state !== 'unmet';

  // 体制の縮小(人の離脱)だけが入力の変化であるとき、チーム規模の回答から導かれるゲート・承認数・
  // ブランチ保護の変化は、緩める向きの決定ではなく事実の帰結である。記名を待たずに反映する(第3章 3.13.3)。
  // ステージや区分の入力も同時に変わる場合は、どの入力の帰結かを分けられないため、決定として扱う
  const SIZE_ORDER = ['size-1-2', 'size-3-9', 'size-10plus'];
  const changedAnswers = [...new Set([...Object.keys(before.answers ?? {}), ...Object.keys(after.answers ?? {})])].filter(
    (k) => before.answers?.[k] !== after.answers?.[k]
  );
  const shrinkOnly =
    departure &&
    SIZE_ORDER.indexOf(after.answers?.['q-team-size']) < SIZE_ORDER.indexOf(before.answers?.['q-team-size']) &&
    changedAnswers.every((k) => k === 'q-team-size' || k === 'q-external-reviewer');
  // 独立レビュー(G-6)の未達が事実であるのは、人が減った結果、作成を指示する席の責任者のほかに、
  // 確認できる人が名簿に残っていない場合に限る。相手が残っているのに確認者を置かないのは決定である
  const author = personKey(after, seatIn(after, 'dev-verifier')?.accountable);
  // 組織上の任命権者は確認者ではない。数えない
  const others = (after.people ?? []).filter((p) => p.id !== author && p.appointer !== true).length;
  const g6Forced = departure && becameUnmet('g6') && others === 0;
  // 1名の体制では、席の兼務に選択の余地がない。兼務の逸脱を決定として扱わない
  const soleInsider = insiders(after).length === 1;
  /** 回答から導かれる値の変化。体制の縮小の帰結であれば、発生として扱う */
  const derived = (line, b, a) => {
    if (a < b && shrinkOnly) {
      diff.push(line);
      arising.push(`体制の縮小に伴う変化: ${line}`);
    } else push(line, b, a);
  };
  /** 独立レビューの未達に伴う変化。人が減って確認者がいなくなった場合に限り、発生として扱う */
  const g6Bound = (line, b, a) => {
    if (a < b && g6Forced) {
      diff.push(line);
      arising.push(`未達の発生に伴う変化: ${line}(承認する人がいない)`);
    } else if (a < b && becameUnmet('g6')) {
      push(`${line}(人は減っていない、または確認できる人が名簿に残っている。独立レビューを置かない決定である)`, b, a);
    } else derived(line, b, a);
  };

  // 規模の境界で変わる設定(レビューの方式、出荷判定者の方式)。並びは統制の弱い順
  const PARAM_RANK = {
    approverMode: ['value-owner-merged', 'named-concurrent', 'dedicated-qa'],
    reviewMode: ['external', 'internal-separated', 'internal-plus-core-external'],
  };
  for (const [key, g] of Object.entries(after.gates)) {
    const b = before.gates?.[key]?.state;
    if (b !== g.state) {
      const line = `${g.label}: ${stateLabel(b ?? 'required')} → ${stateLabel(g.state)}`;
      if (key === 'g6') g6Bound(line, gateRank(b), gateRank(g.state));
      // 独立レビュー以外の未達(技術スタックが未確定のままステージが進んだ、など)は、入力の帰結として表示する
      else if (becameUnmet(key)) diff.push(line);
      else derived(line, gateRank(b), gateRank(g.state));
    }
    const bp = before.gates?.[key]?.params ?? {};
    for (const k of new Set([...Object.keys(bp), ...Object.keys(g.params ?? {})])) {
      const x = bp[k];
      const y = g.params?.[k];
      if (x === y) continue;
      const line = `${g.label} の設定 ${k}: ${x ?? 'なし'} → ${y ?? 'なし'}`;
      const order = PARAM_RANK[k];
      if (order && order.includes(x) && order.includes(y)) derived(line, order.indexOf(x), order.indexOf(y));
      else if (typeof x === 'number' && typeof y === 'number') derived(line, x, y);
      else diff.push(line);
    }
  }

  const ba = before.review?.requiredApprovals ?? 0;
  const aa = after.review?.requiredApprovals ?? 0;
  if (ba !== aa) g6Bound(`必須の承認数: ${ba} → ${aa}`, ba, aa);

  if ((before.ruleset ?? null) !== (after.ruleset ?? null)) {
    const line = `ブランチ保護: ${before.ruleset ?? 'なし'} → ${after.ruleset ?? 'なし'}`;
    g6Bound(line, RULESET_RANK[before.ruleset] ?? 0, RULESET_RANK[after.ruleset] ?? 0);
    remaining.push(
      after.ruleset
        ? `ブランチ保護を適用する(人が実行する。エージェントは実行しない): gh api repos/{owner}/{repo}/rulesets --input .github/rulesets/${after.ruleset}.json`
        : 'ブランチ保護の適用を外す場合は、人が実行する。外す理由を判断記録へ残す'
    );
  }

  // 規模の規則が分離を必須とした組(10名以上)
  const sepIds = (c) => new Set((c.separations ?? []).filter((s) => s.scope === 'team-size').map((s) => s.id));
  const roleName = (id) => seatIn(after, id)?.name ?? id;
  for (const s of (after.separations ?? []).filter((x) => x.scope === 'team-size')) {
    if (!sepIds(before).has(s.id)) push(`兼務禁止: ${s.roles.map(roleName).join(' × ')} を分離必須とする(10名以上)`, 0, 1);
  }
  for (const s of (before.separations ?? []).filter((x) => x.scope === 'team-size')) {
    if (!sepIds(after).has(s.id)) derived(`兼務禁止: ${s.roles.map(roleName).join(' × ')} の分離必須が外れる(10名未満)`, 1, 0);
  }

  // 未達と逸脱。消えた逸脱は例外の失効として挙げる(第3章 3.5.2 / ADR-0029)
  const keysOf = (list, keyFn) => new Set((list ?? []).map(keyFn));
  const unmetKey = (u) => u.gate;
  for (const u of after.unmet ?? []) {
    if (keysOf(before.unmet, unmetKey).has(u.gate)) continue;
    // 決定として扱う独立レビューの未達は、緩める向きの変更の側へ出ている
    if (u.gate !== 'g6' || g6Forced) arising.push(`未達の発生: ${u.label} — ${u.reason}`);
  }
  for (const u of before.unmet ?? []) {
    if (!keysOf(after.unmet, unmetKey).has(u.gate)) resolved.push(`未達の解消: ${u.label}`);
  }
  for (const d of after.deviations ?? []) {
    if (keysOf(before.deviations, deviationKey).has(deviationKey(d))) continue;
    // ゲートの逸脱(出荷判定者の兼務)は、チーム規模の回答から導かれる。席の兼務の逸脱は、席の入力から導かれる
    const fact = d.gate ? shrinkOnly : soleInsider;
    if (fact) {
      arising.push(`逸脱の発生: ${d.label} — ${d.rule}`);
      diff.push(`${d.label}: 逸脱が生じる`);
    } else {
      push(
        d.gate
          ? `${d.label}: 逸脱が生じる(人は減っていない。体制の入力を下げる決定である)`
          : `${d.label}: 逸脱が生じる(別の人を置ける体制で、同じ人が兼ねる決定である)`,
        1,
        0
      );
    }
  }
  for (const d of before.deviations ?? []) {
    if (!keysOf(after.deviations, deviationKey).has(deviationKey(d))) {
      expired.push(d.gate ? `例外の失効: ${d.label}(${d.source})。兼務を解く` : `逸脱の解消: ${d.label}`);
      push(`${d.label}: 逸脱が解消する`, 0, 1);
    }
  }

  // 出荷できない状態。決定ではなく事実であり、記名を待たずに反映する
  if (!before.shipBlocked && after.shipBlocked) {
    diff.push('出荷できない状態: なし → あり');
    arising.push(`出荷できない状態の発生: ${after.shipBlocked.reason}`);
    remaining.push(
      '出荷できない状態である。出荷判定(G-7)の証跡の集約は失敗する。体制を3名以上へ戻す、危害の帰結を設計で下げる、当該の機能を実施しない、のいずれかを人が決める(標準 第8章 軸E)'
    );
  } else if (before.shipBlocked && !after.shipBlocked) {
    diff.push('出荷できない状態: あり → なし');
    resolved.push('出荷できない状態の解消(体制が最小体制を満たした、または区分が変わった)');
  }

  // 人の名簿
  const rosterOf = (c) => Object.fromEntries((c.people ?? []).map((p) => [p.id, p]));
  const bp = rosterOf(before);
  const ap = rosterOf(after);
  const accountsOf = (p) => (Array.isArray(p.accounts) ? p.accounts : []).join(', ');
  // 名簿の既存の行の書き換え(K67 / 第3章 3.13.3)。氏名とアカウントの両方を変える変更は、別の人への差し替えであり
  // 拒否する(rosterSwaps)。氏名だけ、またはアカウントだけの変更は、同じ人の表記の変更として扱い、D-0 表1
  // 「体制と運用形態」の決定者の記名と理由を要する(renameItems)。変更記録へ旧い値と新しい値を残す(rosterEdits)
  const rosterSwaps = [];
  const renameItems = [];
  const rosterEdits = [];
  const priorDeciderRow = findPerson(before, (before.seats ?? []).find((s) => s.role === structureDeciderSeat(before))?.accountable);
  for (const [id, p] of Object.entries(ap)) {
    if (!bp[id]) diff.push(`人の名簿: 追加 ${p.name}${rosterTag(p)}`);
    else {
      const nameChanged = normName(bp[id].name) !== normName(p.name);
      const accountsChanged = accountsOf(bp[id]) !== accountsOf(p);
      if (bp[id].name !== p.name || rosterTag(bp[id]) !== rosterTag(p)) {
        diff.push(`人の名簿: 変更 ${bp[id].name}${rosterTag(bp[id])} → ${p.name}${rosterTag(p)}`);
      }
      if (accountsChanged) {
        diff.push(`人の名簿: ${p.name} のアカウント ${accountsOf(bp[id]) || '未記入'} → ${accountsOf(p) || '未記入'}`);
      }
      // 表記の変更を重ねて別の人へ移す経路を作らないため、直前の値に加えて、その行を名簿へ足したときの値と比べる(K74)。
      // 氏名とアカウントの両方が足したときの値と異なることになる変更は、2回に分けても差し替えとして拒否する
      const origin = rosterOrigin(before, bp[id]);
      const offOrigin = normName(origin.name) !== normName(p.name) && origin.accounts !== accountSetKey(p.accounts);
      if ((nameChanged && accountsChanged) || ((nameChanged || accountsChanged) && offOrigin)) {
        rosterSwaps.push({
          id,
          from: `${bp[id].name}(${accountsOf(bp[id]) || 'アカウント未記入'})`,
          to: `${p.name}(${accountsOf(p) || 'アカウント未記入'})`,
          ...(nameChanged && accountsChanged ? {} : { origin: `${origin.name}(${origin.accounts || 'アカウント未記入'})` }),
        });
      } else if (nameChanged || accountsChanged) {
        const field = nameChanged ? 'name' : 'accounts';
        // 席の責任者の行なら、その席を残す(変化点の記録・D-0 の改訂履歴・品質レポートの項目7 に出す。K74)
        const seats = (before.seats ?? []).filter((s) => s.accountable && findPerson(before, s.accountable)?.id === id).map((s) => s.name);
        const edit = {
          id,
          field,
          from: nameChanged ? bp[id].name : accountsOf(bp[id]) || null,
          to: nameChanged ? p.name : accountsOf(p) || null,
          ...(seats.length ? { seats } : {}),
        };
        rosterEdits.push(edit);
        renameItems.push({
          line: `人の名簿の表記の変更(${id}): ${field === 'name' ? '氏名' : 'アカウント'} ${edit.from ?? '未記入'} → ${edit.to ?? '未記入'}`,
          id,
          // 決定者本人の行の書き換えは、本人の記名では確定できない
          self: Boolean(priorDeciderRow) && priorDeciderRow.id === id,
        });
      }
    }
  }
  for (const [id, p] of Object.entries(bp)) if (!ap[id]) diff.push(`人の名簿: 削除 ${p.name}`);
  // 組織上の任命権者を名簿へ置く変更。決定者が体制に残っている間は、決定者の記名を要する(任命権者の
  // 名義で決定者を替える経路を、記名なしに作らせない)。決定者の席が空いている場合は、記名を待たずに置ける
  const priorDeciderHere = findPerson(after, (before.seats ?? []).find((s) => s.role === structureDeciderSeat(before))?.accountable);
  for (const [id, p] of Object.entries(ap)) {
    if (p.appointer !== true || bp[id]?.appointer === true) continue;
    if (priorDeciderHere) appointItems.push({ line: `人の名簿: ${p.name} を組織上の任命権者として置く`, seat: null, decider: true, roster: true });
    else remaining.push(`${p.name} を組織上の任命権者として名簿へ置いた。決定者の席が空いているため、記名を待たずに置いた。任命権者が記名できるのは、次の変化点からである`);
  }

  // D-0 表1 の決定者の席。決定者を変えるのは、変更前の決定者である
  const gov = (c) => ({
    structureDecider: structureDeciderSeat(c),
    catalogRegistrar: c.governance?.catalogRegistrar ?? structureDeciderSeat(c),
  });
  const registrarName = (id) => (id === 'b4' ? 'リリース判定会(B-4)' : roleName(id));
  if (before.governance) {
    // 決定者の席そのものを変える決定。任免と同じく、統制の向きにかかわらず、前任の決定者の記名を要する
    if (gov(before).structureDecider !== gov(after).structureDecider) {
      const line = `D-0 表1「体制と運用形態」の決定者: ${roleName(gov(before).structureDecider)} → ${roleName(gov(after).structureDecider)}`;
      diff.push(line);
      appointItems.push({ line, seat: null, decider: true, governance: true });
    }
    if (gov(before).catalogRegistrar !== gov(after).catalogRegistrar) {
      const line = `D-0 表1「標準変更カタログへの登録」の決定者: ${registrarName(gov(before).catalogRegistrar)} → ${registrarName(gov(after).catalogRegistrar)}`;
      diff.push(line);
      appointItems.push({ line, seat: null, decider: true, governance: true });
    }
    if ((before.governance.qaNotice ?? null) !== (after.governance?.qaNotice ?? null)) {
      // 品質保証部門の通知先(任意)。通知先を足すのは厳しくする向き、外すのは緩める向き
      const line = `D-0「品質保証部門の通知先」: ${before.governance.qaNotice ?? '定めない'} → ${after.governance?.qaNotice ?? '定めない'}`;
      push(line, before.governance.qaNotice ? 1 : 0, after.governance?.qaNotice ? 1 : 0);
    }
  }

  // 席。旧い構成(seats なし)は、全席が既定値であったものとして比べる
  const prevSeats = Object.fromEntries((before.seats ?? buildSeats()).map((s) => [s.role, s]));
  const ownedBy = Object.fromEntries(
    (after.roles ?? []).map((r) => [r.id, [...(r.gatesOwned ?? []), ...(r.gatesUnmet ?? [])]])
  );
  let credentials = false;
  let performerChanged = false;
  let modeChanged = false;
  // 席の責任者の任免(第3章 3.13.3「席の責任者の任免」)。任命・交代・後任の配置は、統制の向きに
  // かかわらず決定であり、D-0 表1「体制と運用形態」の決定者の記名と理由を要する。決定者の席の交代は、
  // 前任の決定者(体制から外れていれば、組織上の任命権者)の記名を要する。人が体制から外れて席が空く
  // ことは発生であり、記名を待たない
  const deciderRole = structureDeciderSeat(before);
  for (const s of after.seats ?? []) {
    const p = prevSeats[s.role] ?? {};
    const fromKey = personKey(before, p.accountable);
    const toKey = personKey(after, s.accountable);
    const sameName = Boolean(p.accountable) && Boolean(s.accountable) && personName(before, p.accountable) === personName(after, s.accountable);
    if ((p.accountable ?? null) !== (s.accountable ?? null) && ((fromKey && fromKey === toKey) || sameName)) {
      // 同じ人の表記だけの変更(id と氏名の書き換え)。任免ではない
      diff.push(`${s.name}: 責任者の表記 ${p.accountable} → ${s.accountable}(同じ人)`);
    } else if ((p.accountable ?? null) !== (s.accountable ?? null)) {
      const fromName = p.accountable ? personName(before, p.accountable) : null;
      const toName = s.accountable ? personName(after, s.accountable) : null;
      const line = `${s.name}: 責任者 ${fromName ?? '未記入'} → ${toName ?? '未記入'}`;
      if (!s.accountable && p.accountable && !findPerson(after, p.accountable)) {
        diff.push(`${line}(体制から外れた。席が空く)`);
        arising.push(`席が空く: ${s.name}(${fromName} が体制から外れた)`);
      } else {
        diff.push(line);
        appointItems.push({ line, seat: s.role, decider: s.role === deciderRole, from: fromName, to: toName });
      }
      credentials = true;
      if (s.accountable && p.accountable) {
        remaining.push(`${s.name}: 新任の責任者は暫定任命とする(標準 第3章 3.4.1)`);
      }
      const owned = (ownedBy[s.role] ?? []).map((k) => GATE_BY_KEY[k]?.label ?? k);
      if (owned.length) {
        candidates.push(`${s.name} が判定者となる ${owned.join(' / ')} の、仕掛かり中の判定(作成を指示した者と確認する者の関係が変わる)`);
      }
    }
    if (p.mode !== s.mode) {
      modeChanged = true;
      push(`${s.name}: 運用形態 ${MODE_LABEL[p.mode] ?? p.mode} → ${MODE_LABEL[s.mode]}`, -modeRank(p.mode), -modeRank(s.mode), s.role);
      candidates.push(`${s.name} の席で、仕掛かり中の変更の確認(人が事前に確かめる範囲が変わる)`);
    }
    if (performerKey(p.performer) !== performerKey(s.performer)) {
      diff.push(p.performer ? `${s.name}: 担い手の識別が変わる` : `${s.name}: AI の担い手を宣言する`);
      credentials = true;
      // 担い手を初めて宣言する席には、失効する測定値が無い。即時通知の対象は、識別の変更に限る
      if (p.performer) performerChanged = true;
      if (p.qualification) {
        expired.push(
          `適合性確認の失効: ${s.name}(担い手の識別が変わった)。` +
            (qualificationProblems(s).length ? '再確認まで協働を上限とする' : '同じ変化点で、新しい識別に対する再確認の記録が出された')
        );
      }
      // 再確認が済んでいても、委任へ戻すのは緩める向きの決定である(第5章 5.5.7)
      if (p.mode === 'delegated' && s.mode === 'delegated') {
        push(`${s.name}: 担い手の識別が変わった後も委任とする(再確認のうえ、委任へ戻す決定)`, 1, 0, s.role);
      }
    }
    // 適合性確認の記録だけが変わる変化点(再確認の記録の提出)も、構成の変更として記録する
    if (JSON.stringify(p.qualification ?? null) !== JSON.stringify(s.qualification ?? null)) {
      diff.push(
        `${s.name}: 適合性確認の記録 ${p.qualification ? `${p.qualification.confirmedAt} 実施` : 'なし'} → ${
          !s.qualification
            ? 'なし'
            : s.qualification.lapsed
              ? `${s.qualification.confirmedAt} 実施(承認が失効。記録は有効)`
              : `${s.qualification.confirmedAt} 実施(実施: ${s.qualification.performedBy} / 承認: ${s.qualification.approvedBy})`
        }`
      );
    }
    if (!p.qualification?.lapsed && s.qualification?.lapsed) {
      expired.push(`適合性確認の承認の失効: ${s.name}(${s.qualification.lapsed.reason})。承認し直すまで協働を上限とする`);
      remaining.push(
        `${s.name}: 適合性確認の承認者が交代したため、承認が失効した。確認の記録(事例と結果)は有効であり、再実施は要しない。` +
          `新しい責任者が記録を読み、承認し直す。委任の席を引き継ぐときは、入力へ "takeover": "${s.role}" と新しい責任者の decidedBy・reason を書く` +
          '(適合性確認の承認し直し、その席の規則の記名のし直し、委任への復帰を1つの入力で受け付ける)。承認だけなら seats.' +
          `${s.role}.qualification へ approvedBy だけを書く`
      );
    }
    if (!p.intent && s.intent) {
      diff.push(`${s.name}: 委任の宣言を保持する(規則が AI維持管理者の承認待ち。決定: ${s.intent.decidedBy})`);
      remaining.push(
        `${s.name}: 委任の宣言を保持している。承認待ちのあいだは協働として動く。残っている手続は、AI維持管理者の席の責任者による規則の承認(ruleApprovedBy)だけである。` +
          '承認が入った変化点で、委任が有効になる(宣言し直す必要はない)'
      );
    } else if (p.intent && !s.intent && s.mode !== 'delegated') {
      push(`${s.name}: 承認待ちの委任の宣言を取り下げる`, 0, 1);
    }
    if ((p.fallback ?? null) !== (s.fallback ?? null)) {
      diff.push(`${s.name}: AI が使えないときの扱い ${p.fallback ?? '未記入'} → ${s.fallback ?? '未記入'}`);
    }
    if (s.performer && qualificationProblems(s).length) {
      remaining.push(`${s.name}: 適合性確認(標準 第3章 3.4.2。実施は AI維持管理者、承認は席の責任者)。確認まで協働を上限とする`);
    }
  }
  if (credentials) {
    remaining.push('認証情報: 交代した責任者・担い手のトークンを失効させ、新しい担い手へ別のトークンを発行する(文脈の分離。標準 第3章 3.5.3)');
  }

  // 委任の範囲。規則の追加と、狭まると示せない書き換えは、範囲の拡大として扱う。
  // 範囲を狭める変更は厳しくする向きであり、即時に適用する(第5章 5.5.7)
  const bd = before.delegation ?? { allowed: false, rules: [] };
  const ad = after.delegation ?? { allowed: false, rules: [] };
  if (before.delegation && bd.allowed !== ad.allowed) {
    push(`委任の適用: ${bd.allowed ? '可' : '不可'} → ${ad.allowed ? '可' : '不可'}`, bd.allowed ? 0 : 1, ad.allowed ? 0 : 1);
    if (bd.allowed && !ad.allowed) {
      remaining.push(
        '委任を適用できない案件になった。抜き取り待ちの委任の変更(トレーラ `Delegated:` のある変更のうち、事後の抜き取りが済んでいないもの)を、協働の手続で全件確認し直す'
      );
    }
  }
  // 標準変更カタログへ登録した変更種別。登録した者の記名が、登録の決定の記録である
  const typeOf = (list) => Object.fromEntries((list ?? []).map((t) => [String(t?.id ?? '').trim(), t]));
  const bt = typeOf(bd.changeTypes);
  const at = typeOf(ad.changeTypes);
  for (const [id, t] of Object.entries(at)) {
    if (!(id in bt)) diff.push(`標準変更カタログ: 変更種別「${id}」を登録(登録した者: ${t.registeredBy ?? '未記入'})`);
    else if (JSON.stringify(bt[id]) !== JSON.stringify(t)) diff.push(`標準変更カタログ: 変更種別「${id}」の登録の記録を改める`);
  }
  for (const id of Object.keys(bt)) if (!(id in at)) push(`標準変更カタログ: 変更種別「${id}」を削除`, 0, 1);
  // 確約範囲とコア指定のパス。外すと、委任の対象にできる変更が広がる
  const bpp = bd.protectedPaths;
  const app = ad.protectedPaths;
  if (!Array.isArray(bpp) && Array.isArray(app)) {
    // 未宣言のあいだは、どの変更も委任に該当しない。宣言は、委任を適用できる状態へ進める決定である
    push(
      `確約範囲・コア指定のパスを宣言する(${app.length ? app.join(' / ') : 'なし'})。宣言するまでは、委任の条件5 を判定できず、どの変更も委任に該当しない`,
      1,
      0
    );
  } else if (Array.isArray(bpp) && Array.isArray(app)) {
    for (const g of app) if (!bpp.includes(g)) push(`確約範囲・コア指定のパス: 追加 ${g}`, 0, 1);
    for (const g of bpp) if (!app.includes(g)) push(`確約範囲・コア指定のパス: 削除 ${g}`, 1, 0);
  }

  if ((ad.rules ?? []).length && ad.allowed && !Array.isArray(ad.protectedPaths)) {
    remaining.push(
      '確約範囲とコア指定のパス(delegation.protectedPaths)を登録する(無ければ、空の一覧を明示する)。未宣言のあいだ、委任の条件5 を判定できないため、どの変更も委任に該当しない。' +
        `宣言は、${structureDeciderLabel(after)}の記名と理由を要する`
    );
  }
  const ruleOf = (list) => Object.fromEntries((list ?? []).map((r) => [r.id, r]));
  const br = ruleOf(bd.rules);
  const ar = ruleOf(ad.rules);
  // 規則の追加と範囲の拡大は、事前の承認という遮断を外す変更であり、統制の弱化として扱う(ADR-0038)。
  // 委任するという決定(席の責任者)とは別に、規則の変更を AI維持管理者が承認する
  const weakened = [];
  for (const [id, r] of Object.entries(ar)) {
    if (!(id in br)) {
      push(`委任の規則 ${id}: 追加`, 1, 0, r.seat);
      weakened.push(r);
      continue;
    }
    if (JSON.stringify(br[id]) === JSON.stringify(r)) continue;
    // 範囲の拡大の保持(承認済みの範囲は有効なまま、広げた部分だけが承認待ち)
    if (r.pendingChange && JSON.stringify(br[id].pendingChange ?? null) !== JSON.stringify(r.pendingChange)) {
      push(`委任の規則 ${id}: 範囲の拡大を宣言する(広げた部分は AI維持管理者の承認待ち。承認済みの範囲は有効なまま)`, 1, 0, r.pendingChange.seat ?? r.seat);
      weakened.push(r);
    } else if (br[id].pendingChange && !r.pendingChange && ruleChangeDirection(br[id], r) !== 'widen') {
      diff.push(`委任の規則 ${id}: 承認待ちだった範囲の拡大を取り下げる`);
    }
    const way = ruleChangeDirection(br[id], r);
    if (way === 'narrow') push(`委任の規則 ${id}: 範囲を狭める`, 0, 1);
    else if (way === 'same') {
      const approvalChanged = (br[id].approvedBy ?? null) !== (r.approvedBy ?? null);
      const bare = ({ pendingChange, lapsedApproval, approvedBy, approvedAt, ...rest }) => JSON.stringify(rest);
      if (approvalChanged) {
        diff.push(
          `委任の規則 ${id}: AI維持管理者の承認 ${br[id].approvedBy ?? '未記入'} → ${r.approvedBy ?? '未記入'}` +
            (r.lapsedApproval && !r.approvedBy ? '(承認した AI維持管理者が交代したため、承認待ちへ戻る。規則を消さずに、新しい責任者が ruleApprovedBy で承認し直す)' : '')
        );
      } else if (bare(br[id]) !== bare(r)) diff.push(`委任の規則 ${id}: 記名・理由の変更(対象は変わらない)`);
    } else {
      push(`委任の規則 ${id}: 範囲を広げる、または変更種別・席を変える`, 1, 0, r.seat);
      weakened.push(r);
    }
  }
  for (const id of Object.keys(br)) {
    if (!(id in ar)) push(`委任の規則 ${id}: 削除`, 0, 1);
  }
  const pendingRules = (ad.rules ?? []).filter((r) => !r.approvedBy);
  if (weakened.length || pendingRules.length) {
    const ids = [...new Set([...weakened, ...pendingRules].map((r) => r.id))].join(' / ');
    const approved = [...new Set(weakened.filter((r) => r.approvedBy).map((r) => r.approvedBy))];
    remaining.push(
      `委任の規則(${ids})の追加・範囲の拡大は、統制の弱化として扱う。規則の変更を AI維持管理者(席の責任者)が承認する(\`state:needs-platform\`)。` +
        (pendingRules.length
          ? `承認の記名(ruleApprovedBy)が無い規則(${pendingRules.map((r) => r.id).join(' / ')})では、委任は働かない。承認済みの既存の規則による委任は、そのまま続く。席に有効な規則が1つも無ければ、席は協働として扱う。`
          : `承認者: ${approved.join(' / ')}(AI維持管理者の席で判断した)。`) +
        '検知した者は、差分が変更の主張と一致するかの確認に留め、許容可否を判断しない'
    );
  }
  // 規則は承認済みで、席の条件も揃っているのに、席が協働のまま残っている場合。残っている手続を示す
  const standby = [];
  for (const s of after.seats ?? []) {
    const rules = (ad.rules ?? []).filter((r) => r.seat === s.role);
    if (s.mode !== 'collab' || s.intent || !s.delegable || !rules.length || !ad.allowed) continue;
    const ready =
      s.accountable &&
      s.performer &&
      s.fallback &&
      !qualificationProblems(s).length &&
      rules.every((r) => !delegationRuleProblems(r, after).length && !ruleDeciderProblems(after, r).length && !ruleApprovalProblems(after, r).length);
    if (!ready) continue;
    const note =
      `${s.name}: 委任の規則(${rules.map((r) => r.id).join(' / ')})は承認済みだが、席の運用形態は協働のままである。` +
      `委任にするには、席の責任者の記名と理由をつけて、種別 mode で seats.${s.role}.mode を delegated にする(緩める向きの決定。規則の承認だけでは委任にならない)`;
    standby.push(note);
    remaining.push(note);
  }

  // 委任した変更をマージする経路についての注意
  if ((after.seats ?? []).some((s) => s.mode === 'delegated')) remaining.push(MERGE_PATH_NOTE);

  // 個別の値(種別 settings)。検査の下限を下げる向きは、緩める向きとして扱う
  const num = (v) => (typeof v === 'number' ? v : null);
  const setOf = (v) => new Set(Array.isArray(v) ? v : []);
  if (before.configured) {
    const M = RULE_APPROVER_SEAT;
    if ((before.adapters?.stack ?? 'none') !== (after.adapters?.stack ?? 'none')) {
      diff.push(`アダプタ(実装スタック): ${before.adapters?.stack ?? 'none'} → ${after.adapters?.stack ?? 'none'}`);
      remaining.push('実装スタックの確定・変更は技術判断者の判断である。判断記録(ADR)を残す(/adr-write)');
    }
    for (const k of ['projectId', 'profileName']) {
      if ((before[k] ?? null) !== (after[k] ?? null)) diff.push(`${k}: ${before[k] ?? 'なし'} → ${after[k] ?? 'なし'}`);
    }
    const bc = num(before.ci?.coverageThreshold);
    const ac = num(after.ci?.coverageThreshold);
    if (bc !== null && ac !== null && bc !== ac) push(`カバレッジの下限: ${bc}% → ${ac}%`, bc, ac, M);
    for (const [k, label, addLoosens] of [
      ['failOnSeverity', '失敗させる重大度', false],
      ['allowedLicenses', '許可するライセンス', true],
    ]) {
      const b = setOf(before.ci?.[k]);
      const a = setOf(after.ci?.[k]);
      const added = [...a].filter((x) => !b.has(x));
      const removed = [...b].filter((x) => !a.has(x));
      if (!added.length && !removed.length) continue;
      const loosens = addLoosens ? added.length > 0 : removed.length > 0;
      push(`${label}: ${[...b].join(', ') || 'なし'} → ${[...a].join(', ') || 'なし'}`, loosens ? 1 : 0, loosens ? 0 : 1, M);
    }
    for (const [k, label] of [
      ['maxChangedLines', '変更行数の上限'],
      ['maxChangedFiles', '変更ファイル数の上限'],
      ['selfHealMaxIterations', '自己修正ループの反復上限'],
    ]) {
      const b = num(before.task?.[k]);
      const a = num(after.task?.[k]);
      if (b !== null && a !== null && b !== a) push(`${label}: ${b} → ${a}`, -b, -a, M);
    }
    const guardOn = (c) => c.guard?.enabled !== false;
    const bg = before.guard ?? null;
    const ag = after.guard ?? null;
    if (JSON.stringify(bg) !== JSON.stringify(ag)) {
      const line = `強制層の緩和設定(guard): ${bg ? JSON.stringify(bg) : 'なし'} → ${ag ? JSON.stringify(ag) : 'なし'}`;
      const weaker = (guardOn(before) && !guardOn(after)) || (!guardOn(after) && String(ag?.reviewBy ?? '') > String(bg?.reviewBy ?? ''));
      const stronger = !guardOn(before) && guardOn(after);
      push(line, weaker ? 1 : 0, stronger ? 1 : 0, M);
    }
    if (JSON.stringify(before.platform ?? null) !== JSON.stringify(after.platform ?? null)) {
      diff.push(`成果物の配布先: ${before.platform?.host ?? 'なし'} → ${after.platform?.host ?? 'なし'}`);
    }
    const sourcing = (c) => Object.fromEntries((c.unmet ?? []).map((u) => [u.gate, u.reviewSourcing ?? null]));
    for (const [gate, v] of Object.entries(sourcing(after))) {
      if (gate in sourcing(before) && sourcing(before)[gate] !== v) {
        diff.push(`${GATE_BY_KEY[gate]?.label ?? gate} の確認者の調達先: ${sourcing(before)[gate] ?? '未記入'} → ${v ?? '未記入'}`);
      }
    }
  }

  if (stageBack) {
    remaining.push(
      '事業ステージを前へ戻す変更は、ステージ移行ゲート(SG)の判定による。判定記録(docs/gates/)を残し、その所在を変化点の sgRecord へ書く'
    );
  }

  // 責任者が未記入の席。判定者のいないゲートは、適用するまま止まる
  const blankSeats = (after.seats ?? []).filter((s) => !s.accountable);
  if (blankSeats.length) remaining.push(`責任者が未記入の席: ${blankSeats.map((s) => s.name).join(' / ')}`);
  for (const s of blankSeats) {
    const owned = (ownedBy[s.role] ?? []).filter((k) => isActiveState(after.gates?.[k]?.state)).map((k) => GATE_BY_KEY[k]?.label ?? k);
    if (!owned.length) continue;
    remaining.push(
      `${s.name} の責任者が未記入のため、${owned.join(' / ')} は「適用する」のまま、判定できる人がいない。` +
        '後任を置く、外部の確認者を名簿へ記入して置く(external: true)、残った人が兼ねる(1〜2名の体制では、未達または逸脱として記録される)、のいずれかを /process-change で反映する'
    );
  }
  if (!(after.people ?? []).length) {
    remaining.push(
      '人の名簿(people[])が未記入。人が /process-change の people で記入する。名簿が無いあいだ、席を委任にできず、緩める向きの決定を受け付けない'
    );
  }
  // 1人 → 2人。相互の確認で独立レビューを置けるようになったのに、回答が「確認者なし」のまま残る場合
  if (
    insiders(after).length === 2 &&
    insiders(before).length !== 2 &&
    after.answers?.['q-team-size'] === 'size-1-2' &&
    after.answers?.['q-external-reviewer'] === 'reviewer-no'
  ) {
    remaining.push(
      '名簿の体制内の人が2名になったが、回答 q-external-reviewer は「確認者なし(reviewer-no)」のままである。' +
        '作成を指示していない側の人が確認できるなら、answers の q-external-reviewer を reviewer-yes へ改め、独立レビュアの席の責任者を相手にする(相互の確認で G-6 が成立する)。' +
        '席だけを書き換えても、回答が「確認者なし」のあいだ、G-6 は未達のまま残る'
    );
  }

  // 即時通知の対象(第3章 3.13.6)。権限の一時制限(第7章 7.9)の発動は構成に現れないため、種別 notice で記録する
  const noticeReasons = [];
  if ((before.answers?.['q-team-size'] ?? null) !== (after.answers?.['q-team-size'] ?? null)) noticeReasons.push('人数の境界の通過');
  if (modeChanged) noticeReasons.push('運用形態の変更');
  if (performerChanged) noticeReasons.push('検出の層に数えている AI の担い手の識別の変更(検出率の測定値が失効する)');
  // 事象5: 独立レビュー(G-6)が成立から未達・成立しないへ変わる変化。人数の境界を通過しない変化を含む
  if (g6Established(before) && !g6Established(after)) noticeReasons.push('独立レビュー(G-6)が成立から未達・成立しないへ変わった');
  // 事象6: 出荷判定者の席の責任者の交代。前任者にも通知する(離脱済みなら、D-0 表1 の決定者へ)
  const qaBefore = (before.seats ?? []).find((s) => s.role === 'qa-gatekeeper')?.accountable ?? null;
  const qaAfter = seatIn(after, 'qa-gatekeeper')?.accountable ?? null;
  const qaSwap = Boolean(qaBefore) && personKey(before, qaBefore) !== personKey(after, qaAfter);
  if (qaSwap) noticeReasons.push('出荷判定者の席の責任者の交代');
  // 出荷判定者の席の責任者の行の表記の変更は、事象6 と同じ扱いで通知を求める(K74。旧い値と新しい値は rosterEdits に残る)
  const qaRowId = qaBefore ? findPerson(before, qaBefore)?.id : null;
  if (!qaSwap && qaRowId && rosterEdits.some((x) => x.id === qaRowId)) noticeReasons.push('出荷判定者の席の責任者の行の表記の変更(事象6 と同じ扱い)');

  // 人へ戻る判定件数の見込み。直近30日の判定記録を、確定の形態ごとに数える
  const since = Date.now() - 30 * 86400000;
  const recent = readGateRecords().filter((r) => Date.parse((r.judgedAt ?? '').replace(' ', 'T')) >= since);
  if (recent.length) {
    const n = (m) => recent.filter((r) => r.mode === m).length;
    const none = recent.filter((r) => !Object.values(MODE_LABEL).includes(r.mode)).length;
    remaining.push(
      `人へ戻る判定件数の見込み(直近30日の判定記録 ${recent.length} 件): 人確定 ${n('人確定')} / 協働 ${n('協働')} / 委任 ${n('委任')} / 形態の記載なし ${none}`
    );
  } else {
    remaining.push('人へ戻る判定件数の見込み: 記録なし(直近30日の判定記録がない)');
  }

  const loosens = loosenItems.map((i) => i.line);
  // 初回の記入: 初期化の直後で、どの席にも責任者が記入されたことがない状態(全員が離脱して空いた状態を含めない)
  const allBlankBefore =
    (before.seats ?? []).every((s) => !s.accountable) &&
    !(before.changeLog ?? []).some((e) => (e?.diff ?? []).some((l) => /: 責任者 /.test(String(l))));
  // 名簿の表記の変更は、どの席にも責任者が記入されたことがない間(初回の記入より前)は、記名を要しない
  if (allBlankBefore) renameItems.length = 0;
  // 向き「発生」は、人が実際に減った変化点に限る。任免と名簿の表記の変更は、緩める向きを含まない場合に「任免の決定」とする
  const direction = loosens.length
    ? 'loosen'
    : appointItems.length || renameItems.length
      ? 'appoint'
      : departure && arising.length
        ? 'arising'
        : tightens.length
          ? 'tighten'
          : 'none';
  // D-0 表1 の決定者を変える決定は、変更前の決定者が行う
  // 比べる相手は変更後の名簿の人である(名簿の id を書き換えた変化点でも、同じ人を同じ人として扱う)
  const priorDeciderRef = seatIn(before, structureDeciderSeat(before))?.accountable;
  // 名簿の行(id)で同じ人を追う。決定者本人の行の氏名を書き換えた変化点でも、決定者は体制に残っている
  // (氏名の書き換えで「前任の決定者が体制から外れた」状態を作り、任命権者の記名へ切り替える経路を作らない)
  // 名簿の id だけを書き換えた(氏名は同じ)場合も、同じ人として追う
  const priorRow = findPerson(before, priorDeciderRef);
  const priorRowAfter = priorRow ? ((after.people ?? []).find((p) => p.id === priorRow.id) ?? findPerson(after, priorRow.name)) : null;
  const priorDecider = priorRowAfter
    ? priorRowAfter.id
    : priorRow
      ? priorRow.id
      : findPerson(after, priorDeciderRef)
        ? personKey(after, priorDeciderRef)
        : personKey(before, priorDeciderRef);
  // 前任の決定者が体制に残っているか(残っていなければ、組織上の任命権者の記名を受け付ける)
  const priorDeciderPresent = priorRow ? Boolean(priorRowAfter) : Boolean(priorDecider) && Boolean(findPerson(after, priorDeciderRef));
  // 通知先(第3章 3.13.6「通知先」)。出荷判定者の席の責任者と、事象6 の前任者または決定者
  const qaPrevPresent = qaSwap && Boolean(findPerson(after, qaBefore));
  const deciderAfter = seatIn(after, structureDeciderSeat(after))?.accountable ?? null;
  const noticeAlso = qaSwap
    ? qaPrevPresent
      ? [{ to: personName(before, qaBefore), role: 'predecessor' }]
      : deciderAfter
        ? [{ to: personName(after, deciderAfter), role: 'decider' }]
        : []
    : [];
  return {
    appointItems,
    renameItems,
    rosterSwaps,
    rosterEdits,
    allBlankBefore,
    priorDeciderPresent,
    noticeAlso,
    diff,
    loosens,
    loosenItems,
    tightens,
    direction,
    departure,
    stageBack,
    expired,
    arising,
    resolved,
    candidates,
    remaining,
    noticeReasons,
    standby,
    priorDecider,
  };
}

/**
 * 緩める向きの決定者を確かめる(標準 第5章 5.5.7 / 第3章 3.13.3)。問題の一覧を返す。
 * 決定できるのは、対象の席の責任者、または D-0 表1「体制と運用形態」の決定者(既定は事業決裁者の
 * 席の責任者)。AI の名義を受け付けない。決定者そのものを変える決定は、変更前の決定者が行う。
 */
export function deciderProblems(config, report, decidedBy, before = null) {
  const out = nameProblems(config, decidedBy, { requireRoster: true }).map((p) => `決定した者の記名を受け付けられません: ${p}`);
  const key = personKey(config, decidedBy);
  const seatName = (role) => (config.seats ?? []).find((s) => s.role === role)?.name ?? role;
  const decider = structureDeciderLabel(config);
  // 任免の決定(第3章 3.13.3「席の責任者の任免」)
  // 初回の記入(全席が未記入の状態からの記入)は、この変化点で「体制と運用形態」の決定者の席に記入される人の
  // 記名と理由で、1回の変化点として受け付ける(体制の人数に依らない)
  const firstDecider = personKey(config, (config.seats ?? []).find((s) => s.role === structureDeciderSeat(config))?.accountable);
  const soloFirst = report.allBlankBefore && Boolean(firstDecider) && firstDecider === key;
  // 組織上の任命権者の記名は、前任の決定者が体制から外れている場合に限る。この変化点で名簿へ足した任命権者は記名できない
  const appointerSigned = !report.priorDeciderPresent && isAppointer(config, decidedBy) && before && isAppointer(before, decidedBy);
  for (const item of report.appointItems ?? []) {
    if (soloFirst) continue;
    if (report.priorDeciderPresent ? report.priorDecider === key : appointerSigned) continue;
    const who = report.priorDeciderPresent
      ? '変更前の D-0 表1「体制と運用形態」の決定者'
      : '組織上の任命権者(前任の決定者が体制から外れている、または決定者の席が未記入のため。名簿に external: true と appointer: true で、この変化点より前に記載した人)';
    out.push(
      `「${item.line}」は席の責任者の任免(または決定者の変更)であり、決定できるのは${who}です("${decidedBy}" は該当しません)。` +
        (item.decider && !report.allBlankBefore ? '新任の決定者が、自分の任命を自分の記名で確定することはできません(初回の記入を除く)。' : '') +
        (report.allBlankBefore ? '全席が未記入の状態からの初回の記入は、この変化点で D-0 表1「体制と運用形態」の決定者の席に記入する人の記名と理由で受け付けます。' : '') +
        '離脱(席を空ける)だけの変化点は記名なしで反映できます。後任の任命は、別の変化点として決定者の記名と理由をつけて出します(標準 第3章 3.13.3)'
    );
  }
  // 名簿の表記の変更(K67)。決定者の記名と理由を要する。決定者本人の行の変更は、組織上の任命権者、または
  // 本人以外の席の責任者1名の記名を要する(本人の記名では確定できない)
  const otherHolders = new Set(
    (before?.seats ?? [])
      .map((s) => findPerson(before, s.accountable)?.id)
      .filter((id) => id && id !== report.priorDecider && (config.people ?? []).some((p) => p.id === id))
  );
  for (const item of report.renameItems ?? []) {
    const byAppointer = isAppointer(config, decidedBy) && before && isAppointer(before, decidedBy);
    if (item.self && report.priorDeciderPresent) {
      if (key !== report.priorDecider && (byAppointer || otherHolders.has(key))) continue;
      out.push(
        `「${item.line}」は、D-0 表1「体制と運用形態」の決定者本人の行の変更です。決定できるのは、組織上の任命権者(名簿に external: true と appointer: true で、` +
          `この変化点より前に記載した人)、または本人以外の席の責任者1名です("${decidedBy}" は該当しません)。本人の記名では確定できません(第3章 3.13.3)`
      );
      continue;
    }
    if (report.priorDeciderPresent ? report.priorDecider === key : byAppointer) continue;
    out.push(
      `「${item.line}」は同じ人の表記の変更であり、決定できるのは${
        report.priorDeciderPresent ? '変更前の D-0 表1「体制と運用形態」の決定者' : '組織上の任命権者(前任の決定者が体制から外れている、または決定者の席が未記入のため)'
      }です("${decidedBy}" は該当しません)。別の人を足すときは、既存の行を書き換えず、新しい id の行として足します(第3章 3.13.3)`
    );
  }
  for (const item of report.loosenItems) {
    if (allowedDeciders(config, item.seat).has(key)) continue;
    out.push(
      item.seat
        ? `「${item.line}」を決定できるのは、${seatName(item.seat)} の席の責任者、または${decider}です("${decidedBy}" はどちらでもありません)`
        : `「${item.line}」を決定できるのは、${decider}です("${decidedBy}" は該当しません)`
    );
  }
  return out;
}

/**
 * 委任した変更をマージする経路についての注意。委任の形は2つあり、協働として人の承認を待つのは、
 * G-6 の判定の時点を事後へ移す委任で、マージの実行が無効な場合に限る。開発者の席だけの委任は、
 * 独立レビュアが人として事前に承認し、現在のブランチ保護のままマージする
 */
export const MERGE_PATH_NOTE =
  '委任の形は2つある。開発者の席の規則にだけ該当する変更は、変更ごとの検証を担い手が行い、独立レビュアが人として事前に承認する。現在のブランチ保護のままマージできる。' +
  '独立レビュアの席の規則にも該当する変更(G-6 の判定の時点を事後へ移す委任)は、マージの実行が既定で無効であり、組織が有効化するまで協働として扱い、人の承認を待つ。' +
  '該当は、ワークフローが既定ブランチの構成と規則で判定する(行為する AI 自身には判定させない)。トレーラ Delegated: <規則ID> は、どちらの形でも書く';
/** 本文(ですます調)で使う形 */
export const MERGE_PATH_NOTE_POLITE =
  '委任の形は2つあります**。開発者の席の規則にだけ該当する変更は、変更ごとの検証を担い手が行い、独立レビュアが人として事前に承認します。現在のブランチ保護のままマージできます。' +
  '独立レビュアの席の規則にも該当する変更(G-6 の判定の時点を事後へ移す委任)は、マージの実行が既定で無効であり、組織が有効化するまで協働として扱い、人の承認を待ちます。' +
  '該当は、ワークフローが既定ブランチの構成と規則で判定します(行為する AI 自身には判定させません)。トレーラ `Delegated: <規則ID>` は、どちらの形でも書きます。';

export function renderChangeReport(report, clamps = [], config = null) {
  const L = [];
  const section = (title, items, empty) => {
    L.push(`## ${title}`);
    L.push('');
    if (items.length) for (const i of items) L.push(`- ${i}`);
    else L.push(`- ${empty}`);
    L.push('');
  };
  const seatName = (role) => (config?.seats ?? []).find((s) => s.role === role)?.name ?? role;
  const decider = config ? structureDeciderLabel(config) : '事業決裁者の席の責任者';
  section('構成の差分', report.diff, '構成の変更なし');
  section('失効するもの', report.expired, 'なし');
  section(
    '未達の発生・逸脱の発生(即時に反映する。決定ではないため、記名を要求しない。人が減った結果として生じたもの、選択の余地がないものに限る)',
    report.arising,
    'なし'
  );
  section('解消する未達・出荷できない状態', report.resolved, 'なし');
  section(
    '統制を緩める向きの変更(決定した者の記名と理由を要する)',
    report.loosenItems.map(
      (i) =>
        i.intent
          ? `${i.line} — 決定済み: ${i.intent.decidedBy}(${i.intent.at} の宣言。規則の承認により、この変化点で有効になる)`
          : `${i.line} — 決定できる者: ${
              i.seat ? `${seatName(i.seat)} の席の責任者、または${decider}` : decider
            }`
    ),
    'なし'
  );
  section(
    '席の責任者の任免・決定者の変更(統制の向きにかかわらず決定。記名と理由を要する)',
    (report.appointItems ?? []).map(
      (i) =>
        `${i.line} — 決定できる者: ${
          report.priorDeciderPresent ? '変更前の D-0 表1「体制と運用形態」の決定者' : '組織上の任命権者(前任の決定者が体制から外れている、または未記入)'
        }${report.allBlankBefore ? '。全席が未記入の状態からの初回の記入は、この変化点で決定者の席に記入する人の記名で受け付ける' : ''}`
    ),
    'なし'
  );
  if (report.renameItems?.length) {
    section(
      '人の名簿の表記の変更(同じ人の氏名またはアカウント。記名と理由を要する)',
      report.renameItems.map(
        (i) =>
          `${i.line} — 決定できる者: ${
            i.self && report.priorDeciderPresent
              ? '組織上の任命権者、または本人以外の席の責任者1名(決定者本人の行のため)'
              : report.priorDeciderPresent
                ? '変更前の D-0 表1「体制と運用形態」の決定者'
                : '組織上の任命権者(前任の決定者が体制から外れている、または未記入)'
          }`
      ),
      'なし'
    );
  }
  section('統制を厳しくする向きの変更(即時に適用する)', report.tightens, 'なし');
  section(
    '上限を超えるため引き下げた運用形態',
    clamps.map((c) => `${c.name}: ${MODE_LABEL[c.from]} → ${MODE_LABEL[c.to]}(${c.reason})`),
    'なし'
  );
  section('無効になった確認の候補(やり直しの要否は文脈オーナーが決める)', report.candidates, 'なし');
  section('残作業', report.remaining, 'なし');
  return L.join('\n');
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

/** AI が使えない期間の記録を1行にする */
export function outageText(o) {
  if (!o) return null;
  const head = Number.isInteger(o.closes) ? `継続中だった AI が使えない期間(changeLog[${o.closes}])を閉じた` : 'AI が使えない期間';
  return (
    `${head}: ${o.from} 〜 ${o.to ?? '継続中'}(その間の扱い: ${OUTAGE_HANDLING[o.handling] ?? o.handling}` +
    `${o.switched ? '。別の担い手へ一時的に切り替え、その間は委任を協働へ下げた' : ''})`
  );
}

/** 変化点の記録 i の「AI が使えない期間」。開始だけの記録は、後から閉じた記録の終了日を引く */
export function outageAt(config, i) {
  const o = (config.changeLog ?? [])[i]?.outage;
  if (!o || o.to || Number.isInteger(o.closes)) return o ?? null;
  const closed = outagePeriods(config).find((x) => x.index === i);
  return closed?.to ? { ...o, to: closed.to, handling: closed.handling } : o;
}

/** 変化点の記録 i の、即時通知の記録を1つの欄にする。後から追記された種別 notice の記録も引く */
export function noticeText(config, i) {
  const log = config.changeLog ?? [];
  const e = log[i];
  if (!e?.notice) return '対象外';
  const filled = (n) => Boolean(n?.to && n?.at);
  const n = filled(e.notice) ? e.notice : log.find((x) => x?.kind === 'notice' && x.noticeFor === i && filled(x.notice))?.notice;
  if (!n) return '未記入';
  const ROLE = { predecessor: '前任者', decider: '決定者', 'qa-dept': '品質保証部門' };
  const also = (n.also ?? e.notice.also ?? []).map((x) => `${x.to}(${ROLE[x.role] ?? x.role})`);
  // 名簿の人へ対応づかない名義(品質保証部門の通知先など)は、表示で区別する
  const to = n.noTarget || resolveSigner(config, n.to) ? n.to : `${n.to}(名簿の人でない名義)`;
  return `${to}${also.length ? `、${also.join('、')}` : ''} / ${n.at}${n.self ? '(通知する者と通知先が同一)' : ''}`;
}

// ------------------------------------------------ D-0 体制図の生成区間
//
// D-0 体制図のうち、構成から導ける欄(席・責任者・担い手・運用形態の表、委任の範囲、改訂履歴)は
// 生成区間とし、/process-change が書き換える。構成を正とする。人が書くのは、決定の理由と記名
// (変化点の入力 decidedBy / reason)だけである。二重に記入させない(標準 第3章 3.13.4)。

export const D0_FILE = 'docs/D-0-governance.md';
export const D0_SECTIONS = ['seats', 'performers', 'history'];
export const d0Marks = (key) => [`<!-- generated:d0-${key} start -->`, `<!-- generated:d0-${key} end -->`];

/** D-0 節1 の備考(席の役割)。様式の記述と同じ */
const D0_SEAT_NOTE = {
  'biz-approver': '投資とリリースを決裁する',
  'value-owner': '何を作るかを決める。G-2 / G-4 の判定者',
  'tech-lead': 'どう作るかを決める。G-3 の判定者',
  'dev-verifier': 'AI 生成物の検証と理解の維持',
  'independent-reviewer': 'G-6 の判定者。**作成を指示した本人は不可**',
  'qa-gatekeeper': 'G-7 の判定者。開発ラインとは分離する',
  'context-owner': '恒久層コンテキストの維持',
  'ai-maintainer': '強制層の設定・モデルの版の管理',
  'ai-ops': 'モデルの適合性の承認・予算上限・停止条件。AI 維持管理者と兼ねない',
};

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');

/** D-0 の生成区間1つの中身を返す。構成が未設定のときは、空欄の表を返す(様式の初期状態) */
export function renderD0Section(key, config) {
  const L = [];
  const seats = config.configured === false ? buildSeats() : (config.seats ?? []);
  const blank = config.configured === false;
  L.push('この区間は `process.config.json` から生成しています。**手で編集しないでください**。変えるときは `/process-change` を使います。');
  L.push('');
  if (key === 'seats') {
    L.push('| 役割 | 責任者(現任者) | 兼務 | 備考 |');
    L.push('| --- | --- | --- | --- |');
    const who = Object.fromEntries(seats.map((s) => [s.role, personKey(config, s.accountable)]));
    for (const s of seats) {
      const also = seats.filter((x) => x.role !== s.role && who[s.role] && who[x.role] === who[s.role]).map((x) => x.name);
      const name = blank ? '' : s.accountable ? personName(config, s.accountable) : '**未記入**';
      L.push(`| ${s.name} | ${cell(name)} | ${blank ? '' : also.join(' / ') || '—'} | ${D0_SEAT_NOTE[s.role] ?? ''} |`);
    }
    L.push('');
    L.push('人の名簿(`people[]`):');
    L.push('');
    L.push('| id | 氏名 | 区分 | リポジトリ上のアカウント |');
    L.push('| --- | --- | --- | --- |');
    const roster = config.people ?? [];
    for (const p of roster) {
      const accounts = (Array.isArray(p.accounts) ? p.accounts : []).join(', ') || '**未記入**';
      const kind = p.appointer === true ? '組織上の任命権者(体制の外。第3章 3.13.3)' : p.external ? '外部の確認者(体制の人数に数えない)' : '体制の内';
      L.push(`| \`${p.id}\` | ${cell(p.name)} | ${kind} | ${cell(accounts)} |`);
    }
    if (!roster.length) L.push('| | | | |');
  } else if (key === 'performers') {
    const FALLBACK = { human: '人へ戻す', stop: '止める' };
    const d = config.delegation ?? { allowed: false, blockedBy: [], rules: [] };
    L.push('| 役割 | 担い手(人 / AI の担い手の識別) | 運用形態(人確定 / 協働 / 委任) | 委任の範囲(機械の規則の所在) | 適合性確認の期限または失効条件 | AI が使えないときの扱い(人へ戻す / 止める) |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const s of seats) {
      const rules = (d.rules ?? []).filter((r) => r.seat === s.role).map((r) => `\`${r.id}\``);
      const scope = !s.delegable ? '委任しない' : blank ? '' : s.mode === 'delegated' ? rules.join(' ') : rules.length ? `${rules.join(' ')}(委任は有効でない)` : '—';
      const performer = blank
        ? ''
        : s.performer
          ? [s.performer.model, s.performer.instructions, s.performer.permissions].map((x) => x ?? '未記入').join(' / ')
          : '責任者本人(AI の担い手の宣言なし)';
      const q = blank
        ? ''
        : !s.performer
          ? '—'
          : !s.qualification
            ? '**未実施**(協働を上限とする)'
            : qualificationProblems(s).length
              ? `**失効または記録の不足**(${qualificationProblems(s)[0]}。協働を上限とする)`
              : `${s.qualification.confirmedAt} 実施(実施: ${s.qualification.performedBy} / 承認: ${s.qualification.approvedBy})。担い手の識別が変わった時点で失効する`;
      const mode =
        blank && s.modeCeiling !== 'human'
          ? ''
          : (MODE_LABEL[s.mode] ?? s.mode) + (s.intent ? `(委任を宣言済み。規則の承認待ち。決定: ${cell(s.intent.decidedBy)})` : '');
      L.push(`| ${s.name} | ${cell(performer)} | ${mode} | ${scope} | ${cell(q)} | ${blank ? '' : FALLBACK[s.fallback] ?? (s.performer ? '**未記入**' : '—')} |`);
    }
    L.push('');
    L.push('委任の範囲(`delegation`):');
    L.push('');
    if (blank) {
      L.push('- 構成が未設定のため、まだ生成されていない');
    } else if (!d.allowed) {
      L.push(`- この案件では委任を適用できない(${(d.blockedBy ?? []).join('、')})`);
    } else {
      L.push('| 規則 | 席 | 変更の種別 | 対象のパス | 除外するパス | 決定した者(席の責任者) | 規則の承認(AI 維持管理者) | 理由 |');
      L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const r of d.rules ?? []) {
        const seat = seats.find((s) => s.role === r.seat)?.name ?? r.seat;
        const paths = (list) => (list ?? []).map((p) => `\`${p}\``).join(' ') || '—';
        const approval = r.approvedBy
          ? r.approvedBy
          : r.lapsedApproval
            ? `**承認待ち**(承認した ${r.lapsedApproval.approvedBy} が AI維持管理者の席を離れた。この規則では委任は働かない)`
            : '**未承認**(この規則では委任は働かない)';
        const held = r.pendingChange ? `。**範囲の拡大が承認待ち**(対象 ${paths(r.pendingChange.paths)}、決定: ${r.pendingChange.decidedBy}。承認済みの範囲は有効)` : '';
        L.push(
          `| \`${r.id}\` | ${seat} | ${cell(r.changeType ?? '—')} | ${paths(r.paths)} | ${paths(r.excludePaths)} | ${cell(r.decidedBy ?? '**未記入**')} | ${cell(approval + held)} | ${cell(r.reason ?? '**未記入**')} |`
        );
      }
      if (!(d.rules ?? []).length) L.push('| — | — | — | — | — | — | — | 規則なし(委任なし) |');
      L.push('');
      const catalog = d.changeTypes ?? [];
      L.push(
        `- 標準変更カタログへ登録した変更種別: ${
          catalog.length ? catalog.map((t) => `${cell(t.id)}(登録: ${cell(t.registeredBy ?? '未記入')}、${t.registeredAt ?? '日付なし'})`).join(' / ') : 'なし'
        }`
      );
      L.push(
        `- 確約範囲とコア指定のパス: ${
          !Array.isArray(d.protectedPaths)
            ? '未宣言(委任の条件5 を判定できないため、どの変更も委任に該当しない)'
            : d.protectedPaths.length
              ? d.protectedPaths.map((g) => `\`${g}\``).join(' ')
              : 'なし(「確約範囲・コア指定なし」と宣言済み)'
        }`
      );
    }
  } else if (key === 'history') {
    L.push(
      '| 日付 | 変化点の種別 | 概要 | 変更前後の版 | 兼務禁止と独立性の再判定の結果 | 無効になった確認(やり直しの要否) | 失効した確認と例外(再確認の期日) | 決定した者(理由) | 通知先と通知日(即時の通知を要する事象) |'
    );
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const log = blank ? [] : (config.changeLog ?? []);
    log.forEach((e, i) => {
      // 個別の値の変更は体制の変化点ではない。構成の変更記録(changeLog[])にだけ残す。
      // 過去の変化点の通知を埋める記録は、その変化点の行へ出す
      if (e.kind === 'settings' || (e.kind === 'notice' && e.noticeFor != null)) return;
      const kind =
        e.kind === 'init'
          ? '構成の生成'
          : e.kind === 'notice'
            ? '権限の一時制限の発動(変化点に数えない)'
            : (KIND_NOTE[e.kind] ?? `${e.changePoint}`) + (e.result === 'no-change' && e.kind !== 'outage' ? '。構成の変更なし' : '');
      const summary = [
        e.summary ?? '—',
        outageText(outageAt(config, i)),
        e.sgRecord ? `SG の判定記録: ${e.sgRecord}` : null,
        // 名簿の表記の変更は、旧い値と新しい値を出す(K74)
        e.rosterEdits?.length ? `名簿の表記の変更: ${e.rosterEdits.map(rosterEditText).join(' / ')}` : null,
      ]
        .filter(Boolean)
        .join('。');
      const invalidated = (e.invalidatedChecks ?? []).map((c) => `${c.target ?? c}(やり直し: ${c.redo === true ? '要' : c.redo === false ? '不要' : '未定'})`).join(' / ');
      const lapsed = [...(e.expired ?? []), e.recheckDue ? `再確認の期日: ${e.recheckDue}` : null].filter(Boolean).join(' / ');
      const decided = e.decidedBy
        ? `${e.decidedBy}(${e.reason ?? '理由の記載なし'})` +
          (e.appointerSigned ? '。決定者の任命を、組織上の任命権者の記名で行った' : '') +
          (e.ruleApprovedBy ? `。規則の承認: ${e.ruleApprovedBy}(AI 維持管理者の席)` : '')
        : e.direction === 'arising'
          ? '決定なし(発生)'
          : '—';
      L.push(
        `| ${String(e.date).slice(0, 10)} | ${kind} | ${cell(summary)} | ${e.d0Before ?? '—'} → ${e.d0After ?? '—'} | ${cell(e.separationRecheck ?? '—')} | ${cell(invalidated || '—')} | ${cell(lapsed || '—')} | ${cell(decided)} | ${cell(noticeText(config, i))} |`
      );
    });
    if (!log.length) L.push('| | | | | | | | | |');
  }
  return L.join('\n');
}

/** D-0 の生成区間を差し替える。目印の無い区間は missing へ入れる */
export function applyD0Sections(text, config) {
  const missing = [];
  let out = text;
  for (const key of D0_SECTIONS) {
    const [begin, end] = d0Marks(key);
    const b = out.indexOf(begin);
    const e = out.indexOf(end);
    if (b < 0 || e < 0 || e < b) {
      missing.push(key);
      continue;
    }
    out = out.slice(0, b) + begin + '\n\n' + renderD0Section(key, config) + '\n\n' + out.slice(e);
  }
  // 節3(決定の権限)の2行の決定者。構成(governance)を正とし、決定(1名)の欄だけを書き換える
  if (config.configured !== false) {
    for (const [title, name] of d0GovernanceRows(config)) {
      const re = new RegExp(`^(\\|\\s*${title}[^|]*\\|)[^|]*(\\|)`, 'm');
      if (re.test(out)) out = out.replace(re, `$1 ${name} $2`);
      else missing.push(`節3「${title}」の行`);
    }
  }
  return { text: out, missing };
}

/** D-0 節3(決定の権限)の2行と、構成から導いた決定者の名称 */
function d0GovernanceRows(config) {
  const nameOf = (id) => (id === 'b4' ? 'リリース判定会(B-4)' : ((config.seats ?? []).find((s) => s.role === id)?.name ?? id));
  return [
    ['体制と運用形態', nameOf(structureDeciderSeat(config))],
    ['標準変更カタログへの登録', nameOf(config.governance?.catalogRegistrar ?? structureDeciderSeat(config))],
  ];
}

/** D-0 の生成区間が構成と一致するかを確かめる。問題の一覧を返す */
export function d0SectionProblems(text, config) {
  const NAMES = { seats: '節1 役割の割り当て', performers: '節12 担い手と運用形態', history: '節13 改訂履歴' };
  const norm = (s) => s.replace(/\r\n/g, '\n').trim();
  const out = [];
  for (const key of D0_SECTIONS) {
    const [begin, end] = d0Marks(key);
    const b = text.indexOf(begin);
    const e = text.indexOf(end);
    if (b < 0 || e < 0 || e < b) {
      out.push(
        `D-0 の${NAMES[key]}に、生成区間の目印(${begin} / ${end})がありません。templates/00-d0-governance.md から目印の行を写し、` +
          '`node scripts/init/generate-profile.mjs --answers process.config.json` で区間を書き込んでください'
      );
    } else if (norm(text.slice(b + begin.length, e)) !== norm(renderD0Section(key, config))) {
      out.push(
        `D-0 の${NAMES[key]}の生成区間が、構成(process.config.json)と一致しません。この区間は手で編集しません。` +
          '体制を変えるときは /process-change、区間だけを戻すときは `node scripts/init/generate-profile.mjs --answers process.config.json` を使います'
      );
    }
  }
  return out;
}

/** D-0 表1 の決定者の欄に書かれる役割名を、席の ID へ対応づける */
const D0_ROLE_ALIASES = {
  'biz-approver': ['事業決裁者'],
  'value-owner': ['価値責任者'],
  'tech-lead': ['技術判断者'],
  'dev-verifier': ['開発者'],
  'independent-reviewer': ['独立レビュア'],
  'qa-gatekeeper': ['出荷判定者', '品質保証'],
  'context-owner': ['文脈オーナー', 'コンテキストオーナー'],
  'ai-maintainer': ['AI維持管理者'],
  'ai-ops': ['AI運用担当者'],
  b4: ['リリース判定会', 'B-4'],
};

/**
 * D-0 表1(決定の権限)の2行の決定者が、構成(governance)と一致するかを確かめる。
 * 緩める向きの決定者と、標準変更カタログへの登録者の検査は構成を読む。表1 の記入が構成と
 * 食い違うと、体制図に書いた決定者と、機械が受け付ける決定者がずれる
 */
export function d0GovernanceProblems(text, config) {
  const out = [];
  const squeeze = (s) => String(s ?? '').normalize('NFKC').replace(/[\s*]/g, '');
  const rows = [
    ['体制と運用形態', structureDeciderSeat(config)],
    ['標準変更カタログへの登録', config.governance?.catalogRegistrar ?? structureDeciderSeat(config)],
  ];
  for (const [title, want] of rows) {
    const line = text.split(/\r?\n/).find((l) => new RegExp(`^\\|\\s*${title}`).test(l));
    const wantName = want === 'b4' ? 'リリース判定会(B-4)' : ((config.seats ?? []).find((s) => s.role === want)?.name ?? want);
    if (!line) {
      out.push(`D-0 節3(決定の権限)に「${title}」の行がありません。templates/00-d0-governance.md から行を写し、決定者(${wantName})を記入してください`);
      continue;
    }
    const decider = squeeze(line.split('|')[2]);
    if (!decider) {
      out.push(`D-0 節3(決定の権限)の「${title}」の決定者が未記入です。構成では ${wantName} です`);
      continue;
    }
    if (!(D0_ROLE_ALIASES[want] ?? []).some((a) => decider.includes(squeeze(a)))) {
      out.push(
        `D-0 節3(決定の権限)の「${title}」の決定者(${line.split('|')[2].trim()})が、構成(governance)の ${wantName} と一致しません。` +
          '決定者を変えるときは、/process-change の governance で、変更前の決定者の記名と理由をつけて反映します'
      );
    }
  }
  return out;
}

/** D-0 の版を1つ進める。数字で終わらない版は進められない(null) */
export function bumpD0Version(v) {
  const m = String(v ?? '').match(/^(.*?)(\d+)$/);
  return m ? `${m[1]}${Number(m[2]) + 1}` : null;
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
  L.push('このファイルは `/process-init` が生成しました。**このファイルと `process.config.json` を、手で編集しないでください**。構成を書き換えるのは `/process-change` だけです。');
  L.push('体制・運用形態・軸の入力が変わったときは `/process-change` で変化点として反映してください。個別の値(アダプタ、CI の下限、調達先など)も `/process-change`(種別 `settings`)で変えます。');
  L.push('手で書き換えた構成は、変化点の記録(`changeLog[]`)の要約値と一致しなくなり、契約検査が失敗します。');
  L.push('');
  L.push(`- 案件 ID: \`${config.projectId}\``);
  L.push(`- 生成日時: ${config.generatedAt}`);
  L.push(`- 機械可読の構成: [\`process.config.json\`](./process.config.json)`);
  L.push('');

  // --- 出荷できない状態(未達より上に置く) ---
  if (config.shipBlocked) {
    L.push('## 出荷できない状態');
    L.push('');
    L.push(`**${config.shipBlocked.reason}**`);
    L.push('');
    L.push(`- 発生日: ${config.shipBlocked.since}`);
    L.push('- 出荷判定(G-7)の証跡の集約は失敗します。体制を3名以上へ戻す変化点(`/process-change`)で解除されます');
    L.push('- 選択肢は、体制を確保する、危害の帰結を設計で下げて区分を下げる(記録を要する)、当該の機能を実施しない、の3つです(標準 第8章 軸E)');
    L.push('');
  }

  // --- 未達(最上部に置く。隠す経路を持たない) ---
  if (config.unmet.length) {
    L.push('## 未達のゲート');
    L.push('');
    L.push('次のゲートは、**目的を達成する構成を示せていません**。省略ではありません。');
    L.push('');
    L.push('| ゲート | 未達の理由 | 代償措置 | 確認者の調達先 | 根拠 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const u of config.unmet) {
      L.push(
        `| ${u.label} | ${u.reason} | ${u.compensation.join(' / ')}${u.compensationNote ? `(${u.compensationNote})` : ''} | ${u.reviewSourcing ?? '**未記入**'} | ${link(u.source ?? '—', u.sourceUrl)} |`
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
  const gateDeviations = (config.deviations ?? []).filter((d) => d.gate);
  const seatDevs = (config.deviations ?? []).filter((d) => !d.gate);
  if (gateDeviations.length) {
    L.push('## 代償措置つきの逸脱');
    L.push('');
    L.push('次のゲートは**実施しますが、標準が要求する属性を欠いています**。未達ではありません。');
    L.push('');
    L.push('| ゲート | 抵触する規則 | 欠けるもの | 解消の時点 | 根拠 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const d of gateDeviations) {
      L.push(`| ${d.label} | ${d.rule} | ${d.reason} | ${d.resolveWhen} | ${link(d.source, d.sourceUrl)} |`);
    }
    L.push('');
    for (const d of gateDeviations) {
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

  // --- 兼務の逸脱(1〜2名の体制で成立しない兼務禁止。代償措置は定められていない) ---
  if (seatDevs.length) {
    L.push('## 兼務の逸脱');
    L.push('');
    L.push(
      '次の兼務は標準が禁止していますが、**1〜2名の体制では成立しないため、逸脱として記録しています**。' +
        '代償措置は定められていません。出荷判定者の兼務の例外(第3章 3.5.2)を、これらへ広げません。'
    );
    L.push('');
    L.push('| 兼務 | 欠けるもの | 扱い | 解消の時点 | 根拠 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const d of seatDevs) {
      L.push(`| ${d.label} | ${d.reason} | ${d.record} | ${d.resolveWhen} | ${link(d.source, d.sourceUrl)} |`);
    }
    L.push('');
  }

  // --- 事業ステージとステージ移行ゲート(SG) ---
  L.push('## 事業ステージとステージ移行ゲート(SG)');
  L.push('');
  L.push('標準プロセスには、開発の工程ゲート(G-1〜G-8)とは別に、投資継続を判断する**ステージ移行ゲート(SG-0〜SG-2)**が定義されています。');
  L.push('');
  L.push('| ステージ | 目的 | 移行ゲート | 対象とする状態 |');
  L.push('| --- | --- | --- | --- |');
  L.push('| **S0 探索** | 事業仮説と技術的実現性の検証 | **SG-0** | **事業仮説が実証データで支持されている**。技術的実現性が確認されている。次ステージの投資規模と体制が示されている |');
  L.push('| **S1 構築** | 最初の顧客向け(MVP)の構築とビジネス検証 | **SG-1** | 期待効果の検証、初期顧客の獲得、継続的な開発体制の確立 |');
  L.push('| **S2 拡大・運用** | プロダクトの成長、組織拡大、安定運用 | **SG-2** | 投資対効果の最大化、非機能要件の充足 |');
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
    L.push('- **目指すゲート**: **SG-0**(**事業仮説の実証**と技術的実現性の確認)');
    L.push('- **確認事項**: PoCは使い捨てる前提で最速で学ぶ段階です。次の MVP 構築へ移る前に、必ず技術的実現性と事業仮説の検証を終え、SG-0 の判定を受けてください。');
  } else if (phase === 'mvp') {
    L.push('- **現在の想定ステージ**: `S1 構築` (最初の顧客向け(MVP)段階)');
    L.push('- **通過済みの前提**: **SG-0**(**事業仮説の実証**と技術的実現性の確認)');
    L.push('- **目指すゲート**: **SG-1** (ビジネス実証)');
    L.push('- **注意**: 技術的実現性(採用技術が自社ドメインで実用精度を出すことなど)が未検証のまま MVP 工程に入ると、大きな手戻りリスクがあります。**「まだ一度も技術的実現性を検証していない(SG-0を通せる状態にない)」場合は、実態は S0 探索ステージです。** その場合は、`/process-change`(種別 `axis`)でステージを PoC(検証中)へ改め、SG-0 を目指すことを強く推奨します。ステージを前へ戻す変更は、D-0 表1「体制と運用形態」の決定者(既定は事業決裁者の席の責任者)の記名を要します。');
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
  if (a['q-external-reviewer']) L.push(`| 作成を指示した本人以外の確認者 | ${a['q-external-reviewer']} |`);
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
          // ただし書きは、兼務を認める例外とは限らない(1〜2名の体制で逸脱として記録する組を含む)
          return s.exception === 'none' ? name : `${name}(ただし書きあり)`;
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

  // --- ブロック2.6: 席ごとの責任者・担い手・運用形態 ---
  if (config.seats?.length) {
    L.push('## 席と運用形態');
    L.push('');
    L.push(
      '席(ロール)には、結果責任を負う**責任者**(記名の自然人)と、作業を実際に行う**担い手**がいます' +
        '([標準 第5章 5.5](https://takenori-kusaka.github.io/process-compass/phase4-process-design/human-ai-boundary/))。' +
        '**運用形態は上限の宣言です**。変更ごとのリスク区分の判定がそれを下げます(R1 は人確定、R2 は協働まで)。' +
        '宣言から「人の確認は要らない」を導かないでください。'
    );
    L.push('');
    L.push('### 人の名簿');
    L.push('');
    const roster = config.people ?? [];
    if (!roster.length) {
      L.push(
        '**未記入**です。名簿は、人が `/process-change` の `people` で記入します(D-0 体制図の節1 は、構成から生成されます)。' +
          '名簿が無いあいだ、席を委任にできず、統制を緩める向きの決定を受け付けません。'
      );
    } else {
      L.push('| id | 氏名 | 区分 | リポジトリ上のアカウント |');
      L.push('| --- | --- | --- | --- |');
      for (const p of roster) {
        const accounts = (Array.isArray(p.accounts) ? p.accounts : []).map((a) => `\`${a}\``).join(' ') || '**未記入**';
        L.push(`| \`${p.id}\` | ${p.name} | ${p.external ? '外部の確認者(体制の人数に数えない)' : '体制の内'} | ${accounts} |`);
      }
      L.push('');
      L.push(
        'アカウントが未記入の人の承認は、名簿と対応づけられないため、出荷判定の証跡で「独立した人の確認」に数えません。' +
          '**アカウントの記載が正しいかは、機械で確かめていません**(内部監査で確かめます)。'
      );
      for (const n of nameOverrides(config)) {
        L.push('');
        L.push(`**名義の機械検査を人が上書きした: ${n}**(AI を示す語に当たる氏名。人が自然人であることを確認した)`);
      }
    }
    L.push('');
    L.push(
      '責任者・決定した者・適合性確認の承認者は、この名簿と照合します。**AI の名義(モデル名、agent、bot、AI の表記)と、担い手の識別と同じ文字列は受け付けません**。' +
        '同じ語を含む実在の氏名は、人が確認したうえで `nameConfirmed: true` を書いた場合に限り通り、その旨を表示します。'
    );
    L.push('');
    L.push('### 席ごとの宣言');
    L.push('');
    L.push('| 席 | 責任者 | 運用形態(宣言) | 席の上限 | 担い手 | 適合性確認 | AI が使えないとき |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    const FALLBACK = { human: '人へ戻す', stop: '止める' };
    for (const s of config.seats) {
      const performer = s.performer
        ? [s.performer.model, s.performer.instructions, s.performer.permissions].map((x) => x ?? '未記入').join(' / ')
        : '責任者本人(AI の担い手の宣言なし)';
      const q = !s.performer
        ? '—'
        : !s.qualification
          ? '**未実施**(協働を上限とする)'
          : qualificationProblems(s).length
            ? '**失効または記録の不足**(協働を上限とする)'
            : `${s.qualification.confirmedAt} 実施`;
      L.push(
        `| ${s.name} | ${s.accountable ? personName(config, s.accountable) : '**未記入**'} | ${MODE_LABEL[s.mode] ?? s.mode}${
          s.intent ? `(委任を宣言済み。規則の承認待ち。決定: ${s.intent.decidedBy})` : ''
        } | ${MODE_LABEL[s.modeCeiling]} | ${performer} | ${q} | ${FALLBACK[s.fallback] ?? (s.performer ? '**未記入**' : '—')} |`
      );
    }
    L.push('');
    const d = config.delegation ?? { allowed: false, blockedBy: [], rules: [] };
    L.push('### 委任の範囲');
    L.push('');
    if (!d.allowed) {
      L.push(`この案件では委任を適用できません(${d.blockedBy.join('、')})。すべての変更を、人が変更ごとに確定します。`);
    } else if (!d.rules.length) {
      L.push('委任の範囲を定める機械の規則は登録されていません。**委任はありません**。');
    } else {
      L.push('| 規則 | 席 | 変更の種別 | 対象のパス | 決定した者(席の責任者) | 規則の承認(AI維持管理者) | 理由 |');
      L.push('| --- | --- | --- | --- | --- | --- | --- |');
      for (const r of d.rules) {
        const seat = config.seats.find((s) => s.role === r.seat)?.name ?? r.seat;
        L.push(
          `| \`${r.id}\` | ${seat} | ${r.changeType ?? '—'} | ${(r.paths ?? []).map((p) => `\`${p}\``).join(' ')} | ${r.decidedBy ?? '**未記入**'} | ${r.approvedBy ?? '**未承認**(この規則では委任は働かない)'} | ${r.reason ?? '**未記入**'} |`
        );
      }
    }
    L.push('');
    const catalog = d.changeTypes ?? [];
    L.push(
      `標準変更カタログへ登録した変更種別: ${
        catalog.length ? catalog.map((t) => `${t.id}(登録: ${t.registeredBy ?? '未記入'}、${t.registeredAt ?? '日付なし'})`).join(' / ') : '**なし**(規則を登録できません)'
      }`
    );
    L.push('');
    L.push(
      `確約範囲とコア指定のパス: ${
        !Array.isArray(d.protectedPaths)
          ? '**未宣言**(委任の条件5 を判定できないため、どの変更も委任に該当しません。該当するパスが無い場合は、空の配列を宣言します)'
          : d.protectedPaths.length
            ? d.protectedPaths.map((g) => `\`${g}\``).join(' ')
            : 'なし(「確約範囲・コア指定なし」と宣言済み)'
      }`
    );
    L.push('');
    L.push(
      '委任で移るのは判定の時点です。判定者は席の責任者のままです。**該当の判定は機械の規則で行い、行為する AI 自身に判定させません**。' +
        '委任は独立性の未達を解消しません。規則の変更種別は、標準変更カタログ(標準 第3章 3.7.4)に登録した種別に限ります(`delegation.changeTypes[]`)。' +
        '規則の追加と範囲の拡大は統制の弱化として扱い、席の責任者の決定に加えて、AI維持管理者の承認(`state:needs-platform`)を要します。' +
        '独立レビュー(G-6)の判定の時点が事後へ移るのは、独立レビュアの席が委任で、規則に該当し、リスク区分が R3 と記録された変更だけです。'
    );
    L.push('');
    L.push(`**${MERGE_PATH_NOTE_POLITE}`);
    L.push('');
    L.push('### 体制の変化点の記録');
    L.push('');
    L.push('| 日付 | 種別 | 概要 | 結果 | 向き | D-0 の版 | 決定した者 | 通知先と通知日(即時の通知を要する事象) |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    (config.changeLog ?? []).forEach((e, i) => {
      const kind = KIND_NOTE[e.kind] ?? `${e.changePoint ?? '—'} ${e.kind}`;
      const summary = [
        e.summary ?? '—',
        outageText(outageAt(config, i)),
        e.sgRecord ? `SG の判定記録: ${e.sgRecord}` : null,
        // 名簿の表記の変更は、旧い値と新しい値を出す(K74)
        e.rosterEdits?.length ? `名簿の表記の変更: ${e.rosterEdits.map(rosterEditText).join(' / ')}` : null,
      ]
        .filter(Boolean)
        .join('。');
      L.push(
        `| ${String(e.date).slice(0, 10)} | ${kind} | ${summary} | ${e.result === 'no-change' ? '構成の変更なし' : '変更あり'} | ${DIRECTION_LABEL[e.direction] ?? e.direction} | ${e.d0Before ?? '—'} → ${e.d0After ?? '—'} | ${e.decidedBy ?? '—'} | ${noticeText(config, i)} |`
      );
    });
    L.push('');
    const pending = pendingNotices(config);
    if (pending.length) {
      L.push(
        `**即時通知の記録が済んでいない変化点が ${pending.length} 件あります**。出荷判定者の席の責任者へ知らせ、通知先と通知日を \`/process-change\`(種別 \`notice\`)で記録してください。未記入のままでは、出荷判定の証跡の集約が記録の欠落として扱います。`
      );
      L.push('');
    }
    L.push(
      '種別の番号は、D-0 体制図「更新の契機」の1〜5 です。成立済みの判定記録は、変化点の後も書き換えません。' +
        '向きが「未達・逸脱の発生」の行は、人が減った結果の反映であり、決定ではありません(記名を要しません)。' +
        '各記録は、適用後の構成の要約値と、直前の記録の要約値を持ちます。記録を消す・書き換える・切り詰めると、契約検査が失敗します。'
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
  L.push(
    `| カバレッジの下限 | ${config.ci.coverageThreshold}%${
      config.ci.derivedCoverageThreshold != null && config.ci.derivedCoverageThreshold !== config.ci.coverageThreshold
        ? `(標準の導出値は ${config.ci.derivedCoverageThreshold}%。較正により変更)`
        : ''
    } |`
  );
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
  L.push('- 体制・運用形態・ステージが変わったら `/process-change` で反映する。**変化点の後、最初のゲート判定より前に行う**');
  L.push(`- **厳しくする方向の変更は即時に適用する**。緩める方向の変更は、決定した者の記名と理由を要する。決定できるのは、対象の席の責任者、または${structureDeciderLabel(config)}に限る`);
  L.push('- 人の離脱で統制が成立しなくなった変化は、緩める方向の決定ではなく、未達・逸脱の発生である。記名を待たず、即時に反映して表示する');
  L.push('- **人が減っていないのに、回答や席の入力で独立レビューや承認数を下げる変更は、緩める方向の決定である**。記名と理由を要する');
  L.push(`- 事業ステージを前へ戻す変更は、ステージ移行ゲート(SG)の判定による。${structureDeciderLabel(config)}の記名を要する`);
  L.push('- 納期だけの変更は変化点に数えない。起票された場合は「構成の変更なし」と記録する');
  L.push('- 納期を理由に統制を外す要求は、納期の変更ではなく、緩める方向の変更として扱う');
  L.push('- **`process.config.json` を手で編集しない**。構成を書き換えるのは `/process-change` だけである。個別の値(アダプタ、カバレッジの下限、許可するライセンス、変更規模の上限、強制層の緩和設定、配布先、確認者の調達先)は、種別 `settings` で変える。検査の下限を下げる向きは、決定した者の記名と理由を要する');
  L.push('- 変化点の記録(`changeLog[]`)は、適用後の構成の要約値を持つ。手で書き換えた構成と、記録を経ない再生成は、契約検査が検出して失敗させる。PR では基底ブランチの構成とも比べる');
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

  // --- ブロック6: 成果物の配布・共有先（Platform構成） ---
  L.push('## 成果物の配布・共有先（Platform構成）');
  L.push('');
  L.push('ピットイン方式で生成される成果物（決裁資料、レビュー資料、判定提示物など）のホスト・配布先設定です。');
  L.push('');
  L.push('| 項目 | 設定値 |');
  L.push('| --- | --- |');
  L.push(`| 配布先ホスト | \`${config.platform.host}\` |`);
  L.push(`| ホスト URL | ${config.platform.hostUrl ? `\`${config.platform.hostUrl}\`` : '*未指定（リポジトリ内管理）*'} |`);
  L.push('');
  L.push('**セキュリティポリシー**: 生成した成果物を組織外のパブリックなホスト（個人用 Claude Artifacts や公開 Pastebin など）へ置くことは、共有範囲の事前承認がない限り厳格に禁止されています（CLAUDE.md「行ってはならない作業」）。');
  L.push('');

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
  ['取り消せない操作(取り消せない時間帯が存在する操作。列挙は例示。ADR-0053)', 'オーナー(事業決裁者)', 'state:needs-owner'],
];

/**
 * CLAUDE.md へ差し込む構成依存部分を組み立てる。
 *
 * エージェントが起動時に読む文書は CLAUDE.md である。手書きのままでは標準の改訂も
 * 案件の構成も届かないため、構成へ依存する部分は導出物として差し替える(#220 / ADR-0035)。
 */
export function renderProcessRules(config) {
  if (config.configured === false) {
    return `## このプロジェクトの構成(自動生成)

この節は \`/process-init\` が \`process.config.json\` から生成します。**手で編集しないでください**。

プロセス構成が未設定のため、まだ生成されていません。\`/process-init\` を実行すると、有効なゲートと判定者、ロールごとの権限、担ってはならない工程、受信箱のラベルがここへ入ります。`.trim();
  }

  const L = [];
  L.push('## このプロジェクトの構成(自動生成)');
  L.push('');
  L.push(
    'この節は `process.config.json` から生成しています。**手で編集しないでください**。' +
      '内容を変えるときは `/process-change` で変化点として反映します。手で編集すると `check-process-rules` が失敗します。' +
      '**構成(`process.config.json`)も手で編集しないでください**。書き換える経路は `/process-change` だけです。' +
      '変化点の記録を経ない書き換えは、契約検査が検出して失敗させます。'
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

  if (config.shipBlocked) {
    L.push(`**出荷できない状態**: ${config.shipBlocked.reason}`);
    L.push('');
  }
  if (config.unmet?.length) {
    L.push('**未達のゲート**: ' + config.unmet.map((u) => `${u.label}(${u.reason})`).join(' / '));
    L.push('');
    L.push('未達は省略ではありません。**AI で埋めてはなりません**。');
    L.push('');
  }
  const gateDevs = (config.deviations ?? []).filter((d) => d.gate);
  const seatDevs = (config.deviations ?? []).filter((d) => !d.gate);
  if (gateDevs.length) {
    L.push('**代償措置つきの逸脱**: ' + gateDevs.map((d) => `${d.label}(${d.rule})`).join(' / '));
    L.push('');
  }
  if (seatDevs.length) {
    L.push('**兼務の逸脱**(1〜2名の体制。代償措置は定められていない): ' + seatDevs.map((d) => d.label).join(' / '));
    L.push('');
  }

  L.push('### ロールごとの権限');
  L.push('');
  L.push('**自分がどのロールのセッションかを確認してから作業を始めてください**。');
  L.push('分離は、作業領域・セッション・認証情報の3つがすべて分かれている場合にのみ成立します(標準 第3章 3.5.3)。');
  L.push('');
  L.push('| ロール | 判定するゲート | 判定してはならないゲート | 運用形態 | 受信箱 | 引き渡しに使うラベル |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  const seatOf = Object.fromEntries((config.seats ?? []).map((s) => [s.role, s]));
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
    const mode = MODE_LABEL[seatOf[r.id]?.mode] ?? '—';
    L.push(`| ${link(r.name, r.source)} | ${ownedCell} | ${notJudge || '—'} | ${mode} | ${inbox || '—'} | ${hands || '—'} |`);
  }
  L.push('');
  // 自席の運用形態と委任の範囲(第5章 5.5)。禁止だけを示して決めてよい範囲を示さないと、
  // 担い手は自分で決めてよい選択を判別できない
  const rules = config.delegation?.allowed ? (config.delegation.rules ?? []) : [];
  const delegated = (config.seats ?? []).filter((s) => s.mode === 'delegated');
  L.push('- **運用形態は上限の宣言です**。変更ごとのリスク区分がそれを下げます(R1 は人確定、R2 は協働まで)');
  if (delegated.length && rules.length) {
    L.push('- **委任の範囲**(`process.config.json` の `delegation.rules`。該当は機械の規則で判定します):');
    for (const s of delegated) {
      for (const r of rules.filter((x) => x.seat === s.role)) {
        L.push(`  - \`${r.id}\` ${s.name}: ${r.changeType ?? '—'}(${(r.paths ?? []).map((p) => `\`${p}\``).join(' ')})`);
      }
    }
    L.push(`- **${MERGE_PATH_NOTE}**`);
  } else {
    L.push('- **委任の範囲: なし**。人の事前確認(ゲートの判定)を経ずに先へ進めてよい変更は、この構成にありません');
  }
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
      let unit = 'その他';
      if (s.unit === 'per-change') {
        unit = '**変更ごと**';
      } else if (s.unit === 'per-project') {
        unit = '案件ごと（開始時に判定）';
      } else if (s.unit === 'per-stage') {
        unit = 'ステージごと（移行ゲートで再判定が必要）';
      } else if (s.unit === 'per-spec' || s.unit === 'per-feature') {
        unit = '機能ごと（G-4承認時に判定）';
      } else if (s.title.includes('設計審査会')) {
        unit = 'ステージ/機能ごと（S2移行またはG-4時に判定）';
      }
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
  L.push('| 取り消せない操作に当たる(取り消せない時間帯が存在する操作。ガード・検証ゲート・重要テストの削除を含み、例示の一覧に無いことを理由に外さない) | 上に加えて `state:needs-owner` |');
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
      return s.exception === 'none' ? n : `${n}(ただし: ${s.exception})`;
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
  const reject = (msg, details = []) => {
    console.error(`[エラー] ${msg}`);
    for (const d of details) console.error(`  - ${d}`);
    process.exit(1);
  };
  const dryRun = argv.includes('--dry-run');
  // 手元の時刻帯の日付。協定世界時の日付で書くと、人が書く日付(判定記録の判定日時など)と1日ずれる
  const today = localDay();
  // 暦に実在する日付に限る(2026-02-31 を受け付けない)
  const isDay = (v) => isRealDay(v);
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  /** 適合性確認の承認し直し。approvedBy だけを書いた入力(確認の記録は、既存のものを使う) */
  const isReapproval = (q) => isObject(q) && Boolean(q.approvedBy) && Object.keys(q).every((k) => k === 'approvedBy');

  // 設定済みの構成。体制の変化点は、この構成との差分として反映する
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
  } catch (e) {
    // ignore
  }
  const prior = existing?.configured === true ? existing : null;

  const changeFile = arg(argv, '--change', null);
  let change = null;
  if (changeFile) {
    try {
      change = JSON.parse(fs.readFileSync(changeFile, 'utf8'));
    } catch (e) {
      reject(`変化点の入力 ${changeFile} を読めません: ${e.message}`);
    }
    if (!isObject(change)) reject('変化点の入力は、JSON のオブジェクトで書きます');
  }

  // --- 変化点を経ない書き換えの検出(要約値の連鎖) ---
  // 構成を書き換えるのは /process-change だけである。手で書き換えた構成を、再生成や次の変化点で
  // 追認しない。要約値を持たない旧い構成は、最初の /process-change で連鎖を始める
  const HOW_TO_CHANGE = [
    '手での編集を戻す(git checkout -- process.config.json など)',
    '変えたい内容は /process-change で反映する: node scripts/init/generate-profile.mjs --change <file>',
    '個別の値(アダプタ、CI の下限、調達先など)は、種別 settings で変える',
  ];
  let chainStarts = false;
  if (prior) {
    const chain = chainProblems(prior);
    if (chain.problems.length) reject('構成を反映できません。変化点の記録と、現在の構成が一致しません', [...chain.problems, ...HOW_TO_CHANGE]);
    if (chain.legacy && !change) {
      reject('この構成は、変化点の記録(changeLog[])に要約値を持たない旧い構成です。回答ファイルからの再生成は受け付けません', [
        '最初の /process-change で、要約値の連鎖を始めます。変える内容が無い場合は、種別 settings の空の入力で始められます',
        '例: { "kind": "settings", "summary": "要約値の連鎖を始める" } を書いたファイルを --change へ渡す',
      ]);
    }
    chainStarts = chain.legacy;
  }

  // --- 入力の検査 ---
  const CONFIG_KEYS = ['answers', 'seats', 'delegation', 'people', 'governance', 'ruleApprovedBy', 'takeover'];
  const day = change?.date ?? change?.outage?.from ?? change?.outage?.to ?? today;
  // 最後の記録の発効日。これより前の日付の変化点は、記録の順序と食い違う
  const lastDay = String(prior?.changeLog?.at(-1)?.date ?? '').slice(0, 10) || null;
  if (change) {
    if (!prior) reject('設定済みの process.config.json がありません。先に /process-init を実行してください');
    if (!(change.kind in CHANGE_KINDS) || change.kind === 'init') {
      reject(`変化点の種別 "${change.kind}" は不正です`, [
        Object.keys(CHANGE_KINDS).filter((k) => k !== 'init').join(' / ') + ' のいずれかにしてください',
      ]);
    }
    for (const k of ['--stack', '--project-id', '--profile-name']) {
      if (argv.includes(k)) reject(`${k} は、変化点の入力と同時に指定できません。種別 settings の settings で指定してください`);
    }
    const bad = [];
    if (change.date !== undefined && !isDay(change.date)) bad.push(`date "${change.date}" は、暦に実在する日付を YYYY-MM-DD で書きます`);
    else if (change.date !== undefined && change.date > today) bad.push(`date "${change.date}" は未来の日付です。発効日は、変化が起きた日(今日 ${today} 以前)を書きます`);
    else if (change.date !== undefined && lastDay && change.date < lastDay) {
      bad.push(`date "${change.date}" は、最後の変化点の記録の日付(${lastDay})より前です。記録は発効日の順に追記します`);
    }
    if (change.recheckDue != null && !isDay(change.recheckDue)) bad.push(`recheckDue "${change.recheckDue}" は YYYY-MM-DD で書きます`);

    // 席
    if (change.seats !== undefined && !isObject(change.seats)) bad.push('seats は、席(ロール ID)をキーにしたオブジェクトで書きます');
    const knownSeats = prior.seats ?? buildSeats();
    for (const [role, v] of Object.entries(isObject(change.seats) ? change.seats : {})) {
      if (!knownSeats.some((s) => s.role === role)) {
        bad.push(`席 ${role} は構成にありません`);
        continue;
      }
      if (!isObject(v)) {
        bad.push(`seats.${role} はオブジェクトで書きます`);
        continue;
      }
      const unknown = Object.keys(v).filter((k) => !['accountable', 'mode', 'performer', 'fallback', 'qualification'].includes(k));
      if (unknown.length) bad.push(`seats.${role} に書けない欄があります(${unknown.join(', ')})。書けるのは accountable / mode / performer / fallback / qualification です`);
      if (v.mode !== undefined && !SEAT_MODES.includes(v.mode)) bad.push(`seats.${role}.mode "${v.mode}" は不正です。${SEAT_MODES.join(' / ')} のいずれかにしてください`);
      if (v.fallback != null && !['human', 'stop'].includes(v.fallback)) bad.push(`seats.${role}.fallback "${v.fallback}" は不正です。human(人へ戻す) / stop(止める) のいずれかにしてください`);
      if (v.accountable != null && typeof v.accountable !== 'string') bad.push(`seats.${role}.accountable は、人の名簿の氏名または id を文字列で書きます`);
      if (v.performer != null && !isObject(v.performer)) bad.push(`seats.${role}.performer は { model, instructions, permissions } で書きます。人が担う席は null です`);
      if (v.qualification != null) {
        if (!isObject(v.qualification)) bad.push(`seats.${role}.qualification はオブジェクトで書きます`);
        else {
          if (!isReapproval(v.qualification) && !isDay(v.qualification.confirmedAt)) {
            bad.push(`seats.${role}.qualification.confirmedAt(実施日)は、暦に実在する日付を YYYY-MM-DD で書きます(承認し直すだけなら、approvedBy だけを書きます)`);
          } else if (!isReapproval(v.qualification) && v.qualification.confirmedAt > (change.date ?? today)) {
            bad.push(`seats.${role}.qualification.confirmedAt "${v.qualification.confirmedAt}" は、変化点の発効日(${change.date ?? today})より後です。済んでいない確認は記録できません`);
          }
          if (v.qualification.lapsed !== undefined) bad.push(`seats.${role}.qualification.lapsed は入力できません(失効は、承認者の離脱からスクリプトが導きます)`);
        }
      }
    }

    // 軸の回答。知識ベースの設問と選択肢にあるものだけを受け付ける
    if (change.answers !== undefined && !isObject(change.answers)) bad.push('answers は、質問 ID をキーにしたオブジェクトで書きます');
    for (const [qid, oid] of Object.entries(isObject(change.answers) ? change.answers : {})) {
      const q = KB.questions.find((x) => x.id === qid);
      if (!q) bad.push(`answers の質問 ${qid} は知識ベースにありません`);
      else if (!q.options.some((o) => o.id === oid)) bad.push(`answers.${qid} の値 "${oid}" は不正です。${q.options.map((o) => o.id).join(' / ')} のいずれかにしてください`);
    }

    if (change.people !== undefined && !Array.isArray(change.people)) bad.push('people は配列で書きます(名簿の全体を置き換えます)');
    if (change.delegation !== undefined) {
      if (!isObject(change.delegation)) bad.push('delegation はオブジェクトで書きます');
      else {
        const unknown = Object.keys(change.delegation).filter((k) => !['rules', 'changeTypes', 'protectedPaths'].includes(k));
        if (unknown.length) bad.push(`delegation に書けない欄があります(${unknown.join(', ')})。書けるのは rules / changeTypes / protectedPaths です`);
        for (const k of ['rules', 'changeTypes', 'protectedPaths']) {
          if (change.delegation[k] !== undefined && !Array.isArray(change.delegation[k])) bad.push(`delegation.${k} は配列で書きます(一覧の全体を置き換えます)`);
        }
        for (const r of Array.isArray(change.delegation.rules) ? change.delegation.rules : []) {
          if (!isObject(r)) bad.push('delegation.rules の要素はオブジェクトで書きます');
        }
      }
    }
    if (change.governance !== undefined) {
      if (!isObject(change.governance)) bad.push('governance はオブジェクトで書きます');
      else {
        const seatIds = knownSeats.map((s) => s.role);
        const g = change.governance;
        if (g.structureDecider !== undefined && !seatIds.includes(g.structureDecider)) {
          bad.push(`governance.structureDecider "${g.structureDecider}" は席のロール ID ではありません(${seatIds.join(' / ')})`);
        }
        if (g.catalogRegistrar !== undefined && g.catalogRegistrar !== 'b4' && !seatIds.includes(g.catalogRegistrar)) {
          bad.push(`governance.catalogRegistrar "${g.catalogRegistrar}" は、b4(リリース判定会)または席のロール ID で書きます`);
        }
        if (g.qaNotice !== undefined && g.qaNotice !== null && !(typeof g.qaNotice === 'string' && g.qaNotice.trim())) {
          bad.push('governance.qaNotice(品質保証部門の通知先。任意)は、宛先を文字列で書きます。定めない場合は null です');
        }
        const unknownGov = Object.keys(g).filter((k) => !['structureDecider', 'catalogRegistrar', 'qaNotice'].includes(k));
        if (unknownGov.length) bad.push(`governance に書けない欄があります(${unknownGov.join(', ')})。書けるのは structureDecider / catalogRegistrar / qaNotice です`);
      }
    }
    if (change.notice !== undefined) {
      if (!isObject(change.notice)) bad.push('notice は { "to": "<通知先の氏名>", "at": "<通知日>" } で書きます');
      else if (change.notice.at != null) {
        // 通知日は、実在する日付で、未来でなく、通知の対象になった変化点の日付より前でない
        const target = change.kind === 'notice' && Number.isInteger(change.noticeFor) ? String(prior?.changeLog?.[change.noticeFor]?.date ?? '').slice(0, 10) : day;
        if (!isDay(change.notice.at)) bad.push(`notice.at "${change.notice.at}" は、暦に実在する日付を YYYY-MM-DD で書きます`);
        else if (change.notice.at > today) bad.push(`notice.at "${change.notice.at}" は未来の日付です。済んだ通知の日付を書きます`);
        else if (target && change.notice.at < target) bad.push(`notice.at "${change.notice.at}" は、通知の対象になった変化点の日付(${target})より前です`);
      }
    }
    if (change.takeover !== undefined && !(typeof change.takeover === 'string' && knownSeats.some((s) => s.role === change.takeover))) {
      bad.push(`takeover は、引き継ぐ席のロール ID を文字列で書きます(${knownSeats.map((s) => s.role).join(' / ')})`);
    }

    // 変化点に数えない種別。構成を変える入力と同時に出せない
    const extra = (keys) => keys.filter((k) => change[k] !== undefined);
    if (change.kind === 'outage') {
      // AI が使えない期間は変化点に数えない。期間とその間の扱いだけを記録する(第3章 3.13.2)
      const o = isObject(change.outage) ? change.outage : {};
      if (o.closes !== undefined) {
        // 開始だけを記録した期間を、後から閉じる。過去の記録は書き換えず、終了日を持つ記録を追記する
        const open = outagePeriods(prior).filter((x) => x.ongoing);
        const target = open.find((x) => x.index === o.closes);
        if (!target) {
          bad.push(
            `outage.closes ${JSON.stringify(o.closes)} は、継続中の「AI が使えない期間」の記録の添字ではありません。` +
              (open.length ? `継続中の記録: ${open.map((x) => `${x.index}(${x.from} 〜)`).join(' / ')}` : '継続中の記録はありません')
          );
        }
        if (!isDay(o.to)) bad.push('継続中の期間を閉じるときは、outage.to(終了日。YYYY-MM-DD)を書きます');
        else if (target && o.to < target.from) bad.push(`outage の期間が逆です(開始 ${target.from} / 終了 ${o.to})`);
        if (o.handling !== undefined && !(o.handling in OUTAGE_HANDLING)) bad.push('outage.handling は human(人へ戻した) / stop(止めた) のいずれかにしてください');
        if (o.from !== undefined || o.switched !== undefined || o.seats !== undefined) {
          bad.push('継続中の期間を閉じる入力には、from・switched・seats を書きません(開始の記録のものを使います)');
        }
      } else {
        if (!isDay(o.from)) bad.push('outage.from(開始日。YYYY-MM-DD)がありません');
        if (o.to != null && !isDay(o.to)) bad.push('outage.to は YYYY-MM-DD で書きます。継続中なら省略します(後から outage.closes で閉じます)');
        if (isDay(o.from) && isDay(o.to) && o.to < o.from) bad.push(`outage の期間が逆です(開始 ${o.from} / 終了 ${o.to})`);
        if (!(o.handling in OUTAGE_HANDLING)) bad.push('outage.handling は human(人へ戻した) / stop(止めた) のいずれかにしてください');
      }
      if (extra([...CONFIG_KEYS, 'settings']).length) {
        bad.push(`種別 outage では構成を変えられません(${extra([...CONFIG_KEYS, 'settings']).join(', ')} を外してください)。体制や運用形態を変える場合は、該当する種別で反映します`);
      }
    } else if (change.outage !== undefined) {
      bad.push('outage は種別 outage でだけ使えます');
    }
    if (change.kind === 'settings') {
      if (change.settings !== undefined && !isObject(change.settings)) bad.push('settings はオブジェクトで書きます');
      if (extra(CONFIG_KEYS).length) {
        bad.push(`種別 settings では体制を変えられません(${extra(CONFIG_KEYS).join(', ')} を外してください)。体制の変化点は、該当する種別で反映します`);
      }
    } else if (change.settings !== undefined) {
      bad.push('settings は種別 settings でだけ使えます');
    }
    if (change.kind === 'notice') {
      if (extra([...CONFIG_KEYS, 'settings']).length) bad.push(`種別 notice では構成を変えられません(${extra([...CONFIG_KEYS, 'settings']).join(', ')} を外してください)`);
      const pending = pendingNotices(prior);
      if (change.noticeFor !== undefined) {
        if (!pending.some((p) => p.index === change.noticeFor)) {
          bad.push(
            `noticeFor ${JSON.stringify(change.noticeFor)} は、即時通知の記録が済んでいない変化点の添字ではありません。` +
              (pending.length ? `未記入の変化点: ${pending.map((p) => `${p.index}(${String(p.date).slice(0, 10)} ${p.kind})`).join(' / ')}` : '未記入の変化点はありません')
          );
        }
        if (!(change.notice?.to && change.notice?.at)) bad.push('過去の変化点の通知を記録するときは、notice.to(通知先)と notice.at(通知日)の両方を書きます');
      } else if (change.event !== 'restriction') {
        bad.push('種別 notice は、noticeFor(通知を記録する変化点の添字)か、event: "restriction"(承認権限の一時制限の発動。標準 第7章 7.9)のいずれかを書きます');
      }
    } else if (change.noticeFor !== undefined || change.event !== undefined) {
      bad.push('noticeFor と event は種別 notice でだけ使えます');
    }
    if (bad.length) reject('変化点の入力を受け付けられません', bad);

    // 席の責任者の交代の後、その席の委任を新任者が引き継ぐ(第3章 3.13.3 / 3.4.2)。1つの入力で、
    // 適合性確認の承認し直し、その席の規則の決定の記名のし直し、委任への復帰を、新任者の記名と理由で受け付ける
    if (change.takeover !== undefined) {
      const role = change.takeover;
      const seat = (prior.seats ?? []).find((s) => s.role === role);
      const holder = seat?.accountable ?? null;
      const why = [];
      if (change.seats?.[role]?.accountable !== undefined) {
        why.push(`takeover と、同じ席の責任者の変更(seats.${role}.accountable)は同時に出せません。任命は D-0 表1 の決定者の記名で先に反映し、引き継ぎは新任者の記名で別の変化点として出します`);
      }
      if (!holder) why.push(`${seat?.name ?? role} の責任者が未記入です。先に責任者を任命します`);
      else if (!(change.decidedBy && change.reason)) why.push(`引き継ぎには、${seat.name} の席の責任者(${personName(prior, holder)})の記名(decidedBy)と理由(reason)が要ります`);
      else if (personKey(prior, change.decidedBy) !== personKey(prior, holder)) {
        why.push(`引き継ぎを記名できるのは、${seat.name} の席の責任者(${personName(prior, holder)})だけです("${change.decidedBy}" は該当しません)`);
      }
      if (why.length) reject('引き継ぎ(takeover)を受け付けられません', why);
      const rules = (change.delegation?.rules ?? prior.delegation?.rules ?? []).map((r) =>
        r.seat === role && personKey(prior, r.decidedBy) !== personKey(prior, holder)
          ? { ...r, decidedBy: change.decidedBy, decidedAt: day, reason: change.reason, priorDecision: { decidedBy: r.decidedBy, decidedAt: r.decidedAt ?? null } }
          : r
      );
      change.delegation = { ...(change.delegation ?? {}), rules };
      const input = { ...(change.seats?.[role] ?? {}) };
      if (seat.qualification && personKey(prior, seat.qualification.approvedBy) !== personKey(prior, holder) && input.qualification === undefined) {
        input.qualification = { approvedBy: change.decidedBy };
      }
      if (seat.delegable && rules.some((r) => r.seat === role) && input.mode === undefined) input.mode = 'delegated';
      change.seats = { ...(change.seats ?? {}), [role]: input };
    }
  }

  const answers = change ? { ...prior.answers, ...(change.answers ?? {}) } : readAnswers(argv);
  if (!change) {
    // 初期化と再生成の回答も、知識ベースの設問と選択肢で確かめる
    const bad = [];
    for (const [qid, oid] of Object.entries(answers)) {
      const q = KB.questions.find((x) => x.id === qid);
      if (!q) continue;
      if (!q.options.some((o) => o.id === oid)) bad.push(`${qid} の値 "${oid}" は不正です。${q.options.map((o) => o.id).join(' / ')} のいずれかにしてください`);
    }
    if (bad.length) reject('回答を受け付けられません', bad);
  }

  // 表示条件を満たさない質問への回答は落とす(engine と同じ扱い)
  const visible = new Set(visibleQuestions(KB.questions, answers).map((q) => q.id));
  for (const k of Object.keys(answers)) if (k !== 'q-product-type' && !visible.has(k)) delete answers[k];

  // --- 個別の値(アダプタ、CI の下限、変更規模の上限、強制層の緩和設定、配布先、調達先) ---
  // 設定済みの構成の値は、再生成で失わない。変えるときは、種別 settings の変化点による。
  // 初期化では、雛形の CI の値(較正されていない初期値)を引き継がない。標準の導出値を使う
  const S = change?.kind === 'settings' && isObject(change.settings) ? change.settings : {};
  {
    const bad = [];
    const unknown = Object.keys(S).filter((k) => !['stack', 'projectId', 'profileName', 'ci', 'task', 'guard', 'platform', 'reviewSourcing'].includes(k));
    if (unknown.length) bad.push(`settings に書けない欄があります(${unknown.join(', ')})`);
    if (S.stack !== undefined && !fs.existsSync(path.join(ROOT, 'adapters', `${S.stack}.json`))) bad.push(`settings.stack "${S.stack}" に対応する adapters/${S.stack}.json がありません`);
    const posInt = (v) => Number.isInteger(v) && v > 0;
    const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
    if (S.ci !== undefined && !isObject(S.ci)) bad.push('settings.ci はオブジェクトで書きます');
    if (S.ci?.coverageThreshold !== undefined && !(typeof S.ci.coverageThreshold === 'number' && S.ci.coverageThreshold >= 0 && S.ci.coverageThreshold <= 100)) {
      bad.push('settings.ci.coverageThreshold は 0〜100 の数値で書きます');
    }
    for (const k of ['failOnSeverity', 'allowedLicenses']) if (S.ci?.[k] !== undefined && !strList(S.ci[k])) bad.push(`settings.ci.${k} は文字列の配列で書きます`);
    if (S.task !== undefined && !isObject(S.task)) bad.push('settings.task はオブジェクトで書きます');
    for (const k of ['maxChangedLines', 'maxChangedFiles', 'selfHealMaxIterations']) {
      if (S.task?.[k] !== undefined && !posInt(S.task[k])) bad.push(`settings.task.${k} は正の整数で書きます`);
    }
    if (S.guard !== undefined && S.guard !== null) {
      if (!isObject(S.guard) || typeof S.guard.enabled !== 'boolean') bad.push('settings.guard は { "enabled": true / false, "reviewBy": "YYYY-MM-DD", "reason": "<理由>" } で書きます。設定を消すときは null です');
      else if (S.guard.enabled === false && !(isDay(S.guard.reviewBy) && S.guard.reason)) {
        bad.push('強制層を緩和する(guard.enabled: false)ときは、期限(reviewBy。YYYY-MM-DD)と理由(reason)を書きます');
      }
    }
    if (S.platform !== undefined && !isObject(S.platform)) bad.push('settings.platform はオブジェクトで書きます');
    if (S.reviewSourcing !== undefined && !isObject(S.reviewSourcing)) bad.push('settings.reviewSourcing は { "<ゲート>": "<調達先>" } で書きます');
    for (const [gate, v] of Object.entries(isObject(S.reviewSourcing) ? S.reviewSourcing : {})) {
      if (!(prior?.unmet ?? []).some((u) => u.gate === gate)) bad.push(`settings.reviewSourcing の ${gate} は、未達のゲートにありません`);
      // AI の確認は検出の層であり、未達を埋めない。AI を示す調達先を受け付けない
      else if (v != null && aiNameReason(v, { account: true })) {
        bad.push(`調達先 "${v}" は ${aiNameReason(v, { account: true })}。確認者は、作成を指示した本人以外の人に限ります。AI の確認は未達を埋めません`);
      }
    }
    if (bad.length) reject('個別の値の入力を受け付けられません', bad);
  }
  const kept = prior ?? {};
  const guardNow = S.guard !== undefined ? (S.guard ?? undefined) : (existing?.guard ?? undefined);
  const platformNow = { ...(existing?.platform ?? {}), ...(S.platform ?? {}) };
  const ciNow = { ...(kept.ci ?? {}), ...(S.ci ?? {}) };
  const taskNow = { ...(kept.task ?? {}), ...(S.task ?? {}) };

  // 席の記入・委任の規則・変化点の記録は、再生成で失わない。変化点の指定があれば上書きする
  const seatsInput = (prior?.seats ?? buildSeats()).map((s) => ({ ...s, ...(change?.seats?.[s.role] ?? {}) }));
  const delegationInput = { ...(prior?.delegation ?? {}), ...(change?.delegation ?? {}) };
  const peopleInput = change?.people ?? prior?.people ?? [];
  const governanceInput = { ...(prior?.governance ?? {}), ...(change?.governance ?? {}) };
  const priorSeat = Object.fromEntries((prior?.seats ?? []).map((s) => [s.role, s]));

  // 委任の規則の承認(ADR-0038)。追加・拡大した規則と、承認待ちの規則へ、今回の承認者を記録する。
  // 範囲を変えない規則と、狭めた規則は、既存の承認を引き継ぐ。承認は規則の入力からは受け取らない
  //
  // AI維持管理者の席の責任者が交代した場合、前任者が承認した規則は承認待ちへ戻る(第5章 5.5.7)。
  // 新しい責任者は ruleApprovedBy で承認し直せる。規則を消して足し直すことを要求しない。
  // 承認済みの規則の範囲を広げた場合、承認済みの範囲は有効なまま残し、広げた部分だけを承認待ちに
  // する(pendingChange。承認が入った変化点で規則へ反映する。K40 の趣旨)
  const approvedNow = [];
  // 承認待ちに戻った規則(AI維持管理者の交代)と、広げた部分を承認待ちとして保持した規則
  const approvalReturned = [];
  const widenHeld = [];
  // 承認により、保持していた範囲の拡大を反映した規則(決定者は拡大を宣言した者)
  const widenApplied = [];
  if (change) {
    const priorRules = Object.fromEntries((prior?.delegation?.rules ?? []).map((r) => [r.id, r]));
    const ctxAfter = { people: change.people ?? prior.people ?? [], seats: (prior.seats ?? []).map((s) => ({ ...s, ...(change.seats?.[s.role] ?? {}) })) };
    const maintainerKey = personKey(ctxAfter, ctxAfter.seats.find((s) => s.role === RULE_APPROVER_SEAT)?.accountable);
    const approvalValid = (p) => Boolean(p?.approvedBy) && personKey(ctxAfter, p.approvedBy) === maintainerKey;
    // 規則の入力に書いた承認の欄は使わない(承認は ruleApprovedBy だけから受け取る)
    const strip = ({ approvedBy, approvedAt, pendingChange, lapsedApproval, ...rest }) => rest;
    delegationInput.rules = (delegationInput.rules ?? []).map((input) => {
      const r = strip(input);
      const p = priorRules[r.id];
      const approveNow = (rule) => {
        approvedNow.push(rule.id);
        return { ...rule, approvedBy: change.ruleApprovedBy, approvedAt: day };
      };
      if (!p) return change.ruleApprovedBy ? approveNow(r) : { ...r, approvedBy: null, approvedAt: null };
      const base = strip(p);
      const way = ruleChangeDirection(base, r);
      if (way === 'widen') {
        if (change.ruleApprovedBy) return approveNow(r);
        if (approvalValid(p)) {
          // 承認済みの範囲(変更前の規則)を有効なまま残し、広げた部分を承認待ちとして保持する
          widenHeld.push(r.id);
          return { ...base, approvedBy: p.approvedBy, approvedAt: p.approvedAt ?? null, pendingChange: { ...r, at: day } };
        }
        return { ...r, approvedBy: null, approvedAt: null };
      }
      // 範囲を変えない入力で、保持している拡大がある場合。承認が入れば、拡大を反映する
      const held = way === 'same' && p.pendingChange ? p.pendingChange : null;
      if (held && change.ruleApprovedBy) {
        const { at, ...widened } = held;
        widenApplied.push({ id: r.id, seat: widened.seat, decidedBy: widened.decidedBy, reason: widened.reason, at });
        return approveNow(widened);
      }
      const keepHeld = held ? { pendingChange: held } : {};
      if (approvalValid(p)) return { ...r, approvedBy: p.approvedBy, approvedAt: p.approvedAt ?? null, ...keepHeld };
      if (change.ruleApprovedBy) return { ...approveNow(r), ...keepHeld };
      if (p.approvedBy) {
        // 承認した AI維持管理者が交代した。承認待ちへ戻し、前任者の承認を記録として残す
        approvalReturned.push(r.id);
        return { ...r, approvedBy: null, approvedAt: null, lapsedApproval: { approvedBy: p.approvedBy, approvedAt: p.approvedAt ?? null, at: day }, ...keepHeld };
      }
      return { ...r, approvedBy: null, approvedAt: null, ...(p.lapsedApproval ? { lapsedApproval: p.lapsedApproval } : {}), ...keepHeld };
    });
  }

  // 適合性確認を承認した席の責任者が交代した(離脱を含む)とき、承認は新しい責任者へ引き継がれない。
  // 失効するのは承認であり、担い手の識別が変わっていなければ、確認の記録(事例と結果)は有効なまま残る。
  // 離脱の変化点を止めず、承認し直すまで席を協働へ下げる(厳しくする向き。即時。第3章 3.13.3 / 第5章 5.5.7)
  const APPROVAL_LAPSED = '適合性確認の承認者が交代したため、承認が失効(記録は有効。新しい責任者の承認を要する)';
  const lapsedNow = [];
  // 新しい責任者が承認し直した席
  const reapproved = [];
  // 担い手の識別の変更と同時に出された再確認のうち、受け付けないもの
  const invalidRequal = [];
  // 担い手の識別が変わったため、委任を協働へ下げた席
  const performerDown = [];
  // 承認待ちのあいだ保持していた委任の宣言。規則の承認が入った変化点で有効にする
  const intentTried = {};
  const intentDropped = [];
  if (change) {
    const ctxNow = { people: peopleInput, seats: seatsInput, governance: governanceInput };
    const signed = Boolean(change.decidedBy && change.reason);
    for (const s of seatsInput) {
      const input = change.seats?.[s.role] ?? {};
      const p = priorSeat[s.role];
      const iq = input.qualification;
      const performerChanged = Boolean(p?.performer) && performerKey(p.performer) !== performerKey(s.performer);

      // 承認し直し。approvedBy だけを書いた入力は、既存の確認の記録へ、新しい承認者を書く。確認の再実施は要しない
      if (isReapproval(iq)) {
        if (!p?.qualification) reject(`${s.name}: 承認し直す適合性確認の記録がありません。確認の記録の全体を seats.${s.role}.qualification へ書いてください`);
        const { lapsed, ...record } = p.qualification;
        s.qualification = { ...record, approvedBy: iq.approvedBy, approvedAt: day };
        reapproved.push(s.role);
      }
      const q = s.qualification;
      if (q && !q.lapsed && !('qualification' in input) && q.approvedBy && personKey(ctxNow, q.approvedBy) !== personKey(ctxNow, s.accountable)) {
        s.qualification = { ...q, lapsed: { reason: APPROVAL_LAPSED, at: day } };
        lapsedNow.push(s.name);
      }

      // 承認待ちの宣言(委任)。新しい宣言・引き下げ・担い手の識別の変更・決定した者の交代があれば、保持しない
      if (s.intent) {
        if (input.mode !== undefined) delete s.intent;
        else if (performerChanged) {
          intentDropped.push(`${s.name}: 担い手の識別が変わった`);
          delete s.intent;
        } else if (!allowedDeciders(ctxNow, s.role).has(personKey(ctxNow, s.intent.decidedBy))) {
          intentDropped.push(`${s.name}: 委任を宣言した者(${s.intent.decidedBy})が、この席の決定者でなくなった`);
          delete s.intent;
        } else if (s.mode !== 'delegated') {
          intentTried[s.role] = s.intent;
          s.mode = 'delegated';
        }
      }

      // 担い手を初めて宣言する席は、識別の変更ではない。宣言より前に済ませた確認を受け付ける
      if (!performerChanged) continue;
      // 識別の変更と同じ変化点で出された適合性確認を有効とするのは、次をすべて満たす場合に限る。
      //   1. 記録の担い手の欄が、新しい識別と一致する
      //   2. 旧い記録の使い回しでない(確認日が、旧い記録の確認日より後である)
      //   3. 実施者が AI維持管理者の席の責任者、承認者が当該の席の責任者である
      //   4. 当該の席の責任者が、新しい識別で委任を続ける決定として記名し、理由を書く
      // 1つでも欠ければ、協働へ下げる。新しい版を採用する前に確認を済ませておく運用は妨げない
      let requalified = false;
      if (isObject(iq) && !isReapproval(iq)) {
        const why = [];
        if (performerKey(iq.performer) !== performerKey(s.performer)) why.push('記録の担い手の欄(performer)が、新しい識別と一致しない');
        if (p.qualification?.confirmedAt && !(String(iq.confirmedAt) > String(p.qualification.confirmedAt))) {
          why.push(`確認日(${iq.confirmedAt})が、旧い記録の確認日(${p.qualification.confirmedAt})より後でない。旧い記録の使い回しは受け付けない`);
        }
        const authority = qualificationAuthorityProblems(ctxNow, { ...s, qualification: iq });
        if (authority.length) why.push(authority[0]);
        if (why.length) {
          s.qualification = null;
          invalidRequal.push(`${s.name}: ${why.join('。')}`);
        } else requalified = true;
      }
      if (s.mode === 'delegated') {
        // 条件4 の記名は、当該の席の責任者に限る(D-0 表1 の決定者では足りない。第3章 3.4.2)
        const decider = signed && Boolean(s.accountable) && personKey(ctxNow, s.accountable) === personKey(ctxNow, change.decidedBy);
        if (!(requalified && decider)) {
          s.mode = 'collab';
          performerDown.push({
            name: s.name,
            why: !requalified
              ? '新しい識別に対する、有効な適合性確認の記録が無い'
              : !signed
                ? '新しい識別で委任を続ける決定の、記名と理由が無い'
                : `記名した者(${change.decidedBy})が、この席の責任者でない(条件4 の記名は当該の席の責任者に限る)`,
          });
        }
      }
    }
  }

  // 一時的な切り替えの間は担い手の識別が変わるため、委任を協働へ下げる(第3章 3.12.5)。
  // 切り替えが終わっても自動では戻さない。戻すときは緩める向きの手続による(第5章 5.5.7)
  const switchedDown = [];
  if (change?.kind === 'outage' && change.outage.switched) {
    const only = Array.isArray(change.outage.seats) ? new Set(change.outage.seats) : null;
    for (const s of seatsInput) {
      if (s.mode === 'delegated' && (!only || only.has(s.role))) {
        s.mode = 'collab';
        switchedDown.push(s.name);
      }
    }
  }

  // D-0 体制図の版。変化点を経ない再生成では、追随している版を進めない。版の追随は変化点の記録を伴う
  const d0Path = path.join(ROOT, D0_FILE);
  const d0InFile = readD0Version();
  if (d0InFile != null && !D0_VERSION_FORMAT.test(d0InFile)) {
    reject(`D-0 体制図(${D0_FILE})の版 "${d0InFile}" は、版の形式(N.N。例: 1.3)ではありません`, [
      'frontmatter の version を N.N の形式(半角数字。1.0.0・v1.1 は不可)へ改めてから、もう一度実行してください',
    ]);
  }
  const d0Version = change || !prior ? d0InFile : (prior.d0Version ?? null);

  let built;
  try {
    built = buildConfig(answers, {
      stack: S.stack ?? (prior ? (prior.adapters?.stack ?? 'none') : arg(argv, '--stack', 'none')),
      projectId: S.projectId ?? (prior ? (prior.projectId ?? 'P-001') : arg(argv, '--project-id', 'P-001')),
      profileName: S.profileName !== undefined ? S.profileName : prior ? (prior.profileName ?? null) : arg(argv, '--profile-name', null),
      seats: seatsInput,
      delegation: delegationInput,
      people: peopleInput,
      governance: governanceInput,
      // 設定済みの構成では、最小体制を割っても拒否せず、出荷できない状態として反映する。初期化では拒否する
      reflectBelowMinimum: Boolean(prior),
      shipBlockedSince: prior?.shipBlocked?.since ?? change?.date ?? null,
      // 原因は、立った時点のものを保つ。1〜2名の体制のまま区分が上がった場合と、人数が減った場合を書き分ける
      shipBlockedCause: prior?.shipBlocked ? (prior.shipBlocked.cause ?? 'headcount') : prior?.answers?.['q-team-size'] === 'size-1-2' ? 'criticality' : 'headcount',
      d0Version,
      // 変化点を経ない再生成は、構成を変えない。生成日時も引き継ぐ
      generatedAt: prior && !change ? prior.generatedAt : undefined,
      changeLog: prior?.changeLog,
      reviewSourcing: { ...Object.fromEntries((prior?.unmet ?? []).map((u) => [u.gate, u.reviewSourcing])), ...(S.reviewSourcing ?? {}) },
      guard: guardNow,
      allowedLicenses: ciNow.allowedLicenses,
      coverageThreshold: ciNow.coverageThreshold,
      // 変化点では、較正していない下限(導出値のまま)を、導出値の引き上げへ追随させる
      coverageUncalibrated:
        Boolean(change) && S.ci?.coverageThreshold === undefined && kept.ci?.derivedCoverageThreshold != null && kept.ci.coverageThreshold === kept.ci.derivedCoverageThreshold,
      failOnSeverity: ciNow.failOnSeverity,
      maxChangedLines: taskNow.maxChangedLines,
      maxChangedFiles: taskNow.maxChangedFiles,
      selfHealMaxIterations: taskNow.selfHealMaxIterations,
      platformHost: platformNow.host,
      platformHostUrl: platformNow.hostUrl,
    });
  } catch (e) {
    console.error(`[エラー] ${e.message}`);
    for (const d of e.details ?? []) console.error(`  - ${d}`);
    process.exit(1);
  }

  const { config, result, clamps } = built;
  // 構成へ記録を足したか。足した場合に限り、最後の記録へ要約値を書く
  let appended = !prior;

  // --- 変化点を経ない再生成(回答ファイルからの再生成) ---
  if (prior && !change) {
    // 変化点を経ない再生成で、軸の入力を変えない。差分も失効も記録されないまま構成が変わるため
    const canon = (a) => JSON.stringify(Object.entries(a ?? {}).sort(([x], [y]) => x.localeCompare(y)));
    if (canon(prior.answers) !== canon(config.answers)) {
      reject('設定済みの構成と回答が異なります。体制の変化点として反映してください', [
        '/process-change を使うか、node scripts/init/generate-profile.mjs --change <file> を実行する',
      ]);
    }
    for (const [flag, now] of [
      ['--stack', prior.adapters?.stack ?? 'none'],
      ['--project-id', prior.projectId ?? 'P-001'],
      ['--profile-name', prior.profileName ?? null],
    ]) {
      const v = arg(argv, flag, undefined);
      if (v !== undefined && v !== now) {
        reject(`${flag} ${v} は、設定済みの構成の値(${now ?? 'なし'})と異なります。変化点を経ない再生成では値を変えられません`, [
          '種別 settings の変化点で変えます: { "kind": "settings", "summary": "<何を変えたか>", "settings": { "stack": "<スタック>" } }',
        ]);
      }
    }
    // 再生成した構成が、最後の記録の要約値と一致する場合だけ通す。引数(--stack など)や
    // 知識ベースの更新で構成が変わる再生成は、記録を伴わない書き換えになる
    if (configDigest(config) !== prior.changeLog.at(-1).stateHash) {
      const differs = [...new Set([...Object.keys(prior), ...Object.keys(config)])]
        .filter((k) => k !== 'changeLog' && JSON.stringify(prior[k] ?? null) !== JSON.stringify(config[k] ?? null))
        .join(', ');
      reject('再生成すると、構成が変わります。変化点を経ない再生成は、構成を変えない場合だけ受け付けます', [
        `変わる欄: ${differs || '(キーの並びだけ)'}`,
        '引数(--stack / --project-id / --profile-name)で値を変える再生成はできません。種別 settings の変化点で変えます',
        'テンプレートや知識ベースの更新で導出が変わった場合も、/process-change で反映します(種別 settings の空の入力で再導出できます)',
      ]);
    }
    if (prior.d0Version == null && d0InFile != null) {
      // D-0 を作成して最初に版を取得した場合に限り、記録を足して追随する
      config.d0Version = d0InFile;
      config.changeLog = [
        ...config.changeLog,
        changeLogEntry({
          kind: 'init',
          date: localDay(),
          summary: 'D-0 体制図の版を取得した',
          result: 'no-change',
          d0Before: null,
          d0After: d0InFile,
        }),
      ];
      appended = true;
    } else if (d0InFile != null && String(d0InFile) !== String(prior.d0Version)) {
      console.log(
        `[注意] D-0 体制図の版(${d0InFile})が、構成の追随している版(${prior.d0Version})と異なります。` +
          '変化点を経ない再生成では版を進めません。/process-change で変化点として反映してください'
      );
    }
  }

  // --- 体制の変化点(標準 第3章 3.13 / 第8章「再テーラリングの契機」) ---
  if (change) {
    const seatOf = (role) => config.seats.find((s) => s.role === role);
    const signedNow = Boolean(change.decidedBy && change.reason);
    // 承認待ちのあいだ保持していた委任の宣言。規則の承認が入り、席の条件が揃えば、この変化点で有効にする
    const intentApplied = [];
    for (const [role, intent] of Object.entries(intentTried)) {
      const seat = seatOf(role);
      const clamp = clamps.find((c) => c.role === role);
      if (seat.mode === 'delegated') {
        delete seat.intent;
        intentApplied.push({ seat: role, name: seat.name, ...intent });
      } else if (!clamp?.pendingApproval) {
        // 承認待ち以外の理由で委任にできない。宣言を保持しない(条件を整えてから、宣言し直す)
        delete seat.intent;
        intentDropped.push(`${seat.name}: ${clamp?.reason ?? '委任の条件を満たさない'}`);
      }
    }
    // この変化点で委任を宣言したが、規則が承認待ちの席。宣言した意図と決定者を保持する
    for (const c of clamps.filter((x) => x.pendingApproval)) {
      // 委任していた席の規則を広げて承認待ちになった場合も、席の宣言は保持する
      const seat = seatOf(c.role);
      const ownRules = (config.delegation.rules ?? []).filter((r) => r.seat === c.role);
      const returnedOnly =
        change.seats?.[c.role]?.mode === undefined &&
        priorSeat[c.role]?.mode === 'delegated' &&
        ownRules.length &&
        ownRules.every((r) => approvalReturned.includes(r.id)) &&
        seat.accountable &&
        personKey(config, seat.accountable) === personKey(prior, priorSeat[c.role].accountable);
      if (returnedOnly) {
        // AI維持管理者の交代で規則の承認だけが承認待ちへ戻った。席の責任者の委任の決定は変わらないため、
        // 宣言として保持し、承認し直した変化点で委任へ戻す(席の責任者に宣言し直させない)
        seat.intent = {
          mode: 'delegated',
          decidedBy: personName(config, seat.accountable),
          reason: '委任の決定は有効なまま。AI維持管理者の交代で規則の承認が承認待ちへ戻ったため、承認し直すまで宣言として保持する',
          at: day,
          heldFor: 'approval-returned',
        };
      } else if (
        (change.seats?.[c.role]?.mode === 'delegated' || priorSeat[c.role]?.mode === 'delegated') &&
        signedNow &&
        allowedDeciders(config, c.role).has(personKey(config, change.decidedBy))
      ) {
        seat.intent = { mode: 'delegated', decidedBy: change.decidedBy, reason: change.reason, at: day };
      }
    }
    const report = diffConfig(prior, config);
    // 保持していた宣言による委任は、宣言した時点で決定済みである。今回の記名を求めない
    for (const item of report.loosenItems) {
      const applied = intentApplied.find((x) => x.seat === item.seat);
      if (applied && item.line.includes('運用形態')) item.intent = applied;
      // 保持していた範囲の拡大を、規則の承認で反映した。拡大を宣言した者の決定による
      const widened = widenApplied.find((x) => item.line.startsWith(`委任の規則 ${x.id}:`));
      if (widened) item.intent = widened;
    }
    const openItems = report.loosenItems.filter((i) => !i.intent);
    const sep = seatSeparationFindings(config);
    // 即時通知の通知先。出荷判定者の席の責任者が空いた場合は、前任者(名簿に残っていれば)、D-0 表1 の決定者、
    // 品質保証部門の通知先(governance.qaNotice)の順に解決する。いずれも無ければ「通知する者と通知先が同一」として
    // 自動で記録する(K70 / 第3章 3.13.6)
    const qaHolder = seatOf('qa-gatekeeper')?.accountable ?? null;
    let qa = qaHolder;
    let qaVia = qaHolder ? 'qa' : null;
    if (!qa) {
      const pred = report.noticeAlso.find((x) => x.role === 'predecessor');
      const deciderNow = seatOf(structureDeciderSeat(config))?.accountable ?? null;
      if (pred) {
        qa = pred.to;
        qaVia = 'predecessor';
        report.noticeAlso = report.noticeAlso.filter((x) => x !== pred);
      } else if (deciderNow) {
        qa = personName(config, deciderNow);
        qaVia = 'decider';
        report.noticeAlso = report.noticeAlso.filter((x) => x.role !== 'decider');
      }
    }
    const deciderNote = qaVia === 'decider' ? { to: qa } : null;

    // 即時通知(第3章 3.13.6)。対象の変化点では、通知先と通知日を変化点の記録へ残す
    const RESTRICTION = '承認権限の一時制限(標準 第7章 7.9)の発動';
    const noticeReasons = change.kind === 'notice' ? (change.noticeFor !== undefined ? prior.changeLog[change.noticeFor].notice?.reasons ?? [] : [RESTRICTION]) : report.noticeReasons;
    // 通知先: 出荷判定者の席の責任者。事象6 では前任者(離脱済みなら D-0 表1 の決定者)。
    // 品質保証部門の通知先(governance.qaNotice)を定めていれば、すべての即時通知をそこへも送る
    const qaDept = config.governance?.qaNotice ?? null;
    // 過去の変化点の通知を埋める記録は、その変化点で定まった通知先を引き継ぐ
    const also =
      change.kind === 'notice' && change.noticeFor !== undefined
        ? (prior.changeLog[change.noticeFor].notice?.also ?? [])
        : [...(change.kind === 'notice' ? [] : report.noticeAlso), ...(qaDept ? [{ to: qaDept, role: 'qa-dept' }] : [])];
    // 通知する者(第3章 3.13.6 の表)。事象ごとに決まる。権限の一時制限は、発動を記録した者(入力からは分からない)
    const holder = (role) => seatOf(role)?.accountable ?? null;
    const notifiers = new Set();
    let notifierKnown = change.kind !== 'notice';
    for (const r of noticeReasons) {
      if (r.startsWith('人数の境界') || r.startsWith('独立レビュー') || r.startsWith('出荷判定者の席')) notifiers.add(holder('context-owner'));
      else if (r.startsWith('運用形態')) {
        for (const s of config.seats) if (s.mode !== priorSeat[s.role]?.mode) notifiers.add(s.accountable ?? null);
      } else if (r.startsWith('検出の層')) {
        notifiers.add(holder('ai-maintainer'));
        notifiers.add(holder('ai-ops'));
      } else notifierKnown = false;
    }
    // 通知する者と、人の通知先がすべて同一人物なら、通知の入力を要求しない。「通知する者と通知先が同一」と記録する
    const personTargets = [qa, ...also.filter((x) => x.role !== 'qa-dept').map((x) => x.to)];
    const keys = new Set([...notifiers, ...personTargets].map((n) => personKey(config, n)));
    const selfCase =
      change.kind === 'notice' && change.noticeFor !== undefined
        ? prior.changeLog[change.noticeFor]?.notice?.self === true
        : noticeReasons.length > 0 && notifierKnown && Boolean(qa) && !keys.has(null) && keys.size === 1;
    const selfNotice = noticeReasons.length > 0 && notifierKnown && Boolean(qa) && !keys.has(null) && keys.size === 1 && !change.notice?.to;
    // 通知先が1つも解決できない(出荷判定者の席・前任者・決定者・品質保証部門の通知先がいずれも無い)。
    // 知らせる相手がいないため、「通知する者と通知先が同一」として自動で記録する(K70)
    const noTarget = noticeReasons.length > 0 && change.kind !== 'notice' && !qa && !qaDept && !change.notice?.to;
    // 通知先の記名は、名簿の人へ正規化して記録する。対応づかない名義(品質保証部門の通知先など)は、そのまま記録する
    const noticeTo = change.notice?.to ? (resolveSigner(config, change.notice.to)?.name ?? String(change.notice.to).trim()) : null;
    const notice =
      noticeReasons.length || change.notice
        ? {
            to: noticeTo ?? (selfNotice ? personName(config, qa) : noTarget ? NO_NOTICE_TARGET : null),
            // 部門の通知先を定めている場合は、自分への通知を記録しない場合でも、部門へ送った日を要する
            at: change.notice?.at ?? ((selfNotice && !qaDept) || noTarget ? day : null),
            reasons: noticeReasons,
            ...(also.length ? { also } : {}),
            ...(selfNotice || noTarget ? { self: true } : {}),
            ...(noTarget ? { noTarget: true } : {}),
          }
        : null;
    if (notice && !(notice.to && notice.at)) {
      const NOTIFIER = {
        accountable: `文脈オーナー(${seatOf('context-owner')?.accountable ?? '未記入'})`,
        headcount: `文脈オーナー(${seatOf('context-owner')?.accountable ?? '未記入'})`,
        axis: `文脈オーナー(${seatOf('context-owner')?.accountable ?? '未記入'})`,
        mode: '対象の席の責任者',
        performer: `AI維持管理者(${seatOf('ai-maintainer')?.accountable ?? '未記入'})と AI運用担当者(${seatOf('ai-ops')?.accountable ?? '未記入'})`,
      };
      const ROLE_NOTE = { predecessor: '前任の出荷判定者', decider: 'D-0 表1 の決定者(前任の出荷判定者が体制から外れたため)', 'qa-dept': '品質保証部門の通知先' };
      const alsoText = also.length ? `。あわせて ${also.map((x) => `${x.to}(${ROLE_NOTE[x.role] ?? x.role})`).join('、')} へ知らせる` : '';
      report.remaining.push(
        `即時通知(標準 第3章 3.13.6): この変化点は、出荷判定者の席の責任者(${qa ? personName(config, qa) : '未記入'})へ即時に知らせる対象である(${noticeReasons.join('、')})${alsoText}。` +
          `知らせるのは、変化点を起票する責任を持つ者(${NOTIFIER[change.kind] ?? '起票した者'})。` +
          (notice.self
            ? `通知する者と通知先が同一人物のため、自分への通知の入力は要らない(「通知する者と通知先が同一」と記録する)。品質保証部門の通知先へ送った日を notice.at へ書く。`
            : `通知先と通知日を、この入力の notice({ "to", "at" })へ書く。`) +
          `適用後に記録する場合は、種別 notice の変化点で、noticeFor に ${prior.changeLog.length} を書く。` +
          '未記入のままでは、出荷判定の証跡の集約が記録の欠落として扱う'
      );
    }

    // D-0 体制図が無い状態で、変化点(第3章 3.13.1 の1〜5)を適用しない。版を下げる変更も受け付けない
    const versionParts = (v) => String(v ?? '').split(/[^0-9]+/).filter(Boolean).map(Number);
    const versionLess = (x, y) => {
      const a = versionParts(x);
      const b = versionParts(y);
      // 数字を持たない版(draft など)は、前後を比べられない
      if (!a.length || !b.length) return false;
      for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
      return false;
    };
    const d0Refused = [];
    if (CHANGE_KINDS[change.kind] != null && d0InFile == null) {
      d0Refused.push(
        `D-0 体制図(${D0_FILE})がありません。体制の変化点は、D-0 を改訂して反映します。templates/00-d0-governance.md を写して作成し、frontmatter と生成区間でない節を人が記入してから、もう一度実行してください`
      );
    }
    if (d0InFile != null && prior.d0Version != null && versionLess(d0InFile, prior.d0Version)) {
      d0Refused.push(`D-0 体制図の版(${d0InFile})が、構成が追随している版(${prior.d0Version})より前です。版を下げる変更は受け付けません。frontmatter の version を戻してください`);
    }
    // 版の形式は N.N に限る(数字を持たない版や、区切りの違う版は、前後を比べられない)。JSON の数値 2.0 は 2 と読まれるため、整数は N.0 とする
    if (typeof change.d0Version === 'number' && Number.isInteger(change.d0Version)) change.d0Version = `${change.d0Version}.0`;
    else if (change.d0Version !== undefined && change.d0Version !== null) change.d0Version = String(change.d0Version).trim();
    if (change.d0Version !== undefined && !/^\d+\.\d+$/.test(String(change.d0Version))) {
      d0Refused.push(`d0Version "${change.d0Version}" は版の形式(N.N。例: 1.3)ではありません`);
    } else if (change.d0Version !== undefined && d0InFile != null && versionLess(String(change.d0Version), d0InFile)) {
      d0Refused.push(`d0Version "${change.d0Version}" は、現在の D-0 の版(${d0InFile})より前です。版を下げる変更は受け付けません`);
    }

    // D-0 体制図の版。構成が変わる変化点では、版を上げる。人が先に上げていれば、その版を使う。
    // 個別の値の変更(種別 settings)は体制を変えないため、版を上げない
    let d0After = d0InFile;
    if (change.d0Version !== undefined && d0InFile != null) d0After = String(change.d0Version);
    else if (
      change.kind !== 'settings' &&
      d0InFile != null &&
      prior.d0Version != null &&
      String(d0InFile) === String(prior.d0Version) &&
      report.diff.length
    ) {
      d0After = bumpD0Version(d0InFile);
    }
    if (d0InFile != null && d0After != null && String(d0After) !== String(d0InFile)) {
      report.remaining.push(`D-0 体制図(${D0_FILE})の版を ${d0InFile} → ${d0After} へ上げ、生成区間(節1・節12・節13)を書き換える(適用時に、このスクリプトが行う)`);
    } else if (d0InFile == null) {
      report.remaining.push(
        `D-0 体制図(${D0_FILE})が未作成。templates/00-d0-governance.md を写して作成し、frontmatter と、生成区間でない節(節2〜節11)を人が記入する。` +
          '作成後に `node scripts/init/generate-profile.mjs --answers process.config.json` を実行すると、生成区間が書き込まれる'
      );
    }
    config.d0Version = d0After;

    console.log(renderChangeReport(report, clamps, config));
    console.log(`## 兼務禁止と独立性の再判定\n\n- ${separationSummary(config)}`);
    for (const v of sep.violations) console.log(`- 抵触: ${v}`);
    for (const v of sep.deviated) console.log(`- 逸脱として記録(1〜2名の体制): ${v.pair}`);
    for (const v of sep.notIndependent) console.log(`- 独立が成立しない: ${v}`);
    console.log('');

    const refused = [];
    for (const c of clamps) {
      if (c.pendingApproval) continue;
      if (change.seats?.[c.role]?.mode === c.from) {
        const upTo = c.to === 'human' ? 'この席は人確定に限ります' : `${MODE_LABEL[c.to]}までは宣言できます`;
        refused.push(`${c.name} を ${MODE_LABEL[c.from]} にできません: ${c.reason}。${upTo}`);
      }
    }
    // 記名の欄(名簿、席の責任者、適合性確認の承認者)。AI の名義と、名簿に無い名義を拒否する
    for (const p of namingProblems(config)) refused.push(`記名を受け付けられません: ${p}`);
    // 離脱した人が責任者だった席。後任か、未記入かを、入力で示してもらう
    for (const s of config.seats) {
      if (s.accountable && !findPerson(config, s.accountable) && findPerson(prior, s.accountable)) {
        refused.push(
          `${s.name} の責任者 "${s.accountable}" は、名簿から外れています。離脱した人が責任者だった席は、後任を seats.${s.role}.accountable へ書くか、null(未記入)にしてください。` +
            '未記入の席は、後任が決まるまで表示し続けます'
        );
      }
    }
    if (change.decidedBy) {
      for (const p of nameProblems(config, change.decidedBy)) refused.push(`決定した者の記名を受け付けられません: ${p}`);
    }
    // この変化点で出された適合性確認。実施は AI維持管理者の席の責任者、承認は当該の席の責任者に限る(第3章 3.4.2)
    for (const s of config.seats) {
      if (change.seats?.[s.role]?.qualification && s.qualification) {
        for (const p of qualificationAuthorityProblems(config, s, { reapproval: reapproved.includes(s.role) })) {
          refused.push(`適合性確認の記録を受け付けられません: ${p}`);
        }
      }
    }
    // 委任の規則。全域の指定、変更種別、決定した者の名義は、席の運用形態の指定に依らず、書き込む前に確かめる
    const priorRule = Object.fromEntries((prior.delegation?.rules ?? []).map((r) => [r.id, r]));
    const sameRule = (a, b) => {
      const strip = ({ approvedBy, approvedAt, lapsedApproval, ...rest }) => rest;
      return Boolean(a) && JSON.stringify(strip(a)) === JSON.stringify(strip(b));
    };
    const staleRules = [];
    // 判定では常に対象外になるパスを指す規則(確約範囲・コア指定の内側、強制層・構成の正本)。登録は拒否しないが警告する
    const ruleWarnings = [];
    for (const r of config.delegation.rules ?? []) {
      const id = r.id ?? '(id なし)';
      const seat = seatOf(r.seat);
      const found = [];
      if (!seat) found.push(`席 "${r.seat}" は構成にありません`);
      else if (!seat.delegable) found.push(`${seat.name} は委任できない席です(第5章 5.5.6)`);
      found.push(...delegationRuleProblems(r, config));
      // この変化点で追加・変更した規則は、要件を満たさなければ書き込まない。変えていない既存の規則が
      // 要件を満たさなくなった場合(責任者の交代、変更種別の登録の削除など)は、変化点を止めず、
      // 席を協働へ下げて表示する
      if (!sameRule(priorRule[r.id], r)) {
        for (const p of [...found, ...ruleDeciderProblems(config, r)]) refused.push(`委任の規則 ${id}: ${p}`);
      } else if (!seat || !seat.delegable) {
        staleRules.push(`委任の規則 ${id}: ${found[0]}`);
      }
      // 承認待ちとして保持した範囲の拡大も、書き込む前に要件を確かめる
      if (r.pendingChange && JSON.stringify(priorRule[r.id]?.pendingChange ?? null) !== JSON.stringify(r.pendingChange)) {
        for (const p of [...delegationRuleProblems(r.pendingChange, config), ...ruleDeciderProblems(config, r.pendingChange)]) refused.push(`委任の規則 ${id}(範囲の拡大): ${p}`);
      }
      if (!sameRule(priorRule[r.id], r) || r.pendingChange) {
        const target = r.pendingChange ?? r;
        const probe = (g) => String(g).replace(/\*\*/g, 'zq9/zq7').replace(/\*/g, 'zq8');
        const overlap = (list) => (target.paths ?? []).filter((g) => list.some((x) => matchGlob(x, probe(g)) || matchGlob(g, probe(x))));
        const guarded = overlap(NEVER_DELEGATED);
        const inside = overlap((config.delegation.protectedPaths ?? []).filter((x) => typeof x === 'string' && x.trim()));
        if (guarded.length) ruleWarnings.push(`委任の規則 ${id}: 対象のパス ${guarded.join(' / ')} は、強制層・構成の正本・判定の記録に当たります。判定では常に委任の範囲の外になります`);
        if (inside.length) ruleWarnings.push(`委任の規則 ${id}: 対象のパス ${inside.join(' / ')} は、確約範囲・コア指定のパスに重なります。重なる変更は、判定では常に委任の範囲の外になります(第5章 5.5.4 条件5)`);
      }
    }
    const priorTypes = new Set((prior.delegation?.changeTypes ?? []).map((t) => JSON.stringify(t)));
    const newTypes = new Set((config.delegation.changeTypes ?? []).filter((t) => !priorTypes.has(JSON.stringify(t))).map((t) => String(t?.id ?? '').trim()));
    for (const p of changeTypeProblems(config, { only: newTypes })) refused.push(`標準変更カタログ: ${p}`);
    // 登録する者がリリース判定会(B-4)のとき、機械が確かめるのは、登録した者が名簿にいることだけである
    const registrarNote =
      newTypes.size && (config.governance?.catalogRegistrar ?? structureDeciderSeat(config)) === 'b4'
        ? 'D-0 表1「標準変更カタログへの登録」の決定者はリリース判定会(B-4)です。機械が確かめるのは、登録した者が名簿にいることだけであり、B-4 の構成員かどうかは確かめません。' +
          'B-4(既存のリリース会議を含む)を置かない体制では、登録する者を「体制と運用形態」の決定者へ改めます: /process-change の governance で { "catalogRegistrar": "' +
          structureDeciderSeat(config) +
          '" } を、変更前の決定者の記名と理由をつけて反映します'
        : null;
    for (const p of protectedPathsProblems(config)) refused.push(p);

    if (change.ruleApprovedBy) {
      // 規則の承認者は、AI維持管理者の席の責任者に限る。委任を決定した者と同一人物でもよい
      for (const p of nameProblems(config, change.ruleApprovedBy, { requireRoster: true })) {
        refused.push(`規則の承認者の記名を受け付けられません: ${p}`);
      }
      const maintainer = config.seats.find((s) => s.role === RULE_APPROVER_SEAT)?.accountable;
      if (!maintainer || personKey(config, maintainer) !== personKey(config, change.ruleApprovedBy)) {
        refused.push(
          `規則の承認者 "${change.ruleApprovedBy}" は、AI維持管理者の席の責任者ではありません。規則の変更の承認は、AI維持管理者の席の責任者が行います(state:needs-platform)`
        );
      }
      if (!approvedNow.length) refused.push('ruleApprovedBy が書かれていますが、承認の対象になる規則(追加・範囲の拡大・承認待ち)がありません');
    }
    // 即時通知の通知先は、出荷判定者の席の責任者である
    if (change.notice?.to) {
      // 通知先の記名は、氏名の空白・括弧書き・敬称、アカウントの @ の有無を正規化して、名簿の人へ対応づける
      const toPerson = resolveSigner(config, change.notice.to);
      // 品質保証部門の通知先を通知先として記録できるのは、人の通知先が無い場合と、通知する者と人の通知先が同一の場合に限る
      const qaDeptOnly = (!qa || selfCase) && qaDept && normName(change.notice.to) === normName(qaDept);
      const VIA = { qa: '出荷判定者の席の責任者', predecessor: '前任の出荷判定者(出荷判定者の席が空いているため)', decider: 'D-0 表1 の決定者(出荷判定者の席が空いているため)' };
      if (qaDeptOnly) {
        // 出荷判定者の席・前任者・決定者がいずれも無く、品質保証部門の通知先だけが定まっている
      } else if (!toPerson) {
        for (const p of nameProblems(config, change.notice.to, { requireRoster: true })) refused.push(`通知先の記名を受け付けられません: ${p}`);
        if (!nameProblems(config, change.notice.to, { requireRoster: true }).length) refused.push(`通知先の記名 "${change.notice.to}" を、名簿の人へ対応づけられません`);
      } else {
        for (const p of nameProblems(config, toPerson.name, { requireRoster: true })) refused.push(`通知先の記名を受け付けられません: ${p}`);
      }
      if (!qaDeptOnly) {
        if (!qa) {
          refused.push(
            qaDept
              ? `通知先を照合できません。出荷判定者の席の責任者・前任者・D-0 表1 の決定者がいずれも無いため、通知先は品質保証部門の通知先(${qaDept})です`
              : '通知先を照合できません。出荷判定者の席の責任者・前任者・D-0 表1 の決定者・品質保証部門の通知先がいずれも無いため、通知は「通知する者と通知先が同一」として自動で記録されます'
          );
        } else if (toPerson && personKey(config, qa) !== toPerson.id) {
          refused.push(
            `通知先 "${change.notice.to}" は、${VIA[qaVia]}(${personName(config, qa)})ではありません(標準 第3章 3.13.6)。` +
              'notice.to には出荷判定者の席の責任者(空いていれば、前任者、D-0 表1 の決定者の順)を書きます。ほかの通知先は、構成から自動で記録されます'
          );
        }
      }
    }
    for (const p of headcountProblems(config)) refused.push(p);
    // 回答と名簿・席の矛盾(回答は確認者なし、席には別の人の確認者を記入、など。第3章 3.13.5)
    for (const p of answersRosterProblems(config)) refused.push(p);
    // 規模の規則が分離を必須とした組(10名以上)は、10名以上の体制に限る兼務禁止である。拒否の文を書き分ける
    const tenPlus = (config.separations ?? []).filter((s) => s.scope === 'team-size').map((s) => s.roles.map((r) => seatOf(r)?.name ?? r).join(' × '));
    for (const v of sep.violations) {
      const isTen = tenPlus.some((pair) => v.startsWith(`${pair}(`));
      refused.push(
        isTen
          ? `兼務禁止に抵触します: ${v}(10名以上の体制では、同じ人がこの2つの席の責任者になれません。第8章 軸A)`
          : `兼務禁止に抵触します: ${v}(3名以上の体制では、同じ人がこの2つの席の責任者になれません。兼務を逸脱として記録できるのは 1〜2名の体制に限ります)`
      );
    }
    refused.push(...d0Refused);
    if (['schedule-only', 'notice'].includes(change.kind) && report.diff.length) {
      refused.push(
        change.kind === 'notice'
          ? '種別 notice では構成を変えられません'
          : '納期だけの変更では構成を変えられません。納期を理由に統制を外す要求は、統制を緩める向きの変更として、種別を改めて決定した者の記名と理由をつけてください'
      );
    }
    if (d0InFile != null && d0After == null) {
      refused.push(`D-0 体制図の版(${d0InFile})を自動で上げられません。変化点の入力の d0Version に、新しい版を書いてください`);
    }
    // 名簿の既存の行の、氏名とアカウントの両方を変える書き換えは、別の人への差し替えである(K67 / 第3章 3.13.3)
    for (const s of report.rosterSwaps) {
      refused.push(
        (s.origin
          ? `人の名簿の行 "${s.id}" の変更(${s.from} → ${s.to})は、氏名とアカウントの両方を、その行を名簿へ足したときの値(${s.origin})と異なるものにします。`
          : `人の名簿の行 "${s.id}" の氏名とアカウントを、両方とも書き換えています(${s.from} → ${s.to})。`) +
          '既存の行を別の人へ差し替えることはできません(変化点を分けても同じです)。別の人は新しい id の行として足します(席への任命は、任免の決定の手続による)。' +
          '同じ人の表記の変更は、名簿へ足したときの値と比べて、氏名かアカウントの一方に限ります'
      );
    }
    if ((openItems.length || report.appointItems.length || report.renameItems.length) && signedNow) {
      // 緩める向きを決定できるのは、対象の席の責任者、または D-0 表1「体制と運用形態」の決定者に限る。
      // 任免は、変更前の決定者(体制から外れていれば、組織上の任命権者)に限る
      for (const p of deciderProblems(config, { ...report, loosenItems: openItems }, change.decidedBy, prior)) if (!refused.includes(p)) refused.push(p);
    }
    // ステージを前へ戻す変更の判定記録は、docs/gates/ 配下の実在する判定記録を指す
    if (report.stageBack && change.sgRecord) {
      const file = path.resolve(ROOT, String(change.sgRecord));
      const rel = path.relative(path.join(ROOT, 'docs/gates'), file);
      const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (!inside || !/\.md$/i.test(file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        refused.push(`sgRecord "${change.sgRecord}" は、docs/gates/ 配下の実在する判定記録(.md)ではありません。ステージ移行ゲート(SG)の判定記録の所在を書いてください`);
      }
    }
    if (refused.length) reject('この変化点は反映できません', [...new Set(refused)]);

    if (openItems.length && !signedNow) {
      const msg =
        '統制を緩める向きの変更を含みます。決定した者の記名(decidedBy)と理由(reason)が要ります。' +
        `決定できるのは、対象の席の責任者、または${structureDeciderLabel(config)}です。AI が決めてはなりません`;
      if (!dryRun) reject(msg);
      console.log(`[要記名] ${msg}`);
    }
    if (report.appointItems.length && !signedNow) {
      const msg =
        '席の責任者の任免(または D-0 表1 の決定者の変更)を含みます。統制の向きにかかわらず決定であり、決定した者の記名(decidedBy)と理由(reason)が要ります。' +
        (report.priorDeciderPresent
          ? '決定できるのは、変更前の D-0 表1「体制と運用形態」の決定者です。'
          : '前任の決定者が体制から外れている、または未記入のため、決定できるのは組織上の任命権者(名簿に external: true と appointer: true で記載した人)です。') +
        (report.allBlankBefore ? '全席が未記入の状態からの初回の記入は、この変化点で D-0 表1「体制と運用形態」の決定者の席に記入する人の記名と理由で受け付けます。' : '') +
        '離脱(席を空ける)だけなら、記名なしで反映できます。AI が決めてはなりません(標準 第3章 3.13.3)';
      if (!dryRun) reject(msg);
      console.log(`[要記名] ${msg}`);
    }
    if (report.renameItems.length && !report.appointItems.length && !signedNow) {
      const msg =
        '人の名簿の表記の変更(氏名だけ、またはアカウントだけ)を含みます。同じ人の表記の変更として扱い、D-0 表1「体制と運用形態」の決定者の記名(decidedBy)と理由(reason)が要ります。' +
        (report.renameItems.some((i) => i.self)
          ? '決定者本人の行の変更は、組織上の任命権者、または本人以外の席の責任者1名の記名を要します。'
          : '') +
        'AI が決めてはなりません(標準 第3章 3.13.3)';
      if (!dryRun) reject(msg);
      console.log(`[要記名] ${msg}`);
    }
    for (const w of ruleWarnings) console.log(`[警告] ${w}`);
    if (registrarNote) console.log(`[注意] ${registrarNote}`);
    // ステージを前へ戻す変更は、記名と理由だけでは足りない。ステージ移行ゲート(SG)の判定による
    if (report.stageBack && !change.sgRecord) {
      const msg =
        '事業ステージを前へ戻す変更は、ステージ移行ゲート(SG)の判定によります。判定記録の所在(sgRecord)を書いてください';
      if (!dryRun) reject(msg);
      console.log(`[要 SG 判定] ${msg}`);
    }
    if (chainStarts) {
      console.log('[連鎖の開始] この変化点から、変化点の記録へ要約値を持たせます。これより前の構成と記録は、書き換えの有無を検証できません');
    }
    if (report.arising.length) {
      console.log('[即時反映] 未達・逸脱の発生を含みます。決定ではないため、記名を待たずに反映します。未達のまま出荷するかどうかは、既存の規定によります(R1 の変更は標準 第7章 7.3 の例外承認。CL1 以上と規制業は不可)');
    }
    if (config.shipBlocked) console.log(`[出荷不可] ${config.shipBlocked.reason}`);
    for (const n of nameOverrides(config)) console.log(`[上書き] 名義の機械検査を人が上書きした: ${n}`);
    for (const n of report.standby) console.log(`[協働のまま] ${n}`);
    for (const n of staleRules) console.log(`[要修正] 既存の${n}。この規則では委任は働きません。規則を改めるか、削除してください`);
    // 有効でない規則。席に有効な規則が残っていれば、席は委任のままで、その規則だけが働かない
    for (const x of clamps.inactiveRules) {
      const seat = seatOf(x.seat);
      const rest = seat?.mode === 'delegated' ? '席は、承認済みの既存の規則の範囲で委任のままです' : '席は協働として扱います';
      if (x.pending) {
        console.log(`[承認待ち] 委任の規則 ${x.id}(${x.seatName}): AI維持管理者の承認の記名(ruleApprovedBy)があるまで、この規則では委任は働きません。${rest}`);
      } else {
        console.log(`[要修正] 委任の規則 ${x.id}(${x.seatName}): ${x.reason}。この規則では委任は働きません。${rest}`);
      }
    }
    for (const c of clamps.filter((x) => x.pendingApproval)) {
      const held = seatOf(c.role).intent;
      if (held) {
        console.log(
          `[宣言を保持] ${c.name}: 委任の宣言(決定: ${held.decidedBy}、${held.at})を保持しています。承認待ちのあいだは協働として動きます。` +
            '残っている手続は、AI維持管理者の席の責任者による規則の承認(ruleApprovedBy)だけです。承認が入った変化点で、委任が有効になります(宣言し直す必要はありません)'
        );
      }
    }
    for (const x of intentApplied) {
      console.log(`[委任を有効化] ${x.name}: 保持していた委任の宣言(決定: ${x.decidedBy}、${x.at}。理由: ${x.reason})を、規則の承認により有効にしました`);
    }
    for (const n of intentDropped) console.log(`[宣言の失効] 保持していた委任の宣言を取り下げました(${n})。委任にするには、席の責任者の記名と理由をつけて宣言し直します`);
    for (const n of lapsedNow) console.log(`[失効] ${n}: ${APPROVAL_LAPSED}。承認し直すまで、席は協働を上限とします`);
    for (const role of reapproved) console.log(`[承認し直し] ${seatOf(role).name}: 新しい責任者(${seatOf(role).qualification.approvedBy})が、既存の適合性確認の記録を承認しました。確認の再実施は要しません`);
    for (const n of invalidRequal) console.log(`[無効] 同じ変化点で出された適合性確認の記録を受け付けません(${n})。有効な確認まで、席は協働を上限とします`);
    for (const x of performerDown) {
      console.log(
        `[即時反映] ${x.name}: 担い手の識別が変わったため、委任を協働へ下げました(${x.why})。` +
          '新しい識別で委任を続けるには、新しい識別に対する適合性確認の記録と、席の責任者の記名と理由が要ります(種別 mode で反映します)'
      );
    }
    if (switchedDown.length) {
      console.log(`[即時反映] 一時的な切り替えのため、委任を協働へ下げました: ${switchedDown.join(' / ')}。切り替えが終わっても自動では戻りません`);
    }
    for (const id of approvalReturned) {
      console.log(
        `[承認待ちへ戻る] 委任の規則 ${id}: 承認した AI維持管理者が交代したため、承認待ちへ戻りました。規則を消して足し直す必要はありません。` +
          '新しい AI維持管理者の席の責任者が、ruleApprovedBy だけを書いた変化点(種別 mode)で承認し直します'
      );
    }
    for (const id of widenHeld) {
      console.log(`[拡大は承認待ち] 委任の規則 ${id}: 承認済みの範囲は有効なまま残ります。広げた部分だけが、AI維持管理者の承認(ruleApprovedBy)まで承認待ちです`);
    }
    for (const x of widenApplied) console.log(`[拡大を反映] 委任の規則 ${x.id}: 保持していた範囲の拡大(決定: ${x.decidedBy}、${x.at})を、規則の承認により反映しました`);
    if (notice?.noTarget) {
      console.log(
        '[即時通知] 通知先が1つも定まりません(出荷判定者の席の責任者、前任者、D-0 表1 の決定者、品質保証部門の通知先がいずれも無い)。' +
          '「通知する者と通知先が同一」として自動で記録します'
      );
    } else if (notice?.self) {
      console.log(
        `[即時通知] 通知する者と通知先が同一人物(${notice.to})のため、自分への通知の入力を求めません。「通知する者と通知先が同一」と記録します` +
          (config.governance?.qaNotice ? `。品質保証部門の通知先(${config.governance.qaNotice})へ送った日は、notice.at で記録します` : '')
      );
    }
    if (notice && !(notice.to && notice.at)) {
      console.log(
        `[即時通知] 出荷判定者の席の責任者(${qa ? personName(config, qa) : '未記入'})${(notice.also ?? []).map((x) => `・${x.to}`).join('')}への通知が未記録です(${noticeReasons.join('、')})`
      );
    }

    // 承認だけの変化点で、委任の席に規則が加わり有効になった場合も、緩める向きとして記録する。
    // 決定者は、規則を決定した者(宣言した時点の者)である
    const ruleActivated = [];
    for (const r of (config.delegation.rules ?? []).filter((x) => approvedNow.includes(x.id))) {
      if (seatOf(r.seat)?.mode !== 'delegated') continue;
      if (report.loosenItems.some((i) => i.line.startsWith(`委任の規則 ${r.id}:`) || (i.intent && i.seat === r.seat))) continue;
      const item = { line: `委任の規則 ${r.id}: AI維持管理者の承認により、委任の範囲として有効になる`, seat: r.seat, intent: { decidedBy: r.decidedBy, reason: r.reason, at: r.decidedAt ?? day } };
      report.loosenItems.push(item);
      report.loosens.push(item.line);
      ruleActivated.push(item.intent);
    }
    if (report.loosens.length) report.direction = 'loosen';
    const heldDecision = intentApplied[0] ?? widenApplied[0] ?? ruleActivated[0] ?? null;
    // 前任の決定者が体制から外れ、組織上の任命権者の記名で任免を決定した(第3章 3.13.3。保証の開示の項目7 へ出す)
    const appointerSigned = report.appointItems.length > 0 && !report.priorDeciderPresent && isAppointer(config, change.decidedBy);

    const approvedRules = (config.delegation.rules ?? []).filter((r) => approvedNow.includes(r.id));
    const closing =
      change.kind === 'outage' && change.outage.closes !== undefined ? outagePeriods(prior).find((x) => x.index === change.outage.closes) : null;
    config.changeLog = [
      ...config.changeLog,
      changeLogEntry({
        kind: change.kind,
        date: day,
        summary: change.summary,
        result: report.diff.length ? 'changed' : 'no-change',
        direction: report.direction,
        d0Before: change.d0Before ?? prior.d0Version ?? null,
        d0After: config.d0Version,
        diff: report.diff,
        arising: report.arising,
        separationRecheck: change.separationRecheck ?? separationSummary(config),
        invalidatedChecks: change.invalidatedChecks ?? [],
        expired: report.expired,
        recheckDue: change.recheckDue ?? null,
        // 保持していた宣言だけで緩める向きになった変化点は、宣言した時点の決定者と理由を記録する
        decidedBy: change.decidedBy ?? heldDecision?.decidedBy ?? null,
        reason: change.reason ?? (heldDecision ? `${heldDecision.reason}(${heldDecision.at} の決定を、規則の承認により有効にした)` : null),
        intentApplied: intentApplied.map(({ seat, decidedBy, reason, at }) => ({ seat, decidedBy, reason, at })),
        ...(appointerSigned ? { appointerSigned: true } : {}),
        rosterEdits: report.rosterEdits,
        ruleApprovedBy: approvedNow.length ? change.ruleApprovedBy : null,
        nameOverrides: nameOverrides(config),
        ruleApproval: approvedNow.length
          ? {
              approvedBy: change.ruleApprovedBy,
              seat: RULE_APPROVER_SEAT,
              rules: approvedNow,
              // 席の責任者と同一人物でも拒否しない。どの席で判断したかを記録に残す。
              // 比べる相手は、承認した規則を決定した者である
              samePersonAsDecider: approvedRules.some((r) => personKey(config, r.decidedBy) === personKey(config, change.ruleApprovedBy)),
            }
          : null,
        sgRecord: report.stageBack ? (change.sgRecord ?? null) : null,
        outage:
          change.kind === 'outage'
            ? closing
              ? // 継続中の期間を閉じる記録。開始の記録は書き換えず、終了日を持つ記録を足す
                { from: closing.from, to: change.outage.to, handling: change.outage.handling ?? closing.handling, switched: closing.switched, closes: closing.index }
              : {
                  from: change.outage.from,
                  to: change.outage.to ?? null,
                  handling: change.outage.handling,
                  switched: change.outage.switched === true,
                }
            : null,
        notice,
        noticeFor: change.kind === 'notice' && change.noticeFor !== undefined ? change.noticeFor : null,
      }),
    ];
    appended = true;
    if (dryRun) {
      console.log('--dry-run のため、構成は書き換えていません。成立済みの判定記録は、適用後も書き換えません');
      process.exit(0);
    }
  }

  // 最後の記録へ、適用後の構成の要約値と、直前の記録の要約値を書く
  if (appended) sealChangeLog(config);

  const md = renderProfileMd(config, result);

  if (dryRun) {
    console.log(md);
    console.log('\n--- process.config.json ---\n');
    console.log(JSON.stringify(config, null, 2));
  } else {
    fs.writeFileSync(path.join(ROOT, 'process.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(ROOT, 'PROCESS-PROFILE.md'), md, 'utf8');
    console.log('wrote process.config.json / PROCESS-PROFILE.md');

    // D-0 体制図の生成区間(席・責任者・担い手・運用形態の表、委任の範囲、改訂履歴)と、版
    if (fs.existsSync(d0Path)) {
      let text = fs.readFileSync(d0Path, 'utf8');
      // 版を上げるのは変化点だけである。変化点を経ない再生成では、体制図の版に触れない
      const bump = Boolean(change) && config.d0Version != null && String(config.d0Version) !== String(d0InFile);
      if (bump) {
        text = text.replace(/^(---\r?\n[\s\S]*?^version:[ \t]*)(.*)$/m, `$1${config.d0Version}`);
        // 承認者と承認日は、この版を定めた変化点の決定者と日付から生成する。決定を要しない変化点
        // (厳しくする向き、発生)では、その旨を承認者の欄に書く。初版の承認者を残さない
        const last = config.changeLog.at(-1);
        const approver = last.decidedBy
          ? personName(config, last.decidedBy)
          : `決定を要しない変化点(${DIRECTION_LABEL[last.direction] ?? '—'}。${KIND_NOTE[last.kind] ?? `変化点${last.changePoint ?? ''}`})`;
        text = text
          .replace(/^(---\r?\n[\s\S]*?^approver:[ \t]*)(.*)$/m, `$1${approver}`)
          .replace(/^(---\r?\n[\s\S]*?^approved_at:[ \t]*)(.*)$/m, `$1${String(last.date).slice(0, 10)}`);
      }
      const applied = applyD0Sections(text, config);
      fs.writeFileSync(d0Path, applied.text, 'utf8');
      console.log(`wrote ${D0_FILE} (生成区間${bump ? `。版 ${d0InFile} → ${config.d0Version}` : ''})`);
      if (applied.missing.length) {
        console.warn(
          `[警告] ${D0_FILE} に、生成する欄の目印がありません(${applied.missing.map((k) => (D0_SECTIONS.includes(k) ? d0Marks(k)[0] : k)).join(' / ')})。` +
            'templates/00-d0-governance.md の節1・節12・節13 から目印の行を、節3 から「体制と運用形態」「標準変更カタログへの登録」の行を写し、もう一度 `node scripts/init/generate-profile.mjs --answers process.config.json` を実行してください。D-0 の検査は、目印の無い体制図を失敗させます'
        );
      }
    }

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
    if (config.shipBlocked) {
      console.log('');
      console.log(`[出荷不可] ${config.shipBlocked.reason}`);
    }
    if (config.unmet.length) {
      console.log('');
      console.log('[未達] 次のゲートは目的を達成する構成を示せていません:');
      for (const u of config.unmet) console.log(`  - ${u.label}: ${u.reason}`);
    }
    if (config.deviations.length) {
      console.log('');
      console.log('[逸脱] 次のゲート・兼務は、標準が要求する属性を欠いています:');
      for (const d of config.deviations) console.log(`  - ${d.label}: ${d.rule}`);
    }
  }
}

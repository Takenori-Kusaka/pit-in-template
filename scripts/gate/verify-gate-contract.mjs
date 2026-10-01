// プロセス構成と、実際の CI・ブランチ保護・アダプタの整合を検査する。
//
//   node scripts/gate/verify-gate-contract.mjs
//
// テンプレートが「設定したつもり」で運用されることを防ぐための検査です。
// 構成ファイルに書いた要求が、実際の設定に現れていなければ失敗させます。
//
//   node scripts/gate/verify-gate-contract.mjs --delegation [--base origin/main]
//
// 作業中の変更が委任の範囲に当たるかを、機械の規則(delegation.rules)で判定して終了します。
// 行為する AI 自身に該当を判定させないための入口です(標準 第5章 5.5.4 条件2)。
// 該当すれば 0、該当しなければ 1 で終了します。
//
//   node scripts/gate/verify-gate-contract.mjs --base origin/main
//
// 基底ブランチの構成と比べます。構成(process.config.json)を書き換えるのは /process-change だけです。
// 構成が変わっているのに変化点の記録(changeLog[])の追記が無い変更と、基底の記録が先頭部分として
// 保たれていない変更を失敗させます。PR では、環境変数 GITHUB_BASE_REF から基底を読みます。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  loadAdapter,
  ROOT,
  fail,
  warn,
  notice,
  SEAT_MODES,
  SEAT_CEILING,
  MODE_LABEL,
  CHANGE_KINDS,
  modeRank,
  qualificationProblems,
  classifyDelegation,
  sumNumstat,
  OUTAGE_HANDLING,
  aiNameReason,
  namingProblems,
  personKey,
  headcountProblems,
  delegationRuleProblems,
  aiNameBlocked,
  nameOverrides,
  shipBlockedProblems,
  instructionAssetsDigest,
  instructionsCheck,
  chainProblems,
  baseChainProblems,
  changeTypeProblems,
  protectedPathsProblems,
  structureDeciderSeat,
  pendingNotices,
  answersRosterProblems,
  SIGNED_DIRECTIONS,
  DIRECTION_LABEL,
  isRealDay,
} from './config.mjs';
import { seatSeparationFindings, ruleStanding } from '../init/generate-profile.mjs';
import { classifyByRule, classifyForSeat, REVIEWER_SEAT, DEVELOPER_SEAT } from './delegation.mjs';

const config = loadConfig();
const problems = [];
const notes = [];

function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

// ---------------------------------------------------------- 委任の該当の判定

if (process.argv.includes('--delegation')) {
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : 'origin/main';
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const mergeBase = git(['merge-base', base, 'HEAD']);
  if (mergeBase === null) {
    fail(`比較の起点 ${base} を解決できません。該当を判定できない変更は、協働として人の判定へ渡してください`);
    process.exit(1);
  }
  const files = [
    ...(git(['diff', '--name-only', mergeBase]) ?? '').split('\n'),
    ...(git(['ls-files', '--others', '--exclude-standard']) ?? '').split('\n'),
  ].filter(Boolean);
  const lines = sumNumstat(git(['diff', '--numstat', mergeBase]));
  // 証跡の集約と、PR 上の判定(check-delegation)と同じ判定を通す。ここだけ別の結論を出すと、案内どおりに
  // トレーラを書いた変更が、集約で「委任の範囲の逸脱」になる。規則の範囲に加えて、確約範囲とコア指定の
  // パスの宣言、決定した者、AI維持管理者の承認、変更種別の登録者まで確かめる
  const rules = config.delegation?.rules ?? [];
  const reasons = [];
  let judged = null;
  for (const r of rules) {
    const j = classifyByRule(config, files, r.id, lines);
    if (j.rule) {
      judged = j;
      break;
    }
    for (const why of j.reasons) if (!reasons.includes(why)) reasons.push(why);
  }
  if (!rules.length) reasons.push(...classifyDelegation(config, files, null, lines).reasons);
  if (judged) {
    notice(`委任の範囲に当たります: 規則 ${judged.rule}${judged.seat ? `(${judged.seat})` : ''}。対象 ${files.length} ファイル`);
    console.log(`コミットのトレーラへ "Delegated: ${judged.rule}" を書いてください。トレーラは、マージの経路の有無にかかわらず書きます(変更ごとの検証を担い手へ委ねた変更として識別するため)。`);
    // 委任の形は2つある。独立レビュアの席の規則にも該当するかで、独立レビュー(G-6)の扱いが変わる。
    // 行為した席(開発者の席)の規則に該当しない変更は、開発者の席が協働であり、開発者の席の人による
    // 検証が変更ごとに要る(第5章 5.5.6)
    const reviewer = classifyForSeat(config, files, REVIEWER_SEAT, lines);
    const developer = classifyForSeat(config, files, DEVELOPER_SEAT, lines);
    if (developer.rule) {
      console.log('開発者の席の規則に該当します。PR の「検証方法と結果」へ、担い手が実行結果の証拠を書きます(開発者の席の委任の範囲に限り、担い手の記載でよい)。');
    } else {
      console.log(
        '開発者の席の規則には該当しません。開発者の席は協働であり、変更ごとの検証を開発者の席の責任者(人)が行い、「検証方法と結果」を人が書きます(第5章 5.5.6)。' +
          '独立レビュアの席の規則に該当しても、開発者の席の責任者の承認が無い変更は、機械がマージを実行する条件を満たしません。'
      );
    }
    if (reviewer.rule) {
      console.log(
        `独立レビュアの席の規則(${reviewer.rule})にも該当します。リスク区分が R3 と記録された変更に限り、G-6 の判定の時点を事後へ移す委任に当たります。` +
          'PR を出した後に、ワークフロー(delegation.yml)が既定ブランチの構成と規則で判定します。マージの実行は既定で無効です。組織が有効化するまで、協働として扱い、人の承認を待ちます。'
      );
    } else {
      console.log('開発者の席の委任に該当します。独立レビュー(G-6)は、独立レビュアが人として事前に承認します。現在のブランチ保護のままマージできます。');
    }
    console.log('リスク区分が R1・R2 の変更と、区分が未記入の変更は、規則に当たっても委任の対象になりません。G-5 の全通過と、取り消しの実績は、別に満たす必要があります。');
    process.exit(0);
  }
  warn('委任の範囲に当たりません。協働として扱い、人の判定へ渡してください。トレーラ Delegated: は書きません');
  for (const r of reasons) console.log(`  - ${r}`);
  process.exit(1);
}

// ---------------------------------------------------------- 指示資産の識別子

// 担い手の識別(performer.instructions)の末尾へ `@<この値>` を書くと、契約検査が実ファイルと照合する
if (process.argv.includes('--instructions-digest')) {
  console.log(instructionAssetsDigest());
  process.exit(0);
}

// ---------------------------------------------------------- 基底ブランチとの比較

/** 基底ブランチの構成と比べる。--base <ref>、または PR の GITHUB_BASE_REF から基底を読む */
function compareWithBase() {
  const i = process.argv.indexOf('--base');
  const fromEnv = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null;
  const base = i >= 0 ? process.argv[i + 1] : fromEnv;
  if (base) {
    const git = (args) => {
      try {
        return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
      } catch {
        return null;
      }
    };
    // リポジトリの中での ROOT の位置(リポジトリの直下でない配置にも対応する)
    const prefix = (git(['rev-parse', '--show-prefix']) ?? '').trim();
    let resolved = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    if (resolved === null && fromEnv && i < 0) {
      // 浅い取得(fetch-depth: 1)では基底が手元に無い。1回だけ取得を試みる
      git(['fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${process.env.GITHUB_BASE_REF}:refs/remotes/origin/${process.env.GITHUB_BASE_REF}`]);
      resolved = git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    }
    if (resolved === null) {
      problems.push(
        `基底ブランチ ${base} を解決できません。構成が変化点を経ずに書き換えられていないかを、基底と比べて確かめられません。` +
          '基底ブランチを取得してから実行してください(CI では checkout の fetch-depth を 0 にするか、基底を fetch します)'
      );
    } else {
      const text = git(['show', `${base}:${prefix}process.config.json`]);
      let baseConfig = null;
      try {
        baseConfig = text === null ? null : JSON.parse(text);
      } catch {
        problems.push(`基底ブランチ ${base} の process.config.json を読めません(JSON として不正)`);
      }
      const found = baseChainProblems(baseConfig, config);
      for (const p of found) problems.push(`${p}(基底: ${base})`);
      if (baseConfig?.configured === true && !found.length) notice(`基底ブランチ ${base} の構成と比べました。変化点の記録は追記だけです`);
    }
  }
}

// ---------------------------------------------------------- 未設定の扱い

if (config.configured === false) {
  // 基底ブランチで設定済みの構成を、未設定へ戻す変更を通さない
  compareWithBase();
  if (problems.length) {
    for (const p of problems) fail(p);
    process.exit(1);
  }
  notice('プロセス構成が未設定です。Claude Code で /process-init を実行してください');
  notice('未設定のあいだ、契約検査は構成の妥当性を判定しません');
  process.exit(0);
}

// ---------------------------------------------------------- 0. 変化点を経ない書き換え

// 構成を書き換えるのは /process-change だけである。最後の変化点の記録が持つ要約値と、現在の構成が
// 一致しなければ、構成は記録を経ずに書き換えられている。要約値ごと書き換える改ざんは、ローカルだけ
// では検出できない。PR では基底ブランチの構成と比べる(構成は強制層であり、変更は承認を要する)
{
  const chain = chainProblems(config);
  if (chain.legacy) {
    problems.push(
      '変化点の記録(changeLog[])に要約値がありません(旧い構成)。構成が変化点を経ずに書き換えられていないかを確かめられません。' +
        '/process-change を1回実行すると、要約値の連鎖が始まります(変える内容が無ければ、種別 settings の空の入力でよい)'
    );
  }
  for (const p of chain.problems) problems.push(p);

  compareWithBase();
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
      `${u.gate}(${u.label ?? ''}) の確認者(作成を指示した本人以外の人)の調達先が未記入です。この状態は出荷判定の証跡にも残ります`
    );
  } else if (aiNameReason(u.reviewSourcing, { account: true })) {
    problems.push(
      `${u.gate} の確認者の調達先 "${u.reviewSourcing}" は ${aiNameReason(u.reviewSourcing, { account: true })}。AI の確認は検出の層であり、未達を埋めません`
    );
  }
}
for (const [key, g] of Object.entries(config.gates ?? {})) {
  if (g.state === 'unmet' && !(config.unmet ?? []).some((u) => u.gate === key)) {
    problems.push(`gates.${key} が unmet ですが、unmet[] に理由の記録がありません`);
  }
}

// -------------------------------------------------- 2.5 代償措置つきの逸脱

// 逸脱はゲートを実施したうえで属性を欠く状態のため、state は required か simplified になる。
// 「逸脱の記録を消して普通の required に見せる」書き換えを検出する(第3章 3.5.2 / ADR-0029)
const isActive = (s) => s === 'required' || s === 'simplified';
for (const d of config.deviations ?? []) {
  const id = d.gate ?? d.separationId ?? '(識別子なし)';
  if (!d.gate && !d.separationId) problems.push('deviations に、ゲートも兼務禁止の組(separationId)も持たない記録があります');
  if (!d.reason) problems.push(`deviations の ${id} に reason がありません`);
  if (!d.resolveWhen) problems.push(`deviations の ${id} に解消の時点(resolveWhen)がありません`);
  if (!d.gate) {
    // 兼務の逸脱(1〜2名の体制)。代償措置は定められていない。記録と表示を求める(第3章 3.5)
    if (config.answers?.['q-team-size'] !== 'size-1-2') {
      problems.push(`deviations の ${id}: 兼務を逸脱として記録できるのは 1〜2名の体制に限ります(第3章 3.5)`);
    }
    continue;
  }
  const s = config.gates?.[d.gate]?.state;
  if (!isActive(s)) {
    problems.push(
      `deviations に ${d.gate} があるのに、gates.${d.gate}.state が "${s}" です。逸脱は実施を伴います`
    );
  }
  if (!(d.compensation ?? []).length) {
    problems.push(`deviations の ${d.gate} に代償措置がありません。代償措置のない逸脱は認められません`);
  }
}
if (
  config.gates?.g7?.params?.approverMode === 'value-owner-merged' &&
  isActive(config.gates?.g7?.state) &&
  !(config.deviations ?? []).some((d) => d.gate === 'g7')
) {
  problems.push(
    'G-7 の判定者が価値責任者との兼務ですが、deviations[] に逸脱の記録がありません(第3章 3.5.2)'
  );
}

// ---------------------------------------------------------- 3. 不変条件

const a = config.answers ?? {};
// 安全重要度 CL1 以上と規制業は、1〜2名の体制で成立しない。人の離脱などで生じた場合は、
// 出荷できない状態(shipBlocked)として記録されている。記録の無い構成は認めない。
// 記録がある構成は、実態の反映として通し、表示する。出荷は証跡の集約が止める
for (const p of shipBlockedProblems(config)) problems.push(p);
if (config.shipBlocked) notes.push(`出荷できない状態です(${config.shipBlocked.since} から): ${config.shipBlocked.reason}`);
if (a['q-criticality'] === 'cl3' && !config.shipBlocked && (config.review?.reviewerCount ?? 0) < 2) {
  problems.push('CL3 では独立レビューを2名で行います(第8章 軸E)');
}

// ---------------------------------------------------------- 4. AI レビュー

if (config.aiReview?.canApprove) {
  problems.push(
    'aiReview.canApprove を true にできません。AI の確認は検出の層であり、承認として扱わない規定によります(第5章 5.5.4)'
  );
}
if (config.aiReview?.requiredCheck) {
  problems.push(
    'aiReview.requiredCheck を true にできません。AI の判定を合否条件にすると自動化バイアスを招きます'
  );
}

// ---------------------------------------------------------- 4.5 席と運用形態

// 運用形態の宣言は上限であり、席の上限(第5章 5.5.6)を案件の構成から引き上げられない。
// 委任で移るのは判定の時点であり、判定者は席の責任者(人)のままである(ADR-0054)
if (!Array.isArray(config.seats)) {
  notes.push(
    'seats がありません(席・運用形態を持たない旧い構成)。どの席も委任なしとして扱います。/process-change で構成を再生成してください'
  );
} else {
  const delegation = config.delegation ?? {};
  const rules = delegation.rules ?? [];
  const mustBlock = a['q-criticality'] !== 'cl0' || a['q-quality'] === 'quality-regulated';
  if (typeof delegation.allowed !== 'boolean') {
    problems.push('delegation.allowed がありません。委任を適用できる案件かどうかを構成へ出力してください');
  } else if (mustBlock && delegation.allowed) {
    problems.push(
      'delegation.allowed を true にできません。安全重要度 CL1 以上、または規制業では委任を適用しません(第5章 5.5.4 条件1)'
    );
  }

  for (const s of config.seats) {
    const label = s.name ?? s.role;
    const ceiling = SEAT_CEILING[s.role] ?? 'delegated';
    if (!SEAT_MODES.includes(s.mode)) {
      problems.push(`${label}: 運用形態 "${s.mode}" は不正です。${SEAT_MODES.join(' / ')} のいずれかにしてください`);
      continue;
    }
    if (s.modeCeiling !== ceiling) {
      problems.push(`${label}: modeCeiling が "${s.modeCeiling}" です。席の上限は ${ceiling} で、構成から変えられません(第5章 5.5.6)`);
    }
    if (modeRank(s.mode) > modeRank(ceiling)) {
      problems.push(
        `${label}: 運用形態「${MODE_LABEL[s.mode]}」は席の上限「${MODE_LABEL[ceiling]}」を超えています。` +
          (s.mode === 'delegated' ? 'この席は委任できません' : 'この席は人確定に限ります') +
          '(第5章 5.5.6)'
      );
    }
    if (s.fallback != null && !['human', 'stop'].includes(s.fallback)) {
      problems.push(`${label}: fallback "${s.fallback}" は不正です。human(人へ戻す) / stop(止める) のいずれかにしてください`);
    }
    if (s.mode !== 'delegated') continue;

    if (delegation.allowed !== true) {
      problems.push(`${label}: 委任を宣言していますが、この案件では委任を適用できません(delegation.allowed が true でない)`);
    }
    if (!s.accountable) problems.push(`${label}: 委任を宣言していますが、責任者(accountable)が未記入です。委任でも判定者は席の責任者です`);
    if (!s.performer) problems.push(`${label}: 委任を宣言していますが、AI の担い手の識別(performer)が未記入です`);
    for (const q of qualificationProblems(s)) {
      problems.push(`${label}: 委任を宣言していますが、${q}。確認を経ない担い手は協働を上限とします(第3章 3.4.2)`);
    }
    if (!rules.some((r) => r.seat === s.role)) {
      problems.push(`${label}: 委任を宣言していますが、委任の範囲を定める機械の規則(delegation.rules)がありません。所在を書けない席は協働を上限とします`);
    }
    if (!s.fallback) problems.push(`${label}: 委任を宣言していますが、AI が使えないときの扱い(fallback)が未記入です`);
    // 適合性確認を承認するのは、当該の席の責任者である。責任者が交代すると、承認は引き継がれない(第3章 3.4.2)
    if (s.accountable && s.qualification?.approvedBy && personKey(config, s.accountable) !== personKey(config, s.qualification.approvedBy)) {
      problems.push(
        `${label}: 委任を宣言していますが、適合性確認の承認者(${s.qualification.approvedBy})が、この席の責任者ではありません。承認者が交代したため、承認が失効しています(記録は有効。新しい責任者の承認を要する)`
      );
    }
    // 委任の範囲は人が記名で定める。決定した者は、席の責任者、または D-0 表1「体制と運用形態」の決定者に限る。
    // 規則の追加・拡大は統制の弱化であり、AI維持管理者の承認の無い規則では委任は働かない(ADR-0038)。
    // 席を委任にできるのは、有効な規則が1つ以上ある場合である。有効でない規則は、その規則だけが働かない
    const seatRules = rules.filter((x) => x.seat === s.role).map((r) => ({ id: r.id ?? '(id なし)', ...ruleStanding(config, r) }));
    const inactive = seatRules.filter((x) => x.problems.length);
    if (seatRules.length && inactive.length === seatRules.length) {
      for (const x of inactive) problems.push(`委任の規則 ${x.id}: ${x.problems[0]}。${label} に有効な規則が1つもありません。委任を宣言できません`);
    } else {
      // 承認待ちの規則は、下の規則ごとの検査が注意として出す
      for (const x of inactive.filter((y) => !y.pending)) {
        notes.push(`委任の規則 ${x.id}: ${x.problems[0]}。この規則では委任は働きません(${label} は、有効な規則の範囲で委任のままです)`);
      }
    }
    // 指示資産の版の申告と、実ファイルの照合(照合できる形式で申告された場合)
    const ic = instructionsCheck(s.performer);
    if (ic.match === false) {
      problems.push(
        `${label}: 担い手の識別の指示資産(@${ic.declared})が、実ファイル(@${ic.actual})と一致しません。指示資産が変わった時点で適合性確認は失効します。/process-change(種別 performer)で反映し、再確認まで協働を上限とします(第3章 3.4.2)`
      );
    } else if (s.performer && ic.match === null) {
      notes.push(
        `${label}: 担い手の識別の指示資産(${s.performer.instructions ?? '未記入'})は、実ファイルと照合できない形式です(自己申告)。末尾へ @${instructionAssetsDigest()} を書くと照合します(node scripts/gate/verify-gate-contract.mjs --instructions-digest)`
      );
    }
  }

  // 委任の範囲の決定と拡大は、人が確定する(第5章 5.5.5)。全域の指定、変更種別のない規則、
  // 記名と理由のない規則を認めない。変更種別は、標準変更カタログの登録種別である(第3章 3.7.4)
  for (const r of rules) {
    const seat = config.seats.find((s) => s.role === r.seat);
    const id = r.id ?? '(id なし)';
    if (!seat) problems.push(`委任の規則 ${id}: 席 "${r.seat}" は構成にありません`);
    else if ((SEAT_CEILING[seat.role] ?? 'delegated') !== 'delegated') {
      problems.push(`委任の規則 ${id}: ${seat.name} は委任できない席です(第5章 5.5.6)`);
    }
    for (const p of delegationRuleProblems(r, config)) problems.push(`委任の規則 ${id}: ${p}`);
    if (!r.decidedBy || !r.reason) {
      problems.push(`委任の規則 ${id}: 決定した者(decidedBy)または理由(reason)がありません。委任の範囲は人が記名で定めます`);
    } else if (aiNameBlocked(config, r.decidedBy)) {
      problems.push(`委任の規則 ${id}: 決定した者 "${r.decidedBy}" は ${aiNameBlocked(config, r.decidedBy)}。AI の名義の記名を受け付けません`);
    }
    if (!r.approvedBy) {
      notes.push(`委任の規則 ${id}: AI維持管理者の承認がありません(state:needs-platform)。承認の記名があるまで、この規則では委任は働きません(席に有効な規則が1つも無ければ、席は協働として扱います)`);
    } else if (aiNameBlocked(config, r.approvedBy)) {
      problems.push(`委任の規則 ${id}: 規則の承認者 "${r.approvedBy}" は ${aiNameBlocked(config, r.approvedBy)}。AI の名義の記名を受け付けません`);
    }
  }

  // 標準変更カタログへ登録した変更種別と、確約範囲・コア指定のパス。過去の登録者は現在の名簿と
  // 照合しない(離任した人の登録を残すため)。AI の名義だけを拒否する
  for (const p of changeTypeProblems(config, { checkRegistrant: false })) problems.push(`標準変更カタログ: ${p}`);
  for (const p of protectedPathsProblems(config)) problems.push(p);
  if (delegation.allowed && rules.length && !Array.isArray(delegation.protectedPaths)) {
    notes.push(
      '確約範囲とコア指定のパス(delegation.protectedPaths)が未宣言です。委任の条件5(確約範囲とコア指定に触れない)を判定できないため、どの変更も委任に該当しません。該当するパスが無い場合は、/process-change で空の配列を宣言してください'
    );
  }
  // D-0 表1 の決定者の席
  if (config.governance) {
    const g = config.governance;
    const roles = config.seats.map((s) => s.role);
    if (!roles.includes(g.structureDecider)) problems.push(`governance.structureDecider "${g.structureDecider}" は席のロール ID ではありません`);
    if (g.catalogRegistrar !== 'b4' && !roles.includes(g.catalogRegistrar)) problems.push(`governance.catalogRegistrar "${g.catalogRegistrar}" は、b4 または席のロール ID ではありません`);
    if (structureDeciderSeat(config) !== 'biz-approver') {
      notes.push(`D-0 表1「体制と運用形態」の決定者は ${config.seats.find((s) => s.role === g.structureDecider)?.name}(既定の事業決裁者から変えています)`);
    }
  }

  // 記名の欄。責任者・承認者は記名の自然人であり、AI の名義と、名簿に無い名義を受け付けない
  for (const p of namingProblems(config)) problems.push(`記名を受け付けられません: ${p}(第5章 5.5.1)`);
  for (const n of nameOverrides(config)) notes.push(`名義の機械検査を人が上書きした: ${n}`);
  if (!(config.people ?? []).length) {
    notes.push(
      '人の名簿(people[])が未記入です。人が /process-change の people で記入してください(D-0 体制図の節1 は、構成から生成されます)。名簿が無いあいだ、席を委任にできず、緩める向きの決定を受け付けません'
    );
  }

  const blank = config.seats.filter((s) => !s.accountable).map((s) => s.name ?? s.role);
  if (blank.length) notes.push(`責任者が未記入の席があります: ${blank.join(' / ')}。/process-change で責任者を記入してください。出荷判定の証跡の集約は、未記入の席を欠落として扱います`);

  // 兼務禁止の再判定と、宣言した人数とのずれ(第3章 3.13.3 / 3.13.5)
  const sep = seatSeparationFindings(config);
  for (const v of sep.violations) {
    problems.push(`席の責任者が兼務禁止に抵触しています: ${v}(第3章 3.5。3名以上の体制では、同じ人がこの2つの席の責任者になれません)`);
  }
  for (const v of sep.deviated) {
    if (!(config.deviations ?? []).some((d) => d.separationId === v.id)) {
      problems.push(`兼務 ${v.pair} は 1〜2名の体制で成立しない組ですが、deviations[] に逸脱の記録がありません。/process-change で構成を再生成してください(第3章 3.5)`);
    } else {
      notes.push(`兼務を逸脱として記録しています: ${v.pair}。D-0 体制図へ記録し、表示し続けます`);
    }
  }
  for (const v of sep.notIndependent) {
    notes.push(`責任者が同一人物のため、独立が成立しない組があります: ${v}。AI を何体に分けても独立は成立しません`);
  }
  if (
    a['q-team-size'] === 'size-1-2' &&
    isActive(config.gates?.g6?.state) &&
    personKey(config, config.seats.find((s) => s.role === 'dev-verifier')?.accountable) &&
    personKey(config, config.seats.find((s) => s.role === 'dev-verifier')?.accountable) ===
      personKey(config, config.seats.find((s) => s.role === 'independent-reviewer')?.accountable)
  ) {
    problems.push(
      '独立レビュー(G-6)を適用する構成ですが、独立レビュアの席の責任者が、開発者の席の責任者と同一人物です。1〜2名の体制では、作成を指示した本人以外の確認者がいないため未達です。/process-change で構成を再生成してください'
    );
  }
  // 体制の人数と、チーム規模の回答のずれ
  for (const p of headcountProblems(config)) problems.push(`${p}。/process-change で反映してください(第3章 3.13.1)`);
  // 回答と名簿・席の矛盾(回答は確認者なし、席には別の人の確認者を記入、など)
  for (const p of answersRosterProblems(config)) problems.push(`${p}(第3章 3.13.5)`);
  if (config.governance?.qaNotice !== undefined && config.governance.qaNotice !== null && !(typeof config.governance.qaNotice === 'string' && config.governance.qaNotice.trim())) {
    problems.push('governance.qaNotice(品質保証部門の通知先)は、宛先の文字列か null で書きます');
  }

  // 変化点の記録(第3章 3.13.4)。緩める向きは、決定した者の記名と理由を要する
  const log = config.changeLog;
  if (!Array.isArray(log) || !log.length) {
    problems.push('changeLog がありません。構成の生成と体制の変化点の記録を消してはなりません');
  } else {
    log.forEach((e, i) => {
      if (!e.date) problems.push(`changeLog[${i}]: 日付がありません`);
      if (!(e.kind in CHANGE_KINDS)) problems.push(`changeLog[${i}]: 種別 "${e.kind}" は不正です`);
      // 緩める向きと任免の決定は、決定した者の記名と理由を要する
      if (SIGNED_DIRECTIONS.includes(e.direction) && !(e.decidedBy && e.reason)) {
        problems.push(`changeLog[${i}]: ${DIRECTION_LABEL[e.direction]}向きの変更に、決定した者の記名または理由がありません(第3章 3.13.3)`);
      }
      if (e.date && !isRealDay(String(e.date).slice(0, 10))) problems.push(`changeLog[${i}]: 日付 "${e.date}" は、暦に実在する日付ではありません`);
      // 過去の記名は、現在の名簿と照合しない(離任した人の記録を残すため)。AI の名義だけを拒否する
      // 人が上書きした名義は、その時点の記録(nameOverrides)か、現在の名簿で確かめる
      const blocked = (name) => (name && !(e.nameOverrides ?? []).includes(name) ? aiNameBlocked(config, name) : null);
      if (blocked(e.decidedBy)) {
        problems.push(`changeLog[${i}]: 決定した者 "${e.decidedBy}" は ${blocked(e.decidedBy)}。AI の名義の記名を受け付けません(第5章 5.5.7)`);
      }
      if (blocked(e.ruleApprovedBy)) {
        problems.push(`changeLog[${i}]: 規則の承認者 "${e.ruleApprovedBy}" は ${blocked(e.ruleApprovedBy)}。AI の名義の記名を受け付けません`);
      }
      if (e.kind === 'outage' && !(e.outage?.from && e.outage.handling in OUTAGE_HANDLING)) {
        problems.push(`changeLog[${i}]: AI が使えない期間の記録に、開始日またはその間の扱い(人へ戻した / 止めた)がありません`);
      }
      if (e.notice?.to && aiNameBlocked(config, e.notice.to)) {
        problems.push(`changeLog[${i}]: 通知先 "${e.notice.to}" は ${aiNameBlocked(config, e.notice.to)}。AI の名義の記名を受け付けません`);
      }
    });
    // 即時通知(第3章 3.13.6)の記録が済んでいない変化点。出荷判定の証跡の集約が、記録の欠落として扱う
    for (const n of pendingNotices(config)) {
      notes.push(
        `changeLog[${n.index}](${String(n.date).slice(0, 10)} ${n.kind}): 出荷判定者の席の責任者への即時通知が未記録です(${n.reasons.join('、')})。` +
          `/process-change(種別 notice。noticeFor: ${n.index})で、通知先と通知日を記録してください`
      );
    }
  }
}

// ---------------------------------------------------------- 5. アダプタ

let adapter = null;
try {
  adapter = loadAdapter(config);
} catch (e) {
  problems.push(e.message);
}

if (adapter) {
  if (adapter.id !== 'undetermined') {
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
      problems.push(
        `アダプタ ${adapter.id} の "secretScan" が空です。秘匿情報の検査は台帳記録による通過を認めない唯一の基準のため、` +
          '実行するコマンドが必要です。adapters/ のファイルへ書いてください'
      );
    }
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

// ---------------------------------------------------------- 8. 二重エンコードの検査

const GARBLED_CHARS = /[蠖縺繧繝蜿]/;

function scanForGarbledJapanese(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanForGarbledJapanese(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const match = content.match(GARBLED_CHARS);
      if (match) {
        const rel = path.relative(ROOT, fullPath);
        problems.push(
          `ファイル "${rel}" に二重エンコードと思われる化け文字（蠖, 縺, 繧, 繝, 蜿 など）が検出されました。文字コードを UTF-8 で保存し直してください。`
        );
      }
    }
  }
}

scanForGarbledJapanese(path.join(ROOT, '.claude'));
scanForGarbledJapanese(path.join(ROOT, 'templates'));

// ---------------------------------------------------------- 9. 強制層の一時緩和期限の検査

if (config.guard && config.guard.enabled === false) {
  if (config.guard.reviewBy) {
    const deadline = new Date(config.guard.reviewBy);
    const now = new Date();
    if (isNaN(deadline.getTime())) {
      problems.push(`process.config.json の guard.reviewBy に設定された日付 "${config.guard.reviewBy}" が不正です。YYYY-MM-DD 形式で記述してください。`);
    } else if (now > deadline) {
      problems.push(
        `process.config.json において、強制層の緩和期限（guard.reviewBy: ${config.guard.reviewBy}）を過ぎています。` +
          'ガードを有効化（guard.enabled: true）するか、必要に応じて期限と理由（guard.reason）を見直して再設定してください。'
      );
    } else {
      notes.push(
        `強制層の緩和設定（guard.enabled = false）が有効です。期限: ${config.guard.reviewBy}。理由: ${config.guard.reason || '未記入'}`
      );
    }
  } else {
    problems.push(
      'process.config.json の guard.enabled が false ですが、緩和期限（guard.reviewBy）が設定されていません。' +
        '恒久的な緩和を防ぐため、"YYYY-MM-DD" 形式で期限を記述してください。'
    );
  }
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

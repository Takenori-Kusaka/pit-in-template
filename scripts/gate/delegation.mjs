// 委任した変更を、人の事前確認なしに先へ進めてよいかの判定(標準 第5章 5.5.4)。
//
// 決定的な検査であり、AI に判定させない。入力はすべて引数で受け取る。GitHub にも
// 作業ツリーにも触れないため、手元でフィクスチャを与えて試験できる。
// 入口は check-delegation.mjs、証跡の集約(aggregate-evidence.mjs)も同じ関数を使う。
//
// 判定するのは、7条件のうち変更ごとに機械で判定できるものに限る。
//   条件1 構成が委任を許している(CL0・規制業でない・出荷できない状態でない)
//   条件2 変更したファイルがすべて承認済みの1つの規則の範囲に入り、強制層に触れない。
//         PR のリスク区分が R3。席が委任を宣言し、適合性確認が有効。
//         独立レビュアの席の規則にも該当する(G-6 の判定の時点を事後へ移せる)
//   条件3 G-5 の必須チェックが通過している
//   条件5 確約範囲とコア指定のパスに触れない(構成にパスのキーが無ければ、判定できないものとして該当しない。
//         空の配列は「確約範囲・コア指定なし」の宣言として通す)
//   条件7 すべてのコミットにトレーラ Delegated: <規則ID> がある
// G-6 を事後へ移す変更で、開発者の席がその変更について協働である(開発者の席の規則に当たらない)場合は、
// 開発者の席の人による検証が変更ごとに要る(第5章 5.5.6)。機械がマージを実行する条件に、開発者の席の
// 責任者(人)の承認(レビュアごとの最後の状態が承認)を加える。
// 条件4(取り消しの実績)と条件6(事後の抜き取り)は、登録時と事後の人の判断であり、
// ここでは判定しない。判定していない条件は、出力(notJudged)へ必ず載せる。

import {
  classifyDelegation,
  findPersonByAccount,
  personKey,
  aiNameReason,
  matchGlob,
  NEVER_DELEGATED,
  ruleDeciderProblems,
  ruleApprovalProblems,
  changeTypeProblems,
} from './config.mjs';

/** G-5 の必須ステータスチェックの名前(ゲート契約で固定) */
export const REQUIRED_CHECK = 'gate-g5';
/** G-6 の判定の時点を事後へ移すには、この席の規則に該当する必要がある */
export const REVIEWER_SEAT = 'independent-reviewer';
/** 開発者(検証)の席。G-6 を事後へ移す変更で、この席の規則に当たらなければ、開発者の席は協働である */
export const DEVELOPER_SEAT = 'dev-verifier';

/**
 * 先へ進めた変更に残す記録の文。承認と同じ語で記録しない(標準 第5章 5.5.4 条件7)。
 * 「人の事前確認を経ていない変更」は、G-6 の判定を事後へ移した変更だけを指す(第4章 G-7 保証の開示)
 */
export const recordText = (ruleId) =>
  `人の事前確認を経ていない変更(G-6 の判定を事後の抜き取りへ移した変更)として、規則 ${ruleId} により先へ進めた。承認ではない。`;

/** 変更ごとの機械の判定に含めない条件。出力へ必ず載せる */
export const NOT_JUDGED = [
  { id: '条件4', text: '単独で取り消せ、取り消しを実行した実績がある。変更種別の登録時に人が確かめる' },
  { id: '条件6', text: '独立レビュアの席の責任者が、事後に抜き取りで確かめる。逸脱を検知したら協働へ引き下げる。事後の人の判断である' },
];

/** PR の本文から、変更ごとのリスク区分を読む。選択肢を残したままの欄は未記入として扱う */
export function riskClassOf(body) {
  const section = (body ?? '').split(/^##\s*リスク区分.*$/m)[1]?.split(/^##\s/m)[0] ?? '';
  const found = new Set(section.replace(/<!--[\s\S]*?-->/g, '').match(/R[123]/g) ?? []);
  return found.size === 1 ? [...found][0] : null;
}

/** コミットメッセージの末尾の段落(トレーラの区画)から、キーに当たる値を返す */
export function trailerValues(message, key) {
  const blocks = String(message ?? '').replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  // 件名だけのコミットは、トレーラの区画を持たない
  if (blocks.length < 2) return [];
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'i');
  return blocks[blocks.length - 1]
    .split('\n')
    .map((l) => l.match(re)?.[1])
    .filter(Boolean);
}

/**
 * 規則が有効に成立しているかを確かめる。問題の一覧を返す。空なら成立している。
 * 決定した者の記名、AI維持管理者の承認、変更種別の登録の3つを見る(標準 第5章 5.5.4・5.5.7)
 */
export function ruleStandingProblems(config, ruleId) {
  const rule = (config.delegation?.rules ?? []).find((r) => r.id === ruleId);
  if (!rule) return [`規則 ${ruleId} が delegation.rules にない`];
  const out = [
    ...ruleDeciderProblems(config, rule).map((p) => `規則 ${ruleId}: ${p}`),
    ...ruleApprovalProblems(config, rule).map((p) => `規則 ${ruleId}: ${p}`),
  ];
  const types = config.delegation?.changeTypes;
  const type = String(rule.changeType ?? '').trim();
  if (!Array.isArray(types)) {
    out.push(`規則 ${ruleId}: 登録した変更種別の一覧(delegation.changeTypes)が構成にない。登録されていない種別は委任の範囲に入れない`);
  } else if (!types.some((t) => String(t?.id ?? '').trim() === type)) {
    out.push(`規則 ${ruleId}: 変更種別 "${type}" は、登録した変更種別(delegation.changeTypes)にない`);
  } else {
    // 登録した者の記名(名簿・登録の権限を持つ席)を確かめる
    out.push(...changeTypeProblems(config, { only: new Set([type]) }).map((p) => `規則 ${ruleId}: ${p}`));
  }
  return out;
}

/**
 * 確約範囲(SC-M)とコア指定のパス(delegation.protectedPaths)が、構成に宣言されているか(標準 第5章 5.5.4 条件5)。
 *
 * キーが無い構成では、触れていないことを機械で判定できない。規則で分類できない変更は協働へ落とす
 * (条件2)ため、該当なしとして扱う。空の配列は「確約範囲・コア指定なし」の宣言として受け付ける
 */
export const PROTECTED_PATHS_UNDECLARED =
  '条件5 を判定できない: 確約範囲とコア指定のパス(delegation.protectedPaths)が構成に未登録である。該当するパスが無い場合は、空の配列を宣言する';
export function protectedPathsDeclared(config) {
  return Array.isArray(config?.delegation?.protectedPaths);
}

/**
 * トレーラが指す規則に、変更が該当するかを判定する。規則の範囲(classifyDelegation)に加えて、
 * 規則が有効に成立しているか(ruleStandingProblems)と、条件5 のパスが宣言されているかを確かめる。
 * 該当しなければ rule は null
 */
export function classifyByRule(config, files, ruleId, changedLines = null) {
  if (!protectedPathsDeclared(config)) return { rule: null, reasons: [PROTECTED_PATHS_UNDECLARED] };
  const j = classifyDelegation(config, files, ruleId, changedLines);
  if (!j.rule) return { rule: null, reasons: j.reasons };
  const standing = ruleStandingProblems(config, j.rule);
  return standing.length ? { rule: null, reasons: standing } : { rule: j.rule, seat: j.seat, reasons: [] };
}

/**
 * 変更が、指定した席の有効な規則のいずれかに該当するかを判定する。
 * 独立レビュアの席(REVIEWER_SEAT)について該当する変更だけが、G-6 の判定の時点を事後へ移せる
 */
export function classifyForSeat(config, files, seatRole, changedLines = null) {
  if (!protectedPathsDeclared(config)) return { rule: null, reasons: [PROTECTED_PATHS_UNDECLARED] };
  const reasons = [];
  for (const r of (config.delegation?.rules ?? []).filter((x) => x.seat === seatRole)) {
    const j = classifyDelegation(config, files, r.id, changedLines, { seat: seatRole });
    const problems = j.rule ? ruleStandingProblems(config, r.id) : j.reasons;
    if (!problems.length) return { rule: r.id, reasons: [] };
    reasons.push(...problems);
  }
  if (!reasons.length) {
    // 規則が無い場合も、構成・強制層・規模の理由を先に返す
    const j = classifyDelegation(config, files, null, changedLines, { seat: seatRole });
    reasons.push(...(j.reasons.length ? j.reasons : [`席 ${seatRole} の委任の規則が登録されていない`]));
  }
  return { rule: null, reasons: [...new Set(reasons)] };
}

/**
 * 委任した変更を、人の事前確認なしに先へ進めてよいかを判定する。
 *
 * input:
 *   config   基底ブランチの process.config.json(PR の側の構成を渡してはならない)
 *   pr       { number, title, body, state, draft, baseRef, defaultBranch, headSha, fromFork, truncated }
 *   files    [{ path, previousPath, additions, deletions }]  PR の変更ファイル一覧
 *   commits  [{ sha, message }]                               PR のコミット
 *   checks   [{ name, status, conclusion }]                   PR の先頭のコミットのチェック
 *   reviews  [{ login, state, isBot }]                        PR のレビュー(時系列)。開発者の席が協働の場合に使う
 */
export function judgeDelegatedMerge({ config, pr = {}, files = [], commits = [], checks = [], reviews = [] }) {
  const conditions = [];
  const put = (id, label, problems) => conditions.push({ id, label, ok: problems.length === 0, problems });

  // 前提。判定の対象にできる PR か
  const pre = [];
  if (!config || config.configured === false) pre.push('プロセス構成が未設定である');
  if (pr.state && String(pr.state).toLowerCase() !== 'open') pre.push(`PR が open でない(${pr.state})`);
  if (pr.draft) pre.push('PR が Draft である');
  if (pr.defaultBranch && pr.baseRef !== pr.defaultBranch) {
    pre.push(`PR の基底(${pr.baseRef})が既定ブランチ(${pr.defaultBranch})でない。判定の構成は既定ブランチから読む`);
  }
  if (pr.fromFork) pre.push('フォークからの PR である');
  if (pr.truncated) pre.push('変更ファイルまたはコミットの一覧を取得しきれていない');
  if (!files.length) pre.push('変更したファイルがない');
  if (!commits.length) pre.push('コミットがない');
  put('前提', '判定の対象にできる PR である', pre);
  const cfg = config ?? {};

  // 条件1
  const a = cfg.answers ?? {};
  const c1 = [];
  if (a['q-criticality'] !== 'cl0') c1.push(`安全重要度が CL0 でない(${a['q-criticality'] ?? '未記入'})`);
  if (a['q-quality'] === 'quality-regulated') c1.push('規制業に該当する');
  if (cfg.delegation?.allowed !== true) c1.push('構成が委任を許していない(delegation.allowed が true でない)');
  if (cfg.shipBlocked) c1.push(`出荷できない状態である(${cfg.shipBlocked.reason ?? '理由の記録なし'})`);
  put('条件1', '構成が委任を許している(CL0・規制業でない・出荷できない状態でない)', c1);

  // 条件7。条件2 が規則 ID を使うため、先に判定する
  const c7 = [];
  const claimed = new Set();
  const missing = [];
  for (const c of commits) {
    const values = [...new Set(trailerValues(c.message, 'Delegated'))];
    if (values.length !== 1) missing.push(String(c.sha ?? '').slice(0, 8) || '(sha なし)');
    for (const v of values) claimed.add(v);
  }
  if (missing.length) c7.push(`トレーラ Delegated: <規則ID> が無い、または複数あるコミットがある(${missing.slice(0, 5).join(', ')})`);
  if (claimed.size > 1) c7.push(`コミットごとに規則 ID が異なる(${[...claimed].join(', ')})。1つの変更は1つの規則に当てる`);
  const ruleId = !missing.length && claimed.size === 1 ? [...claimed][0] : null;

  // 条件2
  const paths = [...new Set(files.flatMap((f) => [f.path, f.previousPath]).filter(Boolean))];
  const lines = files.reduce((n, f) => n + (Number(f.additions) || 0) + (Number(f.deletions) || 0), 0);
  const c2 = [];
  const guarded = paths.filter((f) => NEVER_DELEGATED.some((g) => matchGlob(g, f)));
  if (guarded.length) {
    c2.push(`強制層・構成の正本・判定の記録に触れる(${guarded.slice(0, 5).join(', ')})。これらに触れる変更は、常に対象外である`);
  }
  let actingRule = null;
  if (!ruleId) c2.push('トレーラから規則 ID が定まらないため、規則を特定できない');
  else {
    const acting = classifyByRule(cfg, paths, ruleId, lines);
    actingRule = acting.rule;
    c2.push(...acting.reasons);
  }
  const risk = riskClassOf(pr.body);
  if (risk !== 'R3') c2.push(`PR のリスク区分が R3 と記録されていない(記録: ${risk ?? '未記入'})`);
  put('条件2', '承認済みの1つの規則の範囲に入り、強制層に触れず、リスク区分が R3 である', [...new Set(c2)]);

  // G-6 の判定の時点を事後へ移せるのは、独立レビュアの席の規則にも該当する変更だけである。
  // 開発者の席の規則にだけ該当する変更は、独立レビュアが人として事前に承認する(現在のルールセットのままマージする)。
  // トレーラの規則に該当しない変更では、判定しない
  let reviewerRule = null;
  if (actingRule) {
    const reviewer = classifyForSeat(cfg, paths, REVIEWER_SEAT, lines);
    reviewerRule = reviewer.rule;
    put(
      'G-6',
      '独立レビュアの席の規則にも該当する(G-6 の判定の時点を事後へ移せる)',
      reviewerRule ? [] : [`独立レビュアの席の委任の範囲に当たらない。G-6 は、独立レビュアが事前に承認する(${reviewer.reasons.slice(0, 3).join('。')})`]
    );
  }

  // 条件3
  const c3 = [];
  const g5 = checks.filter((c) => c.name === REQUIRED_CHECK);
  if (!g5.length) c3.push(`必須チェック ${REQUIRED_CHECK} の結果が無い`);
  for (const c of g5) {
    const status = String(c.status ?? 'completed').toLowerCase();
    const conclusion = String(c.conclusion ?? '').toLowerCase();
    if (status !== 'completed') c3.push(`必須チェック ${REQUIRED_CHECK} が完了していない(${status})`);
    else if (conclusion !== 'success') c3.push(`必須チェック ${REQUIRED_CHECK} が通過していない(${conclusion || '結果なし'})`);
  }
  put('条件3', `G-5 の必須チェック(${REQUIRED_CHECK})が通過している`, [...new Set(c3)]);

  // 条件5。キーが無い構成では判定できないため、該当しない(規則で分類できない変更は協働へ落とす)。
  // 空の配列は「確約範囲・コア指定なし」の宣言として通す。宣言が正しいかは、機械で確かめない
  const notJudged = [...NOT_JUDGED];
  if (!protectedPathsDeclared(cfg)) {
    put('条件5', '確約範囲(SC-M)とコア指定のパスに触れない', [PROTECTED_PATHS_UNDECLARED.replace(/^条件5 を判定できない: /, '判定できない。')]);
  } else {
    const protectedGlobs = cfg.delegation.protectedPaths.filter((g) => typeof g === 'string' && g.trim());
    const hits = paths.filter((f) => protectedGlobs.some((g) => matchGlob(g, f)));
    put(
      '条件5',
      protectedGlobs.length
        ? '確約範囲(SC-M)とコア指定のパスに触れない'
        : '確約範囲(SC-M)とコア指定のパスに触れない(構成が「確約範囲・コア指定なし」と宣言済み)',
      hits.length ? [`確約範囲またはコア指定のパスに触れる(${hits.slice(0, 5).join(', ')})`] : []
    );
  }

  put('条件7', 'すべてのコミットにトレーラ Delegated: <規則ID> がある', c7);

  // G-6 を事後へ移す変更で、開発者の席がこの変更について協働である場合は、開発者の席の人による検証を要する
  // (第5章 5.5.6)。機械がマージする条件に、開発者の席の責任者(人)の承認を加える
  let developerSeatCollab = false;
  if (reviewerRule) {
    const developer = classifyForSeat(cfg, paths, DEVELOPER_SEAT, lines);
    developerSeatCollab = !developer.rule;
    if (developerSeatCollab) {
      const devKey = personKey(cfg, (cfg.seats ?? []).find((s) => s.role === DEVELOPER_SEAT)?.accountable);
      const last = new Map();
      for (const r of reviews) {
        const state = String(r.state ?? '').toUpperCase();
        if (r.login && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(state)) last.set(r.login, { state, bot: Boolean(r.isBot) });
      }
      const approved = [...last].some(
        ([login, v]) => v.state === 'APPROVED' && !v.bot && !aiNameReason(login, { account: true }) && devKey && findPersonByAccount(cfg, login)?.id === devKey
      );
      put(
        '開発者の席',
        '開発者の席はこの変更について協働である。開発者の席の責任者(人)が変更を検証し、承認している',
        approved
          ? []
          : [
              devKey
                ? '開発者の席の責任者(人)の承認が無い(レビュアごとの最後の状態で見る)。開発者の席の人による検証が変更ごとに要る(第5章 5.5.6)'
                : '開発者の席の責任者が未記入、または名簿のアカウントと対応づかない',
            ]
      );
    }
  }

  const eligible = conditions.every((c) => c.ok);
  // 開発者の席だけの委任。G-6 のほかの条件をすべて満たす変更は、変更ごとの検証を担い手が行い、
  // 独立レビュアが人として事前に承認する。人の事前確認を経ていない変更ではない
  const performerVerified = !eligible && Boolean(actingRule) && conditions.every((c) => c.ok || c.id === 'G-6');
  return {
    // 人の事前確認なしに先へ進めてよいか(G-6 を事後へ移す委任)
    eligible,
    // 'post-hoc'(G-6 を事後へ移す) / 'performer-verified'(開発者の席だけの委任。独立レビュアが事前に承認する) / 'collab'
    handling: eligible ? 'post-hoc' : performerVerified ? 'performer-verified' : 'collab',
    rule: eligible ? ruleId : null,
    actingRule: eligible || performerVerified ? actingRule : null,
    claimedRule: ruleId,
    reviewerRule,
    // G-6 を事後へ移す変更で、開発者の席が協働か(開発者の席の責任者の承認を要する)
    developerSeatCollab,
    riskClass: risk,
    conditions,
    reasons: conditions.flatMap((c) => c.problems.map((p) => `${c.id}: ${p}`)),
    notJudged,
    record: eligible ? recordText(ruleId) : null,
  };
}

// テーラリングルールエンジン(提案ロジック #60)
// 知識ベース(src/data/tailoring/)の規則を回答に適用し、
// 参照モデルへの調整プロファイルと根拠トレースを導出する純粋関数群。
// 設計ドキュメント: /tool/proposal-logic/、データ設計: ADR-0008
//
// 依存なしの ESM。Astro アイランド(#61)からも node スクリプトからも import できる。

/** 構造を変える操作(同一対象に1つだけ生き残る) */
const STRUCTURAL_ACTIONS = new Set(['omit', 'simplify', 'strengthen', 'merge-into', 'restore']);
/** 統制を下げる構造操作。restore(適用へ戻す)が取り消す対象(#318 / ADR-0088 決定4) */
const RELAXING_ACTIONS = new Set(['omit', 'simplify', 'merge-into']);

/** 対象の一意キー(例: "gate:g-ship", "process") */
export function targetKey(target) {
  return target.id ? `${target.type}:${target.id}` : target.type;
}

/**
 * 表示すべき質問を返す(appliesWhen による条件付き表示の解決)。
 * 非表示の質問への回答は evaluate() でも無視される。
 */
export function visibleQuestions(questions, answers) {
  return questions.filter(
    (q) =>
      !q.appliesWhen ||
      Object.entries(q.appliesWhen).every(([qid, opts]) => opts.includes(answers[qid]))
  );
}

/** 規則の条件判定。同一質問内は OR、質問間は AND */
function ruleMatches(rule, answers) {
  return Object.entries(rule.when).every(([qid, opts]) => opts.includes(answers[qid]));
}

/**
 * 規則を回答に適用し、調整プロファイルとトレースを導出する。
 *
 * @param {object} kb 知識ベース { questions, rules }
 *   rules は全ファイルの規則を1配列に平坦化したもの(ファイル内の記載順を保つ)
 * @param {Record<string, string>} answers 質問 id → 回答(選択肢 id)
 * @returns {{ answers, matchedRuleIds, trace, warnings, profile }}
 *   - trace: 調整1件ごとの適用記録(根拠表示・出力2の元データ)
 *   - warnings: 規則同士の衝突(ユーザーに判断を促す)
 *   - profile: 対象ごとの最終状態(描画層 #61 が参照モデルへ重ねる)
 */
export function evaluate(kb, answers) {
  // 1. 非表示質問の回答を落とす(条件付き質問の残骸を条件判定に使わない)
  const visibleIds = new Set(visibleQuestions(kb.questions, answers).map((q) => q.id));
  const effAnswers = Object.fromEntries(
    Object.entries(answers).filter(([qid]) => visibleIds.has(qid))
  );

  // 2. 条件が成立する規則を集め、優先度の昇順で安定ソートする
  //    (後に適用されるものが勝つ「後勝ち」。同順位はデータの記載順)
  const matched = kb.rules.filter((r) => ruleMatches(r, effAnswers));
  const ordered = matched
    .map((r, i) => ({ rule: r, order: i }))
    .sort((a, b) => (a.rule.priority ?? 10) - (b.rule.priority ?? 10) || a.order - b.order)
    .map((x) => x.rule);

  // 3. 調整を順に適用する
  const trace = [];
  const warnings = [];
  /** @type {Map<string, object>} 対象ごとの生存中の構造操作 */
  const structural = new Map();
  /** @type {Map<string, object>} 対象+param ごとの生存中の set */
  const params = new Map();

  // quiet: 同じ結論への到達や同順位の通常合成は「衝突」ではないため、
  // 上書きの記録(トレースの取り消し線)だけ残して警告は出さない(#63 ユーザーテスト)
  const conflict = (loser, winner, message, quiet = false) => {
    loser.status = 'overridden';
    loser.overriddenBy = winner.ruleId;
    if (quiet) return;
    warnings.push({ target: targetKey(loser.target), loser: loser.ruleId, winner: winner.ruleId, message });
  };
  /** omit が無効化した設定(omit の調整 → 無効化した set の調整)。省略が取り消されたら、設定を戻す */
  const invalidatedBy = new Map();
  // 省略を取り消して対象を復活させたとき、その省略が無効化した設定を戻す。復活したゲートが、
  // 省略の前に決まっていた設定(判定者の方式・レビューの方式など)を失わないため(#318)
  const reinstate = (omitEntry) => {
    for (const pentry of invalidatedBy.get(omitEntry) ?? []) {
      const pkey = `${targetKey(pentry.target)}#${pentry.param}`;
      const cur = params.get(pkey);
      // 省略の後に同じ設定を別の規則が決めていれば、そちらが勝つ
      if (cur && cur !== pentry && cur.status === 'applied') continue;
      pentry.status = 'applied';
      delete pentry.overriddenBy;
      params.set(pkey, pentry);
    }
    invalidatedBy.delete(omitEntry);
  };

  for (const rule of ordered) {
    for (const adj of rule.adjustments) {
      const entry = {
        ruleId: rule.id,
        priority: rule.priority ?? 10,
        target: adj.target,
        action: adj.action,
        param: adj.param,
        value: adj.value,
        note: adj.note,
        reason: rule.reason,
        source: rule.source,
        status: 'applied',
      };
      trace.push(entry);
      const key = targetKey(adj.target);

      if (adj.action === 'restore') {
        // restore(適用へ戻す): 先に効いている省略・簡略・統合を取り消し、標準の適用へ戻す。
        // 厳格化(strengthen)は下げない。既に適用以上なら何もしない(#318 / ADR-0088 決定4)
        const prev = structural.get(key);
        if (prev && !RELAXING_ACTIONS.has(prev.action)) {
          conflict(entry, prev, `${key} は既に適用されているため、取り消しは要らない`, true);
          continue;
        }
        if (prev) {
          conflict(prev, entry, `${key} への「${prev.action}」を、優先度の高い規則が取り消し(適用へ戻す)`);
          if (prev.action === 'omit') reinstate(prev);
        }
        structural.set(key, entry);
        continue;
      }

      if (STRUCTURAL_ACTIONS.has(adj.action)) {
        const prev = structural.get(key);
        if (prev) {
          // 適用へ戻した対象を厳格化するのは、同じ向きの合成であり衝突ではない
          const sameOutcome =
            (prev.action === adj.action && prev.value === adj.value) || (prev.action === 'restore' && adj.action === 'strengthen');
          conflict(
            prev,
            entry,
            `${key} への「${prev.action}」を優先度の高い規則が「${adj.action}」で上書き`,
            sameOutcome
          );
        }
        // 後から来た omit は、既に適用済みの set(同順位以下)を無効化する
        // (同順位は警告なし: 省略されたゲートの設定が残ると矛盾した提案になる)
        if (adj.action === 'omit') {
          for (const [pkey, pentry] of params) {
            if (pkey.startsWith(`${key}#`) && pentry.status === 'applied' && pentry.priority <= entry.priority) {
              invalidatedBy.set(entry, [...(invalidatedBy.get(entry) ?? []), pentry]);
              conflict(
                pentry,
                entry,
                `${key} の省略により設定「${pentry.param}」が無効化`,
                pentry.priority === entry.priority
              );
            }
          }
        }
        structural.set(key, entry);
      } else if (adj.action === 'set') {
        const pkey = `${key}#${adj.param}`;
        const prev = params.get(pkey);
        if (prev) {
          conflict(prev, entry, `${key} の設定「${adj.param}」を優先度の高い規則が上書き`);
        }
        // 低優先度の omit の上に高優先度の set が来たら、対象を復活させる
        // (品質・規制の要求を省略指示が黙って消さないための安全側の規則)
        // 同順位なら構造操作(省略)を優先し、set 側を静かに落とす
        // (省略済みゲートに「判定者は〜」等の設定が残る矛盾を防ぐ)
        const st = structural.get(key);
        if (st && st.action === 'omit' && st.status === 'applied') {
          if (st.priority < entry.priority) {
            conflict(st, entry, `${key} の省略を、優先度の高い設定要求が取り消し(対象を復活)`);
            structural.delete(key);
            reinstate(st);
          } else {
            conflict(entry, st, `${key} は省略のため設定「${adj.param}」は適用しない`, true);
            invalidatedBy.set(st, [...(invalidatedBy.get(st) ?? []), entry]);
            continue;
          }
        }
        params.set(pkey, entry);
      }
      // action: note は蓄積のみ(衝突しない)
    }
  }

  // 4. 対象ごとの最終状態(プロファイル)へ集約する
  const profile = {};
  for (const entry of trace) {
    if (entry.status !== 'applied') continue;
    const key = targetKey(entry.target);
    const p = (profile[key] ??= { target: entry.target, state: 'standard', params: {}, notes: [] });
    if (STRUCTURAL_ACTIONS.has(entry.action)) {
      p.state =
        entry.action === 'merge-into' ? `merged-into:${entry.value}` : entry.action === 'restore' ? 'standard' : entry.action;
    } else if (entry.action === 'set') {
      p.params[entry.param] = entry.value;
    }
    p.notes.push(entry.note);
  }

  return {
    answers: effAnswers,
    matchedRuleIds: ordered.map((r) => r.id),
    trace,
    warnings,
    profile,
  };
}

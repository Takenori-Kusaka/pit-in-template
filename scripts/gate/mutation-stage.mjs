// G-5 の段 mutation(変異試験)・regulatory(規制要件の検査)の判定(標準 附属書F F.6・附属書H H.1。ADR-0224・ADR-0244。process-compass #445)。
//
// adapter.mjs が呼ぶ。段の必須の判定は決定可能な条件だけで行う。
//   - mutation の必須 =「案件の条件(附属書F F.2 の Q1 が「はい」、または安全重要度 CL3)」または「この変更が R1」
//   - regulatory の必須 = 構成の回答 q-quality が quality-regulated
// R1 の判定(R1 の変更の変異試験は、案件の条件に依らず必須。ADR-0244):
//   - PR の経路: PR の本文の区分(riskClassOf)と、区分の下限(riskFloorOf。基底ブランチの構成の規則)の高いほう
//   - push の経路: コミットのトレーラ Risk: と、区分の下限の高いほう
//   - 判定の入力が読めないとき(経路が分からない・変更ファイルを取れない・本文が渡されない・コミットを取れない)は、必須の側に倒す
// 段の出力の約束(コマンドは、次の1行を標準出力へ出す。外部の記録を照らすコマンドも同じ):
//   mutation-result: score=<0〜100 の数値 または none> survivors=<生き残りの一覧の所在(空でない文字列)>
//   none は「対象の変異体なし」(差分に変異を作れる箇所が無い)。none は閾値があっても比較せず通す
// 機械が見るのは、この行の構文・閾値の型・スコアと閾値の大小まで。コマンドの実質(変異を作ったか)、外部の記録の真正と新しさ、
// 生き残りの所在の実在は確かめない(manual。確かめる者: G-6 の判定者。EV-0339)。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ROOT } from './config.mjs';
import { riskClassOf, trailerValues } from './delegation.mjs';
import { riskFloorOf, changeListBetween, prAuthorRef, instructorsOf, instructorTokensOf, instructorSectionTokens } from './check-pr.mjs';
import { mutationBreachExceptionFor } from './exception-expiry.mjs';
import { clJudgmentState, readF2Q1Text } from './cl-judgment.mjs';

function gitOut(args, root = ROOT) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** 案件の条件(附属書F F.2 の Q1 が「はい」、または CL3)。d0Text は docs/D-0-governance.md の本文(無ければ null) */
export function caseConditionOf(config, d0Text) {
  const reasons = [];
  const q1 = readF2Q1Text(d0Text);
  if (q1 === true) reasons.push('附属書F F.2 の Q1 が「はい」');
  let cls = null;
  try {
    cls = clJudgmentState(config, { text: d0Text }).cls ?? null;
  } catch {
    cls = null;
  }
  if (cls === 'cl3' || config?.answers?.['q-criticality'] === 'cl3') reasons.push('安全重要度 CL3');
  const a = config?.answers ?? {};
  const q1Matters = ['cl1', 'cl2', 'cl3'].includes(a['q-criticality']) || a['q-quality'] === 'quality-regulated';
  return { required: reasons.length > 0, reasons, q1Unreadable: q1 === null && q1Matters };
}

/**
 * この変更が R1 か。
 *   event: 'pull_request' | 'push' | その他(読めない)
 *   body: PR の本文(イベントのペイロードから)。diffBase: 比較の起点(PR は基底ブランチ、push は直前のコミット)
 *   baseConfig: 基底ブランチの構成(区分の下限の規則はここから読む)
 * 返す値: { r1, unreadable, why }。読めないときは r1 = true(必須の側に倒す)
 */
export function r1Of({ event, body, diffBase, baseConfig, git = gitOut }) {
  const unreadable = (why) => ({ r1: true, unreadable: true, why });
  if (event !== 'pull_request' && event !== 'push') {
    return unreadable(event ? `この起動の経路(${event})ではリスク区分を判定しない` : '起動の経路(PIT_IN_EVENT)が分からず、リスク区分を判定できない');
  }
  if (!diffBase) return unreadable('比較の起点(PIT_IN_DIFF_BASE)が渡されず、変更ファイルを取れない');
  // 変更の一覧は check-pr と同じもの(名前の変更を検出し from を持つ)。ここで新しく定義しない(束 B28 の突合 M-3)
  const changes = changeListBetween(git, diffBase, 'HEAD');
  if (changes === null) return unreadable(`${diffBase} との差分を取れない(浅い取得か、起点が無い)`);
  const floor = riskFloorOf(baseConfig?.riskFloor?.rules, changes).floor;
  let declared = null;
  if (event === 'pull_request') {
    if (typeof body !== 'string') return unreadable('PR の本文(PIT_IN_PR_BODY)が渡されない');
    declared = riskClassOf(body);
  } else {
    const log = git(['log', '--format=%B%x00', `${diffBase}..HEAD`]);
    if (log === null) return unreadable(`${diffBase}..HEAD のコミットを取れない`);
    const vals = log.split('\0').flatMap((m) => trailerValues(m, 'Risk'));
    declared = vals.some((v) => /\bR1\b/.test(v)) ? 'R1' : null;
  }
  const r1 = declared === 'R1' || floor === 'R1';
  return { r1, unreadable: false, why: r1 ? (declared === 'R1' ? (event === 'push' ? 'トレーラ Risk: R1' : 'PR の本文の区分が R1') : '区分の下限が R1') : null, declared, floor };
}

/** 段の出力の1行を読む。ok でなければ problem に理由 */
export function parseMutationResult(out) {
  const hits = [...String(out ?? '').matchAll(/^mutation-result:[ \t]+score=(\S+)[ \t]+survivors=(.*?)\s*$/gm)];
  if (!hits.length) return { ok: false, problem: '段の出力に `mutation-result: score=<数値|none> survivors=<所在>` の行がありません。未測定のまま通しません' };
  const [, rawScore, survivors] = hits[hits.length - 1];
  const none = rawScore === 'none';
  const score = none ? null : /^\d+(\.\d+)?$/.test(rawScore) ? Number(rawScore) : NaN;
  if (!none && !(Number.isFinite(score) && score >= 0 && score <= 100)) return { ok: false, problem: `スコア "${rawScore}" が 0〜100 の数値でも none でもありません` };
  if (!survivors.trim()) return { ok: false, problem: '生き残った変異の一覧の所在(survivors=)が空です' };
  return { ok: true, none, score, survivors: survivors.trim() };
}

/** 閾値の型。未設定は undefined を返す(問題なし)。0〜100 の数値でなければ problem */
export function thresholdOf(ci) {
  const v = ci?.mutationThreshold;
  if (v === undefined) return { value: undefined };
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) return { value: v };
  return { value: undefined, problem: `構成の ci.mutationThreshold(${JSON.stringify(v)})が 0〜100 の数値ではありません` };
}

/**
 * 出荷の集約(G-7 の材料)へ出す、構成に閾値が無いことの注意の1行。構成の値を読むだけ(決定可能。ruling-1 §1.1)。
 * 閾値が数値で在れば null(注意を出さない)。無ければ「閾値なしで通過する」と出す。型が不正なら不正と出す
 */
export function mutationThresholdNote(config, d0Text = null) {
  const t = thresholdOf(config?.ci);
  if (t.problem) return `**注意**: ${t.problem}。G-5 の段 mutation の閾値として使えません`;
  if (t.value !== undefined) return null;
  // 案件の条件(CL3・Q1「はい」)に当たる構成では、閾値が無いと段も契約検査も失敗にする(ADR-0224 決定6)。通過するとは言わない
  if (caseConditionOf(config, d0Text).required) {
    return '**注意**: 構成に閾値(ci.mutationThreshold)がありません。案件の条件(附属書F F.2 の Q1 が「はい」または CL3)に当たる構成なので、閾値が未設定のため、段と契約検査が失敗にします。/process-change(種別 settings)で値を書いてください';
  }
  return '**注意**: 構成に閾値(ci.mutationThreshold)がありません。G-5 の段 mutation は、走った事実と生き残りの所在だけを証跡として「閾値なしで通過」します。検出力が足りるとは示していません(附属書H H.1・H.4)';
}

/** 閾値の在否と型の問題(契約検査が使う)。caseRequired: 案件の条件に当たる構成では未設定も問題 */
export function thresholdProblems(config, d0Text) {
  const t = thresholdOf(config?.ci);
  if (t.problem) return [t.problem];
  if (t.value === undefined && caseConditionOf(config, d0Text).required) {
    return ['構成に ci.mutationThreshold(G-5 の段 mutation の閾値。附属書F F.2 の Q1 が「はい」または CL3 の案件では必須)がありません。/process-change(種別 settings)で値を書いてください'];
  }
  return [];
}

/** 段の実行に要る判定をまとめる。env は環境変数、config は作業ツリーの構成 */
export function decideStage({ phase, config, env = process.env, root = ROOT, git = gitOut }) {
  let baseConfig = null;
  if (env.PIT_IN_BASE_CONFIG) {
    try {
      baseConfig = JSON.parse(fs.readFileSync(env.PIT_IN_BASE_CONFIG, 'utf8'));
    } catch {
      baseConfig = null;
    }
  }
  if (phase === 'regulatory') {
    const required = config?.answers?.['q-quality'] === 'quality-regulated';
    return { phase, required, reasons: required ? ['規制業(q-quality が quality-regulated)'] : [] };
  }
  let d0 = null;
  try {
    d0 = fs.readFileSync(`${root}/docs/D-0-governance.md`, 'utf8');
  } catch {
    d0 = null;
  }
  const caseCond = caseConditionOf(config, d0);
  const r1 = r1Of({ event: env.PIT_IN_EVENT, body: env.PIT_IN_PR_BODY, diffBase: env.PIT_IN_DIFF_BASE, baseConfig: baseConfig ?? config, git });
  const reasons = [...caseCond.reasons, ...(r1.r1 ? [r1.unreadable ? `R1 かを判定できない(${r1.why})ため必須の側に倒す` : `この変更が R1(${r1.why})`] : [])];
  // 閾値は基底ブランチの構成から読む。基底の構成が渡されないとき(push・手元)は作業ツリーの構成。
  // 案件の条件に当たる構成で基底に値が無いときは作業ツリーの値を使う(値を初めて入れる PR を止めないため。値の下げは check-pr が止める)
  const base = thresholdOf((baseConfig ?? config)?.ci);
  const head = thresholdOf(config?.ci);
  const t = base.problem ? base : base.value === undefined && caseCond.required ? head : base;
  return { phase, required: caseCond.required || r1.r1, caseRequired: caseCond.required, r1, reasons, threshold: t.value, thresholdProblem: t.problem ?? null, q1Unreadable: caseCond.q1Unreadable };
}

/**
 * 閾値割れを第7章 7.3 の例外承認の行で受けられるか(ADR-0243)。閾値割れのときだけ adapter.mjs が呼ぶ。
 * 入力: PIT_IN_EVENT(pull_request | push)・PIT_IN_PR_CONTEXT(mutation-pr-context.mjs の出力の所在)・
 *       PIT_IN_POLICY_BASE(基底の台帳を読む点。PR は既定ブランチの先端、push は push の直前のコミット)。
 * 返す値: { matched, rejected, reason }。取れない入力はすべて受けない側(reason)に倒す。day は呼び出し側が渡す(時計を読まない)
 */
export function breachExceptionOf({ config, day, env = process.env, root = ROOT, git = gitOut }) {
  const none = (reason) => ({ matched: [], rejected: [], reason });
  const event = env.PIT_IN_EVENT;
  if (event !== 'pull_request' && event !== 'push') return none(event ? `この起動の経路(${event})では閾値割れを台帳の行で受けない` : '起動の経路(PIT_IN_EVENT)が分からない');
  if (!env.PIT_IN_PR_CONTEXT) return none('PR の記録(PIT_IN_PR_CONTEXT)が渡されない');
  let ctx;
  try {
    ctx = JSON.parse(fs.readFileSync(env.PIT_IN_PR_CONTEXT, 'utf8'));
  } catch {
    return none('PR の記録(PIT_IN_PR_CONTEXT)を読めない');
  }
  if (!ctx || ctx.problem) return none(`PR の記録を取得できなかった: ${ctx?.problem ?? '不明'}`);
  if (ctx.route !== event || !ctx.pr?.number) return none('PR の記録の経路が起動の経路と一致しない');
  if (!env.PIT_IN_POLICY_BASE) return none('基底の台帳を読む点(PIT_IN_POLICY_BASE)が渡されない');
  // 規則(名簿・AI の名義)は基底の構成から読む。渡されなければ作業ツリーの構成
  let baseConfig = config;
  if (env.PIT_IN_BASE_CONFIG) {
    try {
      baseConfig = JSON.parse(fs.readFileSync(env.PIT_IN_BASE_CONFIG, 'utf8'));
    } catch {
      return none('基底の構成を読めない');
    }
  }
  const baseLedgerText = git(['show', `${env.PIT_IN_POLICY_BASE}:docs/debt-ledger.md`], root);
  let headLedgerText = null;
  try {
    headLedgerText = fs.readFileSync(`${root}/docs/debt-ledger.md`, 'utf8');
  } catch {
    headLedgerText = null;
  }
  const author = prAuthorRef({ author: ctx.pr.authorLogin, authorId: ctx.pr.authorId });
  const body = ctx.pr.body ?? '';
  // 段はトークンを持たず、@アカウントを数値の識別子へ解決できない。@ で書かれた指示者は対応づかないものとして受けない側へ倒す
  const handles = instructorSectionTokens(body).filter((t) => t.startsWith('@') || t.startsWith('＠'));
  const unresolved = [...instructorTokensOf(baseConfig, body, author, null).unresolved, ...handles.map((t) => `${t}(段は @アカウントを識別子で確かめられない)`)];
  return mutationBreachExceptionFor({
    config: baseConfig,
    baseLedgerText: baseLedgerText || null,
    headLedgerText,
    prNumber: ctx.pr.number,
    day,
    author,
    reviews: ctx.reviews ?? null,
    head: ctx.pr.headSha ?? null,
    instructorIds: instructorsOf(baseConfig, body, author, null).map((i) => i.id),
    instructorUnresolved: unresolved,
  });
}

/**
 * 段の結果の評価(コマンドが終了コード 0 で終わった後)。{ ok, messages: [{level, text}] }
 * exceptionOf: 閾値割れのときだけ呼ばれ、{ matched, rejected, reason } を返す関数(breachExceptionOf)。渡されなければ閾値割れは常に失敗
 */
export function evaluateMutation({ out, stage, exceptionOf = null }) {
  const msgs = [];
  if (stage.thresholdProblem) return { ok: false, messages: [{ level: 'error', text: stage.thresholdProblem }] };
  if (stage.caseRequired && stage.threshold === undefined) {
    return { ok: false, messages: [{ level: 'error', text: '案件の条件(附属書F F.2 の Q1 が「はい」または CL3)に当たる構成で ci.mutationThreshold が未設定です。/process-change(種別 settings)で値を書いてください' }] };
  }
  const r = parseMutationResult(out);
  if (!r.ok) return { ok: false, messages: [{ level: 'error', text: r.problem }] };
  if (r.none) {
    msgs.push({ level: 'notice', text: `対象の変異体なし(survivors=${r.survivors})。閾値の比較はしません` });
    return { ok: true, messages: msgs };
  }
  if (stage.threshold === undefined) {
    msgs.push({ level: 'notice', text: `閾値なしで通過(score=${r.score}、survivors=${r.survivors})。走った事実と所在だけを証跡とし、検出力が足りるとは主張しません` });
    return { ok: true, messages: msgs };
  }
  if (r.score < stage.threshold) {
    const breach = `スコア ${r.score} が閾値 ${stage.threshold} に届きません(survivors=${r.survivors})`;
    const ex = exceptionOf ? exceptionOf() : null;
    if (ex?.matched?.length) {
      const m = ex.matched[0];
      // 証跡の1行。G-7 が見るのは行の形と帰属・期限だけで、段がこの行で受けた事実はこの出力と承認した者の宣言行に頼る
      return { ok: true, messages: [{ level: 'notice', text: `閾値割れを第7章 7.3 の例外承認 ${m.id} で受けた(score=${r.score}、閾値 ${stage.threshold}、承認した者 ${m.approver}、返却の目安 ${m.due}、survivors=${r.survivors})` }] };
    }
    const errs = [{ level: 'error', text: breach }];
    if (ex) {
      if (ex.reason) errs.push({ level: 'error', text: `台帳の行で受けられません: ${ex.reason}` });
      for (const x of ex.rejected) errs.push({ level: 'error', text: `台帳の行 ${x}` });
      if (!ex.reason && !ex.rejected.length) errs.push({ level: 'error', text: '台帳(docs/debt-ledger.md)に対象が `G-5 PR-<この PR の番号>` の区分「例外」の行が無いため、7.3 で受けられません。行の書き方: .claude/skills/gate/reference/exception-paths.md' });
      else errs.push({ level: 'error', text: '承認した者がレビューを出した後は、gate-g5 の「失敗したジョブの再実行」で再評価する' });
    }
    return { ok: false, messages: errs };
  }
  msgs.push({ level: 'notice', text: `スコア ${r.score} は閾値 ${stage.threshold} 以上です(survivors=${r.survivors})` });
  return { ok: true, messages: msgs };
}

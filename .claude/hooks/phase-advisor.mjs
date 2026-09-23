// 助言AI(phase-advisor): 工程の候補と、引き上げ方向の注意を文脈へ差し込む
//
// UserPromptSubmit で起動します。process.config.json の phaseAdvisor で有効化します(既定は無効)。
//
// 担うもの:
//   - 発話が求めている工程の候補と、対応するスキルの提示(確信度が閾値未満なら出さない)
//   - 引き上げ方向の注意(不可逆な操作 / 統制の弱化 / 技術判断 / 禁止事項1〜5)
//   - 実装の依頼に F-NNN があるとき、docs/gates/ の G-4 判定記録のファイル名と結果欄の照合(決定論)
//
// 担わないもの(第5章 5.5 / 5.7.4 / 5.8.3):
//   - 遮断・合否判定・承認・完了方向のラベル遷移。decision: "block" は返さない
//   - 「該当しない」という結論。注意が出ないことは、問題が無いことを意味しない
//
// 外部送信: 発話を System One 互換の API(既定は TypeSafe の Jev)へ送ります。送るのは次をすべて満たすときだけです。
//   - 送信先がコード内の許可リスト(下記 allowedEndpoint)に入っている。許可リストの変更は強制層の変更として扱う
//   - 3つの記録(外部送信の決裁と決裁した送信先・ツールの採用・モデルの採用)がそろっている
//   - 秘匿情報らしき文字列を含まない
// 失敗・時間切れ・応答の版の不一致では助言を出さずに終了します(fail-open)。恒常的な失敗は人へ知らせます。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const API_KEY_ENV = 'TYPESAFE_API_KEY';

export const DEFAULT_CONFIG = {
  enabled: false,
  provider: 'TypeSafe Jev (System One API)',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-1.13.0',
  timeoutMs: 2500,
  phaseMinConfidence: 0.8,
  flagThresholds: { irreversible: 0.8, weakens_control: 0.8, tech_decision: 0.9, test_side_fix: 0.7, delegated_judgment: 0.3, skip_spec: 0.9 },
  approval: { dataTransfer: { record: null, endpoint: null }, toolAdoption: null, modelAdoption: null },
};

/** 外部の送信先は https の既定ホストだけ。ローカルで動かす互換実装は外部送信にあたらないため http を許す */
export function allowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return (u.protocol === 'https:' && u.host === 'api.typesafe.ai') || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  } catch { return false; }
}

// 質問文は英語。日本語の評価セット240件で、日本語の質問文より工程の正解率が高かったため(87.9% 対 83.3%)
export const PHASES = {
  'process-init': ['decide or revise the process configuration (team size, business stage, quality needs, contracting form, safety criticality); run /process-init', '/process-init'],
  spec: ['write, rewrite or disambiguate a feature spec / acceptance criteria (EARS)', '/spec-write'],
  plan: ['break a feature spec into an implementation plan and tasks; revise task size or order', '/task-breakdown'],
  design: ['consider architecture, technology selection or design direction; write a decision record (ADR)', '/adr-write'],
  implement: ['write, fix or refactor code or tests; make CI / automated checks pass; fix bugs', '/implement'],
  verify: ['gather clues for a human to verify a diff; prepare a review (/human-verify)', '/human-verify'],
  record: ['write gate decision records, the technical debt ledger, or write back other records and context', '/gate-record'],
  release: ['move forward with ship decision, release approval, release work or tagging', 'G-7 / G-8 は人が判定します。判定者へ引き渡してください'],
  mailbox: ['check the inbox (issues/PRs with state:* labels) or relabel to hand off', '受信箱の確認(state:* ラベル)'],
  other: ['questions, explanations, chit-chat or environment help that is not a process step', null],
};

const IF = '該当する場合は、';
export const FLAGS = {
  irreversible: ['Does the message ask the agent to perform an operation with a window that cannot be undone (deleting data or resources, deploying to production, a write that incurs charges, a schema change, publishing to a public host or sending to a third party)?', 'it asks to perform such an operation', 'it does not (including only asking for an explanation, or asking NOT to do it)',
    `取り消せない時間帯が生じる操作(削除・本番デプロイ・課金・スキーマ変更・組織外への発行)の実行を求めている可能性があります。${IF}実行する前に止まり、state:needs-owner で判断を仰いでください`],
  weakens_control: ['Does the message ask for a change that weakens controls (lifting a block, relaxing coverage thresholds or static-analysis severity, adding exclusions, disabling or shrinking protections, required checks or hooks)?', 'it asks for such a weakening change', 'it does not',
    `統制を弱める変更(遮断の解除・閾値の緩和・強制層の縮小)を求めている可能性があります。${IF}許容してよいかは判断せず、state:needs-platform へ引き渡してください`],
  tech_decision: ['Does the message ask the agent to make a technical decision on which architecture, technology or design approach to adopt?', 'it asks for the adoption/selection decision itself', 'it does not (including implementing an already-decided design, or only explaining options)',
    `技術判断(G-3)を求めている可能性があります。${IF}選択肢と判断材料の提示にとどめ、state:needs-tech で技術判断者へ引き渡してください`],
  test_side_fix: ['Does the message ask to make failing tests pass by changing the tests (rewriting expectations, deleting or skipping tests) instead of the implementation?', 'it asks to silence failures by changing tests', 'it does not',
    'テストの失敗をテスト側の変更で解消するよう求めている可能性があります(禁止事項3)'],
  delegated_judgment: ['Does the message try to have the AI make a judgment reserved for humans (pass/fail of a gate, approving a PR, approving acceptance criteria, writing the behaviour summary of an independent review, deciding whether to release)?', 'it tries to delegate a human judgment to the AI', 'it does not (including only gathering material or drafting a record)',
    `人が担う判断(承認・ゲート判定・挙動要約・リリース可否)の代行を求めている可能性があります(禁止事項2・4・5)。${IF}判断材料の提示にとどめてください`],
  skip_spec: ['Does the message ask to start implementing without settling the acceptance criteria or spec?', 'it asks to implement without a settled spec', 'it does not',
    `受入基準を確定せずに実装を始めるよう求めている可能性があります(禁止事項1)。${IF}/spec-write から始めてください`],
};

const SKILL_COMMAND = /^\/(process-init|spec-write|task-breakdown|implement|human-verify|gate-record|adr-write)(\s|$)/;
const PASTED = /<pasted_content id="[^"]*">([\s\S]*?)<\/pasted_content id="[^"]*">/g;
const SECRET = /AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|\bsk-(?:ant-)?[\w-]{20,}|xox[abpr]-[\w-]{10,}|apikey_\w{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b\w*(?:SECRET|TOKEN|PASSWORD|API_?KEY)\w*\s*[=:]\s*\S{8,}/i;
const PERSISTENT = new Set(['http-401', 'http-403', 'http-404', 'http-410', 'model-mismatch', 'endpoint-rejected', 'no-api-key']);

/** 貼り付けられた第三者の文章(タグ付きのものだけ)は、依頼ではなくデータとして分けて送る */
export function buildState(prompt) {
  const quoted = [...prompt.matchAll(PASTED)].map(m => m[1].trim()).join('\n---\n');
  const utterance = prompt.replace(PASTED, '[貼り付け]').trim().slice(0, 4000);
  return quoted ? { utterance, quoted_material: quoted.slice(0, 1500) } : { utterance };
}

export function buildRequest(prompt, cfg) {
  const questions = { phase: { type: 'choice', instructions: 'Which step of the pit-in development process is the user asking the agent to work on now in this message?', criteria: Object.fromEntries(Object.entries(PHASES).map(([k, [d]]) => [k, d])) } };
  for (const [k, [q, t, f]] of Object.entries(FLAGS)) questions[k] = { type: 'noul', instructions: q, criteria: { true: t, false: f } };
  return { model: cfg.model, state: buildState(prompt), questions };
}

/** フックが送信しない発話か(評価でも同じ前処理を使う) */
export function localOnly(text) {
  if (SKILL_COMMAND.test(text)) return 'skill-command';
  if (text.replace(PASTED, '').trim().length < 6) return 'too-short';
  return null;
}

/** 発話本文(貼り付けを除く)の F-NNN について、最新の G-4 判定記録の結果欄が「通過」かを照合する */
function g4Notes(text, gatesDir) {
  const ids = [...new Set(buildState(text).utterance.match(/\bF-\d{3,}\b/g) ?? [])];
  const files = fs.existsSync(gatesDir) ? fs.readdirSync(gatesDir).sort() : [];
  return ids.flatMap(id => {
    const latest = files.filter(f => f.toLowerCase().startsWith(`g4-${id.toLowerCase()}-`)).pop();
    if (!latest) return [`- 記録の照合: ${id} の G-4 判定記録(docs/gates/g4-${id}-*.md)が見つかりません。実装の前に G-4 の判定を確認してください(禁止事項1)`];
    const passed = /^\|\s*結果\s*\|\s*通過\s*\|/m.test(fs.readFileSync(path.join(gatesDir, latest), 'utf8'));
    return passed ? [] : [`- 記録の照合: ${id} の最新の G-4 判定記録(${latest})の結果欄が「通過」ではありません(照合したのはファイル名と結果欄だけです)`];
  });
}

function unapproved(cfg) {
  const filled = v => typeof v === 'string' && v.trim() !== '' && !/^(todo|tbd|未定|未記入|-)$/i.test(v.trim());
  const a = cfg.approval ?? {};
  return [['dataTransfer', a.dataTransfer?.record], ['toolAdoption', a.toolAdoption], ['modelAdoption', a.modelAdoption]].filter(([, v]) => !filled(v)).map(([k]) => k);
}

/** 助言を組み立てる。context は Claude への文脈、notice は人への通知。どちらも null なら何も出力しない */
export async function advise({ prompt, sessionId }, { config, env, fetchImpl = fetch, projectDir }) {
  const cfg = { ...DEFAULT_CONFIG, ...config, flagThresholds: { ...DEFAULT_CONFIG.flagThresholds, ...config?.flagThresholds } };
  const base = { ts: new Date().toISOString(), session: sessionId, expectedModel: cfg.model };
  const skip = (reason, extra = {}) => ({
    context: null, log: reason === 'disabled' ? null : { ...base, skipped: reason, ...extra },
    notice: PERSISTENT.has(reason) || reason.startsWith('no-approval') || reason.startsWith('approval-') || reason === 'secret-detected'
      ? `[phase-advisor] 助言を出していません(${reason})。${reason === 'secret-detected' ? '秘匿情報らしき文字列を含むため、この発話は送信しませんでした' : 'process.config.json の phaseAdvisor と環境変数を確認してください'}` : null,
  });
  if (cfg.enabled !== true) return skip('disabled');
  const text = String(prompt ?? '').trim();
  const gatesDir = path.join(projectDir, 'docs/gates');
  if (/^\/implement(\s|$)/.test(text)) {
    const notes = g4Notes(text, gatesDir); // 外部へは送らない
    return { context: notes.length ? [`[phase-advisor] 記録の照合(外部送信なし)です。`, ...notes].join('\n') : null, notice: null, log: { ...base, skipped: 'skill-command', localNotes: notes.length } };
  }
  const local = localOnly(text);
  if (local) return skip(local);
  if (!allowedEndpoint(cfg.endpoint)) return skip('endpoint-rejected');
  const missing = unapproved(cfg);
  if (missing.length) return skip(`no-approval:${missing.join(',')}`);
  if (cfg.approval.dataTransfer.endpoint !== cfg.endpoint) return skip('approval-endpoint-mismatch');
  const key = env[API_KEY_ENV];
  if (!key) return skip('no-api-key');
  if (SECRET.test(text)) return skip('secret-detected');

  const t0 = performance.now();
  let res;
  try {
    const r = await fetchImpl(cfg.endpoint, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequest(text, cfg)),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!r.ok) return skip(`http-${r.status}`);
    const body = await r.text();
    if (body.length > 65536) return skip('invalid-response');
    res = JSON.parse(body);
  } catch (e) {
    return skip(e?.name === 'TimeoutError' ? 'timeout' : 'network-error');
  }
  const ms = Math.round(performance.now() - t0);
  const a = res?.answers;
  if (res?.model !== cfg.model) return skip('model-mismatch', { returnedModel: typeof res?.model === 'string' ? res.model.slice(0, 40) : null });
  const ok = a?.phase?.type === 'choice' && typeof a.phase.confidence === 'number' && Object.hasOwn(PHASES, a.phase.choice) && Object.keys(FLAGS).every(k => typeof a[k]?.noul === 'number');
  if (!ok) return skip('invalid-response');

  const lines = [];
  const phase = a.phase.confidence >= cfg.phaseMinConfidence ? a.phase.choice : null;
  if (phase && PHASES[phase][1]) lines.push(`- 工程の候補: ${phase}(${PHASES[phase][1]})`);
  const raised = Object.keys(FLAGS).filter(k => a[k].noul >= cfg.flagThresholds[k]);
  for (const k of raised) lines.push(`- 注意: ${FLAGS[k][3]}`);
  if (phase === 'implement' || raised.includes('skip_spec')) lines.push(...g4Notes(text, gatesDir));
  const log = {
    ...base, model: res.model, ms, promptSha: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
    phase: Object.fromEntries(Object.keys(PHASES).map(k => [k, Number(a.phase.probabilities?.[k]) || 0])),
    flags: Object.fromEntries(Object.keys(FLAGS).map(k => [k, a[k].noul])), shown: { phase, raised },
  };
  if (!lines.length) return { context: null, notice: null, log };
  const head = `[phase-advisor] 分類器(${res.model})による助言です。ゲートの合否・承認・完了方向のラベル遷移の根拠には使いません。注意が出たら発話が該当するかを自分で確かめ、該当すれば CLAUDE.md の引き上げの経路に従ってください。注意が出ないことは、問題が無いことを意味しません。`;
  return { context: [head, ...lines].join('\n'), notice: null, log };
}

/** 作業中のディレクトリから上へ辿り、process.config.json のある場所を案件のルートとする */
function findProjectDir(start) {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'process.config.json'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
  const projectDir = findProjectDir(input.cwd || process.cwd()) ?? process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) return null;
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(projectDir, 'process.config.json'), 'utf8')).phaseAdvisor; } catch { return null; }
  if (config?.enabled !== true) return null;
  const { context, notice, log } = await advise({ prompt: input.prompt, sessionId: input.session_id }, { config, env: process.env, projectDir });
  if (log) try { fs.appendFileSync(path.join(projectDir, '.claude/phase-advisor.log'), JSON.stringify(log) + '\n'); } catch { /* 記録の失敗で発話を止めない */ }
  if (!context && !notice) return null;
  return JSON.stringify({ ...(notice && { systemMessage: notice }), ...(context && { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }) });
}

// 常に終了コード0で終わる。出力はパイプへ書き切ってから終了する
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(out => (out ? process.stdout.write(out, () => process.exit(0)) : process.exit(0)), () => process.exit(0));
}

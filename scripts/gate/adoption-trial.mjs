// 導入前の検証(標準 附属書I I.11)を、採用者のリポジトリで準備・実行・集計し、「導入前の検証の記録」の様式で出す(#288 第2巡)。
//
//   node scripts/gate/adoption-trial.mjs init                       合否の基準の様式を docs/adoption-trial/criteria.md へ写す
//   node scripts/gate/adoption-trial.mjs seal --manifest <path>     欠陥注入の記録(注入した者だけが持つ)の要約値を封じる
//   node scripts/gate/adoption-trial.mjs tally --manifest <path> [--human <json>] [--ai <json>] [--tolerance 3]
//                                                                    封じた要約値を照合し、見つける者の記録と突き合わせて集計する
//   node scripts/gate/adoption-trial.mjs env-check --by <氏名>       実環境の統制(ルールセットの適用・PR のレビューの取得・ship-evidence の
//                                                                    成果物)を採用者の実環境の gh で読み、docs/adoption-trial/env-check.json へ書く
//   node scripts/gate/adoption-trial.mjs run [--keep]               基準の確認 → 場面集 → 実環境の統制の記録 → 演習の記録 → 成立判定 → 記録の出力
//   node scripts/gate/adoption-trial.mjs verify <記録>              記録の末尾の要約値(入力と本文)を再計算し、一致を確かめる
//
// 7つの要件(I.11)を、このコマンドでは次のように扱う。
//   ⑦ 実環境の統制の確認は env-check が実環境の gh で読む(#288 第6巡)。模擬の gh・未認証・成果物が無い環境では各項目を
//      「読めない」として未確認に倒し、記録の節3 と出荷の集約の項目4 に「未確認」と出し続ける(未達のゲートと同じ扱い)。
//      場面集(⑤)が一時の複製と模擬の gh で止まることと、実環境でブランチ保護が効いていることは別の事実である
//   ① 合否の基準は、採用者が docs/adoption-trial/criteria.md に書いてコミットしてから run する。コミットされていない、
//      記入日時がコミットより後、コミットの後に書き換えた、のいずれかなら実行しない。以前の実行より後に基準を改めた記録は
//      「採用の証拠に数えない」と出す
//   ② 採用者のリポジトリ(構成・D-0・層1・企画書・台帳・人の名簿)で実行する。製品のコードが1つも無いリポジトリ(テンプレートそのもの)
//      で実行した記録には「採用者の環境の証拠ではない」と出す。席に就く人が行ったかは、記録の実施者の欄で人が示す
//   ③ 欠陥注入は、注入した者が記録(manifest)をリポジトリの外に持ち、seal で要約値だけを残す。見つける者には件数も位置も渡らない。
//      tally で要約値を照合し、人の層と AI の層を分けて数え、docs/adoption-trial/seeded-errors.json(記録の置き場。コミットされる)へ書く。
//      出荷の集約は、記録の置き場に記録があるとき evidence/seeded-errors.json を読まない(測定時点が新しくても採らない。#288 第5巡)。
//      evidence/ は .gitignore のため、そこへ書いた測定値は clone した CI の集約に届かない(#288 第4巡)。
//      測定値の層には blind:true と method(出所の印)を書く。出荷の集約は、この印の無い記録と、測定時点が判定の日より後の記録を
//      測定値に数えない。AI の層には測定した担い手の識別(席・モデル・指示資産の版)を書き、現在の識別と一致しなければ失効になる。
//      見つける者は複数(finders[]、findings[].by)でよく、検出率は和集合、各人の検出数は参考値。G-6 を2名で行う体制では2名で見つける。
//      目隠しを確かめられない層(見つける者の誰かが注入した者と同じ、見つける者の記録がコミットされていない、記録の前後関係が逆、など)は
//      測定値として書かず、blind:false と理由だけを書く。出荷の集約はその層を未測定として扱う
//   ④ 再実行の手順・入力・構成の版・出力の所在を記録に書く。記録の名前は秒までの時刻(record-YYYYMMDD-HHMMSS.md)。
//      同じ名前の記録が既にあれば上書きせず止まる
//   ⑤ 場面集11件を、リポジトリの一時の複製で実際のゲートの検査(check-pr・aggregate-evidence・generate-profile・層1 の読み取り)に通す。
//      止まらなかった場面と、確かめられなかった場面をそのまま出す
//   ⑥ 記録は1件の測定(E2)として、根拠の水準を表示する
//
// 記録の様式は、採用者が記入する欄(節0: 実施者、下流の指標の基準値、検証の期間の工数の実績、理解の確認の記録、人事評価の規程と
// 目標設定の様式の写しの所在)と、コマンドが埋める欄(節1〜8)を分ける。演習の記録は、実施日が今日より後なら数えない。
// 類型E の結果は D-0 表7(縮退の3列)へ人が転記する。転記する値と行を記録の節4 に案内する(表7 は手で書く表であり、構成へ入れない)
// 記録の末尾(節10)に、入力(基準のコミットと要約値、構成、注入の記録、場面集の結果、演習の記録)と本文の要約値を書く。本文の要約値は、
// 記録の全文(節10 の後ろを含む)を対象にし、人が書く欄(<!-- human-fields --> の印で囲んだ表の指定の列)と、節10 の要約値の行の値だけを
// 伏せて計算する。節10 の定型の行の後ろに行があれば不一致にする(見出しで打ち切ると、後ろへの追記が検査の外になる。#288 第4巡)。
// verify <記録> が再計算して一致を確かめる。git の履歴に依らず、記録そのものから書き換えを見つけられるようにするため
//
// 以前の実行より後に基準を改めたかは、runs/ の実行の記録と、git の履歴(記録 record-*.md を足したコミットの時刻と、その時点の基準の
// 要約値)の両方で判定する。runs/ を消しても「採用の証拠に数えない」は消えない
//
// 本物の gh を呼ばない。場面の PR は複製の中の模擬の gh(PIT_TRIAL_PRS)から読む。採用者のリポジトリ自体は書き換えない
// (書くのは docs/adoption-trial/ だけ)。

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, fail, notice, warn, isFilledValue, isRealDay, aiNameBlocked, configDigest, localDay, localIso } from './config.mjs';
import { readPolicy, continuityState, samePerson, POLICY_FILE, D0_FILE, ENV_CHECK_FILE, ENV_CHECK_ITEMS, readEnvCheck, envEvidenceMissing, envEvidenceText } from './org-assurance.mjs';
import { isProductCode } from './check-pr.mjs';

export const TRIAL_DIR = 'docs/adoption-trial';
export const CRITERIA_FILE = `${TRIAL_DIR}/criteria.md`;
export const SEAL_FILE = `${TRIAL_DIR}/injection-seal.json`;
export const RESULT_FILE = `${TRIAL_DIR}/injection-result.json`;
export const DRILL_FILE = `${TRIAL_DIR}/drills.json`;
/** 欠陥注入の測定値。記録の置き場に書き、コミットする(出荷の集約が evidence/seeded-errors.json より先に読む) */
export const SEEDED_FILE = `${TRIAL_DIR}/seeded-errors.json`;
const EXIT_FILE = 'docs/exit-rehearsal.json';

const argv = process.argv.slice(2);
const cmdName = argv[0];
const arg = (k, d = null) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
const clean = (v) => String(v ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
const nfkc = (v) => clean(v).normalize('NFKC');
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const rel = (p) => path.join(ROOT, p);
const readText = (p) => (fs.existsSync(rel(p)) ? fs.readFileSync(rel(p), 'utf8').replace(/\r\n/g, '\n') : null);
const writeText = (p, t) => {
  fs.mkdirSync(path.dirname(rel(p)), { recursive: true });
  fs.writeFileSync(rel(p), t);
};
function gitAt(cwd) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
    } catch {
      return null;
    }
  };
}
const git = gitAt(ROOT);

/** 2列の表から、項目が key で始まる行の値 */
function rowValue(text, key) {
  for (const l of String(text ?? '').split('\n')) {
    const m = l.match(/^\|\s*\**([^|]*?)\**\s*\|\s*(.*?)\s*\|\s*$/);
    if (m && nfkc(m[1]).startsWith(key.normalize('NFKC'))) return clean(m[2]);
  }
  return null;
}

// ---------------------------------------------------------------- init

function init() {
  if (fs.existsSync(rel(CRITERIA_FILE))) {
    notice(`${CRITERIA_FILE} は既にあります。書き換えません`);
    return 0;
  }
  const tpl = readText('templates/adoption-trial-criteria.md');
  if (!tpl) {
    fail('templates/adoption-trial-criteria.md がありません');
    return 1;
  }
  writeText(CRITERIA_FILE, tpl);
  notice(`${CRITERIA_FILE} を作りました。採用者(人)が合否の基準・記入日時・記入者を書き、コミットしてから run します。AI は欄を推測で埋めません`);
  return 0;
}

// ---------------------------------------------------------------- 欠陥注入(要件③)

function readJson(p, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
  } catch (e) {
    throw new Error(`${label}(${p})を JSON として読めません: ${e.message}`);
  }
}

function manifestProblems(m) {
  const out = [];
  if (!isFilledValue(m?.injector)) out.push('injector(注入した者)が未記入');
  if (!Array.isArray(m?.injections) || !m.injections.length) out.push('injections[] が無い');
  for (const [i, x] of (m?.injections ?? []).entries()) {
    if (!isFilledValue(x?.file) || !Number.isInteger(x?.line) || !isFilledValue(x?.type)) out.push(`injections[${i}] に file・line(整数)・type(類型)が無い`);
  }
  return out;
}

function seal() {
  const mp = arg('--manifest');
  if (!mp) {
    fail('--manifest <注入の記録の所在> を渡します。記録はリポジトリの外に置き、見つける者に渡しません');
    return 2;
  }
  if (path.resolve(mp).startsWith(path.resolve(ROOT) + path.sep)) {
    fail('注入の記録がリポジトリの中にあります。見つける者が読めるため、目隠しになりません。リポジトリの外へ移してから封じます');
    return 1;
  }
  const raw = fs.readFileSync(path.resolve(mp), 'utf8');
  const m = readJson(mp, '注入の記録');
  const problems = manifestProblems(m);
  if (problems.length) {
    for (const p of problems) fail(`注入の記録: ${p}`);
    return 1;
  }
  const record = { digest: sha256(raw), injector: m.injector, sealedAt: localIso(), note: '件数と位置は含めない。tally で注入の記録と照合する' };
  writeText(SEAL_FILE, JSON.stringify(record, null, 2) + '\n');
  notice(`${SEAL_FILE} を書きました。見つける者が確かめを始める前にコミットします(コミットの時刻が、目隠しの前後関係の証拠になる)`);
  return 0;
}

function tally() {
  const mp = arg('--manifest');
  const tol = Number(arg('--tolerance', '3'));
  const sealRec = readText(SEAL_FILE) ? JSON.parse(readText(SEAL_FILE)) : null;
  if (!mp || !sealRec) {
    fail(`--manifest と、封じた記録(${SEAL_FILE})が要ります。先に seal を実行します`);
    return 2;
  }
  const raw = fs.readFileSync(path.resolve(mp), 'utf8');
  if (sha256(raw) !== sealRec.digest) {
    fail('注入の記録が、封じた要約値と一致しません。封じた後に記録を書き換えた結果は、検出率に数えません');
    return 1;
  }
  const m = JSON.parse(raw);
  const config = loadConfig();
  const blindAll = [];
  const sealCommit = git(['log', '-1', '--format=%cI', '--', SEAL_FILE]);
  if (!sealCommit) blindAll.push(`${SEAL_FILE} がコミットされていない(封じた時点を確かめられない)`);
  const layers = {};
  for (const [layer, def] of [
    ['human', `${TRIAL_DIR}/findings-human.json`],
    ['ai', `${TRIAL_DIR}/findings-ai.json`],
  ]) {
    const fp = arg(`--${layer}`, fs.existsSync(rel(def)) ? rel(def) : null);
    if (!fp) continue;
    const f = readJson(fp, `見つける者の記録(${layer})`);
    const why = [];
    // 見つける者は1名(finder)でも複数(finders[])でもよい。G-6 を2名で行う体制では2名で見つけ、検出率は和集合で数える(#288 第5巡)。
    // 全員が注入した者と別人であることを要する。1人でも同一なら、その層は目隠しを満たさない
    const finders = [...new Set([...(Array.isArray(f.finders) ? f.finders : []), ...(isFilledValue(f.finder) ? [f.finder] : [])].map((x) => String(x ?? '').trim()).filter(Boolean))];
    if (!finders.length) why.push('finder(見つける者)または finders[] が未記入');
    for (const who of finders) {
      if (samePerson(config, who, m.injector)) why.push(`見つける者 ${who} が注入した者と同じ(目隠しにならない。2名以上でも1人が同一なら、その層は目隠しを満たさない)`);
      if (layer === 'human' && aiNameBlocked(config, who)) why.push(`人の層の見つける者 ${who} が AI の名義`);
    }
    const relPath = path.relative(ROOT, path.resolve(fp)).replace(/\\/g, '/');
    const inRepo = !relPath.startsWith('..') && !path.isAbsolute(relPath);
    const fCommit = inRepo ? git(['log', '-1', '--format=%cI', '--', relPath]) : null;
    // 封じた時点との前後関係は、見つける者の記録のコミットの時刻で確かめる。コミットされていない記録(リポジトリの外の記録を含む)と、
    // コミットの後に変更のある記録は、前後関係を確かめられない(#288 第4巡)
    if (!fCommit) why.push(`見つける者の記録(${inRepo ? relPath : fp})がコミットされていない(封じた時点との前後関係を確かめられない)`);
    else if (git(['status', '--porcelain', '--', relPath])) why.push(`見つける者の記録(${relPath})にコミットの後の変更がある(封じた時点との前後関係を確かめられない)`);
    else if (sealCommit && fCommit < sealCommit) why.push('見つける者の記録のコミットが、封じた時点より前');
    // 指摘と注入の対応は、同じファイルで行の差が許容の内の組を、差の小さい順に1対1で割り当てる
    const findings = Array.isArray(f.findings) ? f.findings : [];
    // 指摘ごとの見つけた人(findings[].by)。省略は、見つける者が1名ならその人、複数なら「不明」(和集合には数え、各人の値には数えない)
    const byOf = (x) => (isFilledValue(x?.by) ? String(x.by).trim() : finders.length === 1 ? finders[0] : null);
    const unknownBy = findings.filter((x) => isFilledValue(x?.by) && !finders.some((who) => samePerson(config, who, String(x.by).trim())));
    if (unknownBy.length) why.push(`findings[].by に finders[] に無い名前がある(${[...new Set(unknownBy.map((x) => String(x.by).trim()))].join('、')})。見つける者の記録として整合しない`);
    const match = (list) => {
      const pairs = [];
      list.forEach((x, fi) =>
        m.injections.forEach((inj, k) => {
          const d = Math.abs(inj.line - Number(x.line));
          if (path.normalize(inj.file) === path.normalize(String(x.file ?? '')) && d <= tol) pairs.push({ fi, k, d });
        })
      );
      const usedF = new Set();
      const used = new Set();
      const hits = [];
      for (const pr of pairs.sort((a, b) => a.d - b.d)) {
        if (usedF.has(pr.fi) || used.has(pr.k)) continue;
        usedF.add(pr.fi);
        used.add(pr.k);
        hits.push({ ...m.injections[pr.k], index: pr.k });
      }
      return hits;
    };
    // 和集合(全員の指摘をまとめて1対1で割り当てる)が層の検出数。各人の検出数は参考値として併記する。
    // 各人が見つけた注入の添字(hits)も書く。見つける者の一部が後に名簿から離れたとき、出荷の集約が残る者の
    // 指摘の和集合で値を読み直すため(#288 第6巡 O)。注入の位置は書かない(添字だけ)
    const hits = match(findings);
    const perFinder = Object.fromEntries(
      finders.map((who) => {
        const own = findings.filter((x) => byOf(x) && samePerson(config, byOf(x), who));
        const h = match(own);
        return [who, { findings: own.length, detected: h.length, rate: m.injections.length ? h.length / m.injections.length : null, hits: h.map((x) => x.index).sort((a, b) => a - b) }];
      })
    );
    const byType = {};
    for (const inj of m.injections) {
      byType[inj.type] ??= { injected: 0, detected: 0 };
      byType[inj.type].injected++;
    }
    for (const h of hits) byType[h.type].detected++;
    layers[layer] = {
      finder: finders.length === 1 ? finders[0] : finders.join(' / '),
      finders,
      perFinder,
      seeded: m.injections.length,
      detected: hits.length,
      rate: m.injections.length ? hits.length / m.injections.length : null,
      falsePositives: findings.length - hits.length,
      types: byType,
      missedTypes: Object.entries(byType).filter(([, v]) => v.detected < v.injected).map(([k]) => k),
      blindProblems: why,
      // 目隠しを確かめられたか。偽の層の検出数は参考値であり、測定値ではない
      blind: !why.length,
      measuredAt: localDay(),
    };
  }
  if (!Object.keys(layers).length) {
    fail(`見つける者の記録がありません(${TRIAL_DIR}/findings-human.json、findings-ai.json、または --human / --ai)`);
    return 1;
  }
  // 封じた時点を確かめられない場合は、すべての層の目隠しを確かめられない
  for (const v of Object.values(layers)) if (blindAll.length) v.blind = false;
  const result = { injector: m.injector, digest: sealRec.digest, sealedAt: sealRec.sealedAt, tolerance: tol, injected: m.injections.length, typeBreakdown: Object.fromEntries(Object.entries(layers.human?.types ?? layers.ai.types).map(([k, v]) => [k, v.injected])), layers, blindProblems: blindAll };
  writeText(RESULT_FILE, JSON.stringify(result, null, 2) + '\n');
  // 出荷の集約が読む測定の記録へ(人の層・AI の層を分ける)。記録の置き場(docs/adoption-trial/)に書き、コミットする。
  // evidence/ は .gitignore のため、そこに書くと clone した CI の集約に届かない。目隠しを確かめられない層は、測定値(検出数)を書かず、
  // blind:false と理由だけを書く。出荷の集約はその層を未測定として扱う(標準 附属書I I.11 の要件③)
  const seeded = {};
  const METHOD = '導入前の検証の目隠しの欠陥注入(adoption-trial)';
  // AI の層には、測定した担い手の識別(席・モデル・指示資産の版)を書く。出荷の集約は、現在の構成の識別と一致しないとき
  // 「失効(識別が変わった)」とする。同じ日の世代交代でも失効する(#288 第5巡)
  const performers = (config.seats ?? []).filter((s) => s.performer).map((s) => ({ seat: s.name ?? s.role, role: s.role, model: s.performer.model ?? null, instructions: s.performer.instructions ?? null }));
  for (const [k, v] of Object.entries(layers)) {
    // blind: true と method は出所の印。出荷の集約は、この2つを持たない記録を「出所を検証できない」として測定値に数えない
    seeded[k] = v.blind
      ? { blind: true, seeded: v.seeded, detected: v.detected, measuredAt: v.measuredAt, measuredAtIso: localIso(), method: METHOD, finders: v.finders, perFinder: v.perFinder, types: v.types, ...(k === 'ai' ? { performers } : {}) }
      : { blind: false, blindProblems: [...v.blindProblems, ...blindAll], seeded: v.seeded, measuredAt: v.measuredAt, measuredAtIso: localIso(), method: METHOD, finders: v.finders, ...(k === 'ai' ? { performers } : {}), note: `目隠しを確かめられないため、測定値(検出数)を書かない。出荷の集約は未測定として扱う。参考値は ${RESULT_FILE} にある` };
  }
  writeText(SEEDED_FILE, JSON.stringify(seeded, null, 2) + '\n');
  const layerName = (k) => (k === 'human' ? '人の層' : 'AI の層');
  const perText = (v) => (v.finders.length > 1 ? `。各人: ${Object.entries(v.perFinder).map(([who, p]) => `${who} ${p.detected} 件`).join(' / ')}(和集合 ${v.detected} 件)` : '');
  notice(`${RESULT_FILE} と ${SEEDED_FILE} を書きました(注入 ${m.injections.length} 件。${Object.entries(layers).map(([k, v]) => `${layerName(k)} ${v.blind ? `${v.detected} 件${perText(v)}` : '未測定(目隠しを確かめられない。検出数は測定値として書かない)'}`).join(' / ')})。${SEEDED_FILE} をコミットすると、出荷の集約(項目6)が読む`);
  if (performers.length && layers.ai) notice(`AI の層の測定した担い手の識別: ${performers.map((p) => `${p.seat} ${p.model ?? '(モデル未記入)'} / ${p.instructions ?? '(指示資産の版 未記入)'}`).join(' / ')}。識別が変わると、出荷の集約はこの値を失効として扱う`);
  for (const [k, v] of Object.entries(layers)) for (const p of v.blindProblems) warn(`${layerName(k)}: ${p}。検出率に数えない。${SEEDED_FILE} には blind:false と理由だけを書いた`);
  for (const p of blindAll) warn(`${p}。すべての層を測定値として書かない`);
  return 0;
}

// ---------------------------------------------------------------- 合否の基準(要件①)

export function readCriteria({ root = ROOT } = {}) {
  const p = path.join(root, CRITERIA_FILE);
  const out = { present: fs.existsSync(p), problems: [], items: {}, writer: null, writtenAt: null, commitAt: null, digest: null };
  if (!out.present) {
    out.problems.push(`${CRITERIA_FILE} がありません(node scripts/gate/adoption-trial.mjs init で様式を写し、採用者が書いてコミットする)`);
    return out;
  }
  const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  out.digest = sha256(text);
  out.candidate = rowValue(text, '適用候補');
  out.writer = rowValue(text, '記入者');
  out.writtenAt = rowValue(text, '記入日時');
  // [識別子, 行を探す語(行頭), 記録に書く項目名(附属書I の様式)]
  const keys = [
    ['human', '欠陥注入: 人の層の検出率の下限', '欠陥注入: 人の層の検出率の下限'],
    ['ai', '欠陥注入: AI の層の扱い', '欠陥注入: AI の層の扱い(下限、または「検出の層に数えない」)'],
    ['scenes', '場面集: 止まるべき11場面のうち止まる数', '場面集: 止まるべき11場面のうち止まる数'],
    ['drillE', '類型E: 人へ戻したときに処理できる量の下限', '類型E: 人へ戻したときに処理できる量の下限'],
    ['drillF', '類型F: 別の提供者での差分の許容の範囲', '類型F: 別の提供者での差分の許容の範囲'],
    ['claim', '成立判定', '成立判定: 層1・D-0 の全行記入で成立条件1 が成立する'],
    // 実環境の統制の確認(要件⑦。#288 第6巡)。第6巡より前の様式に行が無い場合は、未記入として実行を止めず、
    // 記録の節6 に「基準の行なし」と出す(人が照合する)。行のある様式では未記入を受け付けない
    ['env', '実環境の統制の確認', '実環境の統制の確認(ルールセットの適用・PR のレビューの取得・ship-evidence の成果物の取得)', { optional: true }],
  ];
  for (const [id, key, label, opt] of keys) out.items[id] = { label, value: rowValue(text, key), rowPresent: rowValue(text, key) !== null, optional: opt?.optional === true };
  const g = gitAt(root);
  const config = loadConfig();
  if (!isFilledValue(out.writer)) out.problems.push('記入者が未記入');
  else if (aiNameBlocked(config, out.writer)) out.problems.push(`記入者 "${out.writer}" が AI の名義(採用者の人が書く)`);
  const wm = nfkc(out.writtenAt).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!wm || !isRealDay(wm[1])) out.problems.push('記入日時が日付(YYYY-MM-DD HH:MM)でない');
  for (const [id, it] of Object.entries(out.items)) {
    if (it.optional && !it.rowPresent) continue;
    if (!isFilledValue(it.value)) out.problems.push(`基準「${it.label}」が未記入`);
  }
  if (!g(['rev-parse', '--git-dir'])) out.problems.push('git のリポジトリでない');
  else {
    out.commitAt = g(['log', '-1', '--format=%cI', '--', CRITERIA_FILE]) || null;
    if (!out.commitAt) out.problems.push(`${CRITERIA_FILE} がコミットされていない。基準を実行の前に記録した証拠にするため、先にコミットする`);
    else if (g(['status', '--porcelain', '--', CRITERIA_FILE])) out.problems.push(`${CRITERIA_FILE} にコミットの後の変更がある。基準を書き換えたなら、コミットし直してから実行する`);
    if (out.commitAt && wm) {
      const written = `${wm[1]}T${wm[2] ?? '00'}:${wm[3] ?? '00'}`;
      if (written > out.commitAt.slice(0, 16)) out.problems.push(`記入日時 ${out.writtenAt} が、コミットの時刻 ${out.commitAt} より後`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 場面集(要件⑤)

const MOCK_GH = `// 導入前の検証の模擬の gh(adoption-trial が一時の複製へ置く)。GitHub へ問い合わせない
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const orig = cp.execFileSync;
const DIR = process.env.PIT_TRIAL_PRS ?? '';
cp.execFileSync = (cmd, args, opts) => {
  if (cmd !== 'gh') return orig(cmd, args, opts);
  if (args[0] === 'pr' && args[1] === 'view') {
    const f = path.join(DIR, args[2] + '.json');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    const e = new Error('no pull requests found');
    e.stderr = 'no pull requests found';
    throw e;
  }
  const ev = args[0] === 'api' ? String(args[1] ?? '').match(/issues\\/(\\d+)\\/events/) : null;
  if (ev) {
    const f = path.join(DIR, ev[1] + '.events.json');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '[]';
  }
  return '[]';
};
syncBuiltinESMExports();
`;

export const SCENES = [
  [1, '判定記録の欠落した出荷', 'G-7 の基準9'],
  [2, '作成を指示した者だけが承認した変更', 'G-7 の基準5'],
  [3, 'AI の名義の記名・解除', 'G-8、7.11 の解除、D-0 の改訂'],
  [4, '未解除の停止の申し立てがある PR と出荷', 'G-5、出荷の証跡の集約'],
  [5, '統制を緩める向きの変更で、決定した者の記名が無いもの', '構成の変更記録'],
  [6, '区分の下限より低いリスク区分の記載', 'G-5'],
  [7, '確定者の記名が無い R1・R2 の変更', 'G-5'],
  [8, '層1 の必須行の空欄', '成立判定の成立条件1'],
  [9, 'D-0 表4 の有事の決定者の空欄', 'G-7 の基準9'],
  [10, '層1 の受容しない条件に当たる事実のある出荷', 'G-7 の基準9 の (b)'],
  [11, '期限を過ぎた組織継続の側の受容', 'G-7 の基準9'],
];

/** glob から、当たる具体的なパスを1つ作る */
const pathFromGlob = (g) => {
  const p = String(g).replace(/\*\*\/?/g, 'pit-trial/').replace(/\*/g, 'trial').replace(/\/+/g, '/');
  return /\/$/.test(p) || !/\.[a-z0-9]+$/i.test(p.split('/').pop()) ? `${p.replace(/\/$/, '')}/trial.js` : p;
};

function runScenes(config, { keep = false } = {}) {
  const head = git(['rev-parse', 'HEAD']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-adoption-trial-'));
  const out = { clone: dir, head, scenes: [] };
  const cg = gitAt(dir);
  execFileSync('git', ['clone', '-q', '--no-hardlinks', ROOT, dir], { stdio: 'ignore' });
  cg(['config', 'user.email', 'adoption-trial@example.invalid']);
  cg(['config', 'user.name', 'adoption-trial']);
  cg(['config', 'core.autocrlf', 'false']);
  cg(['switch', '-q', '-C', 'pit-trial-base', head]);
  const prs = path.join(dir, '.git', 'pit-trial');
  fs.mkdirSync(prs, { recursive: true });
  const mock = path.join(prs, 'mockgh.mjs');
  fs.writeFileSync(mock, MOCK_GH);
  const env = { ...process.env, PIT_TRIAL_PRS: prs, GITHUB_REPOSITORY: 'adoption-trial/clone', GITHUB_BASE_REF: '', GITHUB_STEP_SUMMARY: '' };
  const node = (args) => {
    const r = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const reset = () => {
    cg(['switch', '-q', '-f', 'pit-trial-base']);
    cg(['reset', '-q', '--hard', head]);
    cg(['clean', '-qfdx', '-e', '.git']);
    for (const f of fs.readdirSync(prs)) if (f !== 'mockgh.mjs') fs.rmSync(path.join(prs, f), { force: true });
    for (const b of (cg(['branch', '--format=%(refname:short)']) ?? '').split('\n').filter((x) => x.startsWith('pit-trial-s'))) cg(['branch', '-q', '-D', b]);
  };
  const write = (p, t) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), t);
  };
  const read = (p) => (fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8').replace(/\r\n/g, '\n') : null);
  const commit = (msg) => {
    cg(['add', '-A']);
    cg(['commit', '-q', '--no-verify', '-m', msg]);
    return cg(['rev-parse', 'HEAD']);
  };
  const people = (config.people ?? []).filter((p) => p?.appointer !== true);
  const insiders = people.filter((p) => p.external !== true);
  const A = insiders[0] ?? people[0] ?? null;
  const B = people.find((p) => A && p.id !== A.id) ?? null;
  const acct = (p) => (Array.isArray(p?.accounts) && p.accounts[0] ? String(p.accounts[0]).replace(/^@/, '') : null);
  const body = ({ risk = 'R2', confirmer = null, instructor = A?.name ?? '' } = {}) =>
    `## 検証方法と結果\n\n導入前の検証の場面\n\n## 作成を指示した者\n\n${instructor}\n\n## リスク区分\n\n${risk}\n${confirmer ? `\n確定した者: ${confirmer}\n` : ''}\n## トレーラ\n\nSpec: setup\n`;
  let prNo = 9000;
  const prCommit = (files, opts = {}) => {
    prNo += 1;
    for (const [p, t] of Object.entries(files)) write(p, t);
    const hash = commit(`feat: 導入前の検証の場面 (#${prNo})`);
    const reviews = opts.reviews ?? [];
    fs.writeFileSync(
      path.join(prs, `${prNo}.json`),
      JSON.stringify({ number: prNo, title: 'feat: 導入前の検証の場面', author: { login: acct(A) ?? 'unknown' }, reviews, statusCheckRollup: [{ __typename: 'CheckRun', name: 'gate-g5', status: 'COMPLETED', conclusion: 'SUCCESS' }], body: opts.body ?? body(opts), mergeCommit: { oid: hash }, commits: [{ oid: hash, messageHeadline: 'feat: 導入前の検証の場面' }], labels: (opts.labels ?? []).map((name) => ({ name })) })
    );
    return prNo;
  };
  const agg = () => {
    const r = node(['--import', `file:///${mock.replace(/\\/g, '/')}`, 'scripts/gate/aggregate-evidence.mjs', '--from', head, '--to', 'HEAD']);
    let ev = null;
    try {
      ev = JSON.parse(read('evidence/evidence.json'));
    } catch {
      ev = null;
    }
    return { ...r, ev, gaps: ev?.gaps ?? [] };
  };
  const checkPr = (pr, base = 'pit-trial-base') => {
    fs.writeFileSync(path.join(prs, 'pr.json'), JSON.stringify(pr));
    const r = node(['scripts/gate/check-pr.mjs', '--base', base, '--pr', path.join(prs, 'pr.json'), '--json']);
    let j = null;
    try {
      j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    } catch {
      j = null;
    }
    return { ...r, errors: j?.errors ?? [], notices: j?.notices ?? [] };
  };
  const onBranch = (name, files, msg) => {
    cg(['switch', '-q', '-c', name, 'pit-trial-base']);
    for (const [p, t] of Object.entries(files)) write(p, t);
    commit(msg);
  };
  const gateRecord = (gate, target, judge, extra = '') =>
    `# ゲート判定記録\n\n| 項目 | 値 |\n| --- | --- |\n| ゲート | ${gate} |\n| 対象 | ${target} |\n| 判定者 | ${judge} |\n| 判定日時 | ${localDay()} 10:00 |\n| 結果 | 通過 |\n| 確定の形態 | 人確定 |\n| 参照した D-0 の版 | ${config.d0Version ?? '1.0'} |\n\n${extra}`;
  const policyText = readText(POLICY_FILE);
  const scene = (id, fn) => {
    reset();
    let r;
    try {
      r = fn();
    } catch (e) {
      r = { result: '確かめていない', detail: `場面の実行に失敗した(${String(e.message).split('\n')[0]})` };
    }
    const [, label, where] = SCENES.find((s) => s[0] === id);
    out.scenes.push({ id, label, where, ...r });
  };
  const has = (list, ...words) => list.some((x) => words.every((w) => String(x).includes(w)));
  const stopped = (ok, detail, evidence = null) => ({ result: ok ? '止まった' : '止まらなかった', detail, evidence });

  // 基準の状態(場面を入れない)の集約。場面の欠落が基準の状態に既にあるかを比べる
  reset();
  const base = agg();
  out.baseline = { code: base.code, gaps: base.gaps.length, gapList: base.gaps };

  scene(1, () => {
    if (!['required', 'simplified'].includes(config.gates?.g8?.state)) return { result: '確かめていない', detail: 'G-8 が有効でない構成' };
    write('docs/gates/pit-trial-g8.md', gateRecord('G-8 リリース決裁', 'HEAD', B?.name ?? A?.name ?? '未記入', '## 決断の記録\n\n| 欄 | 記載 |\n| --- | --- |\n| 確認した事項 | 保証の開示 |\n| 確認していない事項 | 本番の負荷 |\n| 判断が変わる条件 | 重大な欠陥 |\n| 受容したリスク | なし |\n| 出荷判定者の異議(リリース決裁 G-8 の記録に限る) | 異議なし |\n| 照らした層1 の版(G-8 に限る) | |\n| 上申(G-8 に限る。段階を超える受容・異議を退けた受容) | |\n'));
    commit('docs: 導入前の検証の場面(G-8 の記録の欠落)');
    const r = agg();
    const ok = r.code !== 0 && has(r.gaps, 'pit-trial-g8.md', '照らした層1 の版');
    return stopped(ok, ok ? '欄の欠落した G-8 の判定記録を、出荷の集約が記載の欠落にした' : '欄の欠落した G-8 の判定記録が欠落にならなかった', r.gaps.filter((g) => g.includes('pit-trial-g8')).slice(0, 2));
  });

  scene(2, () => {
    if (!A || !acct(A)) return { result: '確かめていない', detail: '人の名簿にアカウントを持つ人がいない' };
    const n = prCommit({ 'pit-trial/scene2.js': 'export const scene = 2;\n' }, { risk: 'R1', reviews: [{ author: { login: acct(A) }, state: 'APPROVED', body: '挙動要約: 自分で確かめた' }] });
    const r = agg();
    const ok = r.code !== 0 && has(r.gaps, `PR #${n}`, '独立した人の確認を経ていません');
    return stopped(ok, ok ? '作成を指示した者だけが承認した R1 の変更を、出荷の集約が欠落にした' : '自己承認の変更が欠落にならなかった', r.gaps.filter((g) => g.includes(`#${n}`)).slice(0, 2));
  });

  scene(3, () => {
    const parts = [];
    // (a) 停止の申し立ての AI の名義の解除(G-5)
    write('docs/gates/pit-trial-stop.md', gateRecord('停止の申し立ての解除', 'PR #9103', 'Claude', '## 停止の申し立ての解除\n\n| 欄 | 記載 |\n| --- | --- |\n| 申し立てた者 | ' + (A?.name ?? '申し立て 太郎') + ' |\n| 申し立ての内容 | 場面 |\n| 解除の理由 | 場面 |\n| 申し立てた者の見解を退けたか | 退けていない |\n| 上申先と日付(退けた場合) | 該当なし |\n'));
    commit('docs: 導入前の検証の場面(AI の名義の解除)');
    cg(['branch', '-f', 'pit-trial-base-s3', 'HEAD']);
    cg(['switch', '-q', '-c', 'pit-trial-s3', 'pit-trial-base-s3']);
    write('docs/pit-trial-note.md', '場面3\n');
    commit('docs: 場面3');
    const a = checkPr({ number: 9103, title: 'docs', body: body({ risk: 'R3' }), author: acct(A) ?? '', labels: ['state:stop-requested'] }, 'pit-trial-base-s3');
    parts.push({ part: '停止の申し立ての AI の名義の解除', ok: a.code !== 0 && has(a.errors, '停止の申し立て') && has(a.errors, 'AI') });
    // (b) D-0 の改訂(緩める向きの変化点)の AI の名義の記名
    cg(['switch', '-q', '-f', 'pit-trial-base']);
    cg(['reset', '-q', '--hard', head]);
    const lines = Number(config.task?.maxChangedLines ?? 400);
    fs.writeFileSync(path.join(prs, 'change.json'), JSON.stringify({ kind: 'settings', summary: '導入前の検証の場面', settings: { task: { maxChangedLines: lines * 2 } }, decidedBy: 'Claude', reason: '場面' }));
    const b = node(['scripts/init/generate-profile.mjs', '--change', path.join(prs, 'change.json')]);
    parts.push({ part: '構成の変化点の AI の名義の記名', ok: b.code !== 0 || /AI|受け付けられません|エラー/.test(b.out.split('\n').filter((l) => /エラー|拒否|受け付け/.test(l)).join(' ')) });
    // (c) 層1 の AI の名義の記名
    if (policyText) {
      const t = policyText.replace(/^(\|\s*記名(\([^)]*\))?\s*\|)\s*[^|]*\|/m, '$1 Claude |');
      const p = readPolicy(config, { text: t });
      parts.push({ part: '層1 の AI の名義の記名', ok: !p.valid && p.problems.some((x) => /AI/.test(x)) });
    } else parts.push({ part: '層1 の AI の名義の記名', ok: null });
    const ran = parts.filter((x) => x.ok !== null);
    const ok = ran.length === parts.length && ran.every((x) => x.ok);
    return {
      result: ran.length < parts.length ? (ran.every((x) => x.ok) ? '確かめていない' : '止まらなかった') : ok ? '止まった' : '止まらなかった',
      detail: parts.map((x) => `${x.part}: ${x.ok === null ? '確かめていない(層1 が無い)' : x.ok ? '止まった' : '止まらなかった'}`).join(' / '),
    };
  });

  scene(4, () => {
    onBranch('pit-trial-s4', { 'docs/pit-trial-note.md': '場面4\n' }, 'docs: 場面4');
    const a = checkPr({ number: 9104, title: 'docs', body: body({ risk: 'R3' }), author: acct(A) ?? '', labels: ['state:stop-requested'] });
    cg(['switch', '-q', '-f', 'pit-trial-base']);
    const n = prCommit({ 'pit-trial/scene4.js': 'export const scene = 4;\n' }, { risk: 'R3', labels: ['state:stop-requested'], reviews: B && acct(B) ? [{ author: { login: acct(B) }, state: 'APPROVED', body: '挙動要約: 確かめた' }] : [] });
    const r = agg();
    const prOk = a.code !== 0 && has(a.errors, '停止の申し立て');
    const shipOk = r.code !== 0 && has(r.gaps, '停止の申し立ての保留', `PR #${n}`);
    return stopped(prOk && shipOk, `PR(G-5): ${prOk ? '止まった' : '止まらなかった'} / 出荷の集約: ${shipOk ? '止まった' : '止まらなかった'}`);
  });

  scene(5, () => {
    const lines = Number(config.task?.maxChangedLines ?? 400);
    fs.writeFileSync(path.join(prs, 'change.json'), JSON.stringify({ kind: 'settings', summary: '導入前の検証の場面', settings: { task: { maxChangedLines: lines * 2 } } }));
    const before = read('process.config.json');
    const r = node(['scripts/init/generate-profile.mjs', '--change', path.join(prs, 'change.json')]);
    const unchanged = read('process.config.json') === before;
    const ok = unchanged && /緩める向き/.test(r.out) && /記名/.test(r.out);
    return stopped(ok, ok ? '記名の無い緩める向きの変化点(変更規模の上限の引き上げ)を、構成の変更が拒否した' : '記名の無い緩める向きの変化点が構成へ反映された');
  });

  scene(6, () => {
    const rules = config.riskFloor?.rules ?? [];
    if (!rules.length) return { result: '止まらなかった', detail: '区分の下限の規則(構成の riskFloor)が無い。規則に当たる変更が無いため、低い区分の記載は通る' };
    const rule = rules.find((r) => r.floor === 'R1') ?? rules[0];
    const target = pathFromGlob(rule.paths[0]);
    onBranch('pit-trial-s6', { [target]: '// 導入前の検証の場面6\n' }, 'feat: 場面6');
    const a = checkPr({ number: 9106, title: 'feat', body: body({ risk: 'R3' }), author: acct(A) ?? '' });
    const ok = a.code !== 0 && has(a.errors, '区分の下限');
    return stopped(ok, `${target}(規則 ${rule.id}、下限 ${rule.floor})を R3 と記載: ${ok ? '止まった' : '止まらなかった'}`);
  });

  scene(7, () => {
    onBranch('pit-trial-s7', { 'docs/pit-trial-note.md': '場面7\n' }, 'docs: 場面7');
    const a = checkPr({ number: 9107, title: 'docs', body: body({ risk: 'R2' }), author: acct(A) ?? '' });
    const ok = a.code !== 0 && has(a.errors, 'リスク区分の確定者');
    if (!ok && has(a.notices, 'リスク区分の確定者')) return { result: '止まらなかった', detail: '作成を指示した者以外の人が名簿にいないため、確定していない区分として表示するだけ(1名体制の扱い)' };
    return stopped(ok, ok ? '確定者の無い R2 を G-5 が失敗させた' : '確定者の無い R2 が通った');
  });

  scene(8, () => {
    if (!policyText) return { result: '確かめていない', detail: '層1 が無い' };
    const t = policyText.replace(/^(\|\s*(?:\(必須\)|(必須))?\s*停止の申し立ての解除[^|]*\|[^|]*\|)\s*[^|]*\|/m, '$1 |');
    const p = readPolicy(config, { text: t });
    const ok = !p.valid && p.requiredBlank.some((x) => x.includes('停止の申し立ての解除'));
    return stopped(ok, ok ? '必須行(停止の申し立ての解除)の受容者が空欄の層1 を、有効にしなかった(成立条件1 を満たさない)' : '必須行が空欄の層1 が有効のまま');
  });

  scene(9, () => {
    const d0 = read(D0_FILE);
    if (!d0) return { result: '確かめていない', detail: 'D-0 が無い' };
    const t = d0.replace(/^(\|\s*重大事故\s*\|)\s*[^|]*\|/m, '$1 |');
    if (t === d0) return { result: '確かめていない', detail: 'D-0 の有事の事象の表に「重大事故」の行が無い' };
    write(D0_FILE, t);
    commit('docs: 導入前の検証の場面(有事の決定者の空欄)');
    const r = agg();
    const ok = r.code !== 0 && has(r.gaps, '有事の決定者', '重大事故');
    return stopped(ok, ok ? '有事の決定者の空欄を、出荷の集約が記載の欠落にした' : '有事の決定者の空欄が欠落にならなかった');
  });

  scene(10, () => {
    const p = readPolicy(config);
    const before = base.ev?.assurance?.claim?.nonAcceptable?.facts?.length ?? 0;
    const cond = p.conditions.find((c) => c.kind === 'ledger') ?? p.conditions.find((c) => c.kind === '未回収の例外') ?? p.conditions.find((c) => c.kind === 'R1未確認');
    if (!cond) return { result: '止まらなかった', detail: '層1 の受容しない条件に、機械で照合できる印([台帳:<語>] / [未回収の例外] / [R1未確認])の付いた条件が無い。出荷判定者の突合に依る' };
    if (cond.kind === 'R1未確認') prCommit({ 'pit-trial/scene10.js': 'export const scene = 10;\n' }, { risk: 'R1' });
    else {
      const ledger = read('docs/debt-ledger.md');
      if (!ledger) return { result: '確かめていない', detail: '技術負債台帳が無い' };
      const kind = cond.kind === 'ledger' ? '未解決' : '例外';
      write('docs/debt-ledger.md', `${ledger.replace(/\n*$/, '\n')}| D-9999 | ${kind} | PR #9999 | ${cond.kind === 'ledger' ? cond.word : '場面'}に当たる未達(導入前の検証の場面) | 場面 | 場面 | ${localDay()} | 未返却 | ${A?.name ?? '記録 太郎'} | ${B?.name ?? '承認 次郎'} |\n`);
      commit('docs: 導入前の検証の場面(受容しない条件)');
    }
    const r = agg();
    const facts = r.ev?.assurance?.claim?.nonAcceptable?.facts ?? [];
    const ok = facts.length > before && r.ev?.assurance?.claim?.conditions?.find((c) => c.id === 6)?.ok === false;
    return stopped(ok, ok ? `受容しない条件「${cond.text}」に当たる事実を、成立判定が条件6 の不成立として出した(G-7 の基準9 の (b) で差し戻す材料)` : '受容しない条件に当たる事実が成立判定に出なかった', facts.map((f) => f.fact).slice(0, 2));
  });

  scene(11, () => {
    const spof = base.ev?.assurance?.continuity?.spof ?? [];
    let item = spof.find((x) => x.state !== '通知の期間またはデータが空欄の依存先') ?? spof[0];
    let d0 = read(D0_FILE);
    if (!d0) return { result: '確かめていない', detail: 'D-0 が無い' };
    if (!item) {
      // 基準の状態に受容の対象が無い場合は、場面の中で作る。D-0 節9 の判断の席の代理者を「なし」にすると、
      // その席が「後継不在の席」として単一障害点の一覧に出る(第3章 3.4.3 の要求事項5)
      const secStart = d0.search(/^##\s*9\./m);
      const rest = secStart >= 0 ? d0.slice(secStart + 1) : '';
      const secLen = secStart >= 0 ? (rest.search(/^##\s/m) >= 0 ? rest.search(/^##\s/m) + 1 : d0.length - secStart) : 0;
      const section = secStart >= 0 ? d0.slice(secStart, secStart + secLen) : '';
      const m = section.match(/^\|\s*(価値責任者|技術判断者|独立レビュア|出荷判定者)\s*\|[^\n]*$/m);
      if (!m) return { result: '確かめていない', detail: '基準の状態の単一障害点の一覧が空で、D-0 節9 に判断の席の行も無い(受容の対象を作れない)' };
      d0 = d0.slice(0, secStart) + section.replace(m[0], `| ${m[1]} | | | なし | |`) + d0.slice(secStart + secLen);
      item = { state: '後継不在の席', subject: m[1], made: true };
    }
    const p = readPolicy(config);
    const row = (p.authority ?? []).find((a) => a.target.includes(item.state.slice(0, 4)) || (item.state === '止める席' && /縮退/.test(a.target)) || (/コア理解|後継/.test(item.state) && /後継|理解/.test(a.target)));
    const seatName = row?.role ?? '事業決裁者';
    const seatId = Object.entries({ 事業決裁者: 'biz-approver', 出荷判定者: 'qa-gatekeeper', 価値責任者: 'value-owner', 技術判断者: 'tech-lead', AI運用担当者: 'ai-ops', AI維持管理者: 'ai-maintainer' }).find(([k]) => seatName.includes(k))?.[1] ?? 'biz-approver';
    const who = (config.seats ?? []).find((s) => s.role === seatId)?.accountable ?? A?.name ?? '受容 太郎';
    const t = d0.replace(/(\| 状態 \| 対象 \| 受容した者 \| 受容の期限 \| 照らした層1 の版 \|\n\| --- \| --- \| --- \| --- \| --- \|\n)/, `$1| ${item.state} | ${item.subject} | ${who} | 2000-01-01 | ${p.version ?? 'v1.0'} |\n`);
    if (t === d0) return { result: '確かめていない', detail: 'D-0 節15 の受容の表が無い' };
    write(D0_FILE, t);
    commit('docs: 導入前の検証の場面(期限切れの受容)');
    const r = agg();
    const ok = r.code !== 0 && has(r.gaps, '受容の期限', item.subject);
    const made = item.made ? '(基準の状態に受容の対象が無いため、D-0 節9 の代理者を「なし」にして後継不在の席を作った)' : '';
    return stopped(ok, ok ? `期限を過ぎた受容(${item.state}: ${item.subject})を、出荷の集約が記載の欠落にした${made}` : `期限切れの受容が欠落にならなかった(${item.state}: ${item.subject}。受容した者 ${who} が層1 の権限者でない可能性)${made}`);
  });

  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

// ---------------------------------------------------------------- 演習の記録(手順3)

function readDrills({ today = localDay() } = {}) {
  const out = { E: [], F: [], problems: [] };
  const t = readText(DRILL_FILE);
  if (t) {
    try {
      const j = JSON.parse(t);
      for (const d of Array.isArray(j.drills) ? j.drills : []) {
        const why = [];
        if (!['E', 'F'].includes(d?.type)) why.push('type が E / F でない');
        if (!isRealDay(d?.at)) why.push('at(実施日)が日付でない');
        else if (d.at > today) why.push(`at(実施日)${d.at} が今日(${today})より後。行っていない演習は数えない`);
        if (!isFilledValue(d?.result)) why.push('result(処理できた量 / 差分)が未記入');
        if (!isFilledValue(d?.judgement)) why.push('judgement(判断を担う席の AI を使わない判断の記録の所在)が未記入');
        if (d?.type === 'F' && (!isFilledValue(d?.provider) || !isFilledValue(d?.alternative) || nfkc(d.provider) === nfkc(d.alternative))) why.push('provider と alternative(別の提供者)が無いか同じ');
        const rec = { type: d?.type, at: d?.at ?? null, result: d?.result ?? null, judgement: d?.judgement ?? null, record: d?.record ?? null, seat: isFilledValue(d?.seat) ? String(d.seat) : null, provider: isFilledValue(d?.provider) ? nfkc(d.provider) : null, alternative: isFilledValue(d?.alternative) ? nfkc(d.alternative) : null, valid: !why.length, why };
        (d?.type === 'F' ? out.F : out.E).push(rec);
      }
    } catch (e) {
      out.problems.push(`${DRILL_FILE} を読めない(${e.message})`);
    }
  }
  // 類型F は、退出の予行の記録(docs/exit-rehearsal.json)も数える(別の提供者の記録だけ)。
  // 演習の記録と同じ演習(同じ実施日で、提供者と別の提供者が矛盾しない)は1行にまとめる(#288 第4巡)。
  // まとめた行の「判断の記録」は退出の予行の記録の値(judgement)を優先し、無ければ演習の記録の値。記録の所在は両方を出す
  const ex = readText(EXIT_FILE);
  if (ex) {
    try {
      const j = JSON.parse(ex);
      for (const r of Array.isArray(j) ? j : (j.rehearsals ?? [])) {
        const why = [];
        if (!isRealDay(r?.at)) why.push('実施日が無い');
        else if (r.at > today) why.push(`実施日 ${r.at} が今日(${today})より後`);
        if (!isFilledValue(r?.alternative?.provider) || nfkc(r.alternative.provider) === nfkc(r?.provider)) why.push('別の提供者の記録でない');
        const rec = { type: 'F', at: r?.at ?? null, result: r?.diff ?? r?.result ?? '差分の記載なし', judgement: isFilledValue(r?.judgement) ? String(r.judgement) : null, record: EXIT_FILE, seat: null, provider: isFilledValue(r?.provider) ? nfkc(r.provider) : null, alternative: isFilledValue(r?.alternative?.provider) ? nfkc(r.alternative.provider) : null, valid: !why.length, why };
        const same = out.F.find((d) => !d.merged && d.at && d.at === rec.at && (!d.provider || !rec.provider || d.provider === rec.provider) && (!d.alternative || !rec.alternative || d.alternative === rec.alternative));
        if (!same) {
          out.F.push(rec);
          continue;
        }
        same.merged = true;
        same.judgement = rec.judgement ?? same.judgement;
        same.result = same.result ?? rec.result;
        same.record = `${same.record ?? DRILL_FILE} / ${EXIT_FILE}`;
        same.valid = same.valid && rec.valid;
        same.why = [...same.why, ...rec.why.map((w) => `退出の予行の記録: ${w}`)];
      }
    } catch {
      out.problems.push(`${EXIT_FILE} を読めない`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- run

/** 要約値の節の見出し。本文の要約値はこの節を含む全文が対象で、要約値の行の値だけを伏せる */
const DIGEST_HEADING = '## 10. 要約値';
const HUMAN_START = /^<!-- human-fields start cols=([\d,]+) -->\s*$/;
const HUMAN_END = /^<!-- human-fields end -->\s*$/;
/** 節10 の要約値の行(対象 | 64桁の hex または「なし」) */
const DIGEST_ROW = /^(\|\s*[^|]*?\s*\|\s*)([0-9a-f]{64}|なし)(\s*\|)\s*$/;
/** 節10 の表の後ろの定型の行の数(人が書く欄の範囲、確かめ方、書き換えた記録の扱い)。この後ろに行があれば追記である */
const DIGEST_TAIL_LINES = 3;

/**
 * 本文の要約値の対象になる形に正規化する。記録の全文(節10 の後ろを含む)を対象にし、人が書く欄(印で囲んだ範囲の表の指定の列。
 * 1 始まり)と、節10 の要約値の行の値だけを空にする。見出しで打ち切ると、節10 の後ろへ追記した本文が検査の外になる(#288 第4巡)。
 * 改行は LF、各行の末尾の空白は除く
 */
export function canonicalRecord(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let cols = null;
  let inDigest = false;
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    if (l.startsWith(DIGEST_HEADING)) inDigest = true;
    if (inDigest) {
      const d = l.match(DIGEST_ROW);
      out.push(d ? `${d[1]}${d[3]}` : l);
      continue;
    }
    const m = l.match(HUMAN_START);
    if (m) {
      cols = m[1].split(',').map((x) => Number(x));
      out.push(l);
      continue;
    }
    if (HUMAN_END.test(l)) {
      cols = null;
      out.push(l);
      continue;
    }
    if (cols && l.startsWith('|')) {
      const cells = l.split('|');
      for (const c of cols) if (c < cells.length - 1) cells[c] = ' ';
      out.push(cells.join('|'));
      continue;
    }
    out.push(l);
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

/**
 * 節10 の定型の行(表の後ろの3行)の後ろにある行。記録の末尾は節10 であり、その後ろへ書いた本文(所見・判定など)は追記である。
 * 要約値が一致しなくなるだけでなく、追記そのものを理由として出す
 */
export function linesAfterDigest(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.startsWith(DIGEST_HEADING));
  if (i < 0) return [];
  let seenTable = false;
  let tail = 0;
  const extra = [];
  for (const raw of lines.slice(i + 1)) {
    const l = raw.replace(/\s+$/, '');
    if (!l) continue;
    if (l.startsWith('|')) {
      if (tail) extra.push(l);
      else seenTable = true;
      continue;
    }
    if (seenTable && l.startsWith('- ') && tail < DIGEST_TAIL_LINES) {
      tail++;
      continue;
    }
    extra.push(l);
  }
  return extra;
}

/** 記録の要約値の節(表)を読む。無ければ null */
export function readDigestSection(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  const i = t.indexOf(DIGEST_HEADING);
  if (i < 0) return null;
  const out = {};
  for (const l of t.slice(i).split('\n')) {
    const m = l.match(/^\|\s*(.*?)\s*\|\s*([0-9a-f]{64}|なし)\s*\|\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const DIGEST_ROWS = {
  body: '本文(人が書く欄を除く)',
  criteria: '合否の基準',
  config: '構成',
  injection: '注入の記録(封じた要約値)',
  scenes: '場面集の結果',
  drills: '演習の記録',
};
const scenesDigest = (scenes) => sha256(JSON.stringify((scenes ?? []).map((s) => ({ id: s.id, result: s.result, detail: s.detail }))));

/** verify <記録>: 記録の要約値を再計算し、一致を確かめる */
function verify() {
  const target = argv[1];
  if (!target || target.startsWith('--')) {
    fail('verify <記録の所在(docs/adoption-trial/record-*.md)> を渡します');
    return 2;
  }
  const p = path.resolve(ROOT, target);
  if (!fs.existsSync(p)) {
    fail(`${target} がありません`);
    return 2;
  }
  const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const rec = readDigestSection(text);
  if (!rec) {
    fail(`${target} に要約値の節(${DIGEST_HEADING})がありません。要約値の無い記録は、書き換えを記録そのものから見つけられない(git の履歴に依る)`);
    return 1;
  }
  const results = [];
  const cmp = (label, expected, actual, { hard = true, note = '' } = {}) => {
    const ok = expected !== undefined && expected === actual;
    results.push({ label, ok, hard, expected, actual, note });
  };
  cmp(DIGEST_ROWS.body, rec[DIGEST_ROWS.body], sha256(canonicalRecord(text)), { note: '人が書く欄(節0 の「記入」、節9 の「受容者」「期限」)と節10 の要約値の行の値を除いた全文(節10 の後ろを含む)' });
  // 節10 の定型の行の後ろにある行は追記である(要約値の対象でもあるが、理由を明示する)
  const appended = linesAfterDigest(text);
  if (appended.length) results.push({ label: '節10 の後ろの追記', ok: false, hard: true, expected: '(なし)', actual: `${appended.length} 行`, note: `記録の末尾は節10 であり、その後ろに本文を書けない: ${appended[0].slice(0, 60)}${appended.length > 1 ? ' …' : ''}` });
  // 合否の基準: 記録に書かれたコミットのファイルを git から読み直す(コミット済みの内容は変わらない)
  const critRow = Object.keys(rec).find((k) => k.startsWith(DIGEST_ROWS.criteria));
  const critHash = critRow?.match(/コミット ([0-9a-f]{7,40})/)?.[1] ?? null;
  let critText = null;
  try {
    // gitAt は出力を trim するため、ファイルの内容は生のまま読む(readCriteria と同じ正規化で要約値を取る)
    critText = critHash ? execFileSync('git', ['show', `${critHash}:${CRITERIA_FILE}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : null;
  } catch {
    critText = null;
  }
  cmp(critRow ?? DIGEST_ROWS.criteria, critRow ? rec[critRow] : undefined, critText !== null ? sha256(critText.replace(/\r\n/g, '\n')) : '(コミットを読めない)', { note: critHash ? `git show ${critHash.slice(0, 12)}:${CRITERIA_FILE}` : '記録に基準のコミットが無い' });
  // 場面集の結果: 実行の記録(runs/<stamp>.json)から再計算する
  const stamp = path.basename(p).match(/^record-(\d{8}-\d{6})\.md$/)?.[1] ?? null;
  const runPath = stamp ? rel(`${TRIAL_DIR}/runs/${stamp}.json`) : null;
  let runJson = null;
  try {
    runJson = runPath && fs.existsSync(runPath) ? JSON.parse(fs.readFileSync(runPath, 'utf8')) : null;
  } catch {
    runJson = null;
  }
  cmp(DIGEST_ROWS.scenes, rec[DIGEST_ROWS.scenes], runJson ? scenesDigest(runJson.scenes) : '(実行の記録を読めない)', { note: runPath ? path.relative(ROOT, runPath).replace(/\\/g, '/') : '記録の名前から実行の記録を特定できない' });
  // 現在のリポジトリの状態との比較(記録の後に変わりうる。不一致は書き換えではなく、記録が古い状態の測定であることを示す)
  const config = loadConfig();
  cmp(DIGEST_ROWS.config, rec[DIGEST_ROWS.config], configDigest(config), { hard: false, note: '現在の構成。違えば記録は以前の構成での測定' });
  const sealRec = readText(SEAL_FILE) ? JSON.parse(readText(SEAL_FILE)) : null;
  cmp(DIGEST_ROWS.injection, rec[DIGEST_ROWS.injection], sealRec?.digest ?? 'なし', { hard: false, note: `現在の ${SEAL_FILE}` });
  cmp(DIGEST_ROWS.drills, rec[DIGEST_ROWS.drills], sha256((readText(DRILL_FILE) ?? '').replace(/\n*$/, '\n')), { hard: false, note: `現在の ${DRILL_FILE}` });
  let bad = 0;
  for (const r of results) {
    const line = `${r.label}: ${r.ok ? '一致' : r.hard ? '不一致' : '現在の状態と違う'}${r.note ? `(${r.note})` : ''}${r.ok ? '' : ` 記録 ${String(r.expected ?? '記載なし').slice(0, 12)} / 再計算 ${String(r.actual).slice(0, 12)}`}`;
    if (r.ok) console.log(`  ${line}`);
    else if (r.hard) {
      bad++;
      fail(line);
    } else warn(line);
  }
  if (bad) {
    fail(`${target}: 要約値が一致しない項目が ${bad} 件あります。人が書く欄の外を書き換えた記録は、導入前の検証の記録として数えません(再実行して新しい記録を作る)`);
    return 1;
  }
  notice(`${target}: 本文・合否の基準・場面集の結果の要約値が一致しました(人が書く欄の外は書き換えられていない)`);
  return 0;
}

/** 記録の名前を予約する。記録か実行の記録が既にあれば偽。実行の記録は排他的に作る(同時に始まった実行の片方だけが通る) */
function reserveRun(recordFile, runFile, startedAt) {
  if (fs.existsSync(rel(recordFile))) return false;
  fs.mkdirSync(path.dirname(rel(runFile)), { recursive: true });
  let fd = null;
  try {
    fd = fs.openSync(rel(runFile), 'wx');
    fs.writeSync(fd, JSON.stringify({ startedAt, state: 'running' }, null, 2) + '\n');
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** 記録(record-*.md)を足したコミット(ハッシュ、コミットの時刻、記録の名前の時刻)。古い順 */
function recordCommits() {
  const raw = git(['log', '--reverse', '--format=%x01%H%x09%cI', '--name-only', '--diff-filter=A', '--', `${TRIAL_DIR}/record-*.md`]) ?? '';
  const out = [];
  for (const chunk of raw.split('\x01').filter((c) => c.trim())) {
    const [head, ...files] = chunk.split('\n');
    const [hash, commitAt] = head.split('\t');
    const stamps = files.map((f) => f.trim().match(/record-(\d{8}-\d{6})\.md$/)?.[1]).filter(Boolean);
    if (hash && commitAt && stamps.length) out.push({ hash, commitAt, stamps });
  }
  return out;
}

/** あるコミットの時点の合否の基準の要約値。無ければ null */
function criteriaDigestAt(hash) {
  try {
    const t = execFileSync('git', ['show', `${hash}:${CRITERIA_FILE}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return sha256(t.replace(/\r\n/g, '\n'));
  } catch {
    return null;
  }
}

/** 数の基準(%・件数)を読む。読めなければ null(人が照合する) */
const numberOf = (v) => {
  const m = nfkc(v).match(/(\d+(?:\.\d+)?)\s*(%|件)?/);
  return m ? { n: Number(m[1]), pct: m[2] === '%' } : null;
};

function run() {
  const config = loadConfig();
  if (config.configured === false) {
    fail('プロセス構成が未設定です。/process-init の後に実行します');
    return 1;
  }
  // 要件①: 基準の記入が無ければ実行しない
  const criteria = readCriteria();
  if (criteria.problems.length) {
    for (const p of criteria.problems) fail(`合否の基準: ${p}`);
    console.log('');
    console.log('導入前の検証は、合否の基準を実行の前に採用者が書き、コミットしてからでなければ実行しません(標準 附属書I I.11 の要件①)。');
    return 1;
  }
  const startedAt = localIso();
  // 記録の名前は秒までの時刻。同じ名前の記録が既にあれば、上書きせずに止まる(以前の記録を消さない)
  const stamp = startedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const recordFile = `${TRIAL_DIR}/record-${stamp}.md`;
  const runFile = `${TRIAL_DIR}/runs/${stamp}.json`;
  // 名前を実行の開始時に、排他的な作成で予約する(同じ秒に始まった別の実行が同じ名前で書くのを防ぐ)。実行の終わりに全文で置き換える
  if (!reserveRun(recordFile, runFile, startedAt)) {
    fail(`${recordFile} が既にあります。同じ時刻の記録を上書きしません。1秒おいて実行し直します`);
    return 1;
  }
  // 以前の実行より後に基準を改めた場合は、採用の証拠に数えない(予約だけの記録は数えない)
  const runsDir = rel(`${TRIAL_DIR}/runs`);
  const previous = fs.existsSync(runsDir)
    ? fs
        .readdirSync(runsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')))
        .filter((r) => r.criteriaDigest)
    : [];
  const reworked = previous.filter((r) => r.criteriaDigest !== criteria.digest && r.startedAt < criteria.commitAt).map((r) => ({ startedAt: r.startedAt, source: '実行の記録' }));
  // git の履歴からも判定する(runs/ を消しても消えない。#288 第4巡)。記録(record-*.md)を足したコミットが基準のコミットより前で、
  // その時点の基準の要約値が今と違えば、以前の実行の後に基準を改めている
  for (const r of recordCommits()) {
    if (!(r.commitAt < criteria.commitAt)) continue;
    const then = criteriaDigestAt(r.hash);
    if (then === null || then === criteria.digest) continue;
    for (const stamp of r.stamps) {
      const startedAt = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`;
      if (!reworked.some((x) => String(x.startedAt).slice(0, 19) === startedAt)) reworked.push({ startedAt, source: `git の履歴(コミット ${r.hash.slice(0, 12)})` });
    }
  }
  reworked.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  // 要件②: 採用者の環境か
  const tracked = (git(['ls-files']) ?? '').split('\n').filter(Boolean);
  const product = tracked.filter((f) => isProductCode(f) && !/^(templates|profiles|adapters|scripts)\//.test(f));
  const remote = git(['remote', 'get-url', 'origin']) ?? '';
  const notAdopter = [];
  if (!product.length) notAdopter.push('製品のコードが1つも無い(テンプレートそのもので実行した)');
  if (/pit-in-template/i.test(remote)) notAdopter.push(`リモートがテンプレートのリポジトリ(${remote})`);
  const policy = readPolicy(config);
  const ct = continuityState(config, policy, { day: localDay() });

  console.log('導入前の検証: 場面集を一時の複製で実行しています…');
  const sc = runScenes(config, { keep: argv.includes('--keep') });
  const injection = readText(RESULT_FILE) ? JSON.parse(readText(RESULT_FILE)) : null;
  const drills = readDrills({ today: localDay() });
  const finishedAt = localIso();
  // 類型E の結果を D-0 表7(縮退の3列)へ転記する案内。表7 は手で書く表(構成へ入れない)。実測が無い席と、転記できる演習の結果を対にする
  const eValid = drills.E.filter((d) => d.valid);
  const seatMatch = (d, g) => !d.seat || nfkc(g.seat) === nfkc(d.seat) || nfkc(g.seat).startsWith(nfkc(d.seat).split(/[((]/)[0]) || nfkc(g.role ?? '') === nfkc(d.seat);
  const transcribe = (ct.degradation ?? []).map((g) => ({ seat: g.seat, fallback: g.fallback, quantity: g.quantity, measured: g.measured, from: eValid.filter((d) => seatMatch(d, g)) }));
  const degradationCycle = ct.cycle?.degradation ?? null;

  // 成立判定(手順4)
  const claim = {
    policyValid: policy.valid,
    policyProblems: policy.problems,
    requiredBlank: policy.requiredBlank ?? [],
    emergencyMissing: ct.emergencyMissing,
  };
  // 基準との照合(要件⑥の範囲で、機械が比べられるものだけ比べる)
  const stoppedCount = sc.scenes.filter((s) => s.result === '止まった').length;
  const judge = [];
  // 目隠しを確かめられない層(blind:false、または理由のある層)は、測定値として比べない
  const measuredLayer = (v) => (v && v.blind !== false && !(v.blindProblems ?? []).length && !(injection?.blindProblems ?? []).length ? v : null);
  const hRate = measuredLayer(injection?.layers?.human)?.rate ?? null;
  const hCrit = numberOf(criteria.items.human.value);
  judge.push({ item: criteria.items.human.label, criterion: criteria.items.human.value, result: hRate === null ? '測定なし(tally の記録が無い、または目隠しを確かめられない)' : `${Math.round(hRate * 1000) / 10}%`, pass: hRate === null || !hCrit ? null : hRate * 100 >= hCrit.n });
  const aiLayer = measuredLayer(injection?.layers?.ai);
  const aiCrit = criteria.items.ai.value;
  judge.push({ item: criteria.items.ai.label, criterion: aiCrit, result: aiLayer ? `${Math.round((aiLayer.rate ?? 0) * 1000) / 10}%` : '測定なし', pass: /数えない/.test(nfkc(aiCrit)) ? true : aiLayer && numberOf(aiCrit) ? aiLayer.rate * 100 >= numberOf(aiCrit).n : null });
  const sCrit = numberOf(criteria.items.scenes.value);
  judge.push({ item: criteria.items.scenes.label, criterion: criteria.items.scenes.value, result: `${stoppedCount} / 11`, pass: sCrit ? stoppedCount >= sCrit.n : null });
  const eOk = drills.E.filter((d) => d.valid);
  judge.push({ item: criteria.items.drillE.label, criterion: criteria.items.drillE.value, result: eOk.length ? eOk.map((d) => `${d.at} ${d.result}`).join(' / ') : '記録なし', pass: eOk.length ? null : false });
  const fOk = drills.F.filter((d) => d.valid);
  judge.push({ item: criteria.items.drillF.label, criterion: criteria.items.drillF.value, result: fOk.length ? fOk.map((d) => `${d.at} ${d.result}`).join(' / ') : '記録なし', pass: fOk.length ? null : false });
  const claimOk = claim.policyValid && !claim.emergencyMissing.length;
  judge.push({ item: criteria.items.claim.label, criterion: criteria.items.claim.value, result: claimOk ? '成立(層1 が有効で、D-0 表4 の空欄なし)' : '不成立', pass: claimOk });
  // 要件⑦ 実環境の統制の確認(#288 第6巡)。記録(env-check.json)が無い・項目が確認済みでない記録は「未確認」。
  // 基準の行が無い旧い様式では、基準なしとして人が照合する(結果は出す。黙って通さない)
  const env = readEnvCheck(config);
  const envItem = criteria.items.env;
  judge.push({
    item: envItem.label,
    criterion: envItem.rowPresent ? envItem.value : '(基準の行なし。様式を templates/adoption-trial-criteria.md から更新する)',
    result: env.confirmed ? `確認済み(${String(env.record.checkedAt).slice(0, 10)} ${env.record.checkedBy})` : `**未確認**(${env.items.filter((i) => i.status !== 'confirmed').map((i) => i.label.split('(')[0]).join('・') || env.problems.join('。')})`,
    pass: envItem.rowPresent && isFilledValue(envItem.value) ? env.confirmed : null,
  });

  const evidenceStatus = [
    ...(notAdopter.length ? [`**採用者の環境の証拠ではない**(${notAdopter.join('。')})`] : []),
    ...(reworked.length ? [`**合否の基準を以前の実行(${reworked.map((r) => `${r.startedAt}。${r.source}`).join(', ')})の後に改めている。この記録は採用の証拠に数えない**`] : []),
  ];
  const passText = (v) => (v === null ? '人が照合する' : v ? '基準を満たす' : '**基準を満たさない**');
  const L = [];
  L.push(`# 導入前の検証の記録: ${criteria.candidate ?? '<適用候補>'}`);
  L.push('');
  if (evidenceStatus.length) {
    for (const e of evidenceStatus) L.push(`> ${e}`);
    L.push('');
  }
  L.push(`- 実施期間: ${startedAt}〜${finishedAt} / 実施者: 節0 に書く`);
  L.push(`- 対象のリポジトリと版: ${remote || '(リモートなし)'} ${sc.head} / 構成の版: ${configDigest(config).slice(0, 12)}(D-0 ${config.d0Version ?? '未取得'}) / 層1 の版: ${policy.label} / D-0 の版: ${config.d0Version ?? '未取得'}`);
  L.push(`- 本記録は adoption-trial(node scripts/gate/adoption-trial.mjs run)が出力した。節1〜8 はコマンドが埋め、人は書き換えない。節0 と節9 の受容者・期限は採用者が書く。判定(採否)は採用者が記録を読んで行う`);
  L.push('');
  L.push('## 0. 採用者が記入する欄(コマンドは埋めない。AI は推測で埋めない)');
  L.push('');
  L.push('<!-- human-fields start cols=2 -->');
  L.push('| 欄 | 記入 | 確かめる問い |');
  L.push('| --- | --- | --- |');
  L.push('| 実施者(氏名と席。席に就く予定の人) | <人が書く> | 要件② |');
  L.push('| 下流の指標の基準値(検証の開発ラインで測った値。指標の名前、値、測定の期間、出所) | <人が書く> | Q10 |');
  L.push('| 検証の期間の工数の実績(AI の実行 / 検証 / 修正 / 教育 / 管理の5区分。区分ごとに値と出所。実績が取れない区分は「取れない」と書く) | <人が書く> | Q11 |');
  L.push('| 理解の確認の記録(生成に関与しなかった人が対象のコア機能を説明し、本人以外が日付を付けて確認した記録の所在と確認日) | <人が書く> | Q15 |');
  L.push('| 人事評価の規程と目標設定の様式の写しの所在(停止の申し立て・差し戻しの件数を減点に使わず、AI の利用量・PR の本数・リードタイムを人の目標値にしないことを照合できる箇所) | <人が書く> | Q17 |');
  L.push('<!-- human-fields end -->');
  L.push('');
  L.push('## 1. 合否の基準(実行の前に記入する。採用者が書き、コマンドが写す)');
  L.push(`- 記入日時: ${criteria.writtenAt} / 記入者: ${criteria.writer} / 基準のコミット: ${criteria.commitAt}(実行の開始 ${startedAt} より前)`);
  L.push('');
  L.push('| 項目 | 基準 |');
  L.push('| --- | --- |');
  for (const it of Object.values(criteria.items)) L.push(`| ${it.label} | ${it.rowPresent ? it.value : '(様式に行なし。第6巡より前の様式)'} |`);
  L.push('');
  L.push('## 2. 欠陥注入(要件③。コマンドが埋める)');
  if (!injection) L.push('- 記録なし(seal と tally を実行していない)。検出率は「確かめていない」');
  else {
    L.push('| 注入した者 | 見つける者 | 注入件数 | 類型の内訳 | 人の層の検出数 | AI の層の検出数 | 目隠しの方法 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    const h = injection.layers.human;
    const a = injection.layers.ai;
    // 目隠しを確かめられない層は、検出数を測定値として書かない(参考値は injection-result.json にある)
    const layerBlind = (v) => Boolean(v) && (v.blind === false || (v.blindProblems ?? []).length > 0 || (injection.blindProblems ?? []).length > 0);
    const cell = (v) => (!v ? '—' : layerBlind(v) ? '**未測定**(目隠しを確かめられない)' : String(v.detected));
    L.push(`| ${injection.injector} | ${[h?.finder, a?.finder].filter(Boolean).join(' / ')} | ${injection.injected} | ${Object.entries(injection.typeBreakdown).map(([k, v]) => `${k} ${v}`).join(' / ')} | ${cell(h)} | ${cell(a)} | 注入の記録をリポジトリの外に置き、要約値(${String(injection.digest).slice(0, 12)})を ${injection.sealedAt} に封じた。位置の許容 ±${injection.tolerance} 行 |`);
    L.push(`- 見逃した欠陥の類型: ${[h && !layerBlind(h) ? `人の層 ${h.missedTypes.join('・') || 'なし'}` : null, a && !layerBlind(a) ? `AI の層 ${a.missedTypes.join('・') || 'なし'}` : null].filter(Boolean).join(' / ') || '未測定の層は出さない'}`);
    // 見つける者が2名以上の層は、各人の検出数を参考値として併記する(層の検出率は和集合。G-6 を2名で行う体制は2名で見つける)
    for (const [label, v] of [['人の層', h], ['AI の層', a]]) {
      if (v && !layerBlind(v) && Array.isArray(v.finders) && v.finders.length > 1 && v.perFinder) {
        L.push(`- ${label}の見つける者 ${v.finders.length} 名の各人の検出数(参考値。層の検出率は和集合 ${v.detected} 件): ${Object.entries(v.perFinder).map(([who, p]) => `${who} ${p.detected} 件(指摘 ${p.findings} 件)`).join(' / ')}`);
      }
    }
    for (const p of [...injection.blindProblems, ...(h?.blindProblems ?? []).map((x) => `人の層: ${x}`), ...(a?.blindProblems ?? []).map((x) => `AI の層: ${x}`)]) L.push(`- **目隠しを確かめられない**: ${p}(検出率に数えない。${SEEDED_FILE} には blind:false と理由だけを書いた。出荷の集約は未測定として扱う)`);
    L.push(`- 測定の記録: ${SEEDED_FILE}(${fs.existsSync(rel(SEEDED_FILE)) ? (git(['log', '-1', '--format=%cI', '--', SEEDED_FILE]) ? `コミット済み。出荷の集約が項目6 に読む` : '**コミットされていない**。コミットするまで、clone した出荷の集約には届かない') : '**無い**(tally を実行し直す)'})`);
  }
  L.push('');
  L.push('## 3. 場面集の結果(要件⑤。コマンドが埋める)');
  L.push('');
  L.push('| # | 場面 | 期待 | 結果(止まった / 止まらなかった / 確かめていない) | 出力の所在 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const s of sc.scenes) L.push(`| ${s.id} | ${s.label} | ${s.where}で止まる | ${s.result === '止まった' ? '止まった' : `**${s.result}**`}: ${s.detail} | 一時の複製(${argv.includes('--keep') ? sc.clone : '実行の後に消した。--keep で残せる'}) |`);
  L.push('');
  L.push(`- 基準の状態(場面を入れない)の出荷の集約: 終了コード ${sc.baseline.code} / 記録の欠落 ${sc.baseline.gaps} 件。場面の判定は、場面を入れた後にだけ現れる欠落・失敗で行った`);
  const GAP_SHOW = 20;
  for (const g of (sc.baseline.gapList ?? []).slice(0, GAP_SHOW)) L.push(`  - ${String(g).replace(/\|/g, '/')}`);
  if ((sc.baseline.gapList ?? []).length > GAP_SHOW) L.push(`  - (残り ${sc.baseline.gapList.length - GAP_SHOW} 件は ${runFile} の baseline.gaps にある)`);
  L.push('');
  // 要件⑦ 実環境の統制の確認。場面集は一時の複製と模擬の gh で止まることを確かめるが、実環境でルールセットが効いているか、
  // gate-g5 がレビューを読めるか、ship-evidence が成果物を取れるかは、採用者が実環境の gh で確かめる(env-check)。
  // 確かめていない記録には「未確認」と出し続ける(未達のゲートと同じ扱い。#288 第6巡)
  L.push('### 実環境の統制の確認(要件⑦。env-check の記録をコマンドが写す)');
  L.push('');
  L.push('| 項目 | 結果 | 詳細 |');
  L.push('| --- | --- | --- |');
  for (const i of env.items) L.push(`| ${i.label} | ${i.status === 'confirmed' ? '確認済み' : i.status === 'mismatch' ? '**構成と一致しない**' : '**未確認**'} | ${String(i.detail).replace(/\|/g, '/')} |`);
  L.push('');
  L.push(
    env.present
      ? `- 記録: ${ENV_CHECK_FILE}(確認した者 ${env.record?.checkedBy ?? '未記入'} / ${String(env.record?.checkedAt ?? '').slice(0, 10) || '日付なし'} / 対象 ${env.record?.repo ?? '不明'}。${env.committed === true ? 'コミット済み' : env.committed === false ? '**コミットされていない**' : 'コミットの状態を確かめられない'})${env.problems.length ? `。**${env.problems.join('。')}**` : ''}`
      : `- 記録なし(${ENV_CHECK_FILE} が無い)。採用者が実環境の gh で \`node scripts/gate/adoption-trial.mjs env-check --by <氏名>\` を実行し、記録をコミットする。模擬の gh では各項目が「読めない」と出て未確認のまま残る`
  );
  if (env.present) L.push(`- 実環境の識別(査察で GitHub の画面と突合する鍵): ${env.evidenceText ?? '**記録に無い**(第7巡より前の記録、または識別を返さない gh。確認済みの項目は識別が無ければ未確認に倒れる)'}`);
  L.push('- 場面集の「止まった」は一時の複製と模擬の gh での結果である。実環境でマージを止めるのはブランチ保護であり、その適用はこの表で確かめる。未確認のまま採用の判断を進めるなら、節9 の受容の対象にする');
  L.push('');
  L.push('## 4. 演習(記録は人が書く。コマンドが読んで転記する)');
  L.push('');
  L.push('| 類型 | 実施日 | 処理できた量 / 差分 | 判断を担う席の AI を使わない判断の記録 | 記録の所在 |');
  L.push('| --- | --- | --- | --- | --- |');
  const drillRows = [...drills.E, ...drills.F];
  if (!drillRows.length) L.push(`| — | — | 記録なし(${DRILL_FILE} と docs/exit-rehearsal.json に記録が無い) | — | — |`);
  for (const d of drillRows) L.push(`| ${d.type} | ${d.at ?? '—'} | ${d.result ?? '—'}${d.valid ? '' : `(**数えない**: ${d.why.join('。')})`} | ${d.judgement ?? '記録なし'} | ${d.record ?? DRILL_FILE} |`);
  for (const p of drills.problems) L.push(`- 読めない記録: ${p}`);
  // 類型E の結果を D-0 表7 へ転記する案内(表7 は手で書く。構成へ入れない。標準 第3章 3.12.5、第6章 テンプレ0 表7)
  if (transcribe.length) {
    L.push(`- D-0 表7(縮退の3列)への転記。類型E の「処理できた量」を、AI の担い手を置いた席の「人へ戻したときに処理できる量」へ、実測の日とともに人が書く。層1 の縮退の実測の頻度(${degradationCycle ?? '**空欄**'})を過ぎると「未確認」へ戻る`);
    for (const t of transcribe) {
      if (t.measured) L.push(`  - 「${t.seat}」(扱い ${t.fallback}): 実測あり(${t.quantity})。転記は不要`);
      else if (!t.from.length) L.push(`  - 「${t.seat}」(扱い ${t.fallback}): 現在「${t.quantity}」。数えられる類型E の演習の記録が無いため、転記する値が無い。未確認のまま(単一障害点の一覧に「縮退を確かめていない業務」として出る)`);
      else {
        const d = [...t.from].sort((x, y) => String(x.at).localeCompare(String(y.at))).at(-1);
        L.push(`  - 「${t.seat}」(扱い ${t.fallback}): 現在「${t.quantity}」。表7 の行「${t.seat}」の「人へ戻したときに処理できる量」に「実測 ${d.result}(${d.at} の類型E の演習)」、「実測の日」に ${d.at} と書く(記録 ${d.record ?? DRILL_FILE})${d.seat ? '' : '。演習の記録に seat(席)が無いため、席ごとの量を書き分ける場合は記録に seat を書く'}`);
      }
    }
  }
  L.push('');
  L.push('## 5. 成立判定(コマンドが埋める)');
  L.push(`- 成立判定の出力の所在: このコマンドの出力(層1 と D-0 の読み取り)。出荷の集約(aggregate-evidence)の「保証の主張の成立判定」と同じ読み方`);
  L.push(`- 層1: ${policy.present ? (policy.valid ? '有効' : `**有効でない**(${policy.problems.join(' / ')})`) : '**層1 なし**'}`);
  L.push(`- 層1 の必須行の空欄: ${claim.requiredBlank.length ? `あり(${claim.requiredBlank.join(' / ')})` : 'なし'}`);
  L.push(`- D-0 表4 の空欄: ${claim.emergencyMissing.length ? `あり(${claim.emergencyMissing.join(' / ')})` : 'なし'}`);
  L.push('');
  L.push('## 6. 判定(基準との照合。コマンドが埋める)');
  L.push('');
  L.push('| 項目 | 基準 | 結果 | 合否 |');
  L.push('| --- | --- | --- | --- |');
  for (const j of judge) L.push(`| ${j.item} | ${j.criterion} | ${j.result} | ${passText(j.pass)} |`);
  L.push('');
  L.push('「人が照合する」は、基準と結果が数で比べられない項目です。機械は比べていません。');
  L.push('');
  L.push('## 7. 再実行の手順(要件④。コマンドが埋める)');
  L.push(`- リポジトリの版 ${sc.head} を取り出し、同じ合否の基準(要約値 ${criteria.digest.slice(0, 12)})で \`node scripts/gate/adoption-trial.mjs run\` を実行する`);
  L.push(`- 欠陥注入は、注入の記録(リポジトリの外)と ${SEAL_FILE}・見つける者の記録(${TRIAL_DIR}/findings-*.json。コミット済みのもの)で \`node scripts/gate/adoption-trial.mjs tally --manifest <所在>\` を実行し直す。測定の記録は ${SEEDED_FILE} に出る(コミットする。出荷の集約が読む)`);
  L.push(`- 場面集は一時の複製で、模擬の gh(GitHub へ問い合わせない)を使って、scripts/gate/check-pr.mjs・aggregate-evidence.mjs・scripts/init/generate-profile.mjs を実行した。出力の所在: ${recordFile} と ${runFile}`);
  L.push(`- 記録(${TRIAL_DIR}/)は、記録だけのコミットとしてコミットする。出荷の証跡の集約は ${TRIAL_DIR}/ を記録の置き場として扱い、製品の変更に数えない`);
  L.push('');
  L.push('## 8. 根拠の水準(要件⑥。コマンドが埋める)');
  L.push('- 本記録は1件の測定である(E2 単一事例)。検証した構成と開発ラインの外へ一般化しない');
  if (notAdopter.length) L.push('- 採用者のコードと人で行っていない記録は、本標準の自己評価(E0)と同じ扱いになる(要件②)');
  L.push('');
  L.push('## 9. 範囲を限って受容する残余リスク(受容者と期限は採用者が書く)');
  L.push('');
  L.push('<!-- human-fields start cols=3,4 -->');
  L.push('| 残余リスク | 受容の範囲 | 受容者(層1 の項目4 の権限者) | 期限 | 確かめる運用の記録 |');
  L.push('| --- | --- | --- | --- | --- |');
  L.push('| 結果の効果(欠陥の流出が減るか)は未実証 | 検証した構成と開発ライン | <人が書く> | <YYYY-MM-DD> | 保証の開示の推移、ポストモーテム |');
  L.push('| 人と組織の挙動(記名の質、申し立ての使われ方、評価の運用)は未確認 | 同上 | <人が書く> | <YYYY-MM-DD> | 内部監査 観点14・20、申し立てと解除の記録 |');
  const notStopped = sc.scenes.filter((s) => s.result !== '止まった');
  L.push(`| 場面集で止まらなかった場面${notStopped.length ? `(${notStopped.map((s) => `#${s.id}`).join(', ')})` : '(なし)'} | 手で代える手順を置いた範囲 | <人が書く> | <YYYY-MM-DD> | 手で代えた記録 |`);
  if (!env.confirmed) L.push(`| 実環境の統制が未確認(${env.items.filter((i) => i.status !== 'confirmed').map((i) => i.label.split('(')[0]).join('・') || '記録の問題'}) | 実環境で確かめるまで | <人が書く> | <YYYY-MM-DD> | env-check の記録(${ENV_CHECK_FILE}) |`);
  L.push('<!-- human-fields end -->');
  L.push('');
  L.push('- 受容者・期限と節0 の欄は人が書く。AI は推測で埋めない');
  // 節10: 入力と本文の要約値。本文の要約値は、人が書く欄(印で囲んだ表の指定の列)を除いて計算する
  const criteriaHash = git(['log', '-1', '--format=%H', '--', CRITERIA_FILE]) ?? '不明';
  const digests = {
    criteria: criteria.digest,
    config: configDigest(config),
    injection: injection?.digest ?? 'なし',
    scenes: scenesDigest(sc.scenes),
    drills: sha256((readText(DRILL_FILE) ?? '').replace(/\n*$/, '\n')),
  };
  L.push('');
  L.push(`${DIGEST_HEADING}(第三者が確かめる。コマンドが埋める)`);
  L.push('');
  L.push('| 対象 | 要約値(SHA-256) |');
  L.push('| --- | --- |');
  // 本文の要約値は、節10 を含む全文から要約値の行の値を伏せて計算する。先に仮の値で行を置き、計算の後に差し替える
  const bodyRow = L.push(`| ${DIGEST_ROWS.body} | なし |`) - 1;
  L.push(`| ${DIGEST_ROWS.criteria}(コミット ${criteriaHash} の ${CRITERIA_FILE}) | ${digests.criteria} |`);
  L.push(`| ${DIGEST_ROWS.config} | ${digests.config} |`);
  L.push(`| ${DIGEST_ROWS.injection} | ${digests.injection} |`);
  L.push(`| ${DIGEST_ROWS.scenes} | ${digests.scenes} |`);
  L.push(`| ${DIGEST_ROWS.drills} | ${digests.drills} |`);
  L.push('');
  // 定型の行は DIGEST_TAIL_LINES 行。この後ろに行があれば追記として verify が不一致にする
  L.push('- 人が書く欄の範囲: 節0 の「記入」の列と、節9 の「受容者」「期限」の列(本文中の \`<!-- human-fields start -->\` から \`<!-- human-fields end -->\` までの表の、印に書いた列)。本文の要約値は、この欄と、この表の要約値の列の値だけを伏せた全文(この節の後ろを含む)で計算している');
  L.push(`- 確かめ方: \`node scripts/gate/adoption-trial.mjs verify ${recordFile}\` が、本文・合否の基準(コミットから読み直す)・場面集の結果(実行の記録 ${runFile} から再計算)の一致を確かめる。構成・注入の記録・演習の記録は現在の状態と比べ、違えば記録が以前の状態での測定であることを示す`);
  L.push('- 人が書く欄の外を書き換えた記録と、この節の後ろへ追記した記録は、要約値が一致しない。記録の末尾はこの節である。導入前の検証の記録として数えず、再実行して新しい記録を作る。所見・判定は別の文書に書く');
  digests.body = sha256(canonicalRecord(L.join('\n') + '\n'));
  L[bodyRow] = `| ${DIGEST_ROWS.body} | ${digests.body} |`;
  writeText(recordFile, L.join('\n') + '\n');
  writeText(runFile, JSON.stringify({ startedAt, finishedAt, head: sc.head, criteriaDigest: criteria.digest, criteriaCommitAt: criteria.commitAt, notAdopter, reworked: reworked.map((r) => r.startedAt), baseline: { code: sc.baseline.code, gaps: sc.baseline.gapList ?? [] }, scenes: sc.scenes, injection: injection ? { injected: injection.injected, layers: Object.fromEntries(Object.entries(injection.layers).map(([k, v]) => [k, { detected: v.detected, rate: v.rate, blind: v.blind !== false && !(v.blindProblems ?? []).length && !(injection.blindProblems ?? []).length, blindProblems: v.blindProblems }])) } : null, drills: { E: drills.E.length, F: drills.F.length, counted: { E: eValid.length, F: drills.F.filter((d) => d.valid).length } }, transcribe, claim, judge, envCheck: { present: env.present, confirmed: env.confirmed, items: env.items, problems: env.problems } }, null, 2) + '\n');
  console.log('');
  for (const e of evidenceStatus) warn(e.replace(/\*\*/g, ''));
  console.log(`場面集: 止まった ${stoppedCount} / 11(止まらなかった ${sc.scenes.filter((s) => s.result === '止まらなかった').length}、確かめていない ${sc.scenes.filter((s) => s.result === '確かめていない').length})`);
  for (const s of notStopped) console.log(`  - #${s.id} ${s.label}: ${s.result}(${s.detail})`);
  for (const d of [...drills.E, ...drills.F].filter((x) => !x.valid)) warn(`演習の記録(類型${d.type} ${d.at ?? '日付なし'})を数えない: ${d.why.join('。')}`);
  for (const t of transcribe.filter((x) => !x.measured && x.from.length)) {
    const d = [...t.from].sort((x, y) => String(x.at).localeCompare(String(y.at))).at(-1);
    notice(`D-0 表7 の行「${t.seat}」へ転記する: 人へ戻したときに処理できる量「実測 ${d.result}(${d.at} の類型E の演習)」、実測の日 ${d.at}(人が書く。記録の節4 を見る)`);
  }
  notice(`${recordFile} を出力しました(附属書I「導入前の検証の記録」の様式)。節0 と節9 の受容者・期限を採用者が書き、記録だけのコミットとしてコミットします。第三者は node scripts/gate/adoption-trial.mjs verify ${recordFile} で要約値を確かめます。採否は採用者が記録を読んで判定します。記録は1件の測定(E2)です`);
  return 0;
}

// ---------------------------------------------------------------- 実環境の統制の確認(要件⑦。#288 第6巡)
//
//   node scripts/gate/adoption-trial.mjs env-check --by <確認した者の氏名> [--repo owner/name] [--branch main] [--pr N]
//
// ブランチ保護(ルールセット)の GitHub 上の適用、gate-g5 が PR_REVIEWS に渡すレビューの取得、ship-evidence が取り込む
// gate-g5 の成果物の取得を、採用者のリポジトリの実環境の gh で読み、docs/adoption-trial/env-check.json(記録の置き場)へ書く。
// 第5巡の判定で、採用者が実環境で確かめていないことが「条件付き採用」の理由になった。採用の後の条件ではなく、採用の前の
// 検証の手順にする。gh が無い・未認証・模擬の gh(出力を JSON として読めない、空の一覧)では、各項目を「読めない」として
// 未確認に倒す。黙って通さない。本物の GitHub へ書き込む呼び出しは無い(読むだけ)。
// 第7巡(V): 確認した者の記名だけでは、固定の応答で作った記録と実環境の記録を区別できない。各項目に API の応答の識別
// (ルールセットの id、PR のレビューの id、gate-g5 の実行の id と URL、応答の取得時刻)を evidence として書き、識別の無い応答は
// 確認済みにしない(readEnvCheck も、識別の無い確認済みを未確認に倒す)。査察は識別を GitHub の画面と突合する
const ENV_ITEM_LABEL = Object.fromEntries(ENV_CHECK_ITEMS);

/** gh を呼び、JSON として読む。読めなければ { value: null, why } */
function ghJson(args) {
  let raw;
  try {
    raw = execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const err = String(e.stderr || e.message || '').split('\n').find((l) => l.trim()) ?? 'gh を実行できない';
    return { value: null, why: `gh を実行できない、または失敗した(${err.slice(0, 120)})` };
  }
  if (!String(raw ?? '').trim()) return { value: null, why: 'gh の出力が空(模擬の gh、または対象が無い)。読めない' };
  try {
    return { value: JSON.parse(raw), why: null };
  } catch {
    return { value: null, why: 'gh の出力を JSON として読めない(模擬の gh、または未認証)' };
  }
}

function envCheck() {
  const config = loadConfig();
  if (config.configured === false) {
    fail('プロセス構成が未設定です。/process-init の後に実行します');
    return 1;
  }
  const by = arg('--by');
  if (!isFilledValue(by)) {
    fail('--by <確認した者の氏名> を渡します。実環境で確かめた人(採用者・品質保証部門)の記名であり、AI の名義は受け付けません');
    return 2;
  }
  if (aiNameBlocked(config, by)) {
    fail(`確認した者 "${by}" は AI の名義です。実環境で確かめた人の氏名を書きます`);
    return 1;
  }
  const want = Math.max(1, Number(config.review?.reviewerCount ?? config.review?.requiredApprovals ?? 1) || 1);
  const ruleset = config.ruleset ?? null;
  const g6Active = ['required', 'simplified'].includes(config.gates?.g6?.state);
  // 対象のリポジトリ。--repo > GITHUB_REPOSITORY > gh repo view > git remote。実環境の識別として、API が返す URL も記録する
  let repo = arg('--repo', process.env.GITHUB_REPOSITORY || null);
  let repoUrl = null;
  {
    const v = ghJson(['repo', 'view', ...(repo ? ['--repo', repo] : []), '--json', 'nameWithOwner,url']);
    if (!repo) repo = v.value?.nameWithOwner ?? null;
    repoUrl = typeof v.value?.url === 'string' ? v.value.url : null;
    if (!repo) {
      const remote = git(['remote', 'get-url', 'origin']) ?? '';
      repo = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/)?.[1] ?? null;
    }
  }
  /** 確認済みにする前に、応答の識別が揃っているかを確かめる。欠ければ未確認(実環境の証拠を欠く) */
  const confirmedWith = (id, detail, evidence) => {
    const missing = envEvidenceMissing(id, evidence);
    return missing.length
      ? { status: 'unconfirmed', detail: `応答に実環境の識別(${missing.join('・')})が無く、確認済みにしない(識別を返さない gh、または模擬)。読めた内容: ${detail}`, evidence }
      : { status: 'confirmed', detail, evidence };
  };
  let branch = arg('--branch', null);
  if (!branch) {
    const v = ghJson(['repo', 'view', ...(repo ? ['--repo', repo] : []), '--json', 'defaultBranchRef']);
    branch = v.value?.defaultBranchRef?.name ?? (git(['rev-parse', '--verify', '--quiet', 'refs/heads/main']) !== null ? 'main' : 'master');
  }
  const items = {};
  const unconfirmed = (why) => ({ status: 'unconfirmed', detail: why });

  // 1. ルールセットの適用。既定ブランチに効いている規則(rules/branches/<branch>)を読む
  if (!repo) items.ruleset = unconfirmed('対象のリポジトリ(owner/name)を特定できない(--repo で指定する)');
  else if (!g6Active || !ruleset) items.ruleset = { status: 'confirmed', notApplicable: true, detail: `構成がブランチ保護を要しない(G-6 ${g6Active ? '有効' : '無効'}。ルールセット ${ruleset ?? 'なし'})。確かめる項目なし` };
  else {
    const api = `repos/${repo}/rules/branches/${branch}`;
    const fetchedAt = localIso();
    const r = ghJson(['api', api]);
    if (!Array.isArray(r.value)) items.ruleset = unconfirmed(r.why ?? 'ルールセットの一覧を読めない');
    else if (!r.value.length) items.ruleset = unconfirmed(`既定ブランチ ${branch} に効いているルールセットが無い(.github/rulesets/${ruleset}.json を人が適用する)`);
    else {
      const pr = r.value.find((x) => x?.type === 'pull_request')?.parameters ?? null;
      const checks = r.value.filter((x) => x?.type === 'required_status_checks').flatMap((x) => x?.parameters?.required_status_checks ?? []).map((c) => c?.context).filter(Boolean);
      const bad = [];
      if (!pr) bad.push('pull_request の規則が無い');
      else {
        if (!(Number(pr.required_approving_review_count) >= want)) bad.push(`要求する承認の数 ${pr.required_approving_review_count ?? '未設定'} < 構成 ${want}`);
        if (ruleset === 'regulated') {
          if (pr.require_last_push_approval !== true) bad.push('最後の push の後の承認(require_last_push_approval)が無効');
          if (pr.require_code_owner_review !== true) bad.push('コードオーナーの承認(require_code_owner_review)が無効');
          if (pr.dismiss_stale_reviews_on_push !== true) bad.push('push で古い承認を無効にする設定(dismiss_stale_reviews_on_push)が無効');
        }
      }
      if (!checks.includes('gate-g5')) bad.push('必須チェックに gate-g5 が無い');
      // 実環境の識別: 応答の各規則が属するルールセットの id(GitHub の設定画面の Rulesets の URL の末尾と一致する)
      const rulesetIds = [...new Set(r.value.map((x) => x?.ruleset_id).filter((v) => Number.isFinite(Number(v)) && Number(v) > 0).map(Number))];
      const evidence = { rulesetIds, api, fetchedAt };
      items.ruleset = bad.length
        ? { status: 'mismatch', detail: `効いている規則が構成(${ruleset}。承認 ${want} 名)と一致しない: ${bad.join('。')}`, evidence }
        : confirmedWith('ruleset', `ブランチ ${branch} に承認 ${pr.required_approving_review_count} 名${ruleset === 'regulated' ? '・最後の push の後の承認・コードオーナー' : ''}・必須チェック ${checks.join('/')} が効いている`, evidence);
    }
  }

  // 2. PR のレビューの取得(gate-g5 のワークフローと同じ API)
  if (!repo) items.prReviews = unconfirmed('対象のリポジトリを特定できない');
  else {
    let pr = arg('--pr', null);
    if (!pr) {
      const l = ghJson(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '1', '--json', 'number']);
      pr = Array.isArray(l.value) && l.value[0]?.number ? String(l.value[0].number) : null;
      if (!pr) items.prReviews = unconfirmed(l.why ? `PR の一覧を読めない(${l.why})` : 'マージ済みの PR が無い(最初の PR の後に確かめる。--pr N で指定できる)');
    }
    if (pr) {
      const api = `repos/${repo}/pulls/${pr}/reviews`;
      const fetchedAt = localIso();
      const r = ghJson(['api', api]);
      if (!Array.isArray(r.value)) items.prReviews = unconfirmed(r.why ?? 'レビューを読めない');
      else if (!r.value.length) items.prReviews = unconfirmed(`PR #${pr} のレビューが 0 件(承認のある PR で確かめる。--pr N)`);
      else {
        const shaped = r.value.filter((x) => x && typeof x === 'object' && x.user?.login && x.state);
        // 実環境の識別: レビューの id(PR の画面のレビューのリンク #pullrequestreview-<id> と一致する)と最後の提出時刻(サーバの時刻)
        const reviewIds = shaped.map((x) => x.id).filter((v) => Number.isFinite(Number(v)) && Number(v) > 0).map(Number);
        const lastSubmittedAt = shaped.map((x) => x.submitted_at).filter((v) => typeof v === 'string').sort().at(-1) ?? null;
        const evidence = { pr: Number(pr), reviewIds, lastSubmittedAt, api, fetchedAt };
        items.prReviews = shaped.length
          ? confirmedWith('prReviews', `PR #${pr} のレビュー ${r.value.length} 件を取得(承認 ${shaped.filter((x) => x.state === 'APPROVED').length} 件。user.login と state の形)`, evidence)
          : unconfirmed(`PR #${pr} のレビューに user.login と state が無い(gate-g5 が読む形でない)`);
      }
    }
  }

  // 3. ship-evidence が取り込む gate-g5 の成果物
  if (!repo) items.shipEvidence = unconfirmed('対象のリポジトリを特定できない');
  else {
    const fetchedAt = localIso();
    const runs = ghJson(['run', 'list', '--repo', repo, '--workflow', 'gate-g5', '--status', 'success', '--limit', '1', '--json', 'databaseId,url,createdAt']);
    const first = Array.isArray(runs.value) && runs.value[0] && typeof runs.value[0] === 'object' ? runs.value[0] : null;
    const id = first?.databaseId ? first.databaseId : null;
    if (!id) items.shipEvidence = unconfirmed(runs.why ? `gate-g5 の実行の一覧を読めない(${runs.why})` : 'gate-g5 の成功した実行が無い(最初の PR の後に確かめる)');
    else {
      const api = `repos/${repo}/actions/runs/${id}/artifacts`;
      const a = ghJson(['api', api]);
      const names = Array.isArray(a.value?.artifacts) ? a.value.artifacts.map((x) => x?.name).filter(Boolean) : null;
      if (!names) items.shipEvidence = unconfirmed(a.why ?? `gate-g5 の実行 ${id} の成果物を読めない`);
      else {
        const missing = ['license-scan', 'test-results'].filter((n) => !names.includes(n));
        // 実環境の識別: 実行の id と URL(Actions の画面の URL と一致する)、実行の作成時刻(サーバの時刻)、成果物の id
        const artifactIds = a.value.artifacts.map((x) => x?.id).filter((v) => Number.isFinite(Number(v)) && Number(v) > 0).map(Number);
        const evidence = { runId: Number(id), runUrl: typeof first.url === 'string' ? first.url : null, runCreatedAt: typeof first.createdAt === 'string' ? first.createdAt : null, artifactIds, api, fetchedAt };
        items.shipEvidence = missing.length
          ? unconfirmed(`gate-g5 の実行 ${id} の成果物に ${missing.join('・')} が無い(ある成果物: ${names.join('/') || 'なし'})`)
          : confirmedWith('shipEvidence', `gate-g5 の実行 ${id} に license-scan と test-results がある(ship-evidence が gh run download で取り込む形)`, evidence);
      }
    }
  }
  const allOk = Object.values(items).every((i) => i.status === 'confirmed');
  const record = {
    checkedAt: localIso(),
    checkedBy: by,
    repo: repo ?? null,
    repoUrl,
    branch,
    commit: git(['rev-parse', 'HEAD']),
    config: { reviewerCount: want, ruleset, g6: config.gates?.g6?.state ?? null },
    items,
    note: '実環境の gh で読んだ結果。項目が確認済みでない記録は、導入前の検証の記録と出荷の集約に「実環境の統制 未確認」と出続ける(附属書I I.11 要件⑦)。各項目の evidence は API の応答の識別(査察で GitHub の画面と突合する鍵)であり、識別の無い確認済みは読む側で未確認に倒れる',
  };
  writeText(ENV_CHECK_FILE, JSON.stringify(record, null, 2) + '\n');
  for (const [id, it] of Object.entries(items)) {
    const line = `${ENV_ITEM_LABEL[id]}: ${it.status === 'confirmed' ? '確認済み' : it.status === 'mismatch' ? '構成と一致しない' : '未確認(読めない)'}(${it.detail})`;
    if (it.status === 'confirmed') notice(line);
    else warn(line);
  }
  const idText = envEvidenceText({ record, items: Object.entries(items).map(([id, it]) => ({ id, evidence: it.evidence ?? null })) });
  notice(`実環境の識別(査察で GitHub の画面と突合する鍵): ${idText ?? '無し(識別を返さない gh、または模擬。確認済みの項目は無い)'}`);
  notice(`${ENV_CHECK_FILE} を書きました(確認した者 ${by}。対象 ${repo ?? '不明'} / ${branch})。記録だけのコミットとしてコミットします。確認済みでない項目は、記録と出荷の集約に「未確認」と出続けます(消えません)`);
  return allOk ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fns = { init, seal, tally, run, verify, 'env-check': envCheck };
  if (!fns[cmdName]) {
    console.log('使い方: node scripts/gate/adoption-trial.mjs <init | seal --manifest <所在> | tally --manifest <所在> | env-check --by <氏名> | run | verify <記録>>');
    console.log('合否の基準を採用者が書いてコミットしてから run します(標準 附属書I I.11)。env-check は採用者が実環境の gh で行います(要件⑦)。');
    process.exit(cmdName ? 2 : 0);
  }
  try {
    process.exit(fns[cmdName]());
  } catch (e) {
    fail(e.message);
    process.exit(1);
  }
}

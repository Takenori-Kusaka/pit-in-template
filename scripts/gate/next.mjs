// 現在の状態から、次の一手を出す(#286)。決定的であり、AI に判定させない。
//
//   node scripts/gate/next.mjs            機能(F)ごと・ロールごとの段階と次の一手
//   node scripts/gate/next.mjs --brief    セッションの開始時に注入する要約(数百トークン)
//   node scripts/gate/next.mjs --json     機械可読
//   node scripts/gate/next.mjs --role <ロール>   ロールの詳細(判定するゲート・受信箱など)と、そのロールの次の一手
//   node scripts/gate/next.mjs --scopes   標準の条項の適用範囲と判定の単位
//
// 読むもの: process.config.json、docs/D-0-governance.md(check-d0 と、節3 の手で書く行の空欄)、docs/project-brief.md、
// docs/assumptions.md(前提の台帳の有無だけ)、
// docs/gates/(判定記録)、specs/F-NNN/(spec.md・plan.md)、ローカルの git(既定ブランチのトレーラ
// `Spec: F-NNN / Task-N` と、ブランチ feature/F-NNN-task-N)、自己修正のロック(self-heal.mjs)。
//
// 出す一手は3種類である。
//   command      AI の担い手が実行してよいコマンド
//   human-wait   人の判断待ち(ゲートの判定、任免、受入基準へ戻る判断、出荷の実行など)。終端であり、
//                AI の担い手が実行するコマンドを出さない。待つ席と受信箱のラベルを出す
//   undetermined 判定できない。理由を出し、推測で次のコマンドを出さない
//
// 限界: PR・ラベル・CI の状態は見ない(ネットワークを使わない)。ローカルの git にある情報だけで判定する。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, isGateActive, readGateRecords, personName, structureDeciderSeat, MODE_LABEL, localDay, reviewersRequiredOf, corePathsOf } from './config.mjs';
import { readLock } from './self-heal.mjs';
import { MAILBOX, renderRoleCard, renderClauseScopes, renderEscalation, seatPairingNotes } from '../init/generate-profile.mjs';
import { readPolicy, continuityState, readSeededRecord, aiIdentityMismatch, humanFinderState, competenceState, readEnvCheck, checkAuthority, coreReviewText, qaAffiliationText } from './org-assurance.mjs';

/**
 * 直近の出荷の集約の出力(evidence/evidence.json。.gitignore の下。手元で集約を実行したときだけある)。
 * 10名以上の規則の件数(項目1)は PR のレビューを読んで初めて出るため、次の一手は PR を読まず、集約の出力を写す(#288 第7巡 U)。
 * 集約の後に既定ブランチが進んでいれば、その旨を添える(件数は集約の時点のもの)
 */
function lastAggregate() {
  const p = path.join(ROOT, 'evidence/evidence.json');
  if (!fs.existsSync(p)) return null;
  try {
    const ev = JSON.parse(fs.readFileSync(p, 'utf8'));
    const toCommit = ev.range?.toCommit ?? null;
    const behindRaw = toCommit ? git(['rev-list', '--count', `${toCommit}..HEAD`]) : null;
    const behind = behindRaw === null ? null : Number(behindRaw);
    return {
      independence: ev.assurance?.independence ?? null,
      range: ev.range ?? null,
      generatedAt: typeof ev.generatedAt === 'string' ? ev.generatedAt : null,
      behind: Number.isFinite(behind) ? behind : null,
    };
  } catch {
    return null;
  }
}

const PASS = '通過';
const REJECT = '差し戻し';

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** ゲートを判定する席(ロール)を構成から引く */
function gateRole(config, key) {
  return (config.roles ?? []).find((r) => r.gatesOwned.includes(key)) ?? null;
}

/** 席の表示(席名と責任者)と受信箱のラベル */
function seatOf(config, roleId) {
  const role = (config.roles ?? []).find((r) => r.id === roleId);
  const seat = (config.seats ?? []).find((s) => s.role === roleId);
  const who = seat?.accountable ? personName(config, seat.accountable) : '責任者未記入';
  return {
    role: roleId,
    name: `${role?.name ?? roleId}(${who})`,
    labels: MAILBOX[roleId]?.inbox ?? [],
  };
}

function gateLabel(config, key) {
  return config.gates?.[key]?.label ?? key.toUpperCase();
}

/** ゲートの構成のキー(g4)から、/gate の引数(G-4)を作る */
const gateArg = (key) => key.toUpperCase().replace(/^G(\d)/, 'G-$1');

// 読むべき補助ファイルの所在(#286 段2)。入口のスキルが1枚だけ読ませる。どれを読むかを AI に選ばせないため、ここで出す
const SKILL = '.claude/skills';
const READ = {
  gate: (key) => `${SKILL}/gate/gates/${gateArg(key)}.md`,
  artifact: (file) => `${SKILL}/artifact/artifacts/${file}.md`,
  change: (kind) => `${SKILL}/process-change/kinds/${kind}.md`,
};

/** ゲートの判定待ち(人の判断待ち)を組み立てる */
function gateWait(config, key, target, extra = {}) {
  const role = gateRole(config, key);
  if (!role) {
    return { kind: 'undetermined', reason: `${gateLabel(config, key)} を判定する席が構成にありません(未達の可能性)。PROCESS-PROFILE.md の「未達のゲート」を人が確かめる` };
  }
  const seat = seatOf(config, role.id);
  return {
    kind: 'human-wait',
    what: `${gateLabel(config, key)} の判定${target ? `(対象 ${target})` : ''}`,
    seat,
    after: `判定した人が \`/gate ${gateArg(key)}\` で記録する(記録の作成で判定が成立する)`,
    read: READ.gate(key),
    roles: [
      { role: role.id, action: `${gateLabel(config, key)} を判定し、\`/gate ${gateArg(key)}\` で記録する(人が判定する)` },
      { role: 'ai-agent', action: '実行するコマンドはありません。判定を待つか、別の機能を進める' },
    ],
    ...extra,
  };
}

const forTarget = (r, target) => target === null || (r.target ?? '').split(/[\s,、/]+/).includes(target);

function passed(records, gateKey, target = null) {
  const prefix = gateArg(gateKey);
  return records.some((r) => r.gate?.startsWith(prefix) && r.result === PASS && forTarget(r, target));
}

/**
 * 通過に数えなかった判定記録の所在と理由(#286)。結果欄は「通過」「差し戻し」の語だけを完全一致で読む。
 * 注記を足した値・様式の文言のままの値は通過に数えない(安全側)。数えなかったことを黙って「待ち」と出さず、
 * 記録の所在と理由を出す。直すのは判定者本人であり、AI の担い手は結果欄を書き換えない
 */
function recordIssues(records, gateKey, target = null, since = null) {
  const prefix = gateArg(gateKey);
  const own = records.filter((r) => r.gate?.startsWith(prefix) && forTarget(r, target) && (since === null || !r.judgedAt || r.judgedAt >= since));
  const out = [];
  for (const r of own) {
    if (r.result === PASS) continue;
    if (r.result === REJECT) {
      out.push(`差し戻しの記録 ${r.file} がある。差し戻し理由(判定基準の項目番号)を直した後に、判定者が新しい記録で判定する(成立した記録は書き換えない)`);
      continue;
    }
    const v = r.resultRaw;
    const shown = !v || v.includes(' / ') || v.startsWith('<') ? '未記入、または様式の文言のまま' : `値: "${v.slice(0, 60)}"`;
    out.push(
      `記録 ${r.file} の結果欄が「通過」「差し戻し」のどちらでもない(${shown})ため、通過に数えていない。` +
        '結果欄には2値の語だけを書き、転記の注記などは本文へ書く。直すのは判定者本人(AI の担い手は結果欄を書き換えない)'
    );
  }
  return out;
}

/** ゲートの判定待ちに、通過に数えなかった記録の所在と理由を添える */
function withIssues(step, issues) {
  return issues.length ? { ...step, detail: issues.join(' / '), recordIssues: issues } : step;
}

/** D-0 節3「決定の権限」の、「決定」が空欄の行(手で書く欄。/process-change の種別は無い) */
function d0DecisionBlanks(text) {
  const sec = text.split(/^##\s*3\.\s*決定の権限.*$/m)[1]?.split(/^##\s/m)[0];
  if (!sec) return [];
  const blanks = [];
  for (const line of sec.split(/\r?\n/)) {
    if (!/^\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c)) || cells[0] === '決定の種類') continue;
    if (!cells[1] || /^(—|-|TBD|未定)$/i.test(cells[1])) blanks.push(cells[0].replace(/[((].*$/, ''));
  }
  return blanks;
}

/** spec.md の「受入基準」の表から、記入済みの行を数える */
function criteriaCount(text) {
  const m = text.match(/^##\s*受入基準\s*$([\s\S]*?)(?=^##\s)/m) ?? text.match(/^##\s*受入基準\s*$([\s\S]*)/m);
  if (!m) return 0;
  return m[1].split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|[^|]*\|\s*[^|\s][^|]*\|/.test(l)).length;
}

/** plan.md の「タスク」の表から、タスクの ID と依存を読む */
function planTasks(text) {
  const tasks = [];
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\|\s*(Task-\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (m) tasks.push({ id: m[1], deps: (m[5].match(/Task-\d+/g) ?? []) });
  }
  return tasks;
}

function defaultBranch() {
  for (const b of ['main', 'master']) if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null) return b;
  return null;
}

/** 既定ブランチのコミットのトレーラ Spec: F-NNN / Task-N を集める */
function doneTasks(branch) {
  const out = git(['log', branch, '--format=%B%x00']);
  if (out === null) return null;
  const done = new Set();
  for (const body of out.split('\0')) {
    for (const m of body.matchAll(/^Spec:\s*(F-\d+)\s*\/\s*(Task-\d+)\s*$/gm)) done.add(`${m[1]}/${m[2]}`);
  }
  return done;
}

/** 出荷の判定の基準にしない記録の置き場(判定記録と証跡)。ここだけを変えるコミットは、出荷の範囲の変更に数えない */
const SHIP_RECORD_PATHS = [/^docs\/gates\//, /^evidence\//];

/**
 * 出荷の範囲(最後のタグ..既定ブランチ。タグが無ければ既定ブランチの全体)のコミットのうち、記録の置き場の外を
 * 変えたもの。新しい順に { hash, at }。git を読めなければ null
 */
function shipChanges(lastTag, branch) {
  const out = git(['log', '--format=%x00%H%x09%cI', '--name-only', lastTag ? `${lastTag}..${branch}` : branch]);
  if (out === null) return null;
  const list = [];
  for (const chunk of out.split('\0').filter(Boolean)) {
    const [head, ...files] = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
    const [hash, at] = head.split('\t');
    // ファイルの変更を持たないコミット(マージなど)は数えない
    if (files.length && files.some((f) => !SHIP_RECORD_PATHS.some((re) => re.test(f)))) list.push({ hash, at });
  }
  return list;
}

function localBranches() {
  const out = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return out === null ? null : out.split('\n').filter(Boolean);
}

function cmd(command, reason, extra = {}) {
  return { kind: 'command', command, reason, ...extra };
}

// ---------------------------------------------------------------- 状態の導出

export function computeNext() {
  const result = { generatedAt: new Date().toISOString(), configured: null, summary: null, project: [], features: [], ship: [], notes: [], notSeen: [] };
  const cfgPath = path.join(ROOT, 'process.config.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    result.project.push({ kind: 'undetermined', stage: '構成', reason: `process.config.json を読めません(${e.message.split('\n')[0]})` });
    return result;
  }
  result.configured = config.configured !== false;
  if (!result.configured) {
    result.project.push({ stage: '構成が未設定', ...cmd('/process-init', 'プロセス構成が決まる前に実装を始めない。設問に答えると構成が生成される'), read: '.claude/skills/process-init/SKILL.md' });
    return result;
  }
  const al = config.answerLabels ?? {};
  // 用語の説明に使うゲートの名称(G-4 → G-4 機能仕様承認)
  result.gateLabels = Object.fromEntries(Object.entries(config.gates ?? {}).map(([k, v]) => [gateArg(k), v?.label ?? gateArg(k)]));
  result.summary = {
    team: al['q-team-size'] ?? null,
    phase: al['q-biz-phase'] ?? null,
    shipBlocked: config.shipBlocked?.reason ?? null,
    unmet: (config.unmet ?? []).map((u) => u.label),
    modes: Object.fromEntries((config.seats ?? []).map((s) => [s.role, MODE_LABEL[s.mode] ?? s.mode])),
  };
  const decider = structureDeciderSeat(config);
  const records = readGateRecords();
  const lock = readLock();

  // --- 案件の段階: D-0 → 任免 → D-0 の承認 → G-1 ---
  const d0 = path.join(ROOT, 'docs/D-0-governance.md');
  let projectBlocked = false;
  if (!fs.existsSync(d0)) {
    result.project.push({
      stage: 'D-0 体制図なし',
      ...cmd(
        'cp templates/00-d0-governance.md docs/D-0-governance.md && node scripts/init/generate-profile.mjs --answers process.config.json',
        'D-0 は規模によらず必須で、体制の変化点(/process-change)の前提。生成区間は構成から書き込まれる'
      ),
      read: READ.artifact('00-d0-governance'),
    });
    projectBlocked = true;
  } else {
    const seats = config.seats ?? [];
    const empty = seats.filter((s) => !s.accountable);
    if (empty.length === seats.length && seats.length) {
      result.project.push({
        stage: '席の責任者が未記入',
        kind: 'human-wait',
        what: `席の責任者の任免(${seats.length} 席。名簿と全席を1回の変化点で出す)`,
        seat: seatOf(config, decider),
        after: '人が氏名と記名を決めた後に `/process-change`(種別 accountable)で反映する。氏名を推測で埋めない',
        read: READ.change('accountable'),
        roles: [
          { role: decider, action: '名簿と席の責任者を決め、記名する(D-0 表1「体制と運用形態」の決定者)' },
          { role: 'ai-agent', action: '実行するコマンドはありません。決まった内容を受け取ってから /process-change で反映する' },
        ],
      });
      projectBlocked = true;
    } else {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/gate/check-d0.mjs')], { cwd: ROOT, encoding: 'utf8' });
      if (r.status !== 0) {
        const why = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').find((l) => /error|失敗|ありません|空|過ぎ/.test(l)) ?? 'check-d0 が失敗';
        result.project.push({
          stage: 'D-0 体制図が未承認または不備',
          kind: 'human-wait',
          what: 'D-0 体制図の記入と承認(frontmatter の承認者・承認日・見直し期限など)',
          seat: seatOf(config, decider),
          after: '人が記入・承認した後に `node scripts/gate/check-d0.mjs` で確かめる',
          detail: why.replace(/^::error::/, '').trim().slice(0, 200),
          read: READ.artifact('00-d0-governance'),
          roles: [
            { role: decider, action: 'D-0 の人が決める欄を記入し、承認する' },
            { role: 'ai-agent', action: '人が決める欄(承認者・決定者・閾値)を推測で埋めない。不備の一覧は check-d0 の出力' },
          ],
        });
        projectBlocked = true;
      }
    }
  }
  // D-0 節3 の手で書く行の空欄。段階を止めない(A-O1 の観測の材料であり、例外承認の決定者を引く表でもある)
  if (fs.existsSync(d0)) {
    // 例外承認の決定者は、基準を満たさないまま進めるときに最初に要るため、先に出す
    const blanks = d0DecisionBlanks(fs.readFileSync(d0, 'utf8')).sort((a, b) => (b === '例外承認') - (a === '例外承認'));
    if (blanks.length) {
      result.notes.push(
        `D-0 節3「決定の権限」の「決定」が空欄の行が ${blanks.length} 件(${blanks.slice(0, 4).join(' / ')}${blanks.length > 4 ? ' ほか' : ''})。` +
          '手で書く欄で、/process-change の種別は無い。記入しても version は上げない(版を上げるのは /process-change だけ)。決定者は人が決め、PR で入れる'
      );
    }
  }
  // 前提の台帳(テンプレ10)。全ゲート共通の通過条件の入力であり、最初のゲートの材料と同じ時点で作る。
  // 前提の崩れを理由に判定を止めない(第7章 7.10.1)ため、段階を止めない
  const ledgerStep = !projectBlocked && !fs.existsSync(path.join(ROOT, 'docs/assumptions.md'))
    ? {
        stage: '前提の台帳なし',
        ...cmd(
          'cp templates/10-assumption-ledger.md docs/assumptions.md',
          '全ゲート共通の通過条件(関係する前提の充足状態の記録)の入力。6行の観測した事象を、補助ファイルの「観測の手がかり」から書く。充足状態の確定と受容の決裁は人が行う'
        ),
        read: READ.artifact('10-assumption-ledger'),
      }
    : null;
  // 層1(品質保証の方針と受容の基準。テンプレ11。#288)。組織に1つ置き、G-1 で層2 を照らす先。無くても段階を止めない
  // (保証の主張の成立条件1 を満たさず、出荷が「品質保証の対象外」と出るだけ)。G-1 の材料と同じ時点で作成を案内する
  const policyMissing = !fs.existsSync(path.join(ROOT, 'docs/quality-assurance-policy.md'));
  const policyStep = policyMissing
    ? {
        stage: '層1(品質保証の方針と受容の基準)なし',
        ...cmd(
          'cp templates/11-quality-assurance-policy.md docs/quality-assurance-policy.md',
          '組織に1つ。5項目と記名はトップマネジメント(人)が書く。AI は欄を推測で埋めない。無いあいだも段階は止まらないが、出荷はすべて「品質保証の対象外」と出る'
        ),
        read: READ.artifact('11-quality-assurance-policy'),
      }
    : null;
  if (!projectBlocked && isGateActive(config, 'g1') && !passed(records, 'g1')) {
    const brief = path.join(ROOT, 'docs/project-brief.md');
    if (!fs.existsSync(brief)) {
      result.project.push({ stage: '企画書なし', ...cmd('cp templates/06-project-brief.md docs/project-brief.md', '企画承認(G-1)の審議の材料。観点1(戦略整合)・観点2(自社が勝てる理由)は人が書く。書いたら node scripts/gate/check-g1.mjs'), read: READ.artifact('06-project-brief') });
      if (ledgerStep) result.project.push(ledgerStep);
    } else {
      if (ledgerStep) result.project.push(ledgerStep);
      result.project.push({ stage: '企画承認(G-1)待ち', ...withIssues(gateWait(config, 'g1', null), recordIssues(records, 'g1')) });
    }
    if (policyStep) result.project.push(policyStep);
    projectBlocked = true;
  } else if (ledgerStep) {
    result.project.push(ledgerStep);
  }
  if (policyMissing && !result.project.includes(policyStep) && config.configured !== false) {
    result.notes.push(
      '層1(docs/quality-assurance-policy.md。品質保証の方針と受容の基準)が無い。出荷はすべて「品質保証の対象外」と出る(段階は止めない)。' +
        '作るなら cp templates/11-quality-assurance-policy.md docs/quality-assurance-policy.md。5項目と記名はトップマネジメントが書く(読む: .claude/skills/artifact/artifacts/11-quality-assurance-policy.md)'
    );
  }

  // 導入前の検証(標準 附属書I I.11)。採用を判断する時点の証拠。段階を止めない。記録が1件でもあれば案内しない
  const trialDir = path.join(ROOT, 'docs/adoption-trial');
  const trialRecords = fs.existsSync(trialDir) ? fs.readdirSync(trialDir).filter((f) => /^record-.*\.md$/.test(f)) : [];
  if (!trialRecords.length) {
    result.notes.push(
      `導入前の検証の記録が無い(採用を判断する時点の証拠。附属書I I.11)。${fs.existsSync(path.join(trialDir, 'criteria.md')) ? '合否の基準を採用者が書いてコミットした後に' : '採用者が node scripts/gate/adoption-trial.mjs init で合否の基準を写して書き、コミットした後に'} node scripts/gate/adoption-trial.mjs run(読む: ${READ.artifact('adoption-trial')})。基準と記入者は人が書く`
    );
  }

  // 技術判断者 = AI運用担当者(基準集合の範囲の起案と承認を別の自然人で行えない。標準 第3章 3.12.3 の要求事項10)。段階を止めない
  if (config.configured !== false) for (const n of seatPairingNotes(config)) result.notes.push(n);

  // 独立レビュー(G-6)の承認者の数と記録の書式(標準 第8章 軸C 規制業・軸E CL2/CL3)。2名の体制で1名の承認を「確認あり」と
  // 読まれないよう、注記として常に出す(#288 第5巡)。段階を止めない
  if (config.configured !== false && isGateActive(config, 'g6')) {
    const rc = reviewersRequiredOf(config);
    const n = rc.all;
    const audit = config.review?.recordFormat === 'audit';
    const safety = config.gates?.g6?.params?.independentSafetyAssessment === true;
    // コア機能の変更の承認者の数(第8章 軸C 高 coreReviewerCount。#288 第8巡 Z7)。パスの未宣言は確かめられない旨を出す
    const coreApplies = rc.coreDeclared && rc.core > n;
    const cp = coreApplies ? corePathsOf(config) : null;
    if (n >= 2 || audit || safety || coreApplies) {
      result.notes.push(
        `独立レビュー(G-6)は承認者 ${n} 名(構成 review.reviewerCount。名簿の別人が各自の挙動要約を書く。挙動要約は承認の語だけ(LGTM など)でなく、1〜2文(8文字以上)の本文)。` +
          (n >= 2 ? '1名の承認でマージした変更は、出荷の証跡の集約が「G-6 の承認者 1 名 / 要求 2 名」として独立した人の確認を経ていない変更に数える。G-5(pr-rules)はレビューを読めるとき承認者の数を出す(合否にしない)。' : '') +
          (coreApplies
            ? `**コア機能の独立レビューは ${rc.core} 名**(構成 gates.g6.params.coreReviewerCount。パス: ${cp.declared ? (cp.paths.length ? cp.paths.map((g) => `\`${g}\``).join(' ') : 'なし(宣言済み)') : '**未宣言。コア機能に当たる変更を確かめられない**。/process-change の種別 mode で delegation.protectedPaths を宣言するか、区分の下限の規則 riskFloor.rules のパスを置く'})。コア機能に触れる変更の承認者が ${rc.core} 名に満たなければ、G-5 が警告し、出荷の集約が「承認者 N 名 / 要求 ${rc.core} 名(コア機能)」として独立した人の確認を経ていない変更に数える。`
            : '') +
          (audit ? '判定記録は監査対応書式(構成 review.recordFormat: audit)。変更ごとに G-6 の判定記録を残し、「監査対応書式」の表(2人目の判定者・安全性の評価者)を埋める。PR の承認だけでは記録にならない。' : '') +
          (safety ? '独立した安全性の評価者(実装の責任者から組織的に独立。附属書F)の記名と記録の所在を判定記録に要する(構成 independentSafetyAssessment)。独立した安全性の評価の記録をリポジトリに置くなら docs/safety/(記録の置き場。製品の変更に数えない)。文書管理システムに置くなら、その識別子を判定記録の「安全性の評価の記録の所在」に書く。' : '') +
          `読む: ${READ.gate('g6')}`
      );
    }
  }

  // 変化点の後に失効・後継不在・未確認になったものを、担当の席への次の一手として出す(#288 第6巡 N)。
  // 第5巡の判定では、これらが出荷の直前の集約でしか現れず、「/pit → 出力に従う」の運用の形が閉じなかった。
  // 読むのは出荷の集約と同じ関数(org-assurance.mjs)。段階は止めない(注記)。要約・評価は足さない
  if (config.configured !== false && fs.existsSync(d0)) {
    for (const n of continuityNotes(config)) result.notes.push(n);
  }

  // --- 自己修正のロック ---
  if (lock?.state === 'held') {
    result.project.push({
      stage: '自己修正が保留',
      kind: 'human-wait',
      what: `受入基準へ戻るかの判断(${[lock.spec, lock.task].filter(Boolean).join(' / ') || '対象不明'}。理由: ${lock.reason ?? '—'})`,
      seat: seatOf(config, 'value-owner'),
      after: '人が判断した後に、人が `node scripts/gate/self-heal.mjs release --by "<氏名>"` で保留を解く',
      read: '.claude/skills/implement/SKILL.md',
      roles: [
        { role: 'value-owner', action: '失敗し続けている受入基準を見て、受入基準・分解を直すかを決める' },
        { role: 'ai-agent', action: '実行するコマンドはありません。テストを書き換えない。保留を自分で解かない' },
      ],
    });
  }

  // --- 機能ごと ---
  const specsDir = path.join(ROOT, 'specs');
  const fids = fs.existsSync(specsDir)
    ? fs.readdirSync(specsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^F-\d+$/.test(e.name)).map((e) => e.name).sort()
    : [];
  const branch = defaultBranch();
  const done = branch ? doneTasks(branch) : null;
  const branches = localBranches();
  let complete = 0;

  if (!fids.length && !projectBlocked) {
    result.features.push({ feature: null, stage: '機能仕様なし', ...cmd('/spec-write', '受入基準を確定せずに実装を始めない。最初の機能の受入基準を書く'), read: ['.claude/skills/spec-write/SKILL.md', READ.artifact('01-feature-spec')] });
  }
  for (const f of fids) {
    const F = (x) => result.features.push({ feature: f, ...x });
    if (projectBlocked) {
      F({ stage: '案件の段階を待つ', kind: 'human-wait', what: '案件の段階(上の「案件」)が先', seat: null, after: '案件の段階が進んだ後に、もう一度 next.mjs を実行する', roles: [] });
      continue;
    }
    const specP = path.join(specsDir, f, 'spec.md');
    const planP = path.join(specsDir, f, 'plan.md');
    if (!fs.existsSync(specP)) {
      F({ stage: '機能仕様なし', ...cmd(`/spec-write ${f}`, 'specs/' + f + '/spec.md がない'), read: ['.claude/skills/spec-write/SKILL.md', READ.artifact('01-feature-spec')] });
      continue;
    }
    const spec = fs.readFileSync(specP, 'utf8');
    if (criteriaCount(spec) === 0) {
      F({ stage: '受入基準なし', ...cmd(`/spec-write ${f}`, '「受入基準」の表に記入済みの行がない'), read: ['.claude/skills/spec-write/SKILL.md', READ.artifact('01-feature-spec')] });
      continue;
    }
    const lint = spawnSync(process.execPath, [path.join(ROOT, 'scripts/gate/spec-lint.mjs'), `specs/${f}`], { cwd: ROOT, encoding: 'utf8' });
    if (lint.status !== 0) {
      F({ stage: '受入基準に曖昧語', ...cmd(`/spec-write ${f}`, `spec-lint が検出した(node scripts/gate/spec-lint.mjs specs/${f})`), read: ['.claude/skills/spec-write/SKILL.md', READ.artifact('01-feature-spec')] });
      continue;
    }
    if (isGateActive(config, 'g2') && !passed(records, 'g2', f)) {
      F({ stage: '要件合意(G-2)待ち', ...withIssues(gateWait(config, 'g2', f), recordIssues(records, 'g2', f)) });
      continue;
    }
    if (!fs.existsSync(planP)) {
      F({ stage: '実装計画なし', ...cmd(`/task-breakdown ${f}`, 'specs/' + f + '/plan.md がない'), read: ['.claude/skills/task-breakdown/SKILL.md', READ.artifact('07-implementation-plan')] });
      continue;
    }
    const tasks = planTasks(fs.readFileSync(planP, 'utf8'));
    if (!tasks.length) {
      F({ stage: '実装計画にタスクなし', ...cmd(`/task-breakdown ${f}`, '「タスク」の表に Task-N の行がない'), read: ['.claude/skills/task-breakdown/SKILL.md', READ.artifact('07-implementation-plan')] });
      continue;
    }
    if (isGateActive(config, 'g4') && !passed(records, 'g4', f)) {
      F({ stage: '機能仕様承認(G-4)待ち', ...withIssues(gateWait(config, 'g4', f), recordIssues(records, 'g4', f)) });
      continue;
    }
    if (done === null || branches === null) {
      F({ stage: '実装', kind: 'undetermined', reason: 'git の履歴を読めないため、どのタスクが取り込まれたかを判定できない' });
      continue;
    }
    const remaining = tasks.filter((t) => !done.has(`${f}/${t.id}`));
    if (!remaining.length) {
      complete++;
      F({ stage: '実装済み(既定ブランチへ取り込み済み)', kind: 'done', reason: `${tasks.length} タスクすべてにトレーラ Spec: ${f} / Task-N のコミットがある` });
      continue;
    }
    if (lock && lock.state !== 'held' && lock.spec === f) {
      F({
        stage: `自己修正ループ中(${lock.task})`,
        ...cmd('node scripts/gate/self-heal.mjs iterate', `反復 ${lock.iterations ?? 0} / ${lock.max ?? '—'}。直したら反復を数える。テストが通ったら stop --reason pass、テストの修正を要するなら stop --reason test-change`),
        read: '.claude/skills/implement/SKILL.md',
      });
      continue;
    }
    const inProgress = remaining.filter((t) => branches.some((b) => b.toLowerCase().startsWith(`feature/${f.toLowerCase()}-${t.id.toLowerCase()}`)));
    if (inProgress.length) {
      const t = inProgress[0];
      F({
        stage: `実装中(${t.id})`,
        ...cmd(`/implement ${f} ${t.id}`, `ブランチ feature/${f}-${t.id.toLowerCase()} があり、既定ブランチにこのタスクのコミットがまだない。PR とレビューの状態は見ていない`),
        read: '.claude/skills/implement/SKILL.md',
        roles: [
          { role: 'dev-verifier', action: `/implement で ${t.id} を続け、Draft PR を出す` },
          ...(isGateActive(config, 'g6')
            ? [{ role: 'independent-reviewer', action: `PR が \`state:dev-done\` になったら G-6 を判定する(/human-verify で材料を集める${(config.review?.reviewerCount ?? 1) >= 2 ? `。承認者 ${config.review.reviewerCount} 名。各自が自分の挙動要約を書く` : ''}${config.review?.recordFormat === 'audit' ? '。判定記録は監査対応書式' : ''})` }]
            : []),
        ],
      });
      continue;
    }
    const ready = remaining.find((t) => t.deps.every((d) => done.has(`${f}/${d}`)));
    if (!ready) {
      F({ stage: '実装', kind: 'undetermined', reason: `残りのタスク(${remaining.map((t) => t.id).join(', ')})の依存が取り込まれていない。依存の記載を人が確かめる` });
      continue;
    }
    F({ stage: `実装前(${ready.id})`, ...cmd(`/implement ${f} ${ready.id}`, `${remaining.length} / ${tasks.length} タスクが未取り込み。依存が揃った最初のタスク`), read: '.claude/skills/implement/SKILL.md' });
  }

  // --- 出荷 ---
  if (complete && !projectBlocked) {
    if (config.shipBlocked) {
      result.ship.push({
        stage: '出荷できない状態',
        kind: 'human-wait',
        what: `出荷できない状態の解消(${config.shipBlocked.reason})`,
        seat: seatOf(config, decider),
        after: '体制を確保した後に `/process-change` で反映する',
        read: `${SKILL}/process-change/reference/dry-run.md`,
        roles: [{ role: 'ai-agent', action: '実行するコマンドはありません。出荷の手順を進めない' }],
      });
    } else {
      // 出荷の範囲は、最後のタグから既定ブランチの先頭まで。範囲の中の「変更」(判定記録と証跡だけのコミットを除く)の
      // 最後のコミットより後に判定された記録を、この出荷の判定に数える。判定記録を PR で取り込むと、その取り込みの
      // コミットが最後のコミットになるため、記録だけのコミットを基準にしない(#286)
      const lastTag = git(['describe', '--tags', '--abbrev=0', branch]);
      const changes = shipChanges(lastTag, branch);
      if (lastTag && changes !== null && !changes.length) {
        result.ship.push({ stage: `出荷済み(${lastTag})`, kind: 'done', reason: `タグ ${lastTag} より後に、判定記録と証跡のほかの変更がない。次の出荷は、変更を取り込んだ後に出る` });
        result.notSeen.push('PR・ラベル・CI の状態(ローカルの git だけを見ています)');
        return result;
      }
      const head = (changes?.[0]?.at ?? git(['log', '-1', '--format=%cI', branch]) ?? '').slice(0, 16).replace('T', ' ');
      const judgedAfter = (key) => records.some((r) => r.gate?.startsWith(key) && r.result === PASS && (r.judgedAt ?? '') >= head);
      if (isGateActive(config, 'g7') && !judgedAfter('G-7') && !fs.existsSync(path.join(ROOT, 'docs/handover.md'))) {
        // G-7 基準4。証跡の集約は引き継ぎ文書が無いことを欠落として扱うため、集約より先に作る
        result.ship.push({
          stage: '出荷前(運用引き継ぎ文書なし)',
          ...cmd('cp templates/05-handover.md docs/handover.md', '出荷判定(G-7)の判定対象(基準4)。監視項目・障害時の連絡先・復旧手順を書く。切り戻しは実行した実績のある経路だけを書く'),
          read: READ.artifact('05-handover'),
        });
      } else if (isGateActive(config, 'g7') && !judgedAfter('G-7')) {
        const from = lastTag ?? git(['rev-list', '--max-parents=0', branch])?.split('\n')[0]?.slice(0, 12) ?? '<起点>';
        result.ship.push({
          stage: '出荷前(証跡の集約)',
          ...cmd(`node scripts/gate/aggregate-evidence.mjs --from ${from} --to ${branch}`, `実装済みの機能が ${complete} 件。出荷の範囲の最後の変更(${head})より後の G-7 の判定記録がない。欠落があれば先に埋める`),
          then: withIssues(gateWait(config, 'g7', null), recordIssues(records, 'g7', null, head)),
          read: READ.gate('g7'),
        });
      } else if (isGateActive(config, 'g8') && !judgedAfter('G-8')) {
        result.ship.push({ stage: 'リリース決裁(G-8)待ち', ...withIssues(gateWait(config, 'g8', null), recordIssues(records, 'g8', null, head)) });
      } else {
        result.ship.push({
          stage: '出荷の実行',
          kind: 'human-wait',
          what: '出荷の実行(タグの push・本番への反映は取り消せない操作)',
          seat: seatOf(config, 'biz-approver'),
          after: '人が実行する',
          roles: [{ role: 'ai-agent', action: '実行するコマンドはありません。取り消せない操作を実行しない' }],
        });
      }
    }
  }
  result.notSeen.push('PR・ラベル・CI の状態(ローカルの git だけを見ています)');
  return result;
}

// ---------------------------------------------------------------- 変化点の後の注記(#288 第6巡 N・O・R・Q・⑦)

/** 席の表示(席名と責任者)。注記に担当の席を書くために使う */
function seatText(config, roleId) {
  const role = (config.roles ?? []).find((r) => r.id === roleId);
  const seat = (config.seats ?? []).find((s) => s.role === roleId);
  return `${role?.name ?? seat?.name ?? roleId}の席の責任者 ${seat?.accountable ? personName(config, seat.accountable) : '(未記入)'}`;
}

/**
 * 変化点の後に現れる失効・後継不在・依存先の欄の空欄・実環境の統制の未確認・席の責任者の力量の未確認を、
 * 担当の席と次に実行するものを添えて出す。出荷の集約(aggregate-evidence)と同じ関数で読む。読めないものは出さない
 */
function continuityNotes(config) {
  const notes = [];
  let policy;
  let ct;
  const today = localDay();
  try {
    policy = readPolicy(config, { today });
    ct = continuityState(config, policy, { day: today });
  } catch (e) {
    return [`層1・D-0 の読み取りに失敗したため、組織継続の状態の注記を出せない(${String(e.message).split('\n')[0]})`];
  }
  const authorityOf = (re) => {
    const row = (policy?.authority ?? []).find((r) => re.test(String(r.target ?? '').normalize('NFKC')));
    return row && row.role ? `層1 の項目4 の権限者(${row.role})` : '層1 の項目4 の権限者(行が空欄。層1 を先に埋める)';
  };
  const cont = `${READ.change('settings')}`;

  // 層1 項目4「AI の利用の拡大」の錠(委任の登録を認めない)と、構成の委任の登録の食い違い。委任の決定と承認が同一人物の記録(#288 第8巡 Y7)
  {
    const lock = policy?.delegationLock ?? { locked: false, unclear: false };
    const delegatedSeats = (config.seats ?? []).filter((s) => s.mode === 'delegated').map((s) => s.name);
    const rules = Array.isArray(config.delegation?.rules) ? config.delegation.rules.map((r) => r.id ?? '(id なし)') : [];
    if (lock.locked) {
      notes.push(
        `層1 項目4「AI の利用の拡大」の水準「${lock.level}」: 委任の登録は構成で拒否される(/process-change の種別 mode・performer が席の委任・規則・変更種別・規則の承認を受け付けない)。` +
          (delegatedSeats.length || rules.length
            ? `**構成に委任の登録が残っている**(${[delegatedSeats.length ? `委任の席: ${delegatedSeats.join(' / ')}` : null, rules.length ? `規則: ${rules.join(', ')}` : null].filter(Boolean).join('。')})。出荷の集約は記載の欠落にする。${seatText(config, 'biz-approver')}が種別 mode で席を協働へ戻し規則を削除する(厳しくする向き。記名不要。${READ.change('mode')})`
            : '委任を認めるには、層1 の記名者が水準を改めて版を上げる(体制の変化点)')
      );
    } else if (lock.unclear) {
      notes.push(`層1 項目4「AI の利用の拡大」の水準「${lock.level}」は語「認めない」を含むが、機械が読む形(欄の先頭が「認めない」)でないため、委任の登録の錠は掛かっていない。意図が「認めない」なら層1 の記名者が欄の先頭に「認めない」と書く(人が確かめる。${READ.artifact('11')})`);
    }
    const same = (config.changeLog ?? []).map((e, i) => ({ e, i })).filter(({ e }) => e?.ruleApproval?.samePersonAsDecider);
    if (same.length) {
      notes.push(
        `委任の規則の承認(AI維持管理者)が、委任を決定した者と同一人物の変化点: ${same.map(({ e, i }) => `changeLog[${i}](${String(e.date ?? '').slice(0, 10)}。承認 ${e.ruleApprovedBy})`).join(' / ')}。` +
          (config.answers?.['q-team-size'] === 'size-1-2' ? '1〜2名の体制では、どの席で判断したかの記録として受け付けている(第5章 5.5.7)' : '3名以上の体制でも、どの席で判断したかの記録として受け付けている(第5章 5.5.7、ADR-0057 S50)。別の人の AI維持管理者が承認し直す(種別 mode の ruleApprovedBy)まで、この印は出続ける')
      );
    }
  }

  // AI の層・人の層の検出率の失効(測定の記録 docs/adoption-trial/seeded-errors.json と現在の構成の比較)
  const seeded = readSeededRecord();
  if (seeded.value) {
    const ai = seeded.ai;
    if (ai && ai.blind === true) {
      const diffs = aiIdentityMismatch(config, ai);
      if (diffs && diffs.length) {
        notes.push(
          `AI の層の検出率の測定値が失効(測定した担い手の識別が現在と一致しない: ${diffs.join(' / ')})。出荷の集約は AI の層を未測定と出す。` +
            `${seatText(config, 'ai-ops')}が目隠しの欠陥注入の tally をやり直す(node scripts/gate/adoption-trial.mjs seal → tally。読む: ${READ.artifact('adoption-trial')})`
        );
      }
    }
    const hf = humanFinderState(config, policy, seeded.human);
    if (hf && hf.recorded) {
      if (hf.expired) {
        notes.push(
          `人の層の検出率の測定値が失効(${hf.why})。出荷の集約は人の層を未測定と出す。${seatText(config, 'ai-ops')}が、現在の独立レビュア(${seatText(config, 'independent-reviewer')}と名簿の2人目)を見つける者にして tally をやり直す(読む: ${READ.artifact('adoption-trial')})`
        );
      } else if (hf.notes.length) {
        notes.push(`人の層の検出率の測定値の注記: ${hf.notes.join('。')}。再測定の契機として ${seatText(config, 'ai-ops')}が判断する(層1 の「人の層の再測定の契機」を定めれば失効の規則になる)`);
      }
    }
  }

  // 組織継続の側の状態(単一障害点の一覧)のうち、受容が無い・期限切れのもの。状態ごとに担当の席と次の一手を添える
  const HINT = {
    代替の無い依存先: (s) => `${seatText(config, 'ai-ops')}が別の提供者での退出の予行を行い docs/exit-rehearsal.json へ記録する(読む: ${READ.artifact('11-quality-assurance-policy')})`,
    退出を試していない依存先: (s) => `${seatText(config, 'ai-ops')}が退出の予行(別の提供者での基準集合の回帰評価)を行い docs/exit-rehearsal.json へ記録する`,
    通知の期間またはデータが空欄の依存先: (s) => `${seatText(config, 'ai-ops')}が構成の dependencies[](提供者・通知の期間・データ)を \`/process-change\`(種別 settings)で記入する(読む: ${cont})`,
    縮退を確かめていない業務: (s) => `類型E の演習の実測を D-0 表7(節12 の縮退の3列)へ、実測の日とともに ${seatText(config, structureDeciderSeat(config))}が書く(読む: ${READ.artifact('00-d0-governance')})`,
    止める席: (s) => `AI が使えないときの扱いが「止める」。人へ戻せるなら \`/process-change\`(種別 performer の fallback)で改める`,
    後継不在の席: (s) => `育成の担当(${ct.cycle?.trainer ?? '層1 の欄が**空欄**。空欄のあいだ受容を更新できない'})が後継候補を力量の確認へ進めて D-0 節9 へ書くか、${authorityOf(/後継のいない|理解の保持者/)}が D-0 節15 で期限つきで受容する(読む: ${READ.artifact('00-d0-governance')})`,
    コア理解の保持者が1名以下: (s) => `本人以外の者が日付を付けて理解を確認した記録(H-3 など)を docs/handover.md の節2 へ ${seatText(config, 'tech-lead')}が足すか、${authorityOf(/後継のいない|理解の保持者/)}が D-0 節15 で受容する`,
    自組織に無い資産: (s) => `指示資産・基準集合を自組織のリポジトリへ置く(${seatText(config, 'ai-maintainer')})`,
  };
  const spof = (ct.spof ?? []).filter((s) => s.acceptance?.status !== 'accepted');
  for (const s of spof) {
    const acc = s.acceptance?.status === 'expired' ? `**受容の期限切れ**(${s.acceptance.until}。記載の欠落。出荷の集約が失敗する)` : s.acceptance?.status === 'invalid' ? `受容の記録が無効(${(s.acceptance.why ?? []).join('。')})` : '受容なし';
    const hint = HINT[s.state] ? HINT[s.state](s) : `${authorityOf(/代替の無い依存先/)}が解消するか D-0 節15 で受容する`;
    notes.push(`組織継続の状態「${s.state}: ${s.subject}」(${s.detail})。${acc}。次の一手: ${hint}`);
  }

  // 席の責任者本人の力量の確認(3.4.3 要求事項1)。未確認・失効を、席ごとに1つの注記へまとめて出す
  {
    const comp = competenceState(config, policy, { day: today });
    // 確認した者が名簿の外の記録(#288 第7巡 T)。受け付けたうえで注記し、内部監査の観点6(名簿の実在)へつなぐ
    const outside = comp.filter((c) => c.outsideRoster);
    if (outside.length) {
      notes.push(
        `席の責任者本人の力量の確認で、確認した者が名簿の外: ${outside.map((c) => `${c.seat}(${c.accountable})の確認した者 ${c.record.confirmedBy}(記録 ${c.record.record ?? '所在なし'})`).join(' / ')}。` +
          '受け付けている(外部の研修機関・前任の部門長などがあり得る)。名簿の外の名前は機械で突合できないため、確認の記録に所属・役職を書き、内部監査の観点6(名簿の実在)で突合する。D-0 節9 と出荷の集約の項目7 に「(名簿の外)」と出る'
      );
    }
    const bad = comp.filter((c) => c.status !== 'valid' && c.status !== 'no-accountable');
    if (bad.length) {
      const label = (c) => (c.status === 'expired' ? '**失効**' : c.status === 'cycle-blank' ? '有効性を判定できない' : '**未確認**');
      const cycleBlank = bad.some((c) => c.status === 'cycle-blank');
      notes.push(
        `席の責任者本人の AI を使わない力量の確認(3.4.3 要求事項1。任命時と層1 の周期): ${bad.map((c) => `${c.seat}(${c.accountable})${label(c)}(${c.why})`).join(' / ')}。` +
          (cycleBlank ? `層1 の「AI を使わない力量の確認の周期」を記名者が埋める(読む: ${READ.artifact('11-quality-assurance-policy')})。` : '') +
          `確認は本人以外の者が行い(AI を使っていない期間の成果物、または判定者の面前の演習。自己申告は認めない)、\`/process-change\`(種別 accountable。seats.<席>.competence に確認日・確認した者・記録の所在。決定者の記名は要らない)で構成へ書く。出荷の集約の項目7 に出続ける(読む: ${READ.change('accountable')})`
      );
    }
  }

  // 実環境の統制の確認(附属書I I.11 要件⑦)。未確認は消えない
  const env = readEnvCheck(config);
  if (!env.confirmed) {
    notes.push(
      `実環境の統制の確認(ルールセットの適用・PR のレビューの取得・ship-evidence の成果物): ${env.summary}。` +
        `${seatText(config, 'qa-gatekeeper')}または採用者が、実環境の gh で \`node scripts/gate/adoption-trial.mjs env-check --by <氏名>\` を実行し、記録 ${'docs/adoption-trial/env-check.json'} をコミットする。模擬の gh では「読めない」と出て未確認のまま残る(読む: ${READ.artifact('adoption-trial')})`
    );
  }

  // 10名以上の規則(第8章 軸A。#288 第6巡 Q)。構成の値が実行層で何を要するかを、名簿の所属の有無とともに出す
  if (config.answers?.['q-team-size'] === 'size-10plus') {
    const core = config.review?.mode === 'internal-plus-core-external';
    const qaMode = config.gates?.g7?.params?.approverMode === 'dedicated-qa';
    const teams = (config.people ?? []).some((p) => typeof p.team === 'string' && p.team.trim());
    const paths = Array.isArray(config.delegation?.protectedPaths);
    const parts = [];
    if (core) parts.push(`コア機能(確約範囲・コア指定のパス${paths ? '' : '。**未宣言**。/process-change の種別 mode で protectedPaths を宣言する'})の独立レビューに、作成を指示した者と別の所属の人を含める(構成 review.mode)`);
    if (qaMode) parts.push('出荷判定は QA 部門・専任者(構成 approverMode: dedicated-qa)');
    parts.push('機能責任者への仕様承認の委譲は機械で確かめない(台帳に「降りていない」と開示)');
    // 直近の出荷の集約の項目1 の件数(同じ文。#288 第7巡 U)。集約の出力が無ければ、件数は集約で読む旨だけを出す
    const agg = lastAggregate();
    const counts = [];
    if (agg?.independence) {
      if (core && agg.independence.coreReview) counts.push(`コア機能の独立レビューに別チームを含むか: ${coreReviewText(agg.independence.coreReview)}`);
      if (qaMode && agg.independence.qaAffiliation) counts.push(`出荷判定は QA 部門・専任者か: ${qaAffiliationText(agg.independence.qaAffiliation)}`);
    }
    const same = agg?.independence?.coreReview?.sameTeamOnly?.length ?? 0;
    const aggWhere = agg
      ? `直近の出荷の集約(${agg.range?.from ?? '起点なし'}..${agg.range?.to ?? '?'}${agg.generatedAt ? `、生成 ${agg.generatedAt.slice(0, 19)}` : ''}${agg.behind === null ? '' : agg.behind ? `。集約の後に ${agg.behind} コミット。件数は集約の時点のもの。出荷の前に集約し直す` : '。集約の後のコミットなし'})の項目1`
      : null;
    const countText = counts.length
      ? `。${aggWhere}: ${counts.join(' / ')}${same ? `。**同じ所属の承認者だけの変更 ${same} 件**(コア機能の独立レビューに別の所属の人を含める規則に外れる。欠落にはしない(第8章の表は手引き)。出荷判定者が判定記録の「人が判断する項目」に扱いを書く)` : ''}`
      : agg
        ? `。${aggWhere}に件数の行なし`
        : '。件数は出荷の集約の項目1 で読む(直近の集約の出力 evidence/evidence.json が手元に無い)';
    notes.push(`10名以上の規則: ${parts.join('。')}。${teams ? '名簿の所属(team)から出荷の集約が項目1 に判定を出す' : '名簿に所属(team)の欄が無く、出荷の集約は「判定できない」と出す。/process-change(種別 accountable)の people に team を書く'}${countText}`);
  }
  return notes;
}

// ---------------------------------------------------------------- 出力

function stepLine(s) {
  if (s.kind === 'command') return `[次のコマンド] ${s.command} — ${s.reason}`;
  if (s.kind === 'human-wait') {
    const seat = s.seat ? `待つ席: ${s.seat.name}${s.seat.labels.length ? ` / 受信箱 ${s.seat.labels.map((l) => `\`${l}\``).join(' ')}` : ''}` : '';
    return `[人の判断待ち] ${s.what}${seat ? ` — ${seat}` : ''}`;
  }
  if (s.kind === 'undetermined') return `[判定できない] ${s.reason}`;
  if (s.kind === 'done') return `[完了] ${s.reason}`;
  return '';
}

function renderFull(r, roleFilter = null) {
  const L = ['# 次の一手(scripts/gate/next.mjs。状態から機械が導出)', ''];
  if (r.summary) {
    L.push(`構成: ${r.summary.team ?? '—'} / ${r.summary.phase ?? '—'}。出荷できない状態: ${r.summary.shipBlocked ?? 'なし'}。未達: ${r.summary.unmet.join(' / ') || 'なし'}`);
    L.push('');
  }
  const block = (title, steps, label) => {
    if (!steps.length) return;
    L.push(`## ${title}`);
    for (const s of steps) {
      const roles = (s.roles ?? []).filter((x) => !roleFilter || x.role === roleFilter);
      L.push(`- ${label(s)}${s.stage}: ${stepLine(s)}`);
      if (s.after) L.push(`  - その後: ${s.after}`);
      if (s.detail) L.push(`  - 詳細: ${s.detail}`);
      if (s.then) L.push(`  - 続いて: ${stepLine(s.then)}`);
      if (s.then?.detail) L.push(`  - 詳細: ${s.then.detail}`);
      for (const x of roles) L.push(`  - ${x.role}: ${x.action}`);
      if (s.read) L.push(`  - 読む: ${[].concat(s.read).join(' / ')}`);
    }
    L.push('');
  };
  block('案件', r.project, () => '');
  block('機能', r.features, (s) => (s.feature ? `${s.feature} ` : ''));
  block('出荷', r.ship, () => '');
  if (r.notes?.length) {
    L.push('## 注記(段階を止めない)');
    for (const n of r.notes) L.push(`- ${n}`);
    L.push('');
  }
  const terms = glossaryFor(L.join('\n'), r.gateLabels ?? {});
  if (terms.length) {
    L.push('用語(この出力に出たもの):');
    for (const t of terms) L.push(`- ${t}`);
    L.push('');
  }
  if (r.notSeen.length) L.push(`見ていないもの: ${r.notSeen.join(' / ')}`);
  return L.join('\n');
}

/**
 * 初めて読む人が引っかかる用語の1行の説明(#286)。出力に現れた用語だけを出す。定義の正本は標準と
 * context/glossary.md であり、ここは読み進めるための要約に留める
 */
const TERMS = [
  [/席/, '席: 責任を持つ役割の枠。席ごとに責任者(人)を1人記名する。1人が複数の席を兼ねることがある'],
  [/責任者/, '責任者: 席の結果に責任を持つ人。AI を書かない。記入は任免(決定)であり、/process-change で反映する'],
  [/任免/, '任免: 席の責任者を決める(任命・交代・解任)こと'],
  [/D-0/, 'D-0 体制図: 誰がどの席の責任者で、何を誰が決めるかの記録(docs/D-0-governance.md)。規模によらず必須'],
  [/運用形態|人確定|協働|委任/, '運用形態: 席ごとに AI の担い手へ任せる度合い。人確定(人が行う)/ 協働(AI が起案し、人が変更ごとに確かめて確定する)/ 委任(定めた範囲の変更の検証を AI に任せ、人は事後に抜き取る)'],
  [/受信箱|state:/, '受信箱: 席ごとに見る Issue・PR のラベル(state:*)。人の判断待ちは、このラベルを付けて渡す'],
  [/判定記録|\/gate /, '判定記録: ゲートの判定を docs/gates/ へ残したもの。記録を作った時点で判定が成立する'],
  [/未達/, '未達: 体制などの都合で、目的を達成する構成を示せていないゲート。隠さずに構成書と出荷の証跡へ出る'],
  [/受入基準/, '受入基準: 機能が完成したと言える条件。「条件 + 期待動作」で書き、テストで確かめる'],
  [/自己修正/, '自己修正: テストが通るまで AI が実装を直す反復。上限に達すると止まり、人が受入基準へ戻るかを決める'],
  [/前提の台帳/, '前提の台帳: 標準が置く前提(A-T3・A-O3 など6つ)が成り立っているかを、観測した事象で記録する台帳(docs/assumptions.md)。全ゲート共通の通過条件の入力'],
  [/証跡の集約/, '証跡の集約: 出荷判定(G-7)の前に、記録の欠落を機械で洗い出すこと(aggregate-evidence.mjs)'],
  [/層1/, '層1: 組織が品質を保証すると主張するための最上位の文書(品質保証の方針と受容の基準。docs/quality-assurance-policy.md)。トップマネジメントが記名する。無くても進めるが、出荷は「品質保証の対象外」と出る'],
];

function glossaryFor(text, gateLabels) {
  const out = [];
  const gates = [...new Set(text.match(/G-\d/g) ?? [])].sort();
  if (gates.length) {
    const named = gates.map((g) => gateLabels[g] ?? g);
    out.push(`ゲート(${named.join(' / ')}): 先へ進む前に、決められた席の人(G-5 は機械)が判定して記録を残す関門`);
  }
  for (const [re, line] of TERMS) if (re.test(text)) out.push(line);
  return out;
}

const BRIEF_MAX = 6;

function renderBrief(r) {
  const L = ['[ピットイン] 次の一手(node scripts/gate/next.mjs。詳細は /pit)'];
  if (r.summary) {
    const flags = [r.summary.shipBlocked ? '出荷できない状態あり' : null, r.summary.unmet.length ? `未達 ${r.summary.unmet.length} 件` : null].filter(Boolean);
    L.push(`構成: ${r.summary.team ?? '—'} / ${r.summary.phase ?? '—'}${flags.length ? `。${flags.join('。')}` : ''}`);
  }
  const all = [...r.project, ...r.features, ...r.ship];
  for (const s of all.slice(0, BRIEF_MAX)) {
    L.push(`- ${s.feature ? `${s.feature} ` : ''}${s.stage}: ${stepLine(s)}`);
    // 通過に数えなかった判定記録は、所在だけを添える(理由は /pit の全文)
    const issues = s.recordIssues ?? s.then?.recordIssues ?? [];
    if (issues.length) L.push(`  - 通過に数えなかった記録: ${issues.map((x) => x.match(/docs\/gates\/\S+?\.md/)?.[0]).filter(Boolean).join(' / ')}(理由は node scripts/gate/next.mjs)`);
  }
  if (all.length > BRIEF_MAX) L.push(`- ほか ${all.length - BRIEF_MAX} 件(node scripts/gate/next.mjs)`);
  if (r.notes?.length) L.push(`- 注記 ${r.notes.length} 件(段階を止めない。node scripts/gate/next.mjs)`);
  L.push('人の判断待ちは終端です。AI の担い手はコマンドを実行せず、待つ席へ受信箱のラベルで渡します。');
  return L.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--scopes')) {
    console.log(renderClauseScopes());
    process.exit(0);
  }
  const r = computeNext();
  const ri = argv.indexOf('--role');
  if (ri >= 0) {
    const roleId = argv[ri + 1];
    let config = null;
    try {
      config = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
    } catch {
      /* 下で扱う */
    }
    const card = config && config.configured !== false ? renderRoleCard(config, roleId) : null;
    if (!card) {
      const ids = (config?.roles ?? []).map((x) => x.id).join(' / ');
      console.error(`[next] ロール "${roleId ?? ''}" が構成にありません。${ids ? `ロール: ${ids}` : '構成が未設定です(/process-init)'}`);
      process.exit(2);
    }
    console.log(card);
    console.log('');
    console.log('### エスカレーションの段階とラベル');
    console.log('');
    console.log(renderEscalation());
    console.log('');
    console.log(renderFull(r, roleId));
    process.exit(0);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (argv.includes('--brief')) console.log(renderBrief(r));
  else console.log(renderFull(r));
}

if (isMain) {
  try {
    main();
  } catch (e) {
    // セッションの開始時(--brief)は、失敗しても何も注入せずに終える。推測の状態を文脈へ入れない
    if (process.argv.includes('--brief')) process.exit(0);
    console.error(`[next] 判定できない: ${e.message}`);
    process.exit(1);
  }
}

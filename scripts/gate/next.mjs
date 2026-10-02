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
import { ROOT, isGateActive, readGateRecords, personName, structureDeciderSeat, MODE_LABEL } from './config.mjs';
import { readLock } from './self-heal.mjs';
import { MAILBOX, renderRoleCard, renderClauseScopes, renderEscalation } from '../init/generate-profile.mjs';

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
  if (!projectBlocked && isGateActive(config, 'g1') && !passed(records, 'g1')) {
    const brief = path.join(ROOT, 'docs/project-brief.md');
    if (!fs.existsSync(brief)) {
      result.project.push({ stage: '企画書なし', ...cmd('cp templates/06-project-brief.md docs/project-brief.md', '企画承認(G-1)の審議の材料。観点1(戦略整合)・観点2(自社が勝てる理由)は人が書く。書いたら node scripts/gate/check-g1.mjs'), read: READ.artifact('06-project-brief') });
      if (ledgerStep) result.project.push(ledgerStep);
    } else {
      if (ledgerStep) result.project.push(ledgerStep);
      result.project.push({ stage: '企画承認(G-1)待ち', ...withIssues(gateWait(config, 'g1', null), recordIssues(records, 'g1')) });
    }
    projectBlocked = true;
  } else if (ledgerStep) {
    result.project.push(ledgerStep);
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
          ...(isGateActive(config, 'g6') ? [{ role: 'independent-reviewer', action: 'PR が `state:dev-done` になったら G-6 を判定する(/human-verify で材料を集める)' }] : []),
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

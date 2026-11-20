// 出荷の範囲に、欠陥注入の標識が残っていないかを走査する(標準 第5章 5.6.2 の第3層・第4層。process-compass #356 / IMPL-0047・IMPL-0192)
//
//   node scripts/gate/seeded-error-scan.mjs [--from <起点のタグ>] [--to <終点のタグ>] [--ledger <リポジトリの外の台帳の所在>] [--out <記録の所在>]
//
// 検査:
//   1. 範囲(起点の次から終点まで。起点が無ければ根から)の全コミットの本文(%B)に、行頭の空白を許した標識の行 `Seeded-Error:` があれば失敗。
//      トレーラの解析だけには頼らない(squash で件名と本文が組み替わると、トレーラとして0件になる)
//   2. 台帳を渡したときだけ、キー id・expiresAt・reclaimedAt の3つを読む。未回収の識別子が範囲の差分にある、または
//      期限を超えた未回収がある場合に失敗。台帳はリポジトリの外に置く(リポジトリの中の台帳は識別子が流出する)。
//      渡さなければ「台帳と照合していない」と記録に出す(失敗にしない)
//   3. 記録 evidence/seeded-error-scan.json を、失敗のときも書く。集約(aggregate-evidence.mjs)がこれを読み、欠落・scanRun が true でない・failures がある・
//      residual が 0 でない・範囲が合わない、のいずれかで出荷を失敗させる
//
// 限界(記録にも書く): 標識の残存がないことだけを示す。手で写した変更・標識の形を変えた注入・GitHub 上で文を書き換えた squash・リポジトリの squash の既定の文の設定(PR の題だけ等)は、
// この走査では拾えない。「流出がない」とは記録しない(標準 5.6.2: 4層あっても流出しないとは記録してはならない)。
// PR の検査(check-pr.mjs)が、取り込みの前の拒否(IMPL-0191。process-compass #356)のために、同じ判定の関数 markerCommitsInRange と失敗の文 PR_MARKER_HINT を import する。標識の判定は hasMarker の1か所に置く。
// 標識の文字列は下の定数1か所に置く。標識の形が変わるとき(標識の可視性と秘匿の審議。#356 B)は、ここだけを直す。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 標識の文字列(1か所の定数) */
export const MARKER = 'Seeded-Error:';
const MARKER_LINE = new RegExp(`^[ \\t]*${MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'im');

export const SCAN_FILE = 'evidence/seeded-error-scan.json';
export const STATEMENT = '標識の残存なし(手で写した変更は走査の対象外)';
export const STATEMENT_FAILED = '走査が成立していない(理由は failures)';
export const STATEMENT_FOUND ='標識の残存あり';
export const LEDGER_OFF = '台帳と照合していない';
export const FALSE_POSITIVE_HINT = `標識の文字列を本文に含むコミットは、本文から語を外すか、第7章の例外承認で受ける`;
// PR の取り込み前の検査の失敗の文。PR の時点は PR のブランチで文を直せるため、例外承認を案内しない(出荷の走査は本番の履歴に入った後で直せないので案内する)
export const PR_MARKER_HINT = `注入したコミットは既定ブランチへ取り込みません(第5章 5.6.2 第2層。第7章の例外承認では受けない)。説明のために語を書いたコミットなら、PR のブランチでその行を本文から外します。注入したコミットの標識は外しません(演習の変更は演習用のブランチで閉じる)`;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** 本文に標識の行があるか */
export function hasMarker(body) {
  return MARKER_LINE.test(String(body ?? '').replace(/\r\n/g, '\n'));
}

/** 範囲(git log の spec)のコミットのうち、本文に標識の行があるものの SHA の配列。読めなければ null。浅い clone の検査は呼ぶ側が決める */
export function markerCommitsInRange(cwd, spec) {
  const log = git(cwd, ['log', '--format=%x1e%H%x1f%B', spec]);
  if (log === null) return null;
  return parseLog(log).filter((c) => hasMarker(c.body)).map((c) => c.sha);
}

function parseLog(log) {
  return log.split('').filter((s) => s.trim() !== '').map((s) => {
    const i = s.indexOf('');
    return { sha: s.slice(0, i).trim(), body: s.slice(i + 1) };
  });
}

/** 台帳(JSON。配列、または entries / ledger の配列)を読む。id・expiresAt・reclaimedAt だけを使う */
export function readLedger(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : Array.isArray(raw?.ledger) ? raw.ledger : null;
  if (!list) throw new Error('台帳が配列(または entries / ledger の配列)ではない');
  return list.map((e) => ({ id: e?.id == null ? '' : String(e.id), expiresAt: e?.expiresAt ?? null, reclaimedAt: e?.reclaimedAt ?? null }));
}

/**
 * 走査する。失敗の理由は problems、記録は record。
 * @param {{cwd?:string, from?:string, to?:string, ledger?:string|null, now?:Date}} o
 */
export function scan({ cwd = process.cwd(), from, to, ledger = null, now = new Date() } = {}) {
  const problems = [];
  const toRef = to || (git(cwd, ['describe', '--tags', '--abbrev=0'])?.trim() || 'HEAD');
  const fromRef = from ?? (git(cwd, ['describe', '--tags', '--abbrev=0', `${toRef}^`])?.trim() || '');
  const toSha = git(cwd, ['rev-parse', '--verify', '--quiet', `${toRef}^{commit}`])?.trim() || null;
  const fromSha = fromRef ? git(cwd, ['rev-parse', '--verify', '--quiet', `${fromRef}^{commit}`])?.trim() || null : null;
  const record = {
    scanRun: false,
    residual: null,
    ledgerChecked: false,
    range: { from: fromRef || null, to: toRef, fromSha, toSha },
    scannedAt: now.toISOString(),
    commitsScanned: 0,
    markerCommits: [],
    ledgerFindings: [],
    failures: [],
    statement: null,
    ledgerNote: LEDGER_OFF,
    limits: '標識の残存がないことだけを示す。手で写した変更・標識の形を変えた注入・GitHub 上で文を書き換えた squash・リポジトリの squash の既定の文の設定(PR の題だけ等)で標識が消える経路は拾えない。台帳を渡したのに読めない・浅い clone のときは走査を成立させず(scanRun false・failures)、集約が失敗にする。流出がないとは記録しない',
  };
  if (!toSha) {
    problems.push(`終点 ${toRef} を読めません`);
    return { record, problems };
  }
  if (fromRef && !fromSha) {
    problems.push(`起点 ${fromRef} を読めません`);
    return { record, problems };
  }
  if (git(cwd, ['rev-parse', '--is-shallow-repository'])?.trim() === 'true') {
    problems.push('浅い clone です。範囲の全コミットを走査できません(fetch-depth: 0 で取得します)');
    record.failures = [...problems];
    record.statement = STATEMENT_FAILED;
    return { record, problems };
  }
  const spec = fromSha ? `${fromSha}..${toSha}` : toSha;
  const log = git(cwd, ['log', '--format=%x1e%H%x1f%B', spec]);
  if (log === null) {
    problems.push(`範囲 ${spec} のコミットを読めません`);
    return { record, problems };
  }
  const commits = parseLog(log);
  record.commitsScanned = commits.length;
  record.markerCommits = commits.filter((c) => hasMarker(c.body)).map((c) => c.sha);
  for (const sha of record.markerCommits) problems.push(`コミット ${sha.slice(0, 12)} の本文に標識 ${MARKER} があります。${FALSE_POSITIVE_HINT}`);

  let ledgerBroken = false;
  if (ledger) {
    const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
    const abs = path.resolve(ledger);
    const rel = top ? path.relative(path.resolve(top), abs) : '';
    if (top && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      problems.push(`台帳 ${ledger} がリポジトリの中にあります。台帳はリポジトリの外に置きます(識別子が流出します)`);
      ledgerBroken = true;
    } else {
      try {
        const entries = readLedger(abs);
        const diffRaw = git(cwd, ['diff', fromSha ?? EMPTY_TREE, toSha]);
        if (diffRaw === null) throw new Error('範囲の差分を読めません');
        // 追加の行だけを、語の境界で照合する(ハンクの見出しや SE-1 と SE-10 の部分一致を避ける)
        const added = diffRaw.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
        const today = now.toISOString().slice(0, 10);
        for (const e of entries) {
          if (e.reclaimedAt) continue;
          if (!e.id) {
            record.ledgerFindings.push({ id: '', reason: '識別子が空の未回収の行' });
            continue;
          }
          if (new RegExp(`(?<![A-Za-z0-9])${e.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(added)) record.ledgerFindings.push({ id: e.id, reason: '未回収の識別子が範囲の差分にある' });
          const exp = String(e.expiresAt ?? '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) record.ledgerFindings.push({ id: e.id, reason: 'expiresAt が日付でない未回収の行' });
          else if (exp < today) record.ledgerFindings.push({ id: e.id, reason: `期限(${exp})を超えた未回収` });
        }
        record.ledgerChecked = true;
        record.ledgerNote = `台帳と照合した(${entries.length} 件。内容の十分性は確かめない)`;
        for (const f of record.ledgerFindings) problems.push(`台帳 ${f.id || '(識別子なし)'}: ${f.reason}`);
      } catch (e) {
        problems.push(`台帳を読めません: ${e.message}`);
        ledgerBroken = true;
      }
    }
  }
  // 台帳を渡したのに読めない・解けないときは、走査を成立させない(記録を「残存なし」で残さない)
  if (ledgerBroken) {
    record.failures = [...problems];
    record.statement = STATEMENT_FAILED;
    return { record, problems };
  }
  record.scanRun = true;
  record.residual = record.markerCommits.length + record.ledgerFindings.length;
  record.statement = record.residual === 0 ? STATEMENT : STATEMENT_FOUND;
  return { record, problems };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const out = arg('--out') ?? SCAN_FILE;
  const { record, problems } = scan({ from: arg('--from'), to: arg('--to'), ledger: arg('--ledger') ?? null });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), JSON.stringify(record, null, 2) + '\n', 'utf8');
  console.log(`走査: ${record.range.from ?? '(根)'}..${record.range.to} のコミット ${record.commitsScanned} 件。${record.statement ?? '走査できていない'}。${record.ledgerNote}`);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
}

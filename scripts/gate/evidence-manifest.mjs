// 出荷の証跡の一式の digest の一覧(manifest.json)を作り、検査する(process-compass #333 / ADR-0135)
//
//   node scripts/gate/evidence-manifest.mjs write    --dir <置き場> --run <実行の識別>
//   node scripts/gate/evidence-manifest.mjs verify   --dir <置き場>
//   node scripts/gate/evidence-manifest.mjs previous --root <docs/evidence> --out <evidence/previous> [--artifact ok|failed|none] [--run <前回の実行>] [--source-file <evidence/previous-source.json>]
//
// ship-evidence ワークフローが、出荷の PR で基底ブランチ(docs/evidence/<日付>-<範囲>/)へ運ぶ証跡の一式に、
// ファイルごとの sha256 を並べた一覧を添える。一覧は、組織が定める保管へ引き渡すときの降ろし口を兼ねる。
// **これはリポジトリへの写しであり、組織が定める保管期間の充足を示さない**(標準 第4章「判定が指す記録の保管」。IMPL-0243 は採用者が実装する)。
// digest の一覧が示すのは、置き場の中の自己整合(中身と一覧の一致)だけである。ワークフローが出した一式であることは示さず、
// 出荷の PR へ入る前の差し替え(中身と一覧を揃えた書き換え)は検出しない。一覧の range・target は、同じ置き場の evidence.json(集約の出力)から取る。
// 書き込みの権限を持つ者の変更は防がず、履歴に残る。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_NOTE = 'リポジトリへの写し。組織が定める保管期間の充足は示さない';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 置き場の下のファイル(manifest 自身を除く)を、置き場からの相対パス(/ 区切り)で昇順に返す */
export function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (r !== MANIFEST_NAME) out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
}

/** 集約の出力(evidence.json)が持つ実際の範囲と終点のコミット。読めなければ両方 null(推定で埋めない) */
export function rangeFromEvidence(dir) {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
    const r = e?.range;
    if (!r || !r.to) return { range: null, target: null };
    return { range: `${r.from || 'start'}..${r.to}`, target: r.toCommit ?? null };
  } catch {
    return { range: null, target: null };
  }
}

/** manifest を作って置き場へ書く。書いた内容を返す。range・target は置き場の evidence.json から取る */
export function writeManifest({ dir, run, now = new Date() }) {
  const { range, target } = rangeFromEvidence(dir);
  const files = listFiles(dir).map((p) => {
    const buf = fs.readFileSync(path.join(dir, p));
    return { path: p, sha256: sha256(buf), bytes: buf.length };
  });
  let inputs = null;
  const ip = path.join(dir, 'inputs.json');
  if (fs.existsSync(ip)) {
    try {
      inputs = JSON.parse(fs.readFileSync(ip, 'utf8'));
    } catch {
      inputs = null;
    }
  }
  const manifest = {
    schemaVersion: 1,
    range: range ?? null,
    target: target ?? null,
    recordedAt: now.toISOString(),
    run: run ?? null,
    inputs,
    files,
    note: MANIFEST_NOTE,
  };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** 置き場を manifest に照らす。不一致の一覧を返す(空なら適合) */
export function verifyManifest(dir) {
  const problems = [];
  const mp = path.join(dir, MANIFEST_NAME);
  if (!fs.existsSync(mp)) return [`${MANIFEST_NAME} がありません`];
  let m;
  try {
    m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  } catch (e) {
    return [`${MANIFEST_NAME} を読めません(${e.message})`];
  }
  if (!Array.isArray(m.files)) return [`${MANIFEST_NAME} に files がありません`];
  const listed = new Set();
  for (const f of m.files) {
    listed.add(f.path);
    const fp = path.join(dir, f.path);
    if (!fs.existsSync(fp)) {
      problems.push(`${f.path}: 一覧にあるがファイルがありません`);
      continue;
    }
    const buf = fs.readFileSync(fp);
    if (sha256(buf) !== f.sha256) problems.push(`${f.path}: sha256 が一覧と一致しません`);
    else if (buf.length !== f.bytes) problems.push(`${f.path}: バイト数が一覧と一致しません`);
  }
  for (const p of listFiles(dir)) if (!listed.has(p)) problems.push(`${p}: ファイルがあるが一覧にありません`);
  return problems;
}

/**
 * 前回の証跡を、基底ブランチの写し(root の下の各置き場)から選ぶ。置き場ごとに digest の一覧と照合し、一致して evidence.json を持つもののうち
 * recordedAt が最も新しいものを out へ複製する。一致しない・読めない置き場は読まず、理由を looked に残す(黙って古い側へ進まない)。
 * 返す値は集約の出力へ出す「どこを見たか」。一覧は自己整合しか示さない(verifyManifest の注記)ので、これは改ざんの検出ではない
 */
export function selectPreviousFromCopies(root, out) {
  const looked = [];
  if (fs.existsSync(root)) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(root, e.name);
      if (!fs.existsSync(path.join(d, MANIFEST_NAME))) continue;
      const problems = verifyManifest(d);
      let recordedAt = null;
      try {
        recordedAt = JSON.parse(fs.readFileSync(path.join(d, MANIFEST_NAME), 'utf8')).recordedAt ?? null;
      } catch {
        recordedAt = null;
      }
      if (!problems.length && !recordedAt) problems.push('recordedAt がありません');
      if (!problems.length && !fs.existsSync(path.join(d, 'evidence.json'))) problems.push('evidence.json がありません');
      looked.push({ dir: e.name, recordedAt, ok: problems.length === 0, problems });
    }
  }
  const usable = looked.filter((l) => l.ok).sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0));
  const used = usable[0] ?? null;
  if (used) {
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(root, used.dir, 'evidence.json'), path.join(out, 'evidence.json'));
  }
  return { used: used ? used.dir : null, looked };
}

/**
 * ship-evidence.yml の本文を読み、写しの経路の文字列の欠けを返す(空なら適合)。これは文字列の確認であり、手順が動くことの確認ではない
 * (動作は test-ship-evidence-steps.mjs が手順の本文を取り出して動かす)。
 * (a) 成果物 ship-evidence に retention-days を明示していない(リポジトリの保持の設定に従う一時置き。保管ではない)
 * (b) 一式を docs/evidence/ へ写す手順がある (c) verify ジョブが changes(一式の検査)を呼ぶ
 * (d) coverage-result を取り込み、実行の headSha と対象のコミットを照らす
 * (e) 前回の証跡を、成果物を取れないときは基底ブランチの写し(evidence-manifest.mjs previous)から読む
 */
export function workflowProblems(text) {
  const problems = [];
  const t = String(text ?? '');
  const steps = t.split(/^ {6}- /m);
  const upload = steps.find((s) => /uses:\s*actions\/upload-artifact/.test(s) && /^\s+name:\s*ship-evidence\s*$/m.test(s));
  if (!upload) problems.push('成果物 ship-evidence の upload-artifact がありません');
  else if (/^\s+retention-days:\s*\d+/m.test(upload)) problems.push('成果物 ship-evidence に retention-days を明示しています(明示するとリポジトリの設定より短くなりうる。一時置きとして設定に従う)');
  if (!/evidence-manifest\.mjs write/.test(t)) problems.push('一式を docs/evidence/ へ写す手順(evidence-manifest.mjs write)がありません');
  if (!/git add -f "\$bundle"/.test(t)) problems.push('写した一式を出荷のブランチへ git add する手順がありません(文字列の確認。一式が PR に無いことは verify の検査が失敗にする)');
  const verifyIdx =t.search(/^ {2}verify:\s*$/m);
  if (verifyIdx < 0 || !/node scripts\/gate\/evidence-manifest\.mjs changes --changes/.test(t.slice(verifyIdx))) problems.push('verify ジョブが evidence-manifest.mjs changes(一式の検査)を呼んでいません');
  if (!/--name coverage-result/.test(t)) problems.push('coverage-result の取り込みがありません');
  if (!/--json headSha/.test(t)) problems.push('取り込む実行の headSha と対象のコミットを照らす手順がありません');
  if (!/evidence-manifest\.mjs previous/.test(t)) problems.push('前回の証跡を基底ブランチの写し(evidence-manifest.mjs previous)から読む手順がありません');
  return problems;
}

/**
 * ship-evidence.yml の verify ジョブが、docs/evidence/ の変更(git diff --name-status の行)に対して出す失敗の一覧。
 * 追加以外の変更・出荷の PR 以外が足した一式・出荷の PR の一式の欠け(置き場に evidence.json と manifest.json が無い)・digest の不一致を返す。
 * 空なら適合。ワークフローの case と同じ規則を、入力と出力で確かめられるようにしたもの(ワークフローの case とこの関数の一致は、
 * test-evidence-manifest.mjs が case の本文の存在で確かめる)。
 * @param {{changes: Array<{status: string, path: string}>, ship: boolean, bundleDir: (d: string) => string}} a bundleDir は置き場(docs/evidence/<名>)の実体の場所
 */
export function evidenceChangeProblems({ changes, ship, bundleDir }) {
  const fails = [];
  const dirs = new Set();
  for (const c of changes) {
    if (!c.path.startsWith('docs/evidence/')) continue;
    if (c.status !== 'A') {
      fails.push(`${c.path}: 追加以外の変更(${c.status})。記録の置き場のファイルは書き換えない`);
      continue;
    }
    const m = c.path.match(/^docs\/evidence\/([^/]+)\/[^/]/);
    if (!m) continue;
    if (!ship) {
      fails.push(`${c.path}: 証跡の一式を運ぶのは出荷の PR(ship/<日付>)だけ`);
      continue;
    }
    dirs.add(`docs/evidence/${m[1]}`);
  }
  if (ship && dirs.size === 0) fails.push('出荷の PR に証跡の一式(docs/evidence/<日付>-<範囲>/)がありません(一式の欠け)');
  for (const d of dirs) {
    const real = bundleDir(d);
    for (const need of ['evidence.json', MANIFEST_NAME]) if (!fs.existsSync(path.join(real, need))) fails.push(`${d}: 出荷の PR の一式に ${need} がありません(一式の欠け)`);
    const problems = verifyManifest(real);
    if (problems.length) fails.push(`${d}: digest の一覧と一致しない(${problems.join(' ')})`);
  }
  return fails;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const arg = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  if (cmd === 'previous') {
    const root = arg('--root');
    const out = arg('--out');
    if (!root || !out) {
      console.error('使い方: evidence-manifest.mjs previous --root <docs/evidence> --out <evidence/previous> [--artifact ok|failed|none] [--run <実行>] [--source-file <出力先>]');
      return 2;
    }
    const artifact = arg('--artifact') ?? 'none';
    const run = arg('--run');
    const r = artifact === 'ok' ? { used: null, looked: [] } : selectPreviousFromCopies(root, out);
    const source = artifact === 'ok' ? 'artifact' : r.used ? 'copy' : 'none';
    const info = { source, artifact: { status: artifact, run: run ?? null }, copies: { root, used: r.used, looked: r.looked } };
    const sf = arg('--source-file');
    if (sf) {
      fs.mkdirSync(path.dirname(sf), { recursive: true });
      fs.writeFileSync(sf, `${JSON.stringify(info, null, 2)}
`);
    }
    if (source === 'artifact') console.log(`::notice::前回の証跡を、実行 ${run ?? '?'} の成果物から読みました`);
    else if (source === 'copy') {
      console.log(`::notice::前回の証跡を、成果物(${artifact === 'failed' ? `実行 ${run} から取得できず` : '前回の実行なし'})ではなくリポジトリの写し(${root}/${r.used})から読みました`);
      for (const l of r.looked.filter((x) => !x.ok)) console.log(`::warning::前回の証跡の候補 ${root}/${l.dir} は読みませんでした(${l.problems.join(' ')})`);
    }
    else {
      const bad = r.looked.filter((l) => !l.ok);
      console.log(`::warning::前回の証跡を読めません。成果物: ${artifact === 'failed' ? `実行 ${run} から取得できず` : '前回の実行なし'}。写し: ${root} の置き場 ${r.looked.length} 件を見て、読めるものがありません${bad.length ? `(読まなかった理由: ${bad.map((l) => `${l.dir} ${l.problems.join(' ')}`).join(' / ')})` : ''}`);
    }
    return 0;
  }
  if (cmd === 'changes') {
    const file = arg('--changes');
    const prRoot = arg('--pr-root');
    if (!file || !prRoot) {
      console.error('使い方: evidence-manifest.mjs changes --changes <git diff --name-status の出力> --pr-root <PR の側の docs の展開先> --ship true|false');
      return 2;
    }
    const changes = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [status, p] = l.split('\t');
        return { status, path: p };
      });
    const fails = evidenceChangeProblems({ changes, ship: arg('--ship') === 'true', bundleDir: (d) => path.join(prRoot, d) });
    for (const f of fails) console.log(f);
    return fails.length ? 1 : 0;
  }
  const dir = arg('--dir');
  if (!dir || !['write', 'verify'].includes(cmd)) {
    console.error('使い方: evidence-manifest.mjs write|verify --dir <置き場> [--run] / previous --root --out');
    return 2;
  }
  if (cmd === 'write') {
    const m = writeManifest({ dir, run: arg('--run') });
    console.log(`${dir}/${MANIFEST_NAME}: ${m.files.length} 件の digest を書きました(範囲 ${m.range ?? '不明'}、対象 ${m.target ?? '不明'})`);
    return 0;
  }
  const problems = verifyManifest(dir);
  if (problems.length) {
    for (const p of problems) console.error(`::error::${dir}: ${p}`);
    return 1;
  }
  console.log(`${dir}: digest の一覧と一致`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));

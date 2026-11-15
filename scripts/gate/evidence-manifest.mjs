// 出荷の証跡の一式の digest の一覧(manifest.json)を作り、検査する(process-compass #333 / ADR-0135)
//
//   node scripts/gate/evidence-manifest.mjs write  --dir <置き場> --run <実行の識別> --target <対象のコミット> --range <範囲>
//   node scripts/gate/evidence-manifest.mjs verify --dir <置き場>
//
// ship-evidence ワークフローが、出荷の PR で基底ブランチ(docs/evidence/<日付>-<範囲>/)へ運ぶ証跡の一式に、
// ファイルごとの sha256 を並べた一覧を添える。一覧は、組織が定める保管へ引き渡すときの降ろし口を兼ねる。
// **これはリポジトリへの写しであり、組織が定める保管期間の充足を示さない**(標準 第4章「判定が指す記録の保管」。IMPL-0243 は採用者が実装する)。
// 機械が確かめるのは、写しの存在・digest の一致・追加だけであること(書き込みの権限を持つ者の変更は防がず、履歴に残る)。

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

/** manifest を作って置き場へ書く。書いた内容を返す */
export function writeManifest({ dir, run, target, range, now = new Date() }) {
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
 * ship-evidence.yml の本文を読み、写しの経路の欠けを返す(空なら適合)。
 * (a) 成果物 ship-evidence に retention-days がある (b) 一式を docs/evidence/ へ写す手順がある
 * (c) verify ジョブが verify を呼ぶ
 * (d) coverage-result を取り込み、実行の headSha と対象のコミットを照らす
 * (e) 前回の証跡を、成果物を取れないときは基底ブランチの写しから読む
 */
export function workflowProblems(text) {
  const problems = [];
  const t = String(text ?? '');
  const steps = t.split(/^ {6}- /m);
  const upload = steps.find((s) => /uses:\s*actions\/upload-artifact/.test(s) && /^\s+name:\s*ship-evidence\s*$/m.test(s));
  if (!upload) problems.push('成果物 ship-evidence の upload-artifact がありません');
  else if (!/^\s+retention-days:\s*\d+/m.test(upload)) problems.push('成果物 ship-evidence に retention-days がありません(保持の日数を明示する)');
  if (!/evidence-manifest\.mjs write/.test(t)) problems.push('一式を docs/evidence/ へ写す手順(evidence-manifest.mjs write)がありません');
  const verifyIdx = t.search(/^ {2}verify:\s*$/m);
  if (verifyIdx < 0 || !/evidence-manifest\.mjs verify/.test(t.slice(verifyIdx))) problems.push('verify ジョブが evidence-manifest.mjs verify を呼んでいません');
  if (!/--name coverage-result/.test(t)) problems.push('coverage-result の取り込みがありません');
  if (!/--json headSha/.test(t)) problems.push('取り込む実行の headSha と対象のコミットを照らす手順がありません');
  if (!/docs\/evidence\/\*\/manifest\.json/.test(t)) problems.push('前回の証跡を基底ブランチの写し(docs/evidence/*/manifest.json)から読む手順がありません');
  return problems;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const arg = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  const dir = arg('--dir');
  if (!dir || !['write', 'verify'].includes(cmd)) {
    console.error('使い方: evidence-manifest.mjs write|verify --dir <置き場> [--run --target --range]');
    return 2;
  }
  if (cmd === 'write') {
    const m = writeManifest({ dir, run: arg('--run'), target: arg('--target'), range: arg('--range') });
    console.log(`${dir}/${MANIFEST_NAME}: ${m.files.length} 件の digest を書きました`);
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

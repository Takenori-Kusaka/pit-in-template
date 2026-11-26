// 依存の来歴の照会(G-5 基準8 の一覧の欄の値。process-compass #455 / ADR-0261)。
//
//   node scripts/gate/dependency-provenance.mjs --base origin/main [--verify]
//
// ネットワークを使うのはこのファイルだけ。解析(dependency-parse.mjs)と一覧の組み立て(dependency-diff.mjs)はネットワークに依らない。
// 合否を返さない。照会できなかった行は「照会せず(理由)」、値が欠けた行は「取得できず」として、結果のファイルへ書いて終わる。
// 結果: evidence/dependency-provenance.json
// --verify: node のとき `npm audit signatures`(署名と来歴の証明の検証)を実行し、結果を同じファイルへ書く。失敗しても終了コードは 0。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, loadAdapter } from './config.mjs';
import { collectEntries } from './dependency-collect.mjs';
import { parseAuditSignatures } from './dependency-parse.mjs';

export const REGISTRY = 'https://registry.npmjs.org';

/** 版の公開者(_npmUser の名前) */
function publisherOf(doc, version) {
  return doc?.versions?.[version]?._npmUser?.name ?? null;
}

/** 来歴の証明の有無。packument の dist.attestations がある版は証明つき。dist が読めない版は null */
function attestationOf(doc, version) {
  const d = doc?.versions?.[version]?.dist;
  if (!d) return null;
  return Boolean(d.attestations);
}

/**
 * 1件の照会。fetchJson(url) は { ok, status, json } を返す(試験では応答を差し替える)。
 * 戻り値の status: queried / skipped(照会せず) / unavailable(取得できず) / out-of-scope(対象外)
 */
export async function queryEntry(entry, fetchJson) {
  if (entry.source !== 'public') {
    const why = { private: `私設・ミラーのレジストリ(${entry.host || '不明'})`, git: 'git の解決元', url: 'URL の解決元', file: 'file の解決元', workspace: 'workspace', unknown: '解決元が読めない' }[entry.source] ?? entry.source;
    return { status: 'out-of-scope', reason: why };
  }
  if (entry.lockless) return { status: 'skipped', reason: '版が未確定(ロックファイルが無い)' };
  const url = `${REGISTRY}/${entry.name.replace('/', '%2F')}`;
  let res;
  try {
    res = await fetchJson(url);
  } catch (e) {
    return { status: 'skipped', reason: `不達(${String(e?.message ?? e).slice(0, 60)})` };
  }
  if (!res.ok) {
    if (res.status === 404) return { status: 'unavailable', reason: 'レジストリに名前が無い(404)' };
    return { status: 'skipped', reason: `不達(HTTP ${res.status})` };
  }
  const doc = res.json;
  const time = doc?.time ?? {};
  const q = {
    status: 'queried',
    publishedAt: time[entry.to] ?? null,
    firstPublishedAt: time.created ?? null,
    publisher: publisherOf(doc, entry.to),
    prevPublisher: entry.from ? publisherOf(doc, entry.from) : null,
    attestation: attestationOf(doc, entry.to),
    prevAttestation: entry.from ? attestationOf(doc, entry.from) : null,
    signaturePresent: Array.isArray(doc?.versions?.[entry.to]?.dist?.signatures) ? doc.versions[entry.to].dist.signatures.length > 0 : null,
  };
  const missing = ['publishedAt', 'firstPublishedAt', 'publisher', 'attestation'].filter((k) => q[k] === null);
  if (missing.length === Object.keys({ publishedAt: 1, firstPublishedAt: 1, publisher: 1, attestation: 1 }).length) return { status: 'unavailable', reason: '応答に欄の値が無い' };
  if (missing.length) q.missing = missing;
  return q;
}

/** 同時に 5 件まで照会する。入力の行を切らない(F-4 / R-10) */
export async function queryAll(entries, fetchJson, concurrency = 5) {
  const out = new Array(entries.length);
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      out[i] = await queryEntry(entries[i], fetchJson);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  return out;
}

export async function realFetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  let json = null;
  if (r.ok) json = await r.json();
  return { ok: r.ok, status: r.status, json };
}

function verifySignatures() {
  let adapterId = 'none';
  try {
    adapterId = loadAdapter(loadConfig()).id;
  } catch {
    /* 構成が読めなければ未実施 */
  }
  if (adapterId !== 'node') return { status: 'not-run', reason: `node 以外(${adapterId})の検証は降ろしていない`, kinds: [] };
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) return { status: 'not-run', reason: '依存を導入していない(node_modules が無い)', kinds: [] };
  const r = spawnSync('npm', ['audit', 'signatures'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000 });
  const code = r.error ? 1 : (r.status ?? 1);
  if (r.error) return { status: 'not-run', reason: `実行できず(${r.error.message})`, kinds: [] };
  // 署名の検証と来歴の証明の検証を分けて書く。完全性(go mod verify)は来歴と数えない(go は降ろしていない)
  return { ...parseAuditSignatures(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, code), kinds: ['署名(レジストリの署名)', '来歴の証明(attestation)'] };
}

async function main() {
  const i = process.argv.indexOf('--base');
  const base = i >= 0 ? process.argv[i + 1] : 'origin/main';
  const { entries } = collectEntries(base);
  const queries = await queryAll(entries, realFetchJson);
  const result = { base, queries, verification: process.argv.includes('--verify') ? verifySignatures() : { status: 'not-run', reason: '検証を指定していない', kinds: [] } };
  fs.mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'evidence/dependency-provenance.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`照会 ${queries.length} 件(照会せず ${queries.filter((q) => q.status === 'skipped').length} 件)。検証: ${result.verification.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    // 照会の失敗で段を落とさない。一覧は「照会せず」で出る
    console.log(`照会を実行できませんでした: ${e?.message ?? e}`);
  });
}

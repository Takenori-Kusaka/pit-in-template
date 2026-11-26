// 依存関係の差分の解析と印の付け方(G-5 基準8。process-compass #455 / ADR-0261)。
//
// 純関数だけを置く。ネットワークも git も使わない(照会は dependency-provenance.mjs、git の読み出しは dependency-collect.mjs)。
// 解析の対象は node(package-lock.json の v2・v3 と package.json)。python・go ほかの解析は降ろしていない(IMPL に undelivered で表示する)。
// 合否は判定しない。

export const PUBLIC_NPM_HOST = 'registry.npmjs.org';

/** package-lock.json のキー(node_modules/a/node_modules/@s/b)から名前を取る */
export function nameOfLockKey(key) {
  const at = key.lastIndexOf('node_modules/');
  return at < 0 ? '' : key.slice(at + 'node_modules/'.length);
}

/** 解決元の分類。公開レジストリ以外(私設・ミラー・git・URL・file・workspace)は照会の対象外 */
export function classifySource(pkg) {
  if (pkg?.link) return { kind: 'workspace', host: '' };
  const r = String(pkg?.resolved ?? '');
  if (!r) return { kind: 'unknown', host: '' };
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(r)) return { kind: 'git', host: '' };
  if (/^file:/.test(r)) return { kind: 'file', host: '' };
  let host = '';
  try {
    host = new URL(r).host;
  } catch {
    return { kind: 'unknown', host: '' };
  }
  if (host === PUBLIC_NPM_HOST) return { kind: 'public', host };
  return { kind: 'private', host };
}

function readJson(text) {
  try {
    return { ok: true, value: JSON.parse(String(text ?? '')) };
  } catch {
    return { ok: false, value: null };
  }
}

/** package-lock.json の本文 → { packages: Map(key → pkg), roots: Set(直接の依存の名前) }。読めなければ ok: false */
export function readNpmLock(text) {
  const j = readJson(text);
  if (!j.ok || !j.value || typeof j.value !== 'object' || !j.value.packages) return { ok: false, packages: new Map(), roots: new Set() };
  const packages = new Map(Object.entries(j.value.packages));
  const root = packages.get('') ?? {};
  const roots = new Set([
    ...Object.keys(root.dependencies ?? {}),
    ...Object.keys(root.devDependencies ?? {}),
    ...Object.keys(root.optionalDependencies ?? {}),
    ...Object.keys(root.peerDependencies ?? {}),
  ]);
  return { ok: true, packages, roots };
}

/**
 * ロックファイルの差分(基底 → 現在)。追加された名前@版を1件ずつ返す。
 * 初出の名前(firstSeen)は、基底のロックファイルに同じ名前が無いもの。前の版(from)は、基底にある同じ名前の版。
 * 基底が無い(新規のファイル)ときは、すべてを初出とする
 */
export function diffNpmLock(baseText, headText) {
  const base = baseText ? readNpmLock(baseText) : { ok: true, packages: new Map(), roots: new Set() };
  const head = readNpmLock(headText);
  if (!head.ok || !base.ok) return { ok: false, entries: [] };
  const baseVersions = new Map();
  for (const [k, p] of base.packages) {
    if (!k) continue;
    const n = nameOfLockKey(k);
    if (!baseVersions.has(n)) baseVersions.set(n, new Set());
    baseVersions.get(n).add(p.version ?? '');
  }
  const seen = new Set();
  const entries = [];
  for (const [k, p] of head.packages) {
    if (!k) continue;
    const name = nameOfLockKey(k);
    const version = p.version ?? '';
    const had = baseVersions.get(name);
    if (had?.has(version)) continue;
    const id = `${name}@${version}@${p.resolved ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const src = classifySource(p);
    const nested = k.slice(0, k.lastIndexOf('node_modules/')).includes('node_modules/');
    entries.push({
      ecosystem: 'npm',
      name,
      from: had ? [...had][0] || null : null,
      to: version,
      direct: head.roots.has(name) && !nested,
      source: src.kind,
      host: src.host,
      firstSeen: !had,
      lockless: false,
    });
  }
  return { ok: true, entries };
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** ロックファイルの無い構成(package.json だけ)。直接の依存の宣言の追加・変更だけを出す。推移的な依存は見えない */
export function diffPackageJson(baseText, headText) {
  const head = readJson(headText);
  if (!head.ok || !head.value) return { ok: false, entries: [] };
  const base = baseText ? readJson(baseText) : { ok: true, value: {} };
  if (!base.ok) return { ok: false, entries: [] };
  const baseNames = new Set(SECTIONS.flatMap((s) => Object.keys(base.value?.[s] ?? {})));
  const entries = [];
  for (const sect of SECTIONS) {
    const h = head.value[sect] ?? {};
    const b = base.value?.[sect] ?? {};
    for (const [name, range] of Object.entries(h)) {
      if (b[name] === range) continue;
      entries.push({
        ecosystem: 'npm',
        name,
        from: b[name] ?? null,
        to: String(range),
        direct: true,
        source: /^(git|github:|file:|https?:)/.test(String(range)) ? 'url' : 'public',
        host: '',
        firstSeen: !baseNames.has(name),
        lockless: true,
      });
    }
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------- 印

export const MARK = {
  FIRST_SEEN: '初出の名前',
  PUBLISHER_CHANGED: '公開者の変更',
  ATTESTATION_LOST: '証明の退行',
  VERIFY_FAILED: '検証の失敗',
  NOT_QUERIED: '照会せず',
  UNAVAILABLE: '取得できず',
  OUT_OF_SCOPE: '対象外',
  OMITTED: '表示の省略',
};

/**
 * 1行の印。entry: 解析の結果、q: 照会の結果(無ければ照会せず)、failedNames: 検証が失敗した名前の集合。
 * 印は合否に使わない。G-6 基準5 の「印の付いた行を読んだ」の対象になる
 */
export function marksOf(entry, q, failedNames = new Set()) {
  const m = [];
  if (entry.firstSeen) m.push(MARK.FIRST_SEEN);
  if (!q || q.status === 'skipped') m.push(MARK.NOT_QUERIED);
  else if (q.status === 'out-of-scope') m.push(MARK.OUT_OF_SCOPE);
  else if (q.status === 'unavailable') m.push(MARK.UNAVAILABLE);
  else {
    if (q.publisher && q.prevPublisher && q.publisher !== q.prevPublisher) m.push(MARK.PUBLISHER_CHANGED);
    if (q.prevAttestation === true && q.attestation === false) m.push(MARK.ATTESTATION_LOST);
  }
  if (failedNames.has(entry.name)) m.push(MARK.VERIFY_FAILED);
  return m;
}

/** 照会しなかった理由の集計(「N 件中 M 件を照会せず(理由)」の理由の部分) */
export function skipReasons(queries) {
  const by = new Map();
  for (const q of queries) {
    if (!q || (q.status !== 'skipped' && q.status !== 'out-of-scope')) continue;
    const key = q.status === 'out-of-scope' ? `対象外: ${q.reason}` : q.reason;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([r, n]) => `${r} ${n} 件`);
}

/** npm audit signatures の出力 → { status, failedNames, detail }。終了コード 0 なら passed、それ以外は failed */
export function parseAuditSignatures(text, code) {
  const t = String(text ?? '');
  const failed = new Set();
  if (code !== 0) {
    // 失敗の節の行は「<名前>@<版>」で始まる(例: "sigstore@2.0.0 (https://registry.npmjs.org/)")
    for (const line of t.split('\n')) {
      const mm = line.match(/^\s*((?:@[^/\s]+\/)?[^@\s]+)@\S+/);
      if (mm) failed.add(mm[1]);
    }
  }
  return { status: code === 0 ? 'passed' : 'failed', failedNames: [...failed], detail: t.split('\n').filter(Boolean).slice(-6).join(' / ') };
}

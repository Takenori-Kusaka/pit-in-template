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
  // 名前 → 版 → 基底での「解決元|integrity」の集合(版を据え置いた解決元の変更を拾うため)
  const baseVersions = new Map();
  for (const [k, p] of base.packages) {
    if (!k) continue;
    const n = nameOfLockKey(k);
    if (!baseVersions.has(n)) baseVersions.set(n, new Map());
    const byVer = baseVersions.get(n);
    const v = p.version ?? '';
    if (!byVer.has(v)) byVer.set(v, new Set());
    byVer.get(v).add(String(p.resolved ?? '') + '|' + String(p.integrity ?? ''));
  }
  const seen = new Set();
  const entries = [];
  for (const [k, p] of head.packages) {
    if (!k) continue;
    const name = nameOfLockKey(k);
    const version = p.version ?? '';
    const had = baseVersions.get(name);
    const sameVer = had?.get(version);
    // 版が同じでも、解決元か integrity が基底のどれとも違えば行にする(解決元の変更)
    const sourceChanged = Boolean(sameVer) && !sameVer.has(String(p.resolved ?? '') + '|' + String(p.integrity ?? ''));
    if (sameVer && !sourceChanged) continue;
    const id = `${name}@${version}@${p.resolved ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const src = classifySource(p);
    const nested = k.slice(0, k.lastIndexOf('node_modules/')).includes('node_modules/');
    entries.push({
      ecosystem: 'npm',
      name,
      from: had ? (sourceChanged ? version : [...had.keys()][0] || null) : null,
      to: version,
      direct: head.roots.has(name) && !nested,
      source: src.kind,
      host: src.host,
      firstSeen: !had,
      sourceChanged,
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
        sourceChanged: false,
        lockless: true,
      });
    }
  }
  return { ok: true, entries };
}

// ---------------------------------------------------------------- 印

export const MARK = {
  FIRST_SEEN: '初出の名前',
  SOURCE_CHANGED: '解決元の変更',
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
  if (entry.sourceChanged) m.push(MARK.SOURCE_CHANGED);
  if (!q || q.status === 'skipped') m.push(MARK.NOT_QUERIED);
  else if (q.status === 'out-of-scope') m.push(MARK.OUT_OF_SCOPE);
  else if (q.status === 'unavailable') m.push(MARK.UNAVAILABLE);
  else {
    // 公開者は _npmUser の名前で比べる。両方の版に来歴の証明があり出どころ(ソースのリポジトリ)が読めたときは、出どころも比べる
    // (trusted publishing の版は公開者の名前が全て GitHub Actions になるため)
    const nameChanged = q.publisher && q.prevPublisher && q.publisher !== q.prevPublisher;
    const repoChanged = q.attestedRepo && q.prevAttestedRepo && q.attestedRepo !== q.prevAttestedRepo;
    if (nameChanged || repoChanged) m.push(MARK.PUBLISHER_CHANGED);
    if (q.prevAttestation === true && q.attestation === false) m.push(MARK.ATTESTATION_LOST);
  }
  if (failedNames instanceof Map) {
    const kinds = failedNames.get(entry.name);
    if (kinds?.length) m.push(MARK.VERIFY_FAILED + '(' + [...new Set(kinds)].join('・') + ')');
  } else if (failedNames.has(entry.name)) m.push(MARK.VERIFY_FAILED);
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

/** 検証の種類(IMPL-1038。署名・来歴の証明・完全性は別。完全性(go mod verify)は来歴と数えない) */
export const VERIFY_KIND = { SIGNATURE_INVALID: '署名の不正', SIGNATURE_MISSING: '署名の欠落', ATTESTATION_INVALID: '来歴の証明の不正' };

const SECTION_HEAD = [
  [/invalid registry signature/i, VERIFY_KIND.SIGNATURE_INVALID],
  [/missing registry signature/i, VERIFY_KIND.SIGNATURE_MISSING],
  [/invalid attestation/i, VERIFY_KIND.ATTESTATION_INVALID],
];

/**
 * npm audit signatures の出力 → { status, failedNames, failures, results, detail }。
 *   passed: 終了コード 0
 *   failed: 失敗の節(署名の不正・署名の欠落・来歴の証明の不正)が出力にある。failures は { name, kind } の並び
 *   not-run: 終了コードが 0 以外で失敗の節が1つも無い(依存 0 件・鍵の取得の不達・レジストリが鍵を出さない等)。検証は行われていないので「実施」と表示しない
 * results は種類ごとの結果(署名・来歴の証明・完全性)。完全性は npm では検証しない(not-run)
 */
export function parseAuditSignatures(text, code) {
  const t = String(text ?? '').replace(/\r/g, '');
  const detail = t.split('\n').filter(Boolean).slice(-6).join(' / ');
  if (code === 0) {
    return { status: 'passed', failedNames: [], failures: [], results: { signature: 'passed', attestation: 'passed', integrity: 'not-run' }, detail };
  }
  const failures = [];
  let kind = null;
  for (const line of t.split('\n')) {
    // 節の見出し(例: "1 package has an invalid registry signature:")。名前の行ではない
    if (/^\s*\d+ packages? (has|have)\b/i.test(line)) {
      kind = SECTION_HEAD.find(([re]) => re.test(line))?.[1] ?? null;
      continue;
    }
    if (!kind) continue;
    // 失敗の節の行は「<名前>@<版>」で始まる(例: "sigstore@2.0.0 (https://registry.npmjs.org/)")
    const mm = line.match(/^\s*((?:@[^/\s]+\/)?[^@\s]+)@\d\S*/);
    if (mm && !failures.some((x) => x.name === mm[1] && x.kind === kind)) failures.push({ name: mm[1], kind });
  }
  if (!failures.length) {
    return {
      status: 'not-run',
      reason: `検証を実行できなかった(終了コード ${code}。失敗の節が出力に無い: ${detail})`,
      failedNames: [],
      failures: [],
      results: { signature: 'not-run', attestation: 'not-run', integrity: 'not-run' },
      detail,
    };
  }
  const has = (k) => failures.some((f) => f.kind === k);
  const sig = has(VERIFY_KIND.SIGNATURE_INVALID) || has(VERIFY_KIND.SIGNATURE_MISSING);
  const att = has(VERIFY_KIND.ATTESTATION_INVALID);
  return {
    status: 'failed',
    failedNames: [...new Set(failures.map((f) => f.name))],
    failures,
    // 失敗の節の無い種類は「失敗の報告なし」(出力に成功の件数が無い限り、成功とは書かない)
    results: { signature: sig ? 'failed' : 'no-failure-reported', attestation: att ? 'failed' : 'no-failure-reported', integrity: 'not-run' },
    detail,
  };
}

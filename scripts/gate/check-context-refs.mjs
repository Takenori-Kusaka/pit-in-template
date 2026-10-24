// G-5 基準6(文脈ファイルの形式検査)のうち、リポジトリ内の参照切れを検査する。
//
//   node scripts/gate/check-context-refs.mjs
//
// 標準 第4章 G-5 基準6、フェーズ5「コンテキスト基盤」の陳腐化の検知(参照切れ。リポジトリ内のパスに限る。
// process-compass #314 / ADR-0083 決定3)。
//
// 対象のファイル(文脈ファイル): CLAUDE.md、AGENTS.md、context/ と .claude/ の Markdown。
// 確かめること: 次の参照の先が、リポジトリの中に実在すること。1件でも無ければ失敗する。
//   - Markdown のリンクの相対の宛先([文](../x.md))。先頭が / の宛先はリポジトリの直下から読む
//   - 取り込み(@path/to/file)。行の先頭か空白の後の @ で始まり、/ か . を含む語
//   - 逆引用符の中の、`.claude/` か `scripts/` で始まるパス(リポジトリの直下から読む。最初の空白までを
//     パスとする)。テンプレートが持つ置き場への所在であり、CLAUDE.md が行末に置く「詳細: …」もここに当たる
//     (process-compass #314 の突合 X-8)。次のものは除く:
//       - 雛形の記号を含むもの(`N`・`NNN`・`G-N`・`F-NNN`・`<…>`・`*`・`{…}` など)
//       - .gitignore に当たるもの(実行時に作られる端末ごとの状態。例: `.claude/.self-heal`)
//
// 確かめないこと(標準の基準6 のうち、準拠テンプレートへ降りていない残り。実装マーク IMPL-0263):
//   - 見出しのアンカー(#…)。日本語の見出しの slug は描画系ごとに作り方が違い、誤検出が多い
//   - 逆引用符の中の、`docs/`・`context/` など上記の2つ以外で始まるパス。テンプレートの例は、
//     案件が後で作るファイル(`docs/D-0-governance.md` など)を指し、テンプレートの時点では実在しない
//   - スキームつきの宛先(https: など)。リポジトリの外である
//   - 1ファイルの分量の上限(第3章 3.11.4)。値を支える実証が無く、降ろしていない(IMPL-0306)
// コードブロックと HTML コメント(複数行にわたるものを含む)の中は読まない。

// 依存パッケージなし。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.mjs';

/** 対象の文脈ファイル(リポジトリの直下からの相対パス)を返す */
export function contextFiles(root = ROOT) {
  const out = [];
  for (const f of ['CLAUDE.md', 'AGENTS.md']) if (fs.existsSync(path.join(root, f))) out.push(f);
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.md')) out.push(r);
    }
  };
  walk('context');
  walk('.claude');
  return out.sort();
}

// 雛形の記号(置き場の例。G-N.md・F-NNN・<機能> など)
const PLACEHOLDER = /(^|[^A-Za-z])N+(?=[^A-Za-z]|$)|[<>*{}…]/;
const CODE_PATH = /^(?:\.claude|scripts)\//;

/** .gitignore の行から、パスが当たるかを返す関数を作る(否定・アンカー・ディレクトリ・* と ** に対応する簡易の照合) */
export function gitignoreMatcher(text) {
  const rules = [];
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const body = line
      .split('**')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
      .join('.*');
    const re = new RegExp(`${anchored ? '^' : '(^|/)'}${body}(/|$)`);
    rules.push({ negate, re, dirOnly });
  }
  return (rel) => {
    let hit = false;
    for (const r of rules) if (r.re.test(rel)) hit = !r.negate;
    return hit;
  };
}

/**
 * 1つの文脈ファイルの本文から、確かめる参照を取り出す。
 * 返すのは { line, kind: 'link' | 'import' | 'code', target, resolved } の一覧。resolved はリポジトリの直下からの相対パス。
 * ignored(rel) は .gitignore に当たるか(当たる逆引用符のパスは数えない)
 */
export function referencesOf(file, text, ignored = () => false) {
  const refs = [];
  let fence = null;
  // HTML コメントは、複数行にわたるものも行番号を保って空にする
  const lines = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const f = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (fence === null && f) {
      fence = f[1];
      continue;
    }
    if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    // 逆引用符の中は、.claude/ と scripts/ で始まるパスだけを読む
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const content = m[1].trim();
      if (!CODE_PATH.test(content)) continue;
      const target = content.split(/\s/)[0].replace(/[、。,;:]+$/, '');
      if (PLACEHOLDER.test(target)) continue;
      const resolved = path.posix.normalize(target.split('#')[0].replace(/:\d+(?::\d+)?$/, '').replace(/\/$/, ''));
      if (ignored(resolved)) continue;
      refs.push({ line: i + 1, kind: 'code', target, resolved });
    }
    const t = raw.replace(/`[^`]*`/g, '');
    for (const m of t.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
      const bare = target.split('#')[0].split('?')[0];
      if (!bare) continue;
      let decoded = bare;
      try {
        decoded = decodeURIComponent(bare);
      } catch {
        // 読めない符号はそのまま比べる
      }
      const resolved = decoded.startsWith('/') ? path.posix.normalize(decoded.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded));
      refs.push({ line: i + 1, kind: 'link', target, resolved });
    }
    for (const m of t.matchAll(/(^|\s)@([^\s`)\]]+)/g)) {
      const target = m[2].replace(/[、。,.;:]+$/, '');
      if (!/[/.]/.test(target) || target.startsWith('~')) continue;
      const resolved = target.startsWith('/') ? path.posix.normalize(target.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      refs.push({ line: i + 1, kind: 'import', target: `@${target}`, resolved });
    }
  }
  return refs;
}

/** 参照切れの一覧を返す。exists(rel) は、リポジトリの直下からの相対パスが実在するか。ignored(rel) は .gitignore に当たるか */
export function brokenReferences(files, read, exists, ignored = () => false) {
  const broken = [];
  let checked = 0;
  for (const file of files) {
    for (const r of referencesOf(file, read(file), ignored)) {
      checked++;
      // リポジトリの外を指す相対パス(../ で直下を越える)も参照切れとして扱う
      if (r.resolved.startsWith('..') || !exists(r.resolved)) broken.push({ file, ...r });
    }
  }
  return { broken, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = contextFiles(ROOT);
  const { broken, checked } = brokenReferences(
    files,
    (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'),
    (rel) => fs.existsSync(path.join(ROOT, rel)),
    gitignoreMatcher(fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '')
  );
  if (broken.length) {
    for (const b of broken) {
      console.log(`::error file=${b.file},line=${b.line}::参照切れ: ${b.target} の先(${b.resolved})がリポジトリにありません`);
    }
    console.log(
      `G-5 基準6(参照切れ): ${broken.length} 件(文脈ファイル ${files.length} 件、参照 ${checked} 件)。` +
        '参照の先を直すか、参照を消してください。見出しのアンカーと、逆引用符の中の .claude/・scripts/ 以外で始まるパスは確かめていません'
    );
    process.exit(1);
  }
  console.log(
    `::notice::G-5 基準6(参照切れ): 0 件(文脈ファイル ${files.length} 件、参照 ${checked} 件)。` +
      '見出しのアンカー、逆引用符の中の .claude/・scripts/ 以外で始まるパス、1ファイルの分量の上限は確かめていません(標準 第4章 G-5 基準6 のうち準拠テンプレートへ降りていない部分)'
  );
}

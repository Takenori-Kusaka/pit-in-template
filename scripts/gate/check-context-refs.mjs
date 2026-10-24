// G-5 基準6(文脈ファイルの形式検査)のうち、リポジトリ内の参照切れを検査する。
//
//   node scripts/gate/check-context-refs.mjs
//
// 標準 第4章 G-5 基準6、フェーズ5「コンテキスト基盤」の陳腐化の検知(参照切れ。リポジトリ内のパスに限る。
// process-compass #314 / ADR-0084 決定3)。
//
// 対象のファイル(文脈ファイル): CLAUDE.md、AGENTS.md、context/ と .claude/ の Markdown。
// 確かめること: 次の参照の先が、リポジトリの中に実在すること。1件でも無ければ失敗する。
//   - Markdown のリンクの相対の宛先([文](../x.md))。先頭が / の宛先はリポジトリの直下から読む
//   - 取り込み(@path/to/file)。行の先頭か空白の後の @ で始まり、/ か . を含む語
//
// 確かめないこと(標準の基準6 のうち、準拠テンプレートへ降りていない残り。実装マーク IMPL-0269):
//   - 見出しのアンカー(#…)。日本語の見出しの slug は描画系ごとに作り方が違い、誤検出が多い
//   - 逆引用符(`…`)の中のパス。テンプレートの例は、案件が後で作るファイルを指す
//   - スキームつきの宛先(https: など)。リポジトリの外である
//   - 1ファイルの分量の上限(第3章 3.11.4)。値を支える実証が無く、降ろしていない(IMPL-0312)
// コードブロックと HTML コメントの中は読まない。
//
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

/**
 * 1つの文脈ファイルの本文から、確かめる参照を取り出す。
 * 返すのは { line, kind: 'link' | 'import', target, resolved } の一覧。resolved はリポジトリの直下からの相対パス
 */
export function referencesOf(file, text) {
  const refs = [];
  let fence = null;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
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
    // HTML コメントと逆引用符の中は読まない
    const t = raw.replace(/<!--.*?-->/g, '').replace(/`[^`]*`/g, '');
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

/** 参照切れの一覧を返す。exists(rel) は、リポジトリの直下からの相対パスが実在するか */
export function brokenReferences(files, read, exists) {
  const broken = [];
  let checked = 0;
  for (const file of files) {
    for (const r of referencesOf(file, read(file))) {
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
    (rel) => fs.existsSync(path.join(ROOT, rel))
  );
  if (broken.length) {
    for (const b of broken) {
      console.log(`::error file=${b.file},line=${b.line}::参照切れ: ${b.target} の先(${b.resolved})がリポジトリにありません`);
    }
    console.log(
      `G-5 基準6(参照切れ): ${broken.length} 件(文脈ファイル ${files.length} 件、参照 ${checked} 件)。` +
        '参照の先を直すか、参照を消してください。見出しのアンカーと逆引用符の中のパスは確かめていません'
    );
    process.exit(1);
  }
  console.log(
    `::notice::G-5 基準6(参照切れ): 0 件(文脈ファイル ${files.length} 件、参照 ${checked} 件)。` +
      '見出しのアンカー、逆引用符の中のパス、1ファイルの分量の上限は確かめていません(標準 第4章 G-5 基準6 のうち準拠テンプレートへ降りていない部分)'
  );
}

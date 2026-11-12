// 強制層: 書き込みの遮断
//
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit)で起動します。
//
// 遮断するもの:
//   1. 強制層そのもの(設定・フック・ワークフロー・ルールセット・ゲートのスクリプト)
//      → エージェントが自分を縛る設定を変えられる構成では、遮断が成立しないため
//   2. 自己修正ループ中のテストへの書き込み
//      → 渡された失敗をテスト側の変更で解消する経路を塞ぐため(附属書E E.7)
//      ロックは scripts/gate/self-heal.mjs が始めて終える。ロックのファイルそのものへの書き込みも拒否する。
//      この遮断は guard.enabled に依らず有効である(構成の guard の上書きで一時緩和しても外さない。#286)。
//      強制層そのものの遮断(1)も事業ステージに依らず有効である(PoC でも外さない。標準 第8章 軸B、ADR-0050。process-compass #290)。
//      ロックの外(テストを先に書く作業)は遮断しない
//
// 拒否した操作は .claude/denied.log へ残します。拒否の発生そのものが、
// タスクの範囲設定と実態が合っていない兆候だからです。
//
// 限界: このフックは Claude Code の設定でのみ有効です。他の経路(手動の git 操作、
// 別のエージェント基盤)は遮断しません。「遮断が0件だから安全である」とは記録できません。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * glob をごく小さな部分集合で照合する(`**` `*` `?` のみ)。大文字と小文字を区別しない。Windows(NTFS)と macOS(APFS の既定)は
 * 区別しないファイルシステムで、`.CLAUDE/Settings.json` も `.claude/settings.json` と同じファイルを指すため(process-compass #358。
 * 区別すると強制層の遮断を通る)。区別するファイルシステムでは、大文字と小文字だけが違う別のファイルも遮断する
 */
export function globToRegExp(glob) {
  const SPECIAL = '.+^${}()|[]';
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` は0階層以上にあたる
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '\\') {
      re += '\\\\';
    } else if (SPECIAL.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

export function match(pattern, target) {
  return globToRegExp(pattern).test(target);
}

/**
 * 照合の前にパスを正規化する(process-compass #358 突合 X-1・Y-5・Y-6)。NTFS では別の綴りが同じファイルを指す。
 *  - 代替データストリームの記法(`settings.json::$DATA`・`settings.json:x`)は、ストリーム名を除いて本体のパスにする(Windows のときだけ。
 *    POSIX では `:` は名前に使える文字である)
 *  - Windows は末尾のドットと空白を落とす(`settings.json.`)。この環境の Node の fs は `settings.json.` を別のファイルとして作る
 *    (本体は書き換わらない)。Win32 の API の正規化に頼る道具に備えた、安全側の拒否である
 *  - 存在するパスは realpath(fs.realpathSync.native)で長い名前へ解く(8.3 の短い名前 `SETTIN~1.JSO`・シンボリックリンク・ジャンクション)。
 *    無いパスは、存在する最も深い親を解いて残りをつなぐ
 *  - 解けない成分に 8.3 の形(`~` の後に数字)が残るものは suspicious として返す(保護の型に当たりうるときだけ、呼び出し側が拒否する)
 * 戻り値: { abs: 解いた後のパス, lexical: 解く前(字面)のパス, suspicious }
 */
export function normalizeTarget(filePath) {
  const win = process.platform === 'win32';
  let abs = path.resolve(filePath);
  const root = path.parse(abs).root;
  const rest = abs.slice(root.length);
  const parts = rest.split(/[\\/]+/).filter((p) => p !== '');
  const cleaned = parts.map((p) => {
    if (!win) return p;
    let q = p.replace(/:.*$/, ''); // ストリームの指定
    if (q !== '.' && q !== '..') q = q.replace(/[. ]+$/, '');
    return q === '' ? p : q;
  });
  abs = path.join(root, ...cleaned);
  const lexical = abs;
  // 存在する最も深い親を解く
  let head = abs;
  const tail = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  let resolved = head;
  try {
    resolved = fs.realpathSync.native(head);
  } catch {
    /* 解けなければそのまま */
  }
  const suspicious = tail.some((p) => /~[0-9]/.test(p));
  return { abs: path.join(resolved, ...tail), lexical, suspicious };
}

// 8.3 の短い名前を持ちうる成分か(名前が 8.3 に収まらない、または glob を含む)
function mayHaveShortAlias(seg) {
  if (/[*?]/.test(seg)) return true;
  const i = seg.lastIndexOf('.');
  const base = i > 0 ? seg.slice(0, i) : seg;
  const ext = i > 0 ? seg.slice(i + 1) : '';
  return base.length > 8 || ext.length > 3 || /[^A-Za-z0-9_\-.~$]/.test(seg) || (i > 0 && seg.indexOf('.') !== i);
}

/**
 * 解けなかった 8.3 の形の成分(sus)を、短い名前を持ちうる任意の1成分として、型に当たりうるかを調べる(Y-5)。
 * 強制層の置き場の下でない `scripts/build~2.mjs`・`.claude/skills/v~2/SKILL.md` は当たらない
 */
export function couldMatchWithAlias(pattern, rel) {
  const ps = pattern.split('/');
  const rs = rel.split('/');
  const go = (i, j) => {
    if (i === ps.length) return j === rs.length;
    if (ps[i] === '**') {
      for (let k = j; k <= rs.length; k++) if (go(i + 1, k)) return true;
      return false;
    }
    if (j >= rs.length) return false;
    const seg = rs[j];
    const ok = /~[0-9]/.test(seg) ? mayHaveShortAlias(ps[i]) || globToRegExp(ps[i]).test(seg) : globToRegExp(ps[i]).test(seg);
    return ok && go(i + 1, j + 1);
  };
  return go(0, 0);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const guardPath = path.join(ROOT, '.claude/guard.json');
  if (!fs.existsSync(guardPath)) process.exit(0);
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));

  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0);
  }

  const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  if (!filePath) process.exit(0);

  const target = normalizeTarget(filePath);
  const roots = [ROOT];
  try {
    const rr = fs.realpathSync.native(ROOT);
    if (rr !== ROOT) roots.push(rr);
  } catch {
    /* ROOT が解けなければそのまま */
  }
  // 照合するパスは、解決先と字面(解く前)の両方。どちらかが保護の下にあれば止める。解決先がリポジトリの外でも、字面が中なら字面で照合する
  // (保護の型のディレクトリがジャンクション・リンクのとき、解決先は外へ出る。Y-1)
  const rels = [];
  for (const abs of [target.abs, target.lexical]) {
    for (const r of roots) {
      const x = path.relative(r, abs).split(path.sep).join('/');
      if (!x.startsWith('..') && !path.isAbsolute(x) && !rels.includes(x)) rels.push(x);
    }
  }
  if (rels.length === 0) process.exit(0); // リポジトリ外は対象にしない
  const rel = rels[0];

  const deny = (reason, rule, at = rel) => {
    const line = `${new Date().toISOString()}	${rule}	${at}
`;
    try {
      fs.appendFileSync(path.join(ROOT, guard.denyLog ?? '.claude/denied.log'), line);
    } catch {
      /* 記録に失敗しても遮断は続ける */
    }
    console.error(`[強制層] ${at} への書き込みを拒否しました。

${reason}`);
    process.exit(2);
  };
  const patternOf = (item) => (typeof item === 'object' && item !== null && 'pattern' in item ? item.pattern : item);

  // 0. 解けなかった成分に 8.3 の形を含むパスが、保護・追記だけの型に当たりうるなら拒否する(別の綴りで型を通る経路を塞ぐ。X-1・Y-5)
  if (target.suspicious && guard.enabled !== false) {
    for (const item of [...(guard.protectedPatterns ?? []), ...(guard.appendOnlyPatterns ?? [])]) {
      for (const r of rels) if (couldMatchWithAlias(String(patternOf(item)), r)) deny('別の綴り(8.3 の短い名前)で強制層の下を指すパスは書き込めません', 'protected-alias', r);
    }
  }

  // 1. 強制層そのもの。構成の guard の上書き(期限と理由つき)で一時緩和されている場合だけ適用しない(事業ステージでは外さない。#290)
  if (guard.enabled !== false) {
    for (const item of guard.protectedPatterns ?? []) {
      const isObj = typeof item === 'object' && item !== null && 'pattern' in item;
      const p = isObj ? item.pattern : item;
      const reason = isObj ? (item.reason ?? guard.protectedReason) : guard.protectedReason;
      for (const r of rels) if (match(p, r)) deny(reason, 'protected', r);
    }
  }

  // 1b. 追記だけの置き場(判定記録と写しの置き場)。既にあるファイルへの書き込み(編集)を拒否する。新しいファイルは拒否しない。
  // 成立した記録の変更は、出荷の集約が書き換えとして欠落に数える(process-compass #379 / ADR-0109)。強制層そのものの遮断と同じく
  // guard.enabled の一時緩和で外す
  if (guard.enabled !== false) {
    for (const item of guard.appendOnlyPatterns ?? []) {
      const isObj = typeof item === 'object' && item !== null && 'pattern' in item;
      const p = isObj ? item.pattern : item;
      const reason = isObj ? (item.reason ?? guard.appendOnlyReason) : guard.appendOnlyReason;
      for (const r of rels) if (match(p, r) && roots.some((b) => fs.existsSync(path.join(b, r)))) deny(reason ?? '成立した記録は書き換えません。訂正は元の記録を指す訂正の記録を人が足します', 'append-only', r);
    }
  }

  // 2. 自己修正ループ中のテスト。guard.enabled に依らず適用する
  const lockRel = guard.selfHealLockFile ?? '.claude/.self-heal';
  if (rel.toLowerCase() === lockRel.toLowerCase()) {
    deny('自己修正のロックは `node scripts/gate/self-heal.mjs start|stop` で始めて終えます。ファイルを直接書き換えません', 'self-heal-lock');
  }
  const lock = path.join(ROOT, lockRel);
  if (fs.existsSync(lock)) {
    for (const p of guard.testPatterns ?? []) {
      if (match(p, rel)) deny(guard.selfHealReason, 'self-heal-test');
    }
  }

  process.exit(0);
}

// フックとして起動されたときだけ標準入力を読む(テストからは import できる)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

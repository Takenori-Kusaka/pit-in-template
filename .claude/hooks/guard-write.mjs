// 強制層: 書き込みの遮断
//
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit)で起動します。
//
// 遮断するもの:
//   1. 強制層そのもの(設定・フック・ワークフロー・ルールセット・ゲートのスクリプト)
//      → エージェントが自分を縛る設定を変えられる構成では、遮断が成立しないため
//   2. 自己修正ループ中のテストへの書き込み
//      → 渡された失敗をテスト側の変更で解消する経路を塞ぐため(附属書E E.7)
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

/** glob をごく小さな部分集合で照合する(`**` `*` `?` のみ) */
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
  return new RegExp('^' + re + '$');
}

export function match(pattern, target) {
  return globToRegExp(pattern).test(target);
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

  const rel = path.relative(ROOT, path.resolve(filePath)).split(path.sep).join('/');
  if (rel.startsWith('..')) process.exit(0); // リポジトリ外は対象にしない

  const deny = (reason, rule) => {
    const line = `${new Date().toISOString()}\t${rule}\t${rel}\n`;
    try {
      fs.appendFileSync(path.join(ROOT, guard.denyLog ?? '.claude/denied.log'), line);
    } catch {
      /* 記録に失敗しても遮断は続ける */
    }
    console.error(`[強制層] ${rel} への書き込みを拒否しました。\n\n${reason}`);
    process.exit(2);
  };

  // 1. 強制層そのもの
  for (const item of guard.protectedPatterns ?? []) {
    const isObj = typeof item === 'object' && item !== null && 'pattern' in item;
    const p = isObj ? item.pattern : item;
    const reason = isObj ? (item.reason ?? guard.protectedReason) : guard.protectedReason;
    if (match(p, rel)) deny(reason, 'protected');
  }

  // 2. 自己修正ループ中のテスト
  const lock = path.join(ROOT, guard.selfHealLockFile ?? '.claude/.self-heal');
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

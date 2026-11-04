// 強制層: ホスティングへの書き込みの操作の遮断(抑止の層)
//
// PreToolUse(Bash)で起動します。AI の担い手が、ホスティング(GitHub)の上で人の名義の操作になりうる次のものを
// 実行するのを拒否します(標準 第3章 3.5.3「人と AI の担い手の名義」の要求事項4、ADR-0107。process-compass #429):
//   - 変更の承認・レビュー・マージ(gh pr review / gh pr merge)
//   - 書き込みの形の gh api(-X・--method が GET 以外、-f・-F・--field・--raw-field・--input による POST、GraphQL の mutation と、
//     中身を確かめられないファイルから渡す GraphQL の問い合わせ)
//   - 記録用ブランチ records への git push
//   - 認証情報そのものの読み出し(gh auth token、gh auth status --show-token、GH_TOKEN・GITHUB_TOKEN の展開、printenv)
//   - curl・wget などによる GitHub の API への GET 以外の要求
// 区画は ; & && || | 改行 ( ) { } バッククォートと $( で分け、bash -c・sh -c・eval・pwsh -c の中も同じ規則で見ます。
// 名義を共有する構成(担い手が人の認証情報で動く構成)では、これらの操作はホスティングの記録の上で人の操作と区別できません。
//
// これは**抑止の層**であり、名義の分離ではありません。担い手が書いたプログラム・スクリプトから API や git を呼ぶ経路、
// 変数の展開や命令の組み立てによる回避、ブランチ保護の変更を Web の画面で行う経路は止めません。
// 「遮断が0件だから担い手は人の名義で操作していない」とは記録できません。
// 拒否した操作は .claude/denied.log へ残します。guard.enabled に依らず有効です(緩める向きの一時緩和の対象にしない)。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 命令文を区画の配列にする。区切りは ; & && || | 改行 ( ) { } とバッククォート。引用符の中の区切りは分けない。
 * $( は区切りとして扱い、中の命令を別の区画として見る(二重引用符の中を含む)。厳密なシェルの解釈ではない
 */
export function segmentsOf(command) {
  const out = [];
  let cur = '';
  let q = null;
  let sub = 0; // 二重引用符の中で開いた $( の深さ
  const s = String(command ?? '');
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      cur += c;
      if (c === "'") q = null;
      continue;
    }
    if (q === '"') {
      if (c === '$' && s[i + 1] === '(') {
        flush();
        sub++;
        i++;
        continue;
      }
      if (c === ')' && sub > 0) {
        flush();
        sub--;
        continue;
      }
      if (c === '`') {
        flush();
        continue;
      }
      cur += c;
      if (c === '"' && s[i - 1] !== '\\') q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      flush();
      i++;
      continue;
    }
    if (';&|\n(){}`'.includes(c)) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}

/** 区画を語に分ける(引用符を外す。閉じていない引用符は、残りを1語とする。厳密なシェルの解釈ではない) */
function wordsOf(seg) {
  const words = [];
  const re = /"((?:\\.|[^"\\])*)"?|'([^']*)'?|(\S+)/g;
  let m;
  while ((m = re.exec(seg))) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

const WRITE_METHODS = /^(POST|PUT|PATCH|DELETE)$/i;
const API_HOST = /(^|[/.@])api\.github\.com\b|\/graphql\b|\/api\/v3\b/i;
// 前置きの語(実行するプログラムの前に置かれ、それ自体は命令でないもの)
const PREFIX_WORDS = new Set(['command', 'exec', 'env', 'sudo', 'nohup', 'time', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', 'nice', 'stdbuf', 'ionice']);
const TOKEN_NAMES = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/;
const TOKEN_VARS = /\$\{?(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b/;

/** 区画の先頭の前置き・環境変数の代入を読み飛ばし、[命令の名, 残りの語] を返す */
function commandOf(w) {
  let i = 0;
  while (i < w.length) {
    const x = w[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) || PREFIX_WORDS.has(x)) {
      i++;
      continue;
    }
    if (x === 'timeout') {
      i++;
      while (i < w.length && w[i].startsWith('-')) i++;
      i++; // 時間
      continue;
    }
    if (x === 'xargs') {
      i++;
      while (i < w.length && w[i].startsWith('-')) i += /^-(n|L|P|I|d|E|s)$/.test(w[i]) ? 2 : 1;
      continue;
    }
    break;
  }
  return [path.basename(String(w[i] ?? '')).replace(/\.exe$/i, ''), w.slice(i + 1)];
}

/** gh の引数から、フラグ(-R x / --repo x など)を除いた語の並びを返す */
function ghWords(rest) {
  const out = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (a === '-R' || a === '--repo' || a === '--hostname') {
      k++;
      continue;
    }
    if (a.startsWith('-')) continue;
    out.push(a);
  }
  return out;
}

/**
 * 命令文が、ホスティングへの書き込みの操作か認証情報の読み出しを含めば理由の文を、含まなければ null を返す。
 * 区画ごとに見る。1つでも当たれば拒否する
 */
export function hostingWriteOf(command) {
  return checkCommand(String(command ?? ''), 0);
}

function checkCommand(command, depth) {
  if (depth > 3) return null;
  // 認証情報の変数の展開(単一引用符の中は展開されないため除く)
  if (TOKEN_VARS.test(command.replace(/'[^']*'/g, ''))) return '認証情報の変数(GH_TOKEN・GITHUB_TOKEN)の読み出し';
  for (const seg of segmentsOf(command)) {
    const [head, rest] = commandOf(wordsOf(seg));
    // 別のシェルへ渡した命令文(bash -c "..."・eval "...")は、中を同じ規則で見る
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(head)) {
      const k = rest.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (k >= 0 && rest[k + 1]) {
        const r = checkCommand(rest[k + 1], depth + 1);
        if (r) return r;
      }
      continue;
    }
    if (/^(pwsh|powershell)$/i.test(head)) {
      const k = rest.findIndex((a) => /^-(c|command)$/i.test(a));
      if (k >= 0 && rest[k + 1]) {
        const r = checkCommand(rest.slice(k + 1).join(' '), depth + 1);
        if (r) return r;
      }
      continue;
    }
    if (head === 'eval') {
      const r = checkCommand(rest.join(' '), depth + 1);
      if (r) return r;
      continue;
    }
    if (head === 'printenv' && rest.some((a) => TOKEN_NAMES.test(a))) return 'printenv による認証情報の読み出し';
    if (head === 'git' && rest[0] === 'push' && rest.slice(1).some((a) => /(^|:)(refs\/heads\/)?records$/.test(a))) return 'git push による記録用ブランチ records への書き込み';
    if (head === 'gh') {
      const [sub, sub2] = ghWords(rest);
      if (sub === 'pr' && (sub2 === 'review' || sub2 === 'merge')) return `gh pr ${sub2}(変更の${sub2 === 'review' ? 'レビュー・承認' : 'マージ'})`;
      if (sub === 'auth' && sub2 === 'token') return 'gh auth token(認証情報そのものの読み出し)';
      if (sub === 'auth' && rest.includes('--show-token')) return 'gh auth の --show-token(認証情報そのものの読み出し)';
      if (sub === 'api') {
        const args = rest.slice(rest.indexOf('api') + 1);
        let method = null;
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (a === '-X' || a === '--method') method = String(args[k + 1] ?? '');
          else if (/^--method=/.test(a)) method = a.slice('--method='.length);
          else if (/^-X./.test(a)) method = a.slice(2).replace(/^=/, '');
        }
        if (method && WRITE_METHODS.test(method)) return `gh api の ${method.toUpperCase()}(ホスティングへの書き込み)`;
        const FIELD = /^(-f|-F|--field|--raw-field|--input)$/;
        const FIELD_ATTACHED = /^(-f|-F|--field=|--raw-field=|--input=)./;
        const hasField = args.some((a) => FIELD.test(a) || FIELD_ATTACHED.test(a));
        const fieldValues = args.filter((a, k) => FIELD_ATTACHED.test(a) || FIELD.test(args[k - 1] ?? ''));
        if (args.includes('graphql')) {
          if (/\bmutation\b/i.test(seg)) return 'gh api graphql の mutation(ホスティングへの書き込み)';
          // 問い合わせをファイルから渡す形(--input・query=@file)は、中身を確かめられないため拒否する
          if (args.some((a) => a === '--input' || /^--input=/.test(a)) || fieldValues.some((a) => /=@/.test(a))) return 'gh api graphql の問い合わせをファイルから渡す形(mutation かを確かめられない)';
          continue;
        }
        if (hasField && !(method && /^GET$/i.test(method))) return 'gh api の -f・-F・--input(既定で POST になる。ホスティングへの書き込み)';
      }
      continue;
    }
    if (['curl', 'wget', 'http', 'https', 'xh'].includes(head) && rest.some((a) => API_HOST.test(a))) {
      const writes = rest.some(
        (a, k) =>
          ((a === '-X' || a === '--request' || a === '--method') && WRITE_METHODS.test(String(rest[k + 1] ?? ''))) ||
          /^(-X|--request=|--method=)(POST|PUT|PATCH|DELETE)$/i.test(a) ||
          /^(-d|-F|-T)./.test(a) ||
          /^(-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-T|--upload-file|--post-data|--post-file)(=|$)/.test(a)
      );
      if (writes) return `${head} による GitHub の API への書き込み`;
    }
    if (/^(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)$/i.test(head) && API_HOST.test(seg) && /-Method\s+(Post|Put|Patch|Delete)\b/i.test(seg)) return `${head} による GitHub の API への書き込み`;
  }
  return null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    process.exit(0);
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !command.trim()) process.exit(0);
  const what = hostingWriteOf(command);
  if (!what) process.exit(0);
  let denyLog = '.claude/denied.log';
  try {
    denyLog = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/guard.json'), 'utf8')).denyLog ?? denyLog;
  } catch {
    /* guard.json が無くても遮断は続ける */
  }
  try {
    fs.appendFileSync(path.join(ROOT, denyLog), `${new Date().toISOString()}\thosting-write\t${what}\n`);
  } catch {
    /* 記録に失敗しても遮断は続ける */
  }
  console.error(
    `[強制層] ${what} を拒否しました。\n\n` +
      'AI の担い手は、ホスティングの上で承認・レビュー・マージ・記録用ブランチへの push・書き込みの操作と、認証情報の読み出しをしません。' +
      '人の認証情報で動く構成では、これらの操作はホスティングの記録の上で人の操作と区別できないためです(標準 第3章 3.5.3、CLAUDE.md の常駐の規則)。' +
      '人へ引き渡してください(受信箱のラベル)。読み取りの gh api(GET)は使えます'
  );
  process.exit(2);
}

// フックとして起動されたときだけ標準入力を読む(テストからは import できる)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

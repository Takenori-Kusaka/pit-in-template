// 機能仕様(specs/F-NNN/spec.md)の「確定した版」の3節を取り出す定義(process-compass #334)。
// 確定した版から変わる対象は、受入基準・前提・スコープ外の3節(標準 第4章「確定した版を変える場合」)。
// PR の時点の表示(check-pr.mjs 4c)が使う。出荷の証跡の集約(IMPL-0241 / #355)が同じ定義を使えるよう、節の取り出しを1か所に置く。
//
// 比較の形: 改行を LF に揃え、各行の行末の空白を除き、本文の先頭と末尾の空行を除く。行内の空白・途中の空行・表の整形は変えない。
// 表示では偽の一致・不一致が害にならないが、合否に使う場合は同じ規則でよいかを決め直す(#355)。

export const SPEC_FILE = /^specs\/F-\d+\/spec\.md$/;
export const CONFIRMED_SECTIONS = ['受入基準', '前提', 'スコープ外'];

/** 受入基準の節の見出し。spec-lint.mjs と同じ定義(階層は問わず、語は前方一致)。定義を2か所に持たない */
export const AC_HEADING = /^(#{1,6})\s*受入基準/;
/** 前提・スコープ外の見出し(階層は問わず、語は完全一致) */
const OTHER_HEADING = /^(#{1,6})\s+(前提|スコープ外)\s*$/;
const ANY_HEADING = /^(#{1,6})\s+\S/;
const FENCE = /^(```|~~~)/;

function headingOf(line) {
  const ac = AC_HEADING.exec(line);
  if (ac) return { name: '受入基準', level: ac[1].length };
  const o = OTHER_HEADING.exec(line);
  if (o) return { name: o[2], level: o[1].length };
  return null;
}

/** 3節の本文を返す。見出しが無い節は null。text が null なら3節とも null */
export function specSections(text) {
  const out = Object.fromEntries(CONFIRMED_SECTIONS.map((s) => [s, null]));
  if (text === null || text === undefined) return out;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const bodies = Object.fromEntries(CONFIRMED_SECTIONS.map((s) => [s, []]));
  let inFence = false;
  let current = null;
  let level = 0;
  for (const line of lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      if (current) bodies[current].push(line.replace(/\s+$/, ''));
      continue;
    }
    if (!inFence) {
      const m = headingOf(line);
      const any = ANY_HEADING.exec(line);
      // 節の中の、より深い階層の見出しは本文である。同じ階層以上の見出しで節が終わる
      if (current && any && any[1].length > level) {
        bodies[current].push(line.replace(/\s+$/, ''));
        continue;
      }
      if (m) {
        current = m.name;
        level = m.level;
        if (out[current] === null) out[current] = '';
        // 同じ見出しが複数あれば、出現順に本文を改行でつなぐ
        continue;
      }
      if (any) {
        current = null;
        continue;
      }
    }
    if (current) bodies[current].push(line.replace(/\s+$/, ''));
  }
  for (const s of CONFIRMED_SECTIONS) {
    if (out[s] === null) continue;
    const b = bodies[s];
    let i = 0;
    let j = b.length;
    while (i < j && b[i] === '') i++;
    while (j > i && b[j - 1] === '') j--;
    out[s] = b.slice(i, j).join('\n');
  }
  return out;
}

/** 基底の版と PR の先頭の版で、本文が一致しない節の名の配列(null と文字列の不一致も数える) */
export function changedSpecSections(baseText, headText) {
  const a = specSections(baseText);
  const b = specSections(headText);
  return CONFIRMED_SECTIONS.filter((s) => a[s] !== b[s]);
}

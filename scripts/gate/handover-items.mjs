// 運用引き継ぎ文書(docs/handover.md)の3項目(監視項目・障害時の連絡先・復旧手順)の未記入を検出する
// (標準 第4章 G-7 基準4 の記録 / IMPL-0043・出荷の証跡の集約。process-compass #355)。
//
// 純関数である。fs も git も呼ばない(文書と様式の本文は呼び出し側が渡す)。
//
// 機械が確かめるのは、置き場があるか、置き場が空欄または様式(templates/05-handover.md)の初期の文のままでないか、までである。
// 記入が在ることは、完備を意味しない。閾値の妥当性、連絡先へ届くか、復旧手順を実行できるかは確かめない。
// 様式の文を書き換えただけの記載と「未定」「TBD」の類は、記入として通る。完備は出荷判定者が読んで判定する。
//
// 置き場は見出しの語で引く(階層は問わない)。
//   監視項目       「監視」を含む見出しの節
//   障害時の連絡先 「障害時の連絡先」を含む見出しの節
//   復旧手順       「復旧手順」を含む見出しの節、または先頭のセルが「切り戻し」の表の行
// 見出しを改めた文書(例: 「監視」を含まない見出し)は、置き場が無いものとして扱う。

export const HANDOVER_ITEMS = [
  { id: 'monitoring', label: '監視項目', heading: '「監視」を含む見出し', test: (h) => h.includes('監視') },
  { id: 'contacts', label: '障害時の連絡先', heading: '「障害時の連絡先」を含む見出し', test: (h) => h.includes('障害時の連絡先') },
  { id: 'recovery', label: '復旧手順', heading: '「復旧手順」を含む見出し、または先頭のセルが「切り戻し」の表の行', test: (h) => h.includes('復旧手順') },
];

const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');

/** 比べるための正規化。NFKC・強調と引用の記号・先頭の箇条書きの記号・空白を除く */
const norm = (s) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, '');

/** 記入に数えない値: 空、ダッシュだけ、全体が <…> の形 */
const isBlank = (s) => {
  const n = norm(s);
  return n === '' || /^[-–—―ー]+$/.test(n) || /^<[^<>]*>$/.test(n);
};

const isTableLine = (l) => /^\s*\|/.test(l);
const isSeparator = (l) => /^[\s|:\-–—]+$/.test(l);
const cellsOf = (l) => {
  const t = l.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split(/(?<!\\)\|/).map((c) => c.trim());
};
/** 「- 欄名:」だけで値が空の箇条書き */
const isLabelOnly = (l) => /^\s*[-*+]\s+[^::]*[::]\s*$/.test(l.normalize('NFKC'));

/**
 * 本文を節と行へ分ける。戻りの sections は { heading, rows } の配列。rows は { cells, table } の配列。
 * 表の見出し行と区切り行は含めない。表でない行は cells に1要素(その行)を持つ。
 */
function parse(text) {
  const sections = [{ heading: '', rows: [] }];
  const lines = stripComments(text).replace(/\r\n/g, '\n').split('\n');
  let inTable = 0; // 0: 表の外、1: 見出し行の後、2: 本体
  for (const line of lines) {
    const h = line.match(/^#{1,6}[ \t]+(.*?)[ \t]*$/);
    if (h) {
      sections.push({ heading: h[1].normalize('NFKC'), rows: [] });
      inTable = 0;
      continue;
    }
    const cur = sections[sections.length - 1];
    if (isTableLine(line)) {
      if (inTable === 0) {
        inTable = 1; // 見出し行
        continue;
      }
      if (inTable === 1) {
        inTable = 2;
        if (isSeparator(line)) continue;
      }
      cur.rows.push({ cells: cellsOf(line), table: true });
      continue;
    }
    inTable = 0;
    if (!line.trim()) continue;
    cur.rows.push({ cells: [line.trim()], table: false });
  }
  return sections;
}

/** 様式の初期の文の集合(全セルと表の外の全行。正規化したもの) */
function initialSet(initialText) {
  const set = new Set();
  for (const s of parse(initialText)) {
    for (const r of s.rows) for (const c of r.cells) if (norm(c)) set.add(norm(c));
  }
  return set;
}

/**
 * 3項目ごとの結果を返す。result: 'filled'(様式の初期の文でない記入が1つ以上ある)/ 'unfilled'(置き場は在るが、空欄または初期の文のまま)/
 * 'missing'(置き場が無い)。initialText が null なら様式と比べず、空欄だけを見る(compared: false)
 */
export function handoverItems(text, initialText = null) {
  const compared = typeof initialText === 'string';
  const initial = compared ? initialSet(initialText) : new Set();
  const sections = parse(text);
  const items = HANDOVER_ITEMS.map((it) => {
    const places = []; // 行の集合
    for (const s of sections) if (s.heading && it.test(s.heading)) places.push(...s.rows);
    if (it.id === 'recovery') {
      for (const s of sections) for (const r of s.rows) if (r.table && norm(r.cells[0]) === '切り戻し') places.push(r);
    }
    const found = places.length > 0 || sections.some((s) => s.heading && it.test(s.heading));
    const filled = places.some((r) =>
      r.cells.some((c) => {
        if (isBlank(c)) return false;
        if (!r.table && isLabelOnly(c)) return false;
        return !initial.has(norm(c));
      }),
    );
    return { id: it.id, label: it.label, heading: it.heading, result: !found ? 'missing' : filled ? 'filled' : 'unfilled' };
  });
  return { items, compared };
}

/** 未記入・置き場なしの項目の、記載の欠落の文。記入ありの項目には null。「完備」「合格」の語を出力に使わない */
export function handoverGapText(item) {
  if (item.result === 'unfilled') return `運用引き継ぎ文書(docs/handover.md)の${item.label}が未記入です(様式の初期のまま、または空欄)`;
  if (item.result === 'missing') return `運用引き継ぎ文書(docs/handover.md)の${item.label}の置き場がありません(見出し: ${item.heading})`;
  return null;
}

const RESULT_LABEL = { filled: '記入あり', unfilled: '未記入', missing: '置き場なし' };

/** 集約の基準4 の行の結果の文 */
export function handoverResultText(info) {
  const parts = info.items.map((i) => `${i.label}=${RESULT_LABEL[i.result]}`).join(' / ');
  return `docs/handover.md あり。3項目の記入の有無: ${parts}${info.compared ? '' : '(様式の初期の文と比べていない。空欄だけを見た)'}`;
}

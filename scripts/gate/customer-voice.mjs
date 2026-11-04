// 顧客の声の検証の体制と裏づけの出所を確かめる(標準 第6章 D-0 表1「表1 の列の決まり」・テンプレ6 観点3。process-compass #411 / ADR-0091)。
//
//   - D-0 表1 の「市場・顧客仮説の検証の実施」の行が無い・決定か実行が空欄、実行の列が AI の担い手だけ(人を指名していない)は問題として返す
//   - 「決定」「同意」の列に席・会議体の名でない記載があれば、照合できない記載として返す(失敗にしない。役割名の語彙が閉じていないため。
//     決定権を委ねられていない担当かは、内部監査の観点24 で人が確かめる)
//   - 企画書の観点3 の裏づけの表で、出所の区分の未記入・語彙の外の区分と、「実在の顧客・利用者の観測」なのに観測の記録への到達先が無い行を返す
// 記述の中身(観測が本当に実在の顧客か)は判定しない(第5章 5.7.4)。

import { aiNameBlocked } from './config.mjs';

const squeeze = (s) => String(s ?? '').normalize('NFKC').replace(/[\s*`]/g, '');
const blankCell = (s) => {
  const v = squeeze(s);
  return !v || /^(—|-|<.*>|TBD|未定|\?\?\?)$/i.test(v);
};

/** 決定・同意の列に書いてよい席・会議体の名(準拠テンプレートの D-0 の語彙) */
export const SEAT_AND_BODY_NAMES = [
  '事業決裁者', '価値責任者', '技術判断者', '開発者', '独立レビュア', '出荷判定者', '品質保証', '文脈オーナー', 'コンテキストオーナー', 'AI維持管理者', 'AI運用担当者',
  '投資委員会', 'ステアリングコミッティ', '設計審査会', 'リリース判定会', 'B-1', 'B-2', 'B-3', 'B-4',
];

/** D-0 節3(決定の権限)の表の行を { title, cells[] } で返す */
function decisionRows(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*決定の種類\s*\|/.test(l));
  if (start < 0) return null;
  const rows = [];
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    rows.push({ title: cells[0] ?? '', cells: cells.slice(1) });
  }
  return rows;
}

/**
 * D-0 表1 の検証の行と、決定・同意の列の照合。
 * @returns {{ problems: string[], unmatched: string[] }} problems は失敗にする問題、unmatched は照合できない記載(注意)
 */
export function d0VerificationProblems(text, config) {
  const rows = decisionRows(text);
  if (!rows) return { problems: ['D-0 節3(決定の権限)の表がありません(templates/00-d0-governance.md から写す)'], unmatched: [] };
  const problems = [];
  const row = rows.find((r) => squeeze(r.title).startsWith(squeeze('市場・顧客仮説の検証の実施')));
  if (!row) problems.push('D-0 節3(決定の権限)に「市場・顧客仮説の検証の実施」の行がありません。templates/00-d0-governance.md から行を写し、決定と実行を記入してください(標準 第6章 D-0、ADR-0091)');
  else {
    const [decide, , , , exec] = row.cells;
    if (blankCell(decide)) problems.push('D-0 節3 の「市場・顧客仮説の検証の実施」の「決定」が未記入です。検証を発注する主体を体制の側に置きます(標準 第6章 D-0、ADR-0091)');
    if (blankCell(exec)) problems.push('D-0 節3 の「市場・顧客仮説の検証の実施」の「実行」が未記入です。実在の顧客・利用者を観測する担い手を書きます(標準 第6章 D-0、ADR-0091)');
    else {
      const tokens = String(exec).split(/[、,，/／・]/).map((t) => t.trim()).filter(Boolean);
      const humanSeat = (t) => /AI維持管理者|AI運用担当者/.test(t.normalize('NFKC').replace(/\s/g, ''));
      if (tokens.length && tokens.every((t) => !humanSeat(t) && (/^AI\b|AI の担い手|AIエージェント/i.test(t.normalize('NFKC')) || aiNameBlocked(config, t)))) {
        problems.push(`D-0 節3 の「市場・顧客仮説の検証の実施」の「実行」が AI の担い手だけです(${exec})。実在の顧客・利用者を観測する担い手を指名したことになりません(標準 第6章 D-0「表1 の列の決まり」)`);
      }
    }
  }
  const unmatched = [];
  for (const r of rows) {
    for (const [i, label] of [[0, '決定'], [1, '同意']]) {
      const v = r.cells[i];
      if (blankCell(v) || /該当なし/.test(String(v))) continue;
      const tokens = String(v).split(/[、,，/／]/).map((t) => squeeze(t.replace(/[((][^))]*[))]/g, ''))).filter(Boolean);
      const off = tokens.filter((t) => !SEAT_AND_BODY_NAMES.some((n) => t.includes(squeeze(n))));
      if (off.length) unmatched.push(`「${r.title}」の「${label}」の ${off.join('・')}`);
    }
  }
  return { problems, unmatched };
}

export const SOURCE_KINDS = ['実在の顧客・利用者の観測', '二次資料', 'AI の生成物'];

/** 企画書の観点3 の裏づけの表の問題。表が無い旧い様式は { missing: true } */
export function briefEvidenceProblems(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*裏づけ\s*\|\s*出所の区分\s*\|/.test(l));
  if (start < 0) return { missing: true, problems: [] };
  const problems = [];
  let rowsSeen = 0;
  for (let i = start + 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) {
    const [fact, kind, reach] = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (blankCell(fact)) continue;
    rowsSeen++;
    const k = squeeze(kind);
    const matched = SOURCE_KINDS.find((s) => k === squeeze(s));
    if (blankCell(kind)) problems.push(`観点3 の裏づけ「${fact}」の出所の区分が未記入です(${SOURCE_KINDS.join(' / ')})`);
    else if (!matched) problems.push(`観点3 の裏づけ「${fact}」の出所の区分「${kind}」は、${SOURCE_KINDS.join(' / ')} のいずれでもありません`);
    else if (matched === SOURCE_KINDS[0] && (blankCell(reach) || /^なし$/.test(squeeze(reach)))) problems.push(`観点3 の裏づけ「${fact}」は「実在の顧客・利用者の観測」ですが、観測の記録への到達先がありません`);
  }
  if (!rowsSeen) problems.push('観点3 の裏づけの表に行がありません(価値仮説を支える事実と出所の区分を書く)');
  return { missing: false, problems };
}

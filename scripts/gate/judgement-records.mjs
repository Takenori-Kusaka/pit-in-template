// 判定記録の読み取り(出荷の証跡の集約。process-compass #355 / 束 B20)。純関数である。git も gh も呼ばない。
//   IMPL-0667 必達基準2 の継続・保留の通算の回数(第7章 7.7.5 要求事項4)。人が書いた回数ではなく、記録の区分と判定から数える
//   IMPL-0622 案件に関与していない者による点検(7.7.6)の経過の表示。止めない
//   IMPL-0638 暫定任命の期間中の判定の併記(第3章 3.4.1)。併記を置けない判定は未達として表示する
//
// 限界(根拠水準マークで開示する): 機械が数えるのは必達基準2 の乙・丙の継続・保留だけである。甲へ戻した継続と、必達基準 1・3・4・5 は
// 数える材料が無く、manual(IMPL-0667 の分けた行)で確かめる。欄「7.7.5 の回数」の値は数えた回数を下げる向きには使えない。

const nf = (s) => String(s ?? '').normalize('NFKC');

/** 表の行「| 欄 | 値 |」の値を返す。欄名は前方一致。無ければ null */
function cellOf(text, key) {
  const m = String(text ?? '').match(new RegExp(`^\\|\\s*\\**${key}[^|]*\\**\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}

const CLASSES = ['甲', '乙', '丙'];
const VERDICTS = ['継続', '保留', '中止', '差し戻し'];

/**
 * 必達基準の判定記録 1 件から、数えるための値を読む。
 *   cls: 案件の区分(甲・乙・丙)。「案件 乙」とあればそれ、無ければ区分の欄に丙・乙・甲の順で含まれる最初のもの
 *   verdict: 判定の欄(継続・保留・中止・差し戻し)
 *   declared: 欄「7.7.5 の回数」の先頭の「通算 N 回」の N。読めなければ null
 *   readable: 区分と判定の両方を読めたか
 */
export function reachRecordOf({ file, text, judgedAt, inRange = true }) {
  const sec = String(text ?? '').split(/^##\s*到達の見込み.*$/m)[1]?.split(/^##\s/m)[0] ?? '';
  const clsCell = nf(cellOf(sec, '区分') ?? '').replace(/\([^()]*\)/g, '');
  const caseCls = clsCell.match(/案件(?:の区分)?\s*(?:[::]|は)?\s*(甲|乙|丙)/)?.[1] ?? null;
  const cls = caseCls ?? (['丙', '乙', '甲'].find((c) => clsCell.includes(c)) ?? null);
  const verdictCell = nf(cellOf(String(text ?? ''), '判定') ?? '');
  const verdict = VERDICTS.find((v) => verdictCell.startsWith(v)) ?? null;
  const declaredCell = nf(cellOf(String(text ?? ''), '7\\.7\\.5 の回数') ?? '');
  const declared = declaredCell.match(/^通算\s*(\d+)\s*回/)?.[1];
  return {
    file,
    judgedAt,
    cls,
    verdict,
    declared: declared === undefined ? null : Number(declared),
    inRange,
    readable: Boolean(cls && verdict),
  };
}

/**
 * 必達基準の判定記録(ゲート欄が「必達基準の判定」)を判定日時の順に見て、乙・丙で判定が継続・保留のものを数える。
 * 欄「通算 N 回」が読めるとき、N が数えた回数より大きければ N から続けて数える。N が数えた回数より小さい記録(範囲の中)は欠落にする。
 * 数えた回数が 4 回目以降の記録(範囲の中)は欠落にする。区分か判定を読めない記録は未確認として数えない。
 */
export function reachCounts(records) {
  const sorted = [...(records ?? [])].sort((a, b) => String(a.judgedAt ?? '').localeCompare(String(b.judgedAt ?? '')));
  const gaps = [];
  const unreadable = [];
  const items = [];
  let running = 0;
  for (const r of sorted) {
    if (!r.readable) {
      unreadable.push(r.file);
      items.push({ file: r.file, counted: false, count: running });
      continue;
    }
    const counted = ['乙', '丙'].includes(r.cls) && ['継続', '保留'].includes(r.verdict);
    if (!counted) {
      items.push({ file: r.file, counted: false, count: running });
      continue;
    }
    running += 1;
    if (r.declared !== null && r.declared !== undefined) {
      if (r.declared < running) {
        if (r.inRange) {
          gaps.push(
            `${r.file}: 必達基準2 の継続・保留の通算が ${running} 回に当たるのに、欄「7.7.5 の回数」が「通算 ${r.declared} 回」です。回数は必達基準の番号ごとに通算し、数え直せません。記載の欠落です(第7章 7.7.5 要求事項4)`
          );
        }
      } else if (r.declared > running) {
        running = r.declared;
      }
    }
    if (running >= 4 && r.inRange) {
      gaps.push(
        `${r.file}: 必達基準2 の不合格に対する継続・保留の判定が通算 ${running} 回目(4 回目以降)です。3 回を超えて継続または保留と判定できません。記載の欠落です(第7章 7.7.5 要求事項4。解く道: 中止か、甲へ戻る変更を判定に同時に記録する)`
      );
    }
    items.push({ file: r.file, counted: true, count: running });
  }
  return { items, gaps, unreadable, total: running };
}

/** 項目7 に出す 1 行。止める条件は gaps だけで、この行は表示である */
export function reachCountsText(res) {
  const n = res.items.length;
  return (
    `必達基準2 の継続・保留の通算の回数(第7章 7.7.5): 判定記録 ${n} 件、乙・丙の継続・保留を ${res.total} 回と数えた。` +
    `判定か区分を読めない記録は未確認 ${res.unreadable.length} 件。機械が数えるのは必達基準2 の乙・丙だけで、甲へ戻した継続と必達基準 1・3・4・5 は数えない`
  );
}

const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const VALID_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 案件に関与していない者による点検(第7章 7.7.6)の経過の表示。S1 以降だけが対象。
 * 棚卸しの判定記録(ゲート欄に「棚卸し」を含む)の最終の判定日と、突合の日までの経過日数を出す。記録なしか 365 日超は注意で、止めない。
 */
export function inventoryNotice({ records, stage, day }) {
  if (!stage || stage === 'S0') return { level: 'na', text: `案件に関与していない者による点検(7.7.6): 事業ステージ ${stage ?? '不明'} は対象外(S1 以降の規定)` };
  const days = (records ?? [])
    .filter((r) => /棚卸し/.test(nf(r.gate)))
    .map((r) => nf(r.judgedAt).slice(0, 10))
    .filter((d) => VALID_DAY.test(d) && d <= day)
    .sort();
  const last = days.at(-1);
  if (!last) return { level: 'attention', text: '案件に関与していない者による点検(7.7.6): 棚卸しの判定記録なし(注意。年 1 回以上の点検が要る。出荷は止めない)' };
  const elapsed = dayDiff(last, day);
  if (elapsed > 365) return { level: 'attention', text: `案件に関与していない者による点検(7.7.6): 最終 ${last}、経過 ${elapsed} 日(365 日超。注意。出荷は止めない)` };
  return { level: 'ok', text: `案件に関与していない者による点検(7.7.6): 最終 ${last}、経過 ${elapsed} 日(出荷は止めない)` };
}

const rowsOfTable = (lines, from) => {
  const rows = [];
  let i = from;
  while (i < lines.length && !lines[i].trim().startsWith('|')) i++;
  for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
    rows.push(cells);
  }
  return rows.slice(1);
};

/**
 * D-0 節9 の「暫定任命の期間」の表を読む。期間は「YYYY-MM-DD〜YYYY-MM-DD」。読めない行は unreadable に行の役割を入れる。
 * 空の行と様式の例(< で始まる)は読み飛ばす。
 */
export function provisionalPeriods(d0Text) {
  const lines = String(d0Text ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => /暫定任命の期間/.test(l) && !l.trim().startsWith('|'));
  const rows = [];
  const unreadable = [];
  if (at < 0) return { rows, unreadable };
  for (const c of rowsOfTable(lines, at + 1)) {
    const [role, subject, period] = [nf(c[0]), nf(c[1]), nf(c[2])];
    if (!role || role.startsWith('<')) continue;
    const m = period.match(/(\d{4}-\d{2}-\d{2})\s*(?:〜|~|から|--?)\s*(\d{4}-\d{2}-\d{2})/);
    if (!m || m[1] > m[2]) {
      unreadable.push(role);
      continue;
    }
    rows.push({ role, subject, from: m[1], to: m[2] });
  }
  return { rows, unreadable };
}

/** D-0 節9 の代行者の表から、役割ごとの代行者(後継候補)の名を返す */
function deputiesOf(d0Text, role) {
  const lines = String(d0Text ?? '').split(/\r?\n/);
  const at = lines.findIndex((l) => /^\|\s*役割\s*\|\s*代行者/.test(l));
  if (at < 0) return [];
  const out = [];
  for (const c of rowsOfTable(lines, at)) {
    if (nf(c[0]) === role && c[1] && !c[1].startsWith('<')) out.push(...nf(c[1]).split(/[、,/・]/).map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/**
 * 暫定任命の期間中の判定の併記(第3章 3.4.1。IMPL-0638)。
 *   records: [{ file, gate, judge, judgedAt, coSign }](coSign は判定記録の「確認済みの者の併記」)
 *   resolve(name) → 名簿の人の識別子 / null。isAi(name) → AI の名義か。holderOf(role) → 席の責任者の識別子 / null
 *   roleOfGate(gate) → その判定を担う席の名の候補(D-0 の役割の欄と比べる)
 * 対象: 期間の行の役割の席を担うゲートの判定で、判定日が期間内、判定者が期間の行の対象(責任者なら席の責任者、代理者なら代行者の欄の者)。
 * G-6 は対象にしない(第3章「席の責任者でない確認者の力量」が別の扱いを定める)。
 * 併記が無い・名簿の人でない・AI の名義・判定者本人の判定は unmet。期間か対象の人を読めない行は unconfirmed(未達にしない)。
 */
export function provisionalGaps({ d0Text, records, resolve, isAi, holderOf, roleOfGate }) {
  const { rows, unreadable } = provisionalPeriods(d0Text);
  const unmet = [];
  const unconfirmed = unreadable.map((r) => `${r}: 暫定任命の期間が日付として読めない`);
  let checked = 0;
  for (const row of rows) {
    const subjects = /代理者/.test(row.subject)
      ? deputiesOf(d0Text, row.role).map((n) => resolve(n)).filter(Boolean)
      : [holderOf(row.role)].filter(Boolean);
    if (!subjects.length) {
      unconfirmed.push(`${row.role}: 暫定任命の対象の人を特定できない`);
      continue;
    }
    for (const r of records ?? []) {
      if (/G-?6/.test(nf(r.gate))) continue;
      if (!roleOfGate(nf(r.gate)).includes(row.role)) continue;
      const day = nf(r.judgedAt).slice(0, 10);
      if (!(day >= row.from && day <= row.to)) continue;
      const judgeId = resolve(r.judge);
      if (!judgeId || !subjects.includes(judgeId)) continue;
      checked += 1;
      const co = nf(r.coSign).trim();
      let why = null;
      if (!co || co.startsWith('<') || /^(なし|無し|-|—|該当なし)/.test(co)) why = '確認済みの者の併記が無い';
      else if (isAi(co)) why = '併記が AI の名義';
      else if (!resolve(co)) why = '併記が名簿の人でない';
      else if (resolve(co) === judgeId) why = '併記が判定者本人';
      if (why) unmet.push({ file: r.file, role: row.role, why, inRange: r.inRange !== false });
    }
  }
  return { unmet, unconfirmed, checked };
}

/** 未達の表示の文(項目1)。CL1 以上と規制業は範囲の中の未達で出荷を止める(IMPL-0738) */
export function provisionalUnmetText(res) {
  if (!res.unmet.length && !res.unconfirmed.length && !res.checked) return null;
  const head = `暫定任命の期間中の判定(第3章 3.4.1): 対象 ${res.checked} 件のうち未達 ${res.unmet.length} 件(CL1 以上と規制業は、出荷の範囲の中の未達で出荷を止める)`;
  const list = res.unmet.map((u) => `${u.file}(${u.role}: ${u.why})`).join('、');
  const un = res.unconfirmed.length ? `。確認できない: ${res.unconfirmed.join(' / ')}` : '';
  return `${head}${list ? `: ${list}` : ''}${un}`;
}

/** 出荷を止める併記の未達(IMPL-0738)。出荷の範囲の中の判定だけを、集約の欠落へ渡す形にする */
export function cosignShipEntries(unmet) {
  return (unmet ?? []).filter((u) => u.inRange).map((u) => ({
    gate: 'provisional-cosign',
    label: `暫定任命の判定の併記(${u.file})`,
    reason: `${u.role}: ${u.why}`,
    howToResolve: ['確認済みの者の併記を置いた判定記録を起こし直す(第3章 3.4.1)'],
  }));
}

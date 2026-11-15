// 規模の観測(#295 / ADR-0058。保証の開示の観測。上限へは自動で反映しない)。
//
// 規模の基準値の超過は、失敗でなく規模の確認と区分の下限 R2 で扱う。その根拠(基準値が妥当か)は、超過の分布と、
// 超過した変更の確認の実態でしか較正できない。出荷の範囲の PR について、規模の分布・size:over の件数・
// 超過の理由の内訳(行・ファイル・別集計)・別集計の基準行数に対する倍率の分布・「読み切れたか」の内訳・
// 超過 PR の判定完了時間を、生の値で出す。基準値は各 PR の変更の起点の構成で判定している。
//
// 倍率の分布(1 倍超・2 倍超・5 倍超の件数)は、標準 第4章「基準値を超えた変更の扱い」の EV-0084 の差し替え条件
// (別集計が基準の数倍を超えた PR の件数)を観測できるようにするためのものである(process-compass #296)。
// 前回の集約との比較は出さない(課さないと決めた。何を判断するかを書けないため)。同じ入力からは同じ出力を返す。

const LINE_EDGES = [100, 400, 1000];
const FILE_EDGES = [5, 15, 30];
const LINE_LABELS = ['100 行以下', '101〜400 行', '401〜1000 行', '1001 行以上'];
const FILE_LABELS = ['5 以下', '6〜15', '16〜30', '31 以上'];
/** 別集計の倍率の区切り(基準行数に対する倍。それぞれ「超」で数える) */
export const TEST_RATIO_EDGES = [1, 2, 5];

const bucket = (v, edges) => {
  for (let i = 0; i < edges.length; i++) if (v <= edges[i]) return i;
  return edges.length;
};

const round1 = (v) => Math.round(v * 10) / 10;
/** 昇順の配列の分位点(下側の順位。中央値の求め方 floor((n-1)/2) と同じ流儀)。q は 0〜1 */
const quantile = (sorted, q) => sorted[Math.floor((sorted.length - 1) * q)];

/**
 * 承認までの時間と規模の比(IMPL-0159。標準 運用メトリクス「レビュー所要時間の分布」)と、文書だけの変更の承認までの時間(IMPL-0136 の観測)。
 * 承認の時間 reviewMinutes は、作成から最後の人の承認までの時計時間(承認者が掛けた時間の上限)。AI 名義の承認は数えない(集約が除く)。
 * 比は規模の区間(LINE_LABELS)ごとに、100 行あたりの分の最小・下位四分位・中央値と件数で出す。閾値とは比べない。前回との比較は出さない。
 * 承認者を特定する値は持たない(points は PR の番号・算定行数・分だけ)。散文の文書だけの変更(docOnly。文書の置き場と直下の *.md。強制層・構成は含まない)は算定行数が無く、比を持たない(ADR-0072)。強制層・構成・ロックファイルだけの変更は算定行数が 0 として noDenominator に数える
 */
function summarizeApprovalPace(sorted) {
  const per = LINE_LABELS.map(() => []);
  const points = [];
  let unmeasured = 0;
  let noDenominator = 0;
  const doc = { count: 0, hours: [0, 0, 0, 0], unmeasured: 0 };
  for (const p of sorted) {
    const m = Number.isFinite(p.reviewMinutes) ? p.reviewMinutes : null;
    if (p.docOnly === true) {
      doc.count++;
      if (m === null) doc.unmeasured++;
      else doc.hours[bucket(m / 60, [24, 48, 96])]++;
      continue;
    }
    if (m === null || !p.size) {
      unmeasured++;
      continue;
    }
    if (!(p.size.lines > 0)) {
      noDenominator++;
      continue;
    }
    per[bucket(p.size.lines, LINE_EDGES)].push((m / p.size.lines) * 100);
    points.push({ number: p.number, lines: p.size.lines, minutes: m });
  }
  return {
    approvalPace: {
      byLines: LINE_LABELS.map((range, i) => {
        const v = [...per[i]].sort((a, b) => a - b);
        return v.length
          ? { range, count: v.length, minPer100: round1(v[0]), q1Per100: round1(quantile(v, 0.25)), medianPer100: round1(quantile(v, 0.5)) }
          : { range, count: 0, minPer100: null, q1Per100: null, medianPer100: null };
      }),
      unmeasured,
      noDenominator,
      points,
    },
    docOnly: doc,
  };
}

/** prs は aggregate-evidence の PR の記録(size・sizeAttestation・reviewMinutes・docOnly・number・riskClass)。純関数 */
export function summarizeSizeObservation(prs, { notObserved = [] } = {}) {
  const lineDist = [0, 0, 0, 0];
  const fileDist = [0, 0, 0, 0];
  const att = { yes: 0, no: 0, unanswered: 0, absent: 0 };
  const reasons = { lines: 0, files: 0, test: 0, filesOnly: 0, unknown: 0 };
  const ratio = Object.fromEntries(TEST_RATIO_EDGES.map((e) => [e, 0]));
  let ratioMeasured = 0;
  const overPrs = [];
  const unreadable = [];
  const undetermined = [];
  let measured = 0;
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  for (const p of sorted) {
    if (!p.size) {
      unreadable.push(p.number);
      continue;
    }
    measured++;
    lineDist[bucket(p.size.lines, LINE_EDGES)]++;
    fileDist[bucket(p.size.files, FILE_EDGES)]++;
    if (Number.isFinite(p.size.testRatio)) {
      ratioMeasured++;
      for (const e of TEST_RATIO_EDGES) if (p.size.testRatio > e) ratio[e]++;
    }
    if (p.size.over === null) {
      undetermined.push(p.number);
      continue;
    }
    if (!p.size.over) continue;
    overPrs.push(p);
    const r = p.size.overReasons;
    if (!r) reasons.unknown++;
    else {
      if (r.lines) reasons.lines++;
      if (r.files) reasons.files++;
      if (r.test) reasons.test++;
      if (r.files && !r.lines && !r.test) reasons.filesOnly++;
    }
    if (!p.sizeAttestation) att.absent++;
    else if (p.sizeAttestation.readAll === 'yes') att.yes++;
    else if (p.sizeAttestation.readAll === 'no') att.no++;
    else att.unanswered++;
  }
  const pace = summarizeApprovalPace(sorted);
  const minutes = overPrs.map((p) => p.reviewMinutes).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const median = minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)] : null;
  return {
    total: prs.length,
    measured,
    unreadable,
    undetermined,
    lineDist: LINE_LABELS.map((l, i) => ({ range: l, count: lineDist[i] })),
    fileDist: FILE_LABELS.map((l, i) => ({ range: l, count: fileDist[i] })),
    over: overPrs.length,
    overReasons: reasons,
    testRatio: { measured: ratioMeasured, over: TEST_RATIO_EDGES.map((e) => ({ factor: e, count: ratio[e] })) },
    overPrs: overPrs.map((p) => ({
      number: p.number,
      lines: p.size.lines,
      files: p.size.files,
      testRatio: p.size.testRatio ?? null,
      reasons: p.size.overReasons ? Object.entries(p.size.overReasons).filter(([, v]) => v).map(([k]) => k) : null,
      readAll: p.sizeAttestation?.readAll ?? null,
      attested: Boolean(p.sizeAttestation),
      riskClass: p.riskClass,
      reviewMinutes: p.reviewMinutes,
    })),
    attestation: att,
    reviewMinutes: { n: minutes.length, median, max: minutes.length ? minutes.at(-1) : null },
    approvalPace: pace.approvalPace,
    docOnly: pace.docOnly,
    notObserved: [...notObserved].sort((a, b) => a - b),
    testLines: sorted.reduce((n, p) => n + (p.size?.testLines ?? 0), 0),
  };
}

const REASON_LABEL = { lines: '行数', files: 'ファイル数', test: '別集計' };

export function renderSizeObservation(o) {
  const R = ['### 観測: 変更規模と規模の確認(7項目に数えない。基準値へは自動で反映しない)', ''];
  if (!o.total) {
    R.push('出荷の範囲に PR を経た変更はありません。');
    R.push('');
    return R;
  }
  R.push(
    `出荷の範囲の PR ${o.total} 件のうち、規模を測れたもの ${o.measured} 件${o.unreadable.length ? `。**読めなかったもの ${o.unreadable.length} 件(#${o.unreadable.join(', #')})**。マージコミットの差分を読めないため、規模を空として扱わず、ここに出している` : ''}。` +
      `算定は製品のコードのファイルごとの max(追加, 削除)の合計で、テスト・fixture・snapshot(出荷の範囲で ${o.testLines} 行)は別に数えます。基準値は各 PR の変更の起点の構成で判定しています。`
  );
  if (o.undetermined.length) R.push(`- **超過か判定できなかった PR ${o.undetermined.length} 件(#${o.undetermined.join(', #')})**。変更の起点の構成を読めないため、超過なしとは扱わない`);
  R.push('');
  R.push('| 区間(行数) | 件数 | 区間(ファイル数) | 件数 |');
  R.push('| --- | --- | --- | --- |');
  for (let i = 0; i < o.lineDist.length; i++) R.push(`| ${o.lineDist[i].range} | ${o.lineDist[i].count} | ${o.fileDist[i].range} | ${o.fileDist[i].count} |`);
  R.push('');
  const a = o.attestation;
  const rs = o.overReasons ?? { lines: 0, files: 0, test: 0, filesOnly: 0, unknown: 0 };
  R.push(`- size:over の件数: ${o.over}`);
  R.push(
    `- 超過の理由の内訳(1 件が複数に当たりうる): 行数 ${rs.lines} / ファイル数 ${rs.files}(うちファイル数だけ ${rs.filesOnly}) / 別集計 ${rs.test}` +
      (rs.unknown ? ` / 内訳を取れなかったもの ${rs.unknown}` : '')
  );
  if (o.testRatio) {
    R.push(
      `- 別集計の行数の、基準行数に対する倍率(基準行数を測れた ${o.testRatio.measured} 件): ` +
        o.testRatio.over.map((x) => `${x.factor} 倍超 ${x.count} 件`).join(' / ') +
        '。5 倍超が別集計の size:over に当たる(標準 第4章 EV-0084 の差し替え条件の観測)'
    );
  }
  R.push(`- 規模の確認の「読み切れたか」: はい ${a.yes} / いいえ ${a.no} / 欄なしまたは未回答(担保水準の宣言で保証の所在だけを記入したものを含む) ${a.unanswered} / 規模の確認の節なし ${a.absent}`);
  R.push(
    `- 超過 PR の判定完了時間(作成から最後の人の承認まで。上側の近似): ${o.reviewMinutes.n ? `${o.reviewMinutes.n} 件で中央値 ${o.reviewMinutes.median} 分、最大 ${o.reviewMinutes.max} 分` : '取れなかった(PR の作成日時、または人の承認の日時が記録に無い。AI 名義だけの承認を含む)'}`
  );
  if (o.approvalPace) {
    const ap = o.approvalPace;
    R.push('');
    R.push('#### 承認までの時間と規模の比(観測。作成から最後の人の承認までの時計時間で、承認者が掛けた時間の上限。合否にも警戒の条件にも使わない)');
    R.push('');
    R.push('| 区間(算定行数) | 件数 | 100 行あたりの分(最小) | 同(下位四分位) | 同(中央値) |');
    R.push('| --- | --- | --- | --- | --- |');
    for (const b of ap.byLines) R.push(`| ${b.range} | ${b.count} | ${b.minPer100 ?? '-'} | ${b.q1Per100 ?? '-'} | ${b.medianPer100 ?? '-'} |`);
    R.push('');
    R.push(
      `- 比を持たないもの: 人の承認または規模を取れなかった ${ap.unmeasured} 件(人の承認は、先頭の版への承認で、G-6 に数えた承認者のものに限る) / 算定行数が 0(強制層・構成・ロックファイルだけの変更を含む) ${ap.noDenominator} 件。短い値は「短かった」と確かめられるが、長い値は何も言えない。AI 名義の承認は数えない。承認者別の内訳は出さない`
    );
  }
  if (o.docOnly) {
    const d = o.docOnly;
    R.push('');
    R.push('#### 文書だけの変更の承認までの時間(観測。SLA の判定ではない。48 時間以内は 2 営業日以内。それを超える値から超過は読めない)');
    R.push('');
    R.push(
      `- 算定から除いた散文の文書だけの変更(文書の置き場と直下の *.md。強制層・構成は含まない) ${d.count} 件。作成から最後の人の承認まで: 24 時間以内 ${d.hours[0]} / 48 時間以内 ${d.hours[1]} / 96 時間以内 ${d.hours[2]} / 96 時間超 ${d.hours[3]} / 取れなかった ${d.unmeasured}。算定行数が無く、規模との比は持たない`
    );
  }
  if (o.notObserved?.length) R.push(`- **PR の記録を読めず、観測に入らなかったもの ${o.notObserved.length} 件(#${o.notObserved.join(', #')})**。この節の母数は、PR の記録を読めたものだけである`);
  R.push('');
  if (o.overPrs.length) {
    R.push(
      `- 超過 PR: ${o.overPrs
        .map((p) => `#${p.number}(${p.lines} 行 / ${p.files} ファイル。理由 ${p.reasons ? p.reasons.map((r) => REASON_LABEL[r]).join('・') : '不明'}。区分 ${p.riskClass ?? '未記入'})`)
        .join('、')}`
    );
  }
  R.push('- 差し戻された PR(マージされなかったもの)は、この集約が見る範囲(マージ済みの変更)に無い。差し戻しの件数は PR の記録(GitHub)で確かめる');
  R.push('');
  return R;
}

// 未実施・未測定の継続期間の計算(保証の開示 項目4・項目6。標準 第4章 G-5「構成で選んだ未実施」、ADR-0151。process-compass #330 T-1 / IMPL-0993)。
//
// 純関数だけを持つ。git も時計も呼ばない(必要な値は引数で渡す)。継続期間は表示の材料で、合否には使わない。閾値も課さない
// (継続が長くても集約の problems・gaps は増えない。ADR-0151 で課さないと決めた)。
//
//   - unrunStreak: 1つの検査・層の継続期間。項目6(検出率の未測定の継続)と項目4(未実施の継続)が同じ関数を使う
//   - computeUnrunStreaks: 項目4 の検査ごとの継続期間。値が「未実施」「未測定」で始まるものだけを数える
//   - streakText: 継続期間の文

/** 項目4 の機械検査のうち、継続期間を数えるもの。記録なし(アダプタが無い)と gate-g5 の集計は対象外 */
export const UNRUN_CHECKS = ['test', 'coverage', 'staticAnalysis', 'dependencyAudit', 'licenses', 'secretScan'];

/** 値が未実施または未測定か(前置きの一致で決める。理由は問わない) */
export function isUnrunValue(v) {
  return typeof v === 'string' && (v.startsWith('未実施') || v.startsWith('未測定'));
}

/**
 * 1つの検査・層の継続期間。
 *   measured: 今回は実施・測定できているか。できていれば継続は無い
 *   prevSince / prevReleases: 前回の出力が持つ起点と回数
 *   prevWasUnmeasured: 前回の値が未実施・未測定だったか(前回が起点を持たない旧い形式のときに使う)
 *   previous: 前回の出力(無ければ null)。sameRelease: 前回と同じ出荷の再集計か。releaseDay: 今回の出荷の日
 *   dayOfRef: 参照(コミット等)の日を返す関数
 */
export function unrunStreak({ measured, prevSince, prevReleases, prevWasUnmeasured, previous, sameRelease, releaseDay, dayOfRef }) {
  if (measured) return { since: null, releases: 0, note: null };
  // 同じ出荷の再集計では、回数を進めない
  if (sameRelease && prevSince) return { since: prevSince, releases: prevReleases ?? 1, note: null };
  if (prevSince) return { since: prevSince, releases: (prevReleases ?? 1) + 1, note: null };
  if (previous && prevWasUnmeasured && !sameRelease) {
    // 起点を持たない旧い形式の出力。前回の出荷を起点とする
    const since = dayOfRef(previous.range?.to) || String(previous.generatedAt ?? '').slice(0, 10) || releaseDay;
    return { since, releases: 2, note: null };
  }
  return { since: releaseDay, releases: 1, note: previous ? '今回の出荷から' : '前回の出力なし。起点は今回' };
}

export const streakText = (st) => `${st.since} の出荷から ${st.releases} 回連続${st.note ? `。${st.note}` : ''}`;

/**
 * 項目4 の検査ごとの継続期間。{ <検査>: { since, releases, note } } を返す(未実施・未測定の検査だけ。実施に戻れば消える)。
 *   machineChecks: 今回の項目4 の値(検査名 → 文字列)
 *   prevMachineChecks: 前回の出力の machineChecks(無ければ null)。前回の unrunStreaks を読む
 * 理由が変わっても、未実施・未測定が続く限り途切れない。検査ごとに独立して数える
 */
export function computeUnrunStreaks({ machineChecks, prevMachineChecks = null, previous = null, sameRelease = false, releaseDay, dayOfRef = () => null }) {
  const out = {};
  for (const name of UNRUN_CHECKS) {
    if (!isUnrunValue(machineChecks?.[name])) continue;
    const prev = prevMachineChecks?.unrunStreaks?.[name] ?? null;
    // 旧い形式(unrunStreaks なし)の前回で licenses が「実施」のとき: 旧い集約は空のコマンドも実施と出した(IMPL-0995)。
    // 前回が実施だったと確かめたようには読ませない
    const legacyRun = name === 'licenses' && prevMachineChecks && !prevMachineChecks.unrunStreaks && String(prevMachineChecks.licenses ?? '').startsWith('実施');
    out[name] = unrunStreak({
      measured: false,
      prevSince: prev?.since ?? undefined,
      prevReleases: prev?.releases ?? undefined,
      prevWasUnmeasured: isUnrunValue(prevMachineChecks?.[name]),
      previous,
      sameRelease,
      releaseDay,
      dayOfRef,
    });
    if (legacyRun && out[name].note === '今回の出荷から') out[name].note = '前回の出力は旧い形式(空のライセンス検査も実施と出した)。起点は今回';
  }
  return out;
}

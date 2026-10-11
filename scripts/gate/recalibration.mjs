// 能力依存の定数の再評価待ち(#295 / ADR-0058 決定6)。
//
//   node scripts/gate/recalibration.mjs [--json]
//
// 登録簿(recalibration-registry.json)の能力依存の定数について、再評価の契機が来ているものを数える。契機は2つだけである。
//   1. /process-change(種別 performer)の記録(changeLog)にある、モデル・指示資産の版の変更(最後の再評価の後のもの)
//   2. 暦(最後の再評価、記録が無ければ構成の生成日から半期)
// 「世界のモデルが賢くなった」は契機にしない(観測できる記録だけを使う)。契機で値を自動で変えない。
// 人が「残す・外す・移す」を docs/calibration-register.md へ記名で記録すると、その定数の再評価待ちが解ける。
// 能力に依らない周期・窓(capabilityDependent: false)は、再評価待ちに数えない(能力が上がっても短縮しない)。
//
// 読み取りだけを行う。値を書き換えない。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadConfig, localDay, aiNameBlocked, resolveSigner } from './config.mjs';

export const REGISTRY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recalibration-registry.json');
export const REGISTER_PATH = 'docs/calibration-register.md';
const DECISIONS = ['残す', '外す', '移す'];

export function readRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
}

/** 再評価の記録の表(| ID | 判断 | 日付 | 記名 | 移した先 |)を読む。AI の名義・名簿の外の記名は数えない */
export function readCalibrationRecords(config, text) {
  const latest = new Map();
  const ignored = [];
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!/^RC-\d+$/.test(cells[0] ?? '')) continue;
    const [id, decision, day, by, to] = cells;
    if (!DECISIONS.includes(decision) || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
      ignored.push(`${id}: 判断(残す・外す・移す)または日付の形が違う`);
      continue;
    }
    if (!by || aiNameBlocked(config, by) || !resolveSigner(config, by.replace(/^@/, ''))) {
      ignored.push(`${id}: 記名 "${by ?? ''}" が AI の名義、または人の名簿の人でない`);
      continue;
    }
    if (decision === '移す' && !(to ?? '').trim()) {
      ignored.push(`${id}: 「移す」に移した先の保証が無い`);
      continue;
    }
    if (!latest.has(id) || latest.get(id).day < day) latest.set(id, { id, decision, day, by, to });
  }
  return { latest, ignored };
}

/** 再評価待ちを数える。registry・records は試験で差し替えられる */
export function recalibrationState(config, { today = localDay(), registry = readRegistry(), recordsText = null } = {}) {
  const text = recordsText ?? (fs.existsSync(path.join(ROOT, REGISTER_PATH)) ? fs.readFileSync(path.join(ROOT, REGISTER_PATH), 'utf8') : '');
  const { latest, ignored } = readCalibrationRecords(config, text);
  // 基準日は changeLog の最初の記録の日付(構成を生成した日)。config.generatedAt は /process-change のたびに更新されるため使わない
  // (無関係な settings の変更で暦が後ろへずれ、契機を失う)。最初の記録が無ければ generatedAt を最後の手段にする
  const baseline0 = String((config?.changeLog ?? [])[0]?.date ?? config?.generatedAt ?? '').slice(0, 10) || null;
  const performerChanges = (config?.changeLog ?? []).filter((e) => e?.kind === 'performer' && e.date).map((e) => String(e.date).slice(0, 10));
  const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const items = [];
  for (const c of registry.constants) {
    if (!c.capabilityDependent) continue;
    const rec = latest.get(c.id) ?? null;
    const baseline = rec?.day ?? baseline0;
    const reasons = [];
    if (baseline) {
      // 記録が無い定数は、基準日と同じ日の変更も数える(>=)。記録がある定数は、記録の日より後の変更を数える(同日の記録は、その日の変更を見たうえで書かれたものとして解く)
      const changed = performerChanges.filter((d) => (rec ? d > baseline : d >= baseline));
      if (changed.length) reasons.push(`担い手のモデル・指示資産の版の変更(/process-change performer。${changed.at(-1)})`);
      const due = addDays(baseline, registry.calendarDays ?? 183);
      if (today >= due) reasons.push(`暦(${rec ? '最後の再評価' : '構成の生成'} ${baseline} から ${registry.calendarDays ?? 183} 日。見直し日 ${due})`);
    }
    if (reasons.length) items.push({ id: c.id, name: c.name, reasons, lastDecision: rec, noRelax: Boolean(c.noRelaxByCapability) });
  }
  return {
    total: registry.constants.filter((c) => c.capabilityDependent).length,
    pending: items,
    count: items.length,
    notDependent: registry.constants.filter((c) => !c.capabilityDependent).map((c) => c.id),
    ignored,
  };
}

/** /process-change の出力と /pit の注記の文。再評価待ちが無ければ null */
export function recalibrationNote(state) {
  if (!state.count) return null;
  return (
    `再評価待ちの能力依存の定数 ${state.count} 件(${state.pending.map((p) => `${p.id} ${p.name}`).join(' / ')})。契機: ${[...new Set(state.pending.flatMap((p) => p.reasons.map((r) => r.replace(/\(.*$/, ''))))].join('、')}。` +
    `値は自動で変えない。人が「残す・外す・移す」を ${REGISTER_PATH} へ記名で記録する(移す場合は移した先の保証を書く)。` +
    (state.pending.some((p) => p.noRelax)
      ? `${state.pending.filter((p) => p.noRelax).map((p) => p.id).join('・')} は人の帯域に由来する。**能力が上がったことを理由に緩めない**。変えるなら、実績(充足率)と手段の変化の記録を要する。`
      : '') +
    '能力が上がったことを理由に、観測窓・力量確認の周期・監査の周期は短縮しない(登録簿で「能力に依らない」と明記)' +
    `${state.ignored.length ? `。数えなかった記録: ${state.ignored.join(' / ')}` : ''}`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  const state = recalibrationState(config);
  if (process.argv.includes('--json')) console.log(JSON.stringify(state, null, 2));
  else console.log(recalibrationNote(state) ?? `再評価待ちの能力依存の定数はありません(登録 ${state.total} 件)`);
}

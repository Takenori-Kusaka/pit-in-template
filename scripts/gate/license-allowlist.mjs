// 暫定のライセンスの許可(構成 ci.provisionalLicenses。標準 第4章 G-5「許可リストが判定を妨げた場合の救済」。IMPL-0683。ADR-0222)
//
// 暫定の許可は、期限までのすべての PR に効く範囲の許可である。第7章の例外承認の台帳(1 行が 1 つのゲートの 1 つの対象)では受けない。
// 許可を出す者は法務またはその委任先で、7.3 の決定者(D-0 節3)と別である。失効の効果は「基準5 で再び停止」である。
//
//   ci.provisionalLicenses: [{ license, expires(YYYY-MM-DD), approvedBy, reason }]
//
// - 有効な一覧は effectiveAllowedLicenses() の 1 関数だけが作る。恒久の一覧(ci.allowedLicenses)へ混ぜない
// - 期限の日は有効。翌日から外れる。必須の欄(license・expires・approvedBy・reason)の欠けた行は一覧へ入れない
// - アダプタを経ない経路(ip-clearance-python.mjs が構成から直接読む場合)は恒久の一覧だけを読む。止める側に倒れる
import { isRealDay } from './config.mjs';

const filled = (v) => typeof v === 'string' && v.trim() !== '';

/** 暫定の許可の行の欠陥。構成の検査(generate-profile.mjs の設定の検査)が拒否に使う */
export function provisionalLicenseProblems(config) {
  const list = config?.ci?.provisionalLicenses;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return ['ci.provisionalLicenses は配列で書きます'];
  const out = [];
  list.forEach((e, i) => {
    const at = `ci.provisionalLicenses[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return out.push(`${at} はオブジェクトで書きます`);
    for (const k of ['license', 'expires', 'approvedBy', 'reason']) if (!filled(e[k])) out.push(`${at}.${k} が空です(license・expires・approvedBy・reason は全て要ります)`);
    if (filled(e.expires) && !isRealDay(e.expires)) out.push(`${at}.expires "${e.expires}" は実在する日付(YYYY-MM-DD)ではありません`);
  });
  return out;
}

/**
 * 基準5 へ渡す許可リストを作る。
 * @returns {{ allowed: string[], active: object[], expired: object[], problems: string[] }}
 *   allowed = 恒久の一覧 + 期限の内の暫定の許可。active・expired は項目5 の開示に使う
 */
export function effectiveAllowedLicenses(config, day) {
  const permanent = Array.isArray(config?.ci?.allowedLicenses) ? [...config.ci.allowedLicenses] : [];
  const list = Array.isArray(config?.ci?.provisionalLicenses) ? config.ci.provisionalLicenses : [];
  const active = [];
  const expired = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || !['license', 'expires', 'approvedBy', 'reason'].every((k) => filled(e[k])) || !isRealDay(e.expires)) continue;
    (e.expires >= day ? active : expired).push(e);
  }
  const allowed = [...permanent];
  for (const e of active) if (!allowed.includes(e.license)) allowed.push(e.license);
  return { allowed, active, expired, problems: provisionalLicenseProblems(config) };
}

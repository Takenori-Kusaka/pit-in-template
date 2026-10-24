// 常駐の規則の照合(claude-md-resident.mjs)の変異の試験(process-compass #314 / ADR-0083 決定2)。
//
//   node scripts/gate/test-claude-md-resident.mjs
//
// 固定する決定:
//   - 規則ごとに、核の文言を正規化して、同じ節の行と照合する
//   - 変異(行の削除・節を 1 行に置き換える・否定を除く)で照合が落ちる
//   - 案件が行の前後へ書き足すこと、節の中で並べ替えること、節へ行を足すことは妨げない
//   - 一覧の作り直し(--write-resident)は追加だけ。一覧から消えた規則を CLAUDE.md から読み直して消さない。omit の規則を足し戻さない
// テンプレートの CLAUDE.md の写しを変えて試します。リポジトリの状態を変えません。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { buildManifest, extractRules, loadManifest, missingResident, normalizeRule } from './claude-md-resident.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}

const TEXT = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const manifest = loadManifest();
const miss = (text) => missingResident(text, manifest);
const ruleOf = (pattern) => manifest.rules.find((r) => pattern.test(r.core));

check('一覧に規則がある(規則ごとの識別子・節・核の文言)', manifest.rules.length > 0 && manifest.rules.every((r) => /^CR-\d{3}$/.test(r.id) && r.section && r.core));
check('テンプレートの CLAUDE.md は、一覧のすべての節と規則を満たす', (() => {
  const m = miss(TEXT);
  return m.absent.length + m.empty.length + m.rules.length === 0;
})());

// 変異1: 行の削除
{
  const line = TEXT.split('\n').find((l) => l.includes('委任の範囲に当たるかを自分で判定しない'));
  const m = miss(TEXT.replace(`${line}\n`, ''));
  const r = ruleOf(/^委任の範囲に当たるかを自分で判定しない/);
  check('変異: 規則の行を消すと、その規則が無いと出る', Boolean(r) && m.rules.length === 1 && m.rules[0].id === r.id, JSON.stringify(m.rules));
  check('変異: 行を消しても節の見出しと本文は残る(節の照合だけでは落ちない経路)', m.absent.length === 0 && m.empty.length === 0);
}

// 変異2: 節を 1 行に置き換える
{
  const start = TEXT.indexOf('### 判断の確定と委任');
  const end = TEXT.indexOf('### 受信箱とラベル');
  const m = miss(`${TEXT.slice(0, start)}### 判断の確定と委任(第5章 5.5)\n\n- 判断は人が確定する。\n\n${TEXT.slice(end)}`);
  const inSection = manifest.rules.filter((r) => r.section.startsWith('判断の確定と委任'));
  check(
    '変異: 節を 1 行に置き換えると、節の規則がすべて無いと出る',
    inSection.length > 3 && m.rules.length === inSection.length && m.absent.length === 0 && m.empty.length === 0,
    `${m.rules.length} / ${inSection.length}`
  );
}

// 変異3: 否定を除く
{
  const m1 = miss(TEXT.replace('**`graft init` を実行しない**', '**`graft init` を実行する**'));
  check('変異: 否定を除く(実行しない → 実行する)と、その規則が無いと出る', m1.rules.length === 1 && /graft init/.test(m1.rules[0].core), JSON.stringify(m1.rules));
  const m2 = miss(TEXT.replace('| 4 | 差分を確認せずに承認する |', '| 4 | 差分を確認して承認する |'));
  check('変異: 表の行の禁止事項の文言を変えると、その規則が無いと出る', m2.rules.length === 1 && /差分を確認せずに承認する/.test(m2.rules[0].core), JSON.stringify(m2.rules));
  const m3 = miss(TEXT.replace('**AI は停止を解除しない**', '**AI も停止を解除する**'));
  check('変異: 停止の解除の禁止を除くと、その規則が無いと出る', m3.rules.length === 1 && m3.rules[0].section.startsWith('停止の申し立て'), JSON.stringify(m3.rules));
}

// 案件の編集の自由: 行の前後への書き足し・並べ替え・行の追加・止める仕組みの列の書き換え(行の途中への挿入は文言の変更として落ちる)
{
  let t = TEXT.replace('- **`graft init` を実行しない**', '- 案件の注: **`graft init` を実行しない**');
  t = t.replace(/^(- \*\*AI の確認は検出の層\*\*.*)$/m, '$1 案件の補足: 当社の CI では静的解析の結果も同じ扱い。');
  const start = t.indexOf('### 一律で AI に委譲できない領域');
  const end = t.indexOf('### 判断の確定と委任');
  const sec = t.slice(start, end).split('\n');
  const items = sec.filter((l) => l.startsWith('- ')).reverse();
  let k = 0;
  const reordered = sec.map((l) => (l.startsWith('- ') ? items[k++] : l)).join('\n');
  t = `${t.slice(0, start)}${reordered.replace('- 安全に関する最終的な判断', '- 案件で足した規則: 決済の金額の確定\n- 安全に関する最終的な判断')}${t.slice(end)}`;
  t = t.replace(/\| 4 \| 差分を確認せずに承認する \| 指示文/, '| 4 | 差分を確認せずに承認する | 当社のレビューのボット');
  const m = miss(t);
  check('案件の編集: 前後への書き足し・並べ替え・行の追加・止める仕組みの列の書き換えでは落ちない', m.absent.length + m.empty.length + m.rules.length === 0, JSON.stringify(m.rules));
}

// 正規化: 太字・逆引用符・リンクの記法・HTML コメント・全角の違いを除く
{
  check('正規化: 太字と逆引用符と HTML コメントを除く', normalizeRule('**`graft init` を実行しない** <!-- 根拠: x -->') === 'graft init を実行しない');
  check('正規化: リンクは文だけを残す', normalizeRule('[用語集](context/glossary.md) を読む') === '用語集 を読む');
}

// 作り直しは追加だけ
{
  const removed = { ...manifest, rules: manifest.rules.slice() };
  const extra = { id: 'CR-999', section: '迷ったら', core: '案件の CLAUDE.md から消えた規則' };
  removed.rules.push(extra);
  const built = buildManifest(TEXT, removed);
  check('作り直し: CLAUDE.md に無い規則も一覧から消さない(追加だけ)', built.rules.some((r) => r.id === 'CR-999'));
  const added = buildManifest(`${TEXT}\n### 案件の節\n\n- 新しい規則を書く。\n`, manifest);
  const last = added.rules[added.rules.length - 1];
  check('作り直し: 新しい規則に次の番号を振って足す', added.rules.length === manifest.rules.length + 1 && last.core === '新しい規則を書く' && last.id === `CR-${String(manifest.rules.length + 1).padStart(3, '0')}`, JSON.stringify(last));
  const target = manifest.rules[0];
  const omitted = buildManifest(TEXT, { ...manifest, rules: manifest.rules.slice(1), omit: [{ ...target, reason: '試験' }] });
  check('作り直し: omit へ移した規則を足し戻さない', !omitted.rules.some((r) => r.core === target.core) && omitted.omit.length === 1);
  check('抽出: 所在だけの行(理由: / 詳細:)と説明の段落は規則に数えない', !extractRules(TEXT).some((r) => /^(理由|詳細)/.test(r.core) || /^各行の/.test(r.core)));
}

if (failures) {
  console.error(`\n常駐の規則の照合の試験: ${failures} 件の失敗`);
  process.exit(1);
}
console.log('\n常駐の規則の照合の試験: すべて通過');

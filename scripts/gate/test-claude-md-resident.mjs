// 常駐の規則の照合(claude-md-resident.mjs)の変異の試験(process-compass #314 / ADR-0084 決定2)。
//
//   node scripts/gate/test-claude-md-resident.mjs
//
// 固定する決定:
//   - 規則ごとに、核の文言を正規化して、同じ節の行と照合する
//   - 変異(行の削除・節を 1 行に置き換える・否定を除く・節の本文を複数行のコメントで囲む)で照合が落ちる
//   - 案件が行の前後へ書き足すこと、節の中で並べ替えること、節へ行を足すこと、太字を外すことは妨げない
//   - 一覧の作り直し(--write-resident)は追加だけ。一覧から消えた規則を CLAUDE.md から読み直して消さない。omit の規則を足し戻さない
//   - omit の各項目に reason と approvedBy(AI の名義でない)が要る
//
// 変異は、この試験の中に持つ固定の写し(FIXTURE)に対して行います。案件の CLAUDE.md は読みません。
// 案件の CLAUDE.md の照合は check-process-rules.mjs が行います。案件が太字を外す等の許される編集をしても、
// この試験は落ちません(process-compass #314 の突合 X-4)。

import { aiNameReason } from './config.mjs';
import { blankComments, buildManifest, extractRules, missingResident, normalizeRule, omitProblems } from './claude-md-resident.mjs';

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${detail}`}`);
}

// 固定の写し。テンプレートの CLAUDE.md の形(箇条書き・太字で始まる段落・表・所在だけの行・構成依存部分)を縮めたもの
const FIXTURE = `# 開発規約

前書きの段落。規則の索引です。

## 迷ったら

- **\`/pit\` を実行する**(\`node scripts/gate/next.mjs\`)。次のコマンドを出す
- 詳細: \`.claude/skills/pit/SKILL.md\`

## このプロジェクトの構成(自動生成)

<!-- generated:process-rules start -->
- 構成が未設定。
<!-- generated:process-rules end -->

## 規則の索引

各行の \`[機械]\` は、機械が止める規則です。

### 行ってはならない作業

| # | 禁止事項 | 止める仕組み |
| --- | --- | --- |
| 3 | **テストの失敗を、テスト側の変更で解消する** | \`[機械]\` フックが遮断する |
| 4 | 差分を確認せずに承認する | 指示文 |

理由: \`.claude/skills/pit/reference/boundaries.md\`

### 一律で AI に委譲できない領域

- 安全に関する最終的な判断
- 認証・認可・個人データ・外部との契約に関わる決定
- 適用範囲そのものの拡大

### 判断の確定と委任

- **委任の範囲に当たるかを自分で判定しない** \`[機械]\` 委任の検査
- **委任の変更を自分でマージしない**
- 責任者の欄へ AI の名義を書かない
- **AI の確認は検出の層**。承認と記録しない
- 詳細: \`.claude/skills/pit/reference/boundaries.md\`

### 停止の申し立て

- 誰でも止められる。**AI は停止を解除しない**(ラベルを外さない)

### コードの探索

- **\`graft init\` を実行しない**(全リポジトリへ登録するため)
`;

const manifest = buildManifest(FIXTURE, null);
const miss = (text) => missingResident(text, manifest);
const total = (m) => m.absent.length + m.empty.length + m.rules.length;
const ruleOf = (pattern) => manifest.rules.find((r) => pattern.test(r.core));
const unbold = (text) => text.replace(/\*\*/g, '');

/** needle を含む最初の行の中で from を to へ置き換える。置き換わらなければ null(変異の空振りを試験の失敗にする) */
function mutateLine(text, needle, from, to) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(needle) && l.includes(from));
  if (i < 0) return null;
  lines[i] = lines[i].replace(from, to);
  return lines.join('\n');
}

/** 見出し start の次の行から、見出し end の前までを返す */
function sectionBody(text, start, end) {
  const s = text.indexOf('\n', text.indexOf(start)) + 1;
  const e = text.indexOf(end);
  return { s, e };
}

check(
  '固定の写しから一覧を作る(構成依存部分・説明の段落・所在だけの行は規則に数えない)',
  manifest.rules.length === 12 && manifest.rules.every((r) => /^CR-\d{3}$/.test(r.id) && r.section && r.core) && !manifest.sections.some((s) => s.heading.includes('自動生成')),
  `${manifest.rules.length} 件: ${JSON.stringify(manifest.rules.map((r) => r.core))}`
);

/** 変異の一揃い。base は照合が通る文書。太字つきと太字を外したものの両方で回す */
function mutationSuite(base, label) {
  check(`${label}: 写しは一覧のすべての節と規則を満たす`, total(miss(base)) === 0, JSON.stringify(miss(base)));

  // 変異1: 行の削除
  {
    const line = base.split('\n').find((l) => l.includes('委任の範囲に当たるかを自分で判定しない'));
    const m = miss(base.replace(`${line}\n`, ''));
    const r = ruleOf(/^委任の範囲に当たるかを自分で判定しない/);
    check(`${label}: 変異: 規則の行を消すと、その規則が無いと出る`, Boolean(r) && m.rules.length === 1 && m.rules[0].id === r.id, JSON.stringify(m.rules));
    check(`${label}: 変異: 行を消しても節の見出しと本文は残る(節の照合だけでは落ちない経路)`, m.absent.length === 0 && m.empty.length === 0);
  }

  // 変異2: 節を 1 行に置き換える
  {
    const { s, e } = sectionBody(base, '### 判断の確定と委任', '### 停止の申し立て');
    const m = miss(`${base.slice(0, s)}\n- 判断は人が確定する。\n\n${base.slice(e)}`);
    const inSection = manifest.rules.filter((r) => r.section === '判断の確定と委任');
    check(
      `${label}: 変異: 節を 1 行に置き換えると、節の規則がすべて無いと出る`,
      inSection.length === 4 && m.rules.length === inSection.length && m.absent.length === 0 && m.empty.length === 0,
      `${m.rules.length} / ${inSection.length}`
    );
  }

  // 変異3: 否定を除く
  {
    const t1 = mutateLine(base, 'graft init', '実行しない', '実行する');
    const m1 = t1 === null ? null : miss(t1);
    check(`${label}: 変異: 否定を除く(実行しない → 実行する)と、その規則が無いと出る`, m1 !== null && m1.rules.length === 1 && /graft init/.test(m1.rules[0].core), JSON.stringify(m1?.rules));
    const t2 = mutateLine(base, '| 4 |', '確認せずに', '確認して');
    const m2 = t2 === null ? null : miss(t2);
    check(`${label}: 変異: 表の行の禁止事項の文言を変えると、その規則が無いと出る`, m2 !== null && m2.rules.length === 1 && /差分を確認せずに承認する/.test(m2.rules[0].core), JSON.stringify(m2?.rules));
    const t3 = mutateLine(base, '停止を解除しない', 'AI は停止を解除しない', 'AI も停止を解除する');
    const m3 = t3 === null ? null : miss(t3);
    check(`${label}: 変異: 停止の解除の禁止を除くと、その規則が無いと出る`, m3 !== null && m3.rules.length === 1 && m3.rules[0].section === '停止の申し立て', JSON.stringify(m3?.rules));
  }

  // 変異4: 節の本文を複数行のコメントで囲む(描画されず、コメントを除いて読む系にも見えない)
  {
    const { s, e } = sectionBody(base, '### 行ってはならない作業', '### 一律で AI に委譲できない領域');
    const wrapped = `${base.slice(0, s)}<!--\n${base.slice(s, e)}-->\n\n${base.slice(e)}`;
    const m = miss(wrapped);
    const inSection = manifest.rules.filter((r) => r.section === '行ってはならない作業');
    check(
      `${label}: 変異: 節の本文を複数行のコメントで囲むと、節の規則が無いと出る`,
      inSection.length === 2 && inSection.every((r) => m.rules.some((x) => x.id === r.id)) && m.empty.some((x) => x.heading === '行ってはならない作業'),
      JSON.stringify(m)
    );
  }

  // 案件の編集の自由: 行の前後への書き足し・並べ替え・行の追加・止める仕組みの列の書き換え(行の途中への挿入は文言の変更として落ちる)
  {
    let t = mutateLine(base, 'graft init', '- ', '- 案件の注: ');
    t = t && mutateLine(t, 'AI の確認は検出の層', '承認と記録しない', '承認と記録しない 案件の補足: 当社の CI では静的解析の結果も同じ扱い。');
    if (t) {
      const { s, e } = sectionBody(t, '### 一律で AI に委譲できない領域', '### 判断の確定と委任');
      const sec = t.slice(s, e).split('\n');
      const items = sec.filter((l) => l.startsWith('- ')).reverse();
      let k = 0;
      const reordered = sec.map((l) => (l.startsWith('- ') ? items[k++] : l)).join('\n');
      t = `${t.slice(0, s)}${reordered.replace('- 安全に関する最終的な判断', '- 案件で足した規則: 決済の金額の確定\n- 安全に関する最終的な判断')}${t.slice(e)}`;
      t = mutateLine(t, '| 4 |', '指示文', '当社のレビューのボット');
    }
    const m = t === null ? null : miss(t);
    check(`${label}: 案件の編集: 前後への書き足し・並べ替え・行の追加・止める仕組みの列の書き換えでは落ちない`, m !== null && total(m) === 0, JSON.stringify(m?.rules));
  }
}

mutationSuite(FIXTURE, '太字あり');
// 陰性の対照: 太字を外しただけの文書は、照合も変異の試験も通る(許される編集で試験が落ちないこと)
check('陰性の対照: 太字を外すと文書は変わる(対照が空振りでない)', unbold(FIXTURE) !== FIXTURE);
mutationSuite(unbold(FIXTURE), '太字なし');

// 正規化: 太字・逆引用符・リンクの記法・HTML コメント・全角の違いを除く
{
  check('正規化: 太字と逆引用符と HTML コメントを除く', normalizeRule('**`graft init` を実行しない** <!-- 根拠: x -->') === 'graft init を実行しない');
  check('正規化: リンクは文だけを残す', normalizeRule('[用語集](context/glossary.md) を読む') === '用語集 を読む');
  const blanked = blankComments('a <!--\nb\n--> c\nd');
  check('コメントの除去: 複数行のコメントを、行番号を保って空にする', blanked === 'a \n\n c\nd', JSON.stringify(blanked));
}

// 作り直しは追加だけ
{
  const removed = { ...manifest, rules: manifest.rules.slice() };
  const extra = { id: 'CR-999', section: '迷ったら', core: '案件の CLAUDE.md から消えた規則' };
  removed.rules.push(extra);
  const built = buildManifest(FIXTURE, removed);
  check('作り直し: CLAUDE.md に無い規則も一覧から消さない(追加だけ)', built.rules.some((r) => r.id === 'CR-999'));
  const added = buildManifest(`${FIXTURE}\n### 案件の節\n\n- 新しい規則を書く。\n`, manifest);
  const last = added.rules[added.rules.length - 1];
  check('作り直し: 新しい規則に次の番号を振って足す', added.rules.length === manifest.rules.length + 1 && last.core === '新しい規則を書く' && last.id === `CR-${String(manifest.rules.length + 1).padStart(3, '0')}`, JSON.stringify(last));
  const target = manifest.rules[0];
  const omitted = buildManifest(FIXTURE, { ...manifest, rules: manifest.rules.slice(1), omit: [{ ...target, reason: '試験', approvedBy: '山田 太郎' }] });
  check('作り直し: omit へ移した規則を足し戻さない', !omitted.rules.some((r) => r.core === target.core) && omitted.omit.length === 1);
  check('抽出: 所在だけの行(理由: / 詳細:)と説明の段落は規則に数えない', !extractRules(FIXTURE).some((r) => /^(理由|詳細)/.test(r.core) || /^各行の/.test(r.core)));
}

// omit の項目: reason と approvedBy(AI の名義でない)が要る
{
  const base = { omit: [] };
  check('omit: 項目が無ければ不備は無い', omitProblems(base, aiNameReason).length === 0);
  const ok = { omit: [{ id: 'CR-001', section: '迷ったら', core: 'x', reason: '案件では /pit を使わない', approvedBy: '山田 太郎' }] };
  check('omit: reason と人の approvedBy がある項目は通る', omitProblems(ok, aiNameReason).length === 0, JSON.stringify(omitProblems(ok, aiNameReason)));
  const noReason = { omit: [{ id: 'CR-001', section: '迷ったら', core: 'x', approvedBy: '山田 太郎' }] };
  check('omit: reason の無い項目は不備に出る', omitProblems(noReason, aiNameReason).some((p) => /reason/.test(p)));
  const noApprover = { omit: [{ id: 'CR-001', section: '迷ったら', core: 'x', reason: '理由' }] };
  check('omit: approvedBy の無い項目は不備に出る', omitProblems(noApprover, aiNameReason).some((p) => /approvedBy/.test(p)));
  const aiApprover = { omit: [{ id: 'CR-001', section: '迷ったら', core: 'x', reason: '理由', approvedBy: 'Claude' }] };
  check('omit: AI の名義の approvedBy は不備に出る', omitProblems(aiApprover, aiNameReason).some((p) => /AI の名義/.test(p)), JSON.stringify(omitProblems(aiApprover, aiNameReason)));
}

if (failures) {
  console.error(`\n常駐の規則の照合の試験: ${failures} 件の失敗`);
  process.exit(1);
}
console.log('\n常駐の規則の照合の試験: すべて通過');

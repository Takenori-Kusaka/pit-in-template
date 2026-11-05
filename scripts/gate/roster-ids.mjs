// 名簿の数値の識別子の提案(標準 第4章「判定の成立」の保全の条件「アカウントと人の対応表」。process-compass #430 / ADR-0108 / IMPL-0426)。
//
//   node scripts/gate/roster-ids.mjs            記録用ブランチの写しと基底ブランチの複製から提案を出す
//   node scripts/gate/roster-ids.mjs --lookup   写しに現れないアカウントを gh api users/<login> で引く。写しの値と現在の値の食い違いも確かめる
//   node scripts/gate/roster-ids.mjs --json     提案を JSON で出す
//
// ホスティングの記録は、数値の識別子で名簿の人へ対応づける。名簿のアカウントに識別子が無ければ、その人の承認・判定・帰属を
// 数えない(移行期間を置かない)。このスクリプトは、名簿の識別子の無いアカウントごとに、記録用ブランチ records の写し
// (records/reviews/pr-*.json の reviews[].user.id・author.id)と基底ブランチの複製(docs/records/reviews/)から識別子を集めて
// 提案する。
//   - 写しどうしで、同じログイン名に別の識別子が現れたアカウントは提案しない(改名の後に他人が取得した疑い)。所見に出す
//   - 提案の源は写しの数値の識別子とし(ADR-0108 決定2)、ホスティングの今の値(gh api users/<login>)と一致するものだけを提案する。
//     食い違うもの・引けないものは提案せず所見に出す(写しは書き込みの権限を持つ者が書ける。process-compass #379)。ホスティングを
//     読めない実行(gh を使えない)では写しから提案し、照合していない旨を出す
//   - --lookup では、写しに現れないアカウントも gh api users/<login> で引いて提案する
//   - 名簿に識別子を持つアカウントで、写しに同じログイン名の別の識別子が現れたものも所見に出す
// 名簿を書き換えない。提案を確かめたうえで、人が /process-change(種別 accountable)で名簿へ書く。AI は名簿を書き換えない。
// 提案の値が本人のアカウントかは機械で確かめない(写しは承認の時点のホスティングの値であり、名簿の記載の正しさは監査の観点6)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig, accountKey, accountLoginOf, accountIdOf, numericAccountId, hasWriteAssociation } from './config.mjs';
import { readRecordsBranch, parseCopy } from './records.mjs';

/** 基底ブランチの写しの複製の置き場(aggregate-evidence.mjs の BASE_COPIES_DIR と同じ) */
export const BASE_COPIES_DIR = 'docs/records/reviews';

/** 写し 1 件から、(login, id) の観測を集める。reviews[].user と author */
export function observationsOfCopy(copy, where) {
  const out = [];
  const push = (who, at) => {
    const login = accountLoginOf(who?.login ?? '');
    const id = numericAccountId(who?.id ?? null);
    if (login && id !== null) out.push({ login, id, where: at });
  };
  if (copy?.author) push(copy.author, `${where}#author`);
  // リポジトリとの関係(author_association)が書き込みの権限を持つ者の値でないレビューの書き手は、提案の根拠にしない(改名の後に他人が
  // 旧名を取得してレビューを残した疑い。IMPL-0425 と同じ読み方。#430 突合 M-3)。値の無い古い写しはそのまま読み、件数を返す
  out.excluded = 0;
  out.unassociated = 0;
  (Array.isArray(copy?.reviews) ? copy.reviews : []).forEach((r, i) => {
    const rel = hasWriteAssociation(r);
    if (rel === false) {
      out.excluded++;
      return;
    }
    if (rel === null) out.unassociated++;
    push(r?.user ?? r?.author, `${where}#reviews[${i}]`);
  });
  return out;
}

/**
 * 提案を作る。sources は [{ where, copy }]。lookup は (login) => 数値の識別子 | null(--lookup のときだけ渡す。写しに現れない
 * アカウントも提案する)。verify は写しの値をホスティングで照合する関数(同じ形。既定は lookup)。
 * 提案は、ホスティングで照合した値に限る(process-compass #379 / ADR-0109 決定4)。写しは書き込みの権限を持つ者が書けるため、
 * 写しにだけある書き手・ホスティングと識別子が食い違う写しを提案の根拠にしない。verify も lookup も無ければ、写しの値を提案せず
 * 「ホスティングで照合していない」として出す。
 * 返り値: { proposals: [{ person, login, id, from }], findings: [文], unresolved: [{ person, login, why }], withId: 件数 }
 */
export function proposeRosterIds(config, { sources = [], lookup = null, verify = lookup } = {}) {
  const seen = new Map(); // accountKey → Map<id, where[]>
  let excluded = 0;
  let unassociated = 0;
  for (const s of sources) {
    const obs = observationsOfCopy(s.copy, s.where);
    excluded += obs.excluded ?? 0;
    unassociated += obs.unassociated ?? 0;
    for (const o of obs) {
      const k = accountKey(o.login);
      const m = seen.get(k) ?? new Map();
      m.set(o.id, [...(m.get(o.id) ?? []), o.where]);
      seen.set(k, m);
    }
  }
  const proposals = [];
  const findings = [];
  const unresolved = [];
  let withId = 0;
  const roster = Array.isArray(config?.people) ? config.people : [];
  for (const p of roster) {
    for (const a of Array.isArray(p?.accounts) ? p.accounts : []) {
      const login = accountLoginOf(a);
      if (!login) continue;
      const k = accountKey(login);
      const ids = seen.get(k) ?? new Map();
      const rosterId = accountIdOf(a);
      if (rosterId !== null) {
        withId++;
        const other = [...ids.keys()].filter((x) => x !== rosterId);
        if (other.length) findings.push(`${p.name} @${login}: 名簿の数値の識別子は ${rosterId} だが、写しに同じログイン名の別の識別子 ${other.join(', ')} が現れる(${other.flatMap((x) => ids.get(x)).slice(0, 3).join('・')})。改名の後に他人が取得した疑い。名簿を直すかを人が確かめる`);
        continue;
      }
      if (ids.size > 1) {
        findings.push(`${p.name} @${login}: 写しに別の数値の識別子 ${[...ids.keys()].join(', ')} が現れるため、提案しない(改名の後に他人が取得した疑い。どれが本人のアカウントかを人が確かめる)`);
        unresolved.push({ person: p.name, login, why: '写しの識別子が食い違う' });
        continue;
      }
      if (ids.size === 1) {
        const [[id, where]] = [...ids];
        const check = verify ?? lookup;
        if (!check) {
          // ホスティングを読めない実行: 写しから提案し、照合していない旨を出す(ADR-0108 決定2。process-compass #379 突合 M-5)
          proposals.push({ person: p.name, personId: p.id, login, id, unverified: true, from: `写し(${where.slice(0, 2).join('・')}${where.length > 2 ? ` ほか ${where.length - 2} 件` : ''})。ホスティングで照合していない(gh を使える環境で実行し直すと照合する)` });
          continue;
        }
        {
          const now = check(login);
          if (now === null) {
            findings.push(`${p.name} @${login}: 写しの数値の識別子は ${id} だが、gh api users/${login} で現在の値を引けない(削除・改名の疑い)。提案しない`);
            unresolved.push({ person: p.name, login, why: '現在の値を引けない' });
            continue;
          }
          if (now !== id) {
            findings.push(`${p.name} @${login}: 写しの数値の識別子 ${id} と、現在の値 ${now}(gh api users/${login})が異なる。改名の後に他人が取得した疑いがあるため、提案しない`);
            unresolved.push({ person: p.name, login, why: '写しの値と現在の値が異なる' });
            continue;
          }
        }
        proposals.push({ person: p.name, personId: p.id, login, id, from: `写し(${where.slice(0, 2).join('・')}${where.length > 2 ? ` ほか ${where.length - 2} 件` : ''})。ホスティングの現在の値と一致` });
        continue;
      }
      if (lookup) {
        const now = lookup(login);
        if (now !== null) {
          proposals.push({ person: p.name, personId: p.id, login, id: now, from: `gh api users/${login}(写しに現れない。承認・判定の記録で確かめていない)` });
          continue;
        }
        unresolved.push({ person: p.name, login, why: `写しに現れず、gh api users/${login} でも引けない` });
        continue;
      }
      unresolved.push({ person: p.name, login, why: '写しに現れない(--lookup を付けると gh api users/<login> で引く)' });
    }
  }
  return { proposals, findings, unresolved, withId, excluded, unassociated };
}

/** 提案を当てた名簿(/process-change の種別 accountable の people に渡す形。名簿の全体)。提案の無い要素は変えない */
export function rosterWithProposals(config, proposals) {
  const byKey = new Map(proposals.map((x) => [`${x.personId}\u0000${accountKey(x.login)}`, x.id]));
  return (Array.isArray(config?.people) ? config.people : []).map((p) => ({
    ...p,
    ...(Array.isArray(p.accounts)
      ? {
          accounts: p.accounts.map((a) => {
            const id = byKey.get(`${p.id}\u0000${accountKey(a)}`);
            return id !== undefined && accountIdOf(a) === null ? { login: accountLoginOf(a), id } : a;
          }),
        }
      : {}),
  }));
}

/** 写しの読み取り元(記録用ブランチと基底ブランチの複製)。読めない理由も返す */
export function copySources(root = ROOT, { fetch = true } = {}) {
  const sources = [];
  const notes = [];
  const rb = readRecordsBranch({ cwd: root, fetch });
  if (rb.available) for (const [n, copy] of rb.reviews) sources.push({ where: `${rb.ref}:records/reviews/pr-${n}.json`, copy });
  else notes.push(rb.reason);
  const dir = path.join(root, BASE_COPIES_DIR);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const { copy } = parseCopy(`${BASE_COPIES_DIR}/${f}`, fs.readFileSync(path.join(dir, f), 'utf8'));
      if (copy) sources.push({ where: `${BASE_COPIES_DIR}/${f}`, copy });
    }
  } else notes.push(`基底ブランチの写しの複製(${BASE_COPIES_DIR}/)が無い`);
  return { sources, notes };
}

/** gh でホスティングを読めるか(gh api rate_limit が通るか) */
export function ghAvailable() {
  try {
    execFileSync('gh', ['api', 'rate_limit', '--jq', '.resources.core.limit'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** gh api users/<login> の id。引けなければ null */
export function ghUserId(login) {
  try {
    const out = execFileSync('gh', ['api', `users/${encodeURIComponent(login)}`, '--jq', '.id'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return numericAccountId(out.trim());
  } catch {
    return null;
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const { sources, notes } = copySources(ROOT);
  // 写しの値は、--lookup の有無に依らずホスティング(gh api users/<login>)で照合する(process-compass #379)
  const hostOk = ghAvailable();
  const r = proposeRosterIds(config, { sources, lookup: argv.includes('--lookup') && hostOk ? ghUserId : null, verify: hostOk ? ghUserId : null });
  if (!hostOk) notes.push('gh でホスティングを読めないため、写しの値をホスティングの今の値で照合していない(提案に「照合していない」と付けた)');
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...r, notes, people: rosterWithProposals(config, r.proposals) }, null, 2));
    process.exit(0);
  }
  const L = [];
  L.push(`名簿の数値の識別子の提案(写し ${sources.length} 件を読んだ。識別子を持つアカウント ${r.withId} 件)`);
  for (const n of notes) L.push(`  注記: ${n}`);
  if (r.excluded) L.push(`  注記: リポジトリとの関係(author_association)が書き込みの権限を持たないレビューの書き手 ${r.excluded} 件を、提案の根拠にしていない`);
  if (r.unassociated) L.push(`  注記: リポジトリとの関係の値の無い古い写しのレビュー ${r.unassociated} 件は、関係を確かめずに読んだ(提案の値が本人のアカウントかを人が確かめる)`);
  const total = (Array.isArray(config.people) ? config.people : []).flatMap((p) => (Array.isArray(p?.accounts) ? p.accounts : [])).filter((a) => accountLoginOf(a)).length;
  if (!total) L.push('  名簿(people[].accounts)にアカウントがありません。名簿は人が /process-change(種別 accountable)で記入します');
  else if (!r.proposals.length && !r.unresolved.length && !r.findings.length) L.push('  名簿のアカウントはすべて数値の識別子を持ち、写しとの食い違いはありません');
  if (r.proposals.length) {
    L.push('', '提案(名簿へ書くのは人。提案の値が本人のアカウントかを確かめてから書く):');
    for (const x of r.proposals) L.push(`  - ${x.person} @${x.login} → id ${x.id}(${x.from})${x.unverified ? '。**ホスティングで照合していない**' : ''}`);
  }
  if (r.unresolved.length) {
    L.push('', '提案できないアカウント:');
    for (const x of r.unresolved) L.push(`  - ${x.person} @${x.login}: ${x.why}`);
  }
  if (r.findings.length) {
    L.push('', '所見(食い違い):');
    for (const f of r.findings) L.push(`  - ${f}`);
  }
  if (r.proposals.length) {
    L.push(
      '',
      '反映の手順: 提案を確かめたうえで、人が /process-change(種別 accountable)の people に、名簿の全体を書いて渡す。',
      '`node scripts/gate/roster-ids.mjs --json` の people が、提案を当てた名簿の全体である(D-0 表1「体制と運用形態」の決定者の記名と理由を要する)。AI は名簿を書き換えない'
    );
  }
  console.log(L.join('\n'));
  process.exit(0);
}

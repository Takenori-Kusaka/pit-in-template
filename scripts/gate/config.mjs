// 構成ファイルとアダプタの読み込み。ゲートのスクリプトが共通で使う。
// 依存パッケージなし。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadConfig() {
  const p = path.join(ROOT, 'process.config.json');
  if (!fs.existsSync(p)) {
    throw new Error('process.config.json がありません。/process-init を実行してください');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function loadAdapter(config) {
  const stack = config.adapters?.stack ?? 'none';
  const p = path.join(ROOT, 'adapters', `${stack}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`adapters/${stack}.json がありません。process.config.json の adapters.stack を確認してください`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** ゲートが有効か(required / simplified を有効とみなす) */
export function isGateActive(config, key) {
  const s = config.gates?.[key]?.state;
  return s === 'required' || s === 'simplified';
}

export function gateState(config, key) {
  return config.gates?.[key]?.state ?? 'required';
}

// ---------------------------------------------------------------- 席と運用形態

/** 運用形態の語彙(標準 第5章 5.5.2)。並びは統制の厳しい順 */
export const SEAT_MODES = ['human', 'collab', 'delegated'];
export const MODE_LABEL = { human: '人確定', collab: '協働', delegated: '委任' };

/**
 * 席ごとの運用形態の上限(標準 第5章 5.5.6)。ここに無い席の上限は delegated。
 *
 * 構成ファイルではなく検査の側に置く。構成に書いた上限は書き換えられるため、
 * 案件単位で上限を引き上げる経路になる(第8章 テーラリングの禁止事項)。
 */
export const SEAT_CEILING = {
  'biz-approver': 'human',
  'ai-ops': 'human',
  'qa-gatekeeper': 'collab',
  'ai-maintainer': 'collab',
};

/**
 * 体制の変化点の種別と、標準の番号(第3章 3.13.1)。番号を持たない種別は null。
 * schedule-only と outage は変化点に数えない。記録のためだけに置く(第3章 3.13.2)
 */
export const CHANGE_KINDS = {
  init: null,
  accountable: 1,
  headcount: 2,
  mode: 3,
  performer: 4,
  axis: 5,
  'schedule-only': null,
  outage: null,
  settings: null,
  notice: null,
};

/** 変化点に数えない種別の表示名 */
export const KIND_NOTE = {
  'schedule-only': '納期だけの変更(変化点に数えない)',
  outage: 'AI が使えない期間(変化点に数えない)',
  settings: '個別の値の変更(変化点に数えない)',
  notice: '即時通知の記録(変化点に数えない)',
};

/** AI が使えない期間の扱い(D-0 節12「AI が使えないときの扱い」と同じ語彙) */
export const OUTAGE_HANDLING = { human: '人へ戻した', stop: '止めた' };

/**
 * 変化点の向きの表示名。arising は、未達・逸脱の発生(決定ではなく事実。第3章 3.13.3)。
 * 人が実際に減った変化点に限って付く。人が減っていないのに統制を下げる変更は loosen である
 */
export const DIRECTION_LABEL = {
  loosen: '緩める',
  // 席の責任者の任免。統制の向きにかかわらず決定として扱い、決定者の記名と理由を要する(第3章 3.13.3)
  appoint: '任免の決定',
  tighten: '厳しくする',
  arising: '未達・逸脱の発生',
  none: '—',
};

/** 決定した者の記名と理由を要する向き */
export const SIGNED_DIRECTIONS = ['loosen', 'appoint'];

export function modeRank(mode) {
  return SEAT_MODES.indexOf(mode);
}

/** 担い手の識別(モデルの版・指示資産の版・権限の組)を比較できる形にする */
export function performerKey(p) {
  return p ? JSON.stringify([p.model ?? null, p.instructions ?? null, p.permissions ?? null]) : null;
}

// ---------------------------------------------------------------- 人の名簿
//
// 責任者・決定者・承認者は記名の自然人である(標準 第5章 5.5.1 / 5.5.7)。
// 構成は人の名簿(people[])を持ち、記名の欄を名簿と照合する。名簿は人が D-0 体制図の
// 節1 と合わせて記入する。AI を示す名義は、名簿に書かれていても受け付けない。

/** 全角の英数字・記号と半角の片仮名は、互換の形へ寄せてから比べる(NFKC) */
const normName = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/** AI を示す語。名義に含まれていれば、自然人の記名として受け付けない */
const AI_NAME_RULES = [
  [/(?<![A-Za-z])AI(?![A-Za-z])|ＡＩ|人工知能/, 'AI の表記を含む'],
  [/(?<![A-Za-z])agent(?![A-Za-z])|エージェント/i, 'agent の表記を含む'],
  [/Agent(?![a-z])/, 'agent の表記を含む'],
  [/(?<![A-Za-z])bot(?![A-Za-z])|ボット|dependabot|renovate|github-actions/i, 'bot の表記を含む'],
  [/Bot(?![a-z])/, 'bot の表記を含む'],
  [
    /(?<![A-Za-z])(claude|anthropic|gpt|chatgpt|openai|gemini|copilot|codex|llama|mistral|grok|deepseek|qwen|sonnet|opus|haiku|fable|mythos|llm|assistant|model)(?![A-Za-z])|モデル/i,
    'モデル名または提供者名を含む',
  ],
  // 片仮名の読み。語の一致であり、別の文字種・役職名による回避は閉じない(監査観点6 で確かめる)
  [/エーアイ/, 'AI の表記を含む'],
  [
    /クロード|アンソロピック|チャットジーピーティー|ジーピーティー|オープンエーアイ|ジェミニ|コパイロット|コーデックス|ミストラル|グロック|ディープシーク|ソネット|オーパス|フェイブル|ミトス|アシスタント/,
    'モデル名または提供者名を含む',
  ],
];

/**
 * 名義が AI を示す語を含む場合、その理由を返す。含まなければ null。
 *
 * 語の一致による機械検査であり、同じ語を含む実在の氏名も当たる。名簿の該当者に、人が確認した旨
 * (people[].nameConfirmed)がある場合の扱いは aiNameBlocked による。
 * account を真にすると、ホスティングのアカウント名の表記([bot])も見る
 */
export function aiNameReason(name, { account = false } = {}) {
  const n = normName(name);
  if (account && /\[bot\]$/i.test(n)) return 'bot の表記を含む';
  for (const [re, why] of AI_NAME_RULES) if (re.test(n)) return why;
  return null;
}

/** 名簿から人を引く。id または氏名で一致させる */
export function findPerson(config, ref) {
  const n = normName(ref);
  if (!n) return null;
  const roster = Array.isArray(config.people) ? config.people : [];
  return roster.find((p) => p?.id === n || normName(p?.name) === n) ?? null;
}

/** 同一人物かを比べるためのキー。名簿にあれば id、無ければ氏名の文字列 */
export function personKey(config, ref) {
  const n = normName(ref);
  if (!n) return null;
  return findPerson(config, n)?.id ?? n;
}

/** 表示に使う氏名。名簿にあれば名簿の氏名 */
export function personName(config, ref) {
  return findPerson(config, ref)?.name ?? normName(ref);
}

/**
 * 記名として受け付けない理由を返す。受け付ける場合は null。
 *
 * AI を示す語に当たった名義は、既定では拒否する。名簿の該当者に、人が確認した旨
 * (nameConfirmed: true)がある場合に限り通す。通した名義は nameOverrides が返し、出力へ表示する。
 * 担い手の識別と同じ文字列と、名簿に無い名義の拒否は、上書きできない(nameProblems)
 */
export function aiNameBlocked(config, name) {
  const person = findPerson(config, name);
  const why = aiNameReason(person?.name ?? name);
  if (!why) return null;
  return person?.nameConfirmed === true ? null : why;
}

/** 名義の機械検査を、人が上書きした名簿の人(氏名の一覧) */
export function nameOverrides(config) {
  const roster = Array.isArray(config.people) ? config.people : [];
  return roster.filter((p) => p?.nameConfirmed === true && aiNameReason(p.name)).map((p) => normName(p.name));
}

/** 担い手の識別に使われている文字列の一覧。責任者の欄へ同じ文字列を書く経路を塞ぐ */
function performerStrings(config) {
  const out = new Set();
  for (const s of config.seats ?? []) {
    for (const p of [s.performer, s.qualification?.performer]) {
      for (const v of Object.values(p ?? {})) if (v) out.add(normName(v));
    }
  }
  return out;
}

/**
 * 記名の欄に書かれた名義の問題を返す。空なら自然人の記名として受け付ける。
 *
 * requireRoster が真のときは、名簿に無い名義を拒否する。名簿が1件でも記入されていれば、
 * requireRoster によらず照合する。名簿が空のあいだは、未記入として表示するにとどめる。
 */
export function nameProblems(config, name, { requireRoster = false, checkRoster = true } = {}) {
  const n = normName(name);
  if (!n) return ['記名がない'];
  const out = [];
  // 名簿の id で書かれた記名は、名簿の氏名で確かめる
  const ai = aiNameBlocked(config, n);
  if (ai) {
    out.push(
      `"${n}" は ${ai}。記名は自然人の氏名に限る。AI の名義を受け付けない` +
        '(同じ語を含む実在の氏名の場合は、人が確認したうえで、名簿の該当者へ nameConfirmed: true を書く)'
    );
  }
  if (performerStrings(config).has(n)) {
    out.push(`"${n}" は担い手の識別(performer)と同じ文字列である。担い手を責任者・決定者・承認者にできない`);
  }
  const roster = Array.isArray(config.people) ? config.people : [];
  // checkRoster を偽にすると、記録時点の記名(離任した適合性確認の実施者など)を現在の名簿と照合しない
  if (checkRoster && (requireRoster || roster.length) && !findPerson(config, n)) {
    out.push(
      roster.length
        ? `"${n}" は人の名簿(people[])にない`
        : `人の名簿(people[])が未記入のため、"${n}" を照合できない。名簿は人が /process-change の people で記入する`
    );
  }
  return out;
}

/** 名簿そのものの問題を返す */
export function rosterProblems(config) {
  const roster = config.people;
  if (roster === undefined) return [];
  if (!Array.isArray(roster)) return ['people が配列ではない'];
  const out = [];
  const ids = new Set();
  const names = new Set();
  const accounts = new Set();
  const performers = performerStrings(config);
  roster.forEach((p, i) => {
    const at = `people[${i}]`;
    if (!p?.id || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(p.id)) out.push(`${at}: id がない、または英数字の識別子ではない`);
    else if (ids.has(p.id)) out.push(`${at}: id "${p.id}" が重複している`);
    ids.add(p?.id);
    const n = normName(p?.name);
    if (!n) {
      out.push(`${at}: 氏名(name)がない`);
      return;
    }
    if (names.has(n)) out.push(`${at}: 氏名 "${n}" が重複している。同姓同名は区別できる表記にする`);
    names.add(n);
    const ai = aiNameReason(n);
    if (ai && p.nameConfirmed !== true) {
      out.push(
        `${at}: "${n}" は ${ai}。名簿に書けるのは自然人だけである` +
          '(同じ語を含む実在の氏名の場合は、人が確認したうえで nameConfirmed: true を書く)'
      );
    }
    if (p.nameConfirmed !== undefined && typeof p.nameConfirmed !== 'boolean') out.push(`${at}: nameConfirmed は true / false で書く`);
    if (performers.has(n)) out.push(`${at}: "${n}" は担い手の識別(performer)と同じ文字列である`);
    if (p.external !== undefined && typeof p.external !== 'boolean') out.push(`${at}: external は true / false で書く`);
    // 組織上の任命権者(第3章 3.13.3)。体制の外の人として記載する。実際に任命の権限を持つかは、機械で確かめない
    if (p.appointer !== undefined && typeof p.appointer !== 'boolean') out.push(`${at}: appointer は true / false で書く`);
    else if (p.appointer === true && p.external !== true) {
      out.push(`${at}: "${n}" を組織上の任命権者(appointer: true)とするなら、体制の外の人(external: true)として記載する(標準 第3章 3.13.3)`);
    }
    // リポジトリ上のアカウント。承認したアカウントを名簿の人へ対応づけるために使う。
    // 記載が正しいかは機械で確かめない(架空の2人目を書ける)。監査観点6 で確かめる
    if (p.accounts !== undefined) {
      if (!Array.isArray(p.accounts)) out.push(`${at}: accounts は配列で書く(リポジトリ上のアカウント名)`);
      else {
        for (const a of p.accounts) {
          const key = accountKey(a);
          if (typeof a !== 'string' || !key) {
            out.push(`${at}: accounts に空の値、または文字列でない値がある`);
            continue;
          }
          const bot = aiNameReason(a, { account: true });
          if (bot) out.push(`${at}: アカウント "${a}" は ${bot}。人のアカウントに限る。AI・bot のアカウントを、人の名簿へ書かない`);
          if (accounts.has(key)) out.push(`${at}: アカウント "${a}" が重複している。1つのアカウントは1人に対応づける`);
          accounts.add(key);
        }
      }
    }
  });
  // 記名の照合(resolveSigner)は、氏名・名簿の id・アカウントを同じ並びで引く。ある人の氏名と別の人のアカウント、
  // アカウントと別の人の id のように、別の人の識別と重なる記入は、記名を1人へ対応づけられないため拒否する(K75)。
  // 同じ種類どうしの重複は上で数える。氏名どうしは、空白・括弧書き・敬称を落として初めて重なる場合だけをここで数える
  const owners = new Map();
  roster.forEach((p, i) => {
    const keys = [
      ['id', typeof p?.id === 'string' ? p.id.toLowerCase() : '', p?.id],
      ['氏名', signerKey(p?.name), p?.name],
      ...(Array.isArray(p?.accounts) ? p.accounts : []).filter((a) => typeof a === 'string').map((a) => ['アカウント', accountKey(a), a]),
    ];
    for (const [what, key, raw] of keys) {
      if (!key) continue;
      const o = owners.get(key);
      if (!o) owners.set(key, { i, what, raw });
      else if (o.i !== i && (o.what !== what || (what === '氏名' && normName(o.raw) !== normName(raw)))) {
        out.push(`people[${i}]: ${what} "${raw}" が、people[${o.i}] の${o.what} "${o.raw}" と重なる。記名を1人へ対応づけられないため、別の人の氏名・id・アカウントと重ならない表記にする`);
      }
    }
  });
  return out;
}

/** アカウント名を比べるためのキー(大文字と小文字を区別しない。先頭の @ は落とす) */
export function accountKey(account) {
  return typeof account === 'string' ? account.normalize('NFKC').trim().replace(/^@/, '').toLowerCase() : '';
}

/** アカウントから名簿の人を引く。対応づかなければ null */
export function findPersonByAccount(config, account) {
  const key = accountKey(account);
  if (!key) return null;
  const roster = Array.isArray(config.people) ? config.people : [];
  return roster.find((p) => (Array.isArray(p?.accounts) ? p.accounts : []).some((a) => accountKey(a) === key)) ?? null;
}

/**
 * 記名を照合するためのキー。空白・括弧書き(肩書きなど)・末尾の敬称・先頭の @ を落とす。
 * 「山田太郎」「山田　太郎」「山田 太郎(開発)」「山田 太郎 様」を同じ記名として扱う
 */
export function signerKey(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[(][^()]*[)]/g, '')
    .replace(/\s+/g, '')
    .replace(/^@/, '')
    .replace(/(さん|さま|様|殿|氏|くん|君)$/u, '')
    .toLowerCase();
}

/**
 * 記名(氏名・名簿の id・アカウント)を名簿の人へ対応づける。対応づかない、または複数の人に当たる記名は null。
 * 例外承認の承認した者、作成を指示した者、即時通知の通知先の照合に使う(文字列の完全一致で比べない)
 */
export function resolveSigner(config, ref) {
  const direct = findPerson(config, ref);
  if (direct) return direct;
  const key = signerKey(ref);
  if (!key) return null;
  const roster = Array.isArray(config.people) ? config.people : [];
  const hits = new Set(roster.filter((p) => p?.id?.toLowerCase() === key || signerKey(p?.name) === key));
  const byAccount = findPersonByAccount(config, key);
  if (byAccount) hits.add(byAccount);
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * 記入があるか。空欄、「—」「-」、「未定」「未記入」「なし」などの記入でない値、様式の説明(<…>)を残した値は、
 * 記入なしとして扱う。変更種別の登録の根拠(basis)と、例外承認の記録の欄で、同じ判定を使う
 */
export function isFilledValue(v) {
  const s = String(v ?? '').replace(/\*/g, '').normalize('NFKC').trim();
  if (!s) return false;
  if (/^[—\-–ー―‐_.。・?]+$/.test(s)) return false;
  if (/^(未定|未記入|未作成|なし|無し|特になし|該当なし|不明|空欄|tbd|todo|n\/?a|none|null|undefined|x+)$/i.test(s)) return false;
  // 様式の置き場の文字列(<…>)。全体が置き場のもの、または日本語の置き場を含むもの
  if (/^<.*>$/.test(s) || /<[^<>]*[^\x00-\x7F][^<>]*>/.test(s)) return false;
  return true;
}

/**
 * 例外承認の「対象」が、変更でなくゲートの判定を指すか(#286)。`G-2 F-001`・`G-1 P-001` の形(ゲートと、判定記録の
 * 対象)。この形の行は、変更(PR・コミット)の例外承認として対応づけない。指さなければ null
 */
export function gateExceptionTarget(target) {
  const m = /^(G-[1-8]|SG\d?)\s+([A-Za-z]+-\d+|v?\d+(?:\.\d+)*[\w.-]*)$/i.exec(String(target ?? '').replace(/[*`]/g, '').normalize('NFKC').trim());
  return m ? { gate: m[1].toUpperCase(), subject: m[2] } : null;
}

/** 例外承認の行が有効を示す状態の値。完全一致で判定する(前方一致で判定しない) */
export const ACTIVE_EXCEPTION_STATES = ['未返却', '未回収', '有効'];

// 技術負債台帳(テンプレ3)の欄は見出し行の欄名で読む。見出し行に「区分」と「状態」を持たない旧い台帳は、
// 位置で読む(区分=2列目、内容=3列目、状態=最後の列)。旧い台帳は「対象」と「承認した者」の欄を持たない
const LEDGER_COLUMNS = {
  kind: ['区分'],
  target: ['対象'],
  content: ['内容'],
  reason: ['受容した理由', '受容理由'],
  due: ['返却の目安', '返却目安'],
  state: ['状態'],
  approver: ['承認した者'],
  recorder: ['記録者'],
};

/**
 * 技術負債台帳の本文から、全行を読む。出荷判定の証跡の集約(例外承認の対応づけ)と、G-5 の PR の検査
 * (基底ブランチの台帳にある例外承認)が、同じ読み方を使う
 */
export function parseLedger(text) {
  const rows = [];
  let header = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells.includes('区分') && cells.includes('状態')) {
      header = cells;
      continue;
    }
    if (!/^\**D-\d+/.test(cells[0] ?? '')) continue;
    const at = (key) => {
      if (!header) return null;
      const i = header.findIndex((h) => LEDGER_COLUMNS[key].includes(h.replace(/\*/g, '')));
      return i >= 0 ? (cells[i] ?? '') : null;
    };
    rows.push(
      header
        ? {
            id: cells[0].replace(/\*/g, ''),
            kind: String(at('kind') ?? '').replace(/\*/g, ''),
            target: at('target'),
            content: at('content') ?? '',
            reason: at('reason'),
            due: at('due'),
            state: at('state') ?? '',
            approver: at('approver'),
            recorder: at('recorder'),
            text: cells.join(' '),
          }
        : {
            id: cells[0].replace(/\*/g, ''),
            kind: String(cells[1] ?? '').replace(/\*/g, ''),
            target: null,
            content: cells[2] ?? '',
            reason: null,
            due: null,
            state: cells[cells.length - 1] ?? '',
            approver: null,
            recorder: null,
            text: cells.join(' '),
          }
    );
  }
  return rows;
}

/** 期限の欄から日付(YYYY-MM-DD または YYYY/MM/DD)を取り出す。実在する日付として解釈できなければ null */
export function dueDayOf(v) {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(v ?? '').normalize('NFKC'));
  if (!m) return null;
  const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isRealDay(day) ? day : null;
}

/** 名簿の人が、組織上の任命権者(体制の外の人。appointer: true)か */
export function isAppointer(config, ref) {
  const p = findPerson(config, ref);
  return p?.external === true && p?.appointer === true;
}

/**
 * 出荷判定者 × 事業決裁者の兼務禁止(標準 第3章 3.5)。異議を書く者と、残存リスクを受容する者が
 * 同一になり、受容が自己完結する。3名以上は拒否、1〜2名は逸脱として記録する。
 *
 * 知識ベース(scripts/vendor/tailoring-kb.json の separations)が同じ2席の組を持てば、そちらを使う。
 * 持たない版の知識ベースでも働くよう、構成の生成が足す(generate-profile.mjs の buildConfig)
 */
export const SHIPPING_BUSINESS_SEPARATION = {
  id: 'sep-shipping-business',
  roles: ['qa-gatekeeper', 'biz-approver'],
  scope: 'same-project',
  reason: '異議を書く者と、残存リスクを受容する者が同一である(G-8 の受容が自己完結する)',
  exception: '1〜2名体制で分離が成立しない場合に限り、逸脱として記録し、保証の開示の項目1 へ表示する(第3章 3.5)',
  gate: null,
  source: 'https://takenori-kusaka.github.io/process-compass/phase4-process-design/roles-responsibilities/',
};

/**
 * 独立レビュー(G-6)が成立しているか。適用する状態で、未達の記録が無い場合に限る。
 * 成立から未達・成立しないへ変わる変化は、即時通知の対象である(標準 第3章 3.13.6 の事象5)
 */
export function g6Established(config) {
  const s = config?.gates?.g6?.state;
  return (s === 'required' || s === 'simplified') && !(config?.unmet ?? []).some((u) => u.gate === 'g6');
}

/**
 * D-0 表1「体制と運用形態」の決定者の席(標準 第5章 5.5.4 / 第3章 3.13.3)。既定は事業決裁者。
 * 構成(governance.structureDecider)を正とし、D-0 の検査が表1 の記入との一致を確かめる
 */
export const DEFAULT_STRUCTURE_DECIDER = 'biz-approver';
export function structureDeciderSeat(config) {
  const role = config.governance?.structureDecider;
  return (config.seats ?? []).some((s) => s.role === role) ? role : DEFAULT_STRUCTURE_DECIDER;
}

/** 表示に使う、決定者の席の呼び名 */
export function structureDeciderLabel(config) {
  const role = structureDeciderSeat(config);
  const name = (config.seats ?? []).find((s) => s.role === role)?.name ?? '事業決裁者';
  return `${name}の席の責任者(D-0 表1「体制と運用形態」の決定者)`;
}

/**
 * 統制を緩める向きの決定をしてよい人(標準 第5章 5.5.7 / 第3章 3.13.3)。
 * 対象の席の責任者、または D-0 表1「体制と運用形態」の決定者(既定は事業決裁者の席の責任者)に限る。
 * 席を特定できない決定(ゲートの状態、軸の入力)は、後者に限る。
 */
export function allowedDeciders(config, seatRole = null) {
  const keys = new Set();
  for (const role of [seatRole, structureDeciderSeat(config)]) {
    const seat = role ? (config.seats ?? []).find((s) => s.role === role) : null;
    const key = personKey(config, seat?.accountable);
    if (key) keys.add(key);
  }
  return keys;
}

/** 委任の規則を決定した者が、現在の席の責任者、または D-0 表1「体制と運用形態」の決定者かを確かめる */
export function ruleDeciderProblems(config, rule) {
  const out = [];
  if (!rule?.decidedBy || !rule?.reason) {
    out.push('決定した者(decidedBy)または理由(reason)がない。委任の範囲は人が記名で定める');
    return out;
  }
  const hint = `責任者が交代したときは、新しい責任者が規則を確かめて記名し直す(/process-change の入力へ "takeover": "${rule.seat}" と、新しい責任者の decidedBy・reason を書くと、規則の記名のし直し・適合性確認の承認し直し・委任への復帰を1つの入力で受け付ける)`;
  const named = nameProblems(config, rule.decidedBy, { requireRoster: true });
  out.push(...named.map((p) => `決定した者の記名を受け付けられない(${p})。${hint}`));
  if (named.length) return out;
  if (!allowedDeciders(config, rule.seat).has(personKey(config, rule.decidedBy))) {
    out.push(
      `決定した者 "${rule.decidedBy}" は、対象の席の責任者でも、${structureDeciderLabel(config)}でもない。` +
        hint
    );
  }
  return out;
}

/** 委任の規則の変更を承認する席(標準 第3章 3.11.2: 指示資産・強制層の承認権限) */
export const RULE_APPROVER_SEAT = 'ai-maintainer';

/**
 * 委任の規則に、AI維持管理者の承認があるかを確かめる(標準 第5章 5.5.7 / ADR-0038)。
 *
 * 委任の該当を判定する機械の規則は強制層である。規則の追加と範囲の拡大は、事前の承認という
 * 遮断を外す変更であり、統制の弱化として扱う。委任するという決定(席の責任者)とは別に、
 * 規則そのものの変更を AI維持管理者の席の責任者が承認する。席の責任者と同一人物でもよい。
 * その場合も、どの席で判断したかを記録に残す。承認の無い規則では、委任を有効にしない。
 */
export function ruleApprovalProblems(config, rule) {
  if (!rule?.approvedBy) {
    return ['AI維持管理者の承認(approvedBy)がない。規則の追加・拡大は統制の弱化であり、AI維持管理者の席の責任者が承認する(state:needs-platform)'];
  }
  const out = nameProblems(config, rule.approvedBy, { requireRoster: true }).map((p) => `規則の承認者の記名を受け付けられない(${p})`);
  const maintainer = (config.seats ?? []).find((s) => s.role === RULE_APPROVER_SEAT)?.accountable;
  if (!maintainer) out.push('AI維持管理者の席の責任者が未記入のため、規則の承認者を照合できない');
  else if (personKey(config, maintainer) !== personKey(config, rule.approvedBy)) {
    out.push(
      `規則の承認者 "${rule.approvedBy}" は、AI維持管理者の席の責任者ではない。` +
        '責任者が交代したときは、新しい責任者が規則を確かめて承認し直す'
    );
  }
  return out;
}

/**
 * 構成に書かれた記名(席の責任者、適合性確認の承認者)の問題を返す。
 * 名簿との照合は、委任を宣言した席で必須にする。名簿が記入済みなら、すべての席で照合する。
 */
export function namingProblems(config) {
  const out = rosterProblems(config).map((p) => `人の名簿: ${p}`);
  for (const s of config.seats ?? []) {
    const label = s.name ?? s.role;
    const requireRoster = s.mode === 'delegated';
    if (s.accountable) {
      for (const p of nameProblems(config, s.accountable, { requireRoster })) out.push(`${label} の責任者: ${p}`);
      if (isAppointer(config, s.accountable)) {
        out.push(`${label} の責任者: "${personName(config, s.accountable)}" は組織上の任命権者(体制の外の人)として名簿にある。任命権者を席の責任者にしない(標準 第3章 3.13.3)`);
      }
    }
    // 承認者が離脱して失効した確認は、記録として残す。離任した人の記名を、現在の名簿と照合しない
    if (s.qualification?.approvedBy && !s.qualification.lapsed) {
      for (const p of nameProblems(config, s.qualification.approvedBy, { requireRoster })) {
        out.push(`${label} の適合性確認の承認者: ${p}`);
      }
    }
  }
  return out;
}

/**
 * 適合性確認の実施者と承認者が、標準の定める者かを確かめる(標準 第3章 3.4.2 の要求事項4)。
 * 実施は AI維持管理者の席の責任者、承認は当該の席の責任者に限る。
 *
 * 失効の契機は2つある。確認の記録(事例と結果)の失効は、担い手の識別の変化による。承認の失効は、
 * 承認した席の責任者の交代による(離脱を含む。前の責任者が名簿に残るかどうかに依らない。要求事項9)。
 * 承認は新しい責任者へ引き継がれない。記録は有効なまま残り、新しい責任者が承認し直すまで協働を上限とする。
 * 失効の印(qualification.lapsed)は /process-change が付け、qualificationProblems が失効として返す
 */
export function qualificationAuthorityProblems(config, seat, { reapproval = false } = {}) {
  const q = seat?.qualification;
  if (!q) return [];
  const out = [];
  const label = seat.name ?? seat.role;
  const maintainer = (config.seats ?? []).find((s) => s.role === RULE_APPROVER_SEAT)?.accountable;
  // 承認し直し(責任者の交代で失効した承認を、新しい責任者が書く)では、確認の記録は当時のままであり、
  // 実施者を現在の席と照合しない
  // 承認し直しでも、実施者の名義が AI を示す語を含む記録は受け付けない(名簿とは照合しない)
  for (const p of nameProblems(config, q.performedBy, { requireRoster: true, checkRoster: !reapproval })) out.push(`${label} の適合性確認の実施者: ${p}`);
  for (const p of nameProblems(config, q.approvedBy, { requireRoster: true })) out.push(`${label} の適合性確認の承認者: ${p}`);
  if (out.length) return out;
  if (reapproval) {
    // 実施者は照合しない
  } else if (!maintainer) out.push(`${label} の適合性確認: AI維持管理者の席の責任者が未記入のため、実施者を照合できない`);
  else if (personKey(config, maintainer) !== personKey(config, q.performedBy)) {
    out.push(`${label} の適合性確認の実施者 "${q.performedBy}" は、AI維持管理者の席の責任者ではない(標準 第3章 3.4.2: 実施は AI維持管理者が行う)`);
  }
  if (!seat.accountable) out.push(`${label} の適合性確認: 席の責任者が未記入のため、承認者を照合できない`);
  else if (personKey(config, seat.accountable) !== personKey(config, q.approvedBy)) {
    out.push(`${label} の適合性確認の承認者 "${q.approvedBy}" は、この席の責任者ではない(標準 第3章 3.4.2: 承認は席の責任者が行う)`);
  }
  return out;
}

/**
 * 最小体制を割っている理由を返す。割っていなければ null(標準 第8章 軸A・軸E)。
 *
 * 安全重要度 CL1 以上と規制業は、1〜2名の体制で成立しない。初期化では拒否する。
 * 設定済みの構成で人の離脱などにより生じた場合は、拒否せずに反映し、出荷できない状態
 * (shipBlocked)として表示する。旧い構成のまま止めると、実態と構成が食い違う(第3章 3.13.3)
 */
export function belowMinimumStaffing(answers, cause = 'headcount') {
  if (answers?.['q-team-size'] !== 'size-1-2') return null;
  const why = [];
  const cl = answers['q-criticality'];
  if (['cl1', 'cl2', 'cl3'].includes(cl)) why.push(`安全重要度 ${cl.toUpperCase()}`);
  if (answers['q-quality'] === 'quality-regulated') why.push('規制業');
  if (!why.length) return null;
  // 原因で書き分ける。人数の減少(headcount)と、1〜2名の体制のまま区分が上がった場合(criticality)
  return cause === 'criticality'
    ? `1〜2名の体制のまま、案件が CL1 以上・規制業になった(${why.join('、')}。体制は 1〜2名)。出荷できない(第5章 5.5.7、ADR-0028)`
    : `CL1 以上・規制業で体制が3名を割った(${why.join('、')}。体制は 1〜2名)。出荷できない(第5章 5.5.7、ADR-0028)`;
}

/** 出荷できない状態の記録と、回答の整合を確かめる */
export function shipBlockedProblems(config) {
  const reason = belowMinimumStaffing(config.answers);
  const sb = config.shipBlocked ?? null;
  if (reason && !sb) {
    return ['安全重要度 CL1 以上または規制業を 1〜2名の体制で扱う構成ですが、出荷できない状態(shipBlocked)の記録がありません(第8章 軸A・軸E)'];
  }
  if (!reason && sb) return ['shipBlocked がありますが、回答は最小体制を割っていません。/process-change で構成を再生成してください'];
  if (sb && !(sb.reason && sb.since)) return ['shipBlocked に理由(reason)または発生日(since)がありません'];
  return [];
}

/**
 * 体制の人数と、チーム規模の回答のずれを返す(標準 第3章 3.13.1 の変化点2)。
 *
 * 体制の内の人は、席の責任者と人の名簿から数える。外部の確認者(external)は数えない。
 * 人が離れて3名を割ったのに回答が3名以上のままの構成は、成立しない分離を成立と表示する。
 */
export function headcountProblems(config) {
  const out = [];
  const size = config.answers?.['q-team-size'];
  const insiders = new Set(
    (config.seats ?? [])
      .map((s) => s.accountable)
      .filter((n) => n && findPerson(config, n)?.external !== true)
      .map((n) => personKey(config, n))
  ).size;
  const rosterInsiders = (Array.isArray(config.people) ? config.people : []).filter((p) => p?.external !== true).length;
  const headcount = Math.max(insiders, rosterInsiders);
  if (size === 'size-1-2' && headcount >= 3) {
    out.push(
      `体制の内の人が ${headcount} 名いますが(席の責任者と人の名簿から数えた)、チーム規模の回答は 1〜2名のままです。人数の境界の通過は体制の変化点です(answers の q-team-size を改めます)`
    );
  }
  // 10名の境界。レビューの方式、出荷判定者の方式、分離を必須とする組が変わる(第8章 軸A)
  if (size === 'size-3-9' && headcount >= 10) {
    out.push(
      `体制の内の人が ${headcount} 名いますが(席の責任者と人の名簿から数えた)、チーム規模の回答は 3〜9名のままです。10名の境界の通過は体制の変化点です(answers の q-team-size を size-10plus へ改めます)`
    );
  }
  if (size === 'size-10plus' && rosterInsiders >= 3 && rosterInsiders < 10) {
    out.push(
      `人の名簿の体制の内の人は ${rosterInsiders} 名ですが、チーム規模の回答は 10名以上のままです。10名の境界の通過は体制の変化点です(answers の q-team-size を size-3-9 へ改めます。席の責任者でない担い手も、名簿へ記入します)`
    );
  }
  if (size && size !== 'size-1-2' && rosterInsiders > 0 && rosterInsiders < 3) {
    out.push(
      `人の名簿の体制の内の人は ${rosterInsiders} 名ですが、チーム規模の回答は 3名以上のままです。人の離脱で成立しなくなった統制は、未達・逸脱として即時に反映します(answers の q-team-size を size-1-2 へ改めます。席の責任者でない担い手も、名簿へ記入します)`
    );
  }
  return out;
}

/**
 * 回答と、席・名簿の記入の矛盾を返す(標準 第3章 3.13.5)。
 *
 * 1〜2名の体制で「作成を指示した本人以外の確認者はいない」と回答した構成は、独立レビュー(G-6)を
 * 未達として表示する。その構成で、独立レビュアの席に開発者の席と別の人を記入すると、表示は未達の
 * まま、変更ごとの集計では「独立した人の確認あり」に数えられる。どちらかが実態と合っていない
 */
export function answersRosterProblems(config) {
  const out = [];
  const a = config.answers ?? {};
  const seat = (role) => (config.seats ?? []).find((s) => s.role === role);
  const dev = seat('dev-verifier')?.accountable;
  const rev = seat('independent-reviewer')?.accountable;
  if (
    a['q-team-size'] === 'size-1-2' &&
    a['q-external-reviewer'] === 'reviewer-no' &&
    personKey(config, dev) &&
    personKey(config, rev) &&
    personKey(config, dev) !== personKey(config, rev)
  ) {
    out.push(
      `回答は「作成を指示した本人以外の確認者はいない」(q-external-reviewer: reviewer-no)ですが、独立レビュアの席の責任者(${personName(config, rev)}${
        findPerson(config, rev)?.external ? '。外部の確認者' : ''
      })は、開発者の席の責任者(${personName(config, dev)})と別の人です。` +
        '確認できる人がいるなら、回答を reviewer-yes へ改めます(G-6 が成立し、承認を強制する設定が入ります)。いないなら、独立レビュアの席へ別の人を記入しません'
    );
  }
  return out;
}

/**
 * 構成だけから確かめられる整合を、まとめて返す(契約検査のうち、リポジトリの設定ファイルに依らない部分)。
 *
 * 出荷の証跡の集約が呼ぶ。PR を経ない体制では、契約検査が走らないまま出荷へ進む場合があるため、
 * 集約の時点でも、変化点を経ない書き換え(要約値の連鎖)と、回答・名簿・席の食い違いを確かめる。
 * 返した問題は、記録の欠落として扱う。要約値ごと書き換えた偽造は、ここでも検出できない
 */
export function configIntegrityProblems(config) {
  if (!config || config.configured === false) return [];
  const out = [];
  const chain = chainProblems(config);
  if (chain.legacy) {
    out.push('変化点の記録(changeLog[])に要約値がありません(旧い構成)。構成が変化点を経ずに書き換えられていないかを確かめられません。/process-change を1回実行すると、要約値の連鎖が始まります');
  }
  out.push(...chain.problems);
  out.push(...answersRosterProblems(config), ...headcountProblems(config), ...shipBlockedProblems(config));
  for (const p of namingProblems(config)) out.push(`記名を受け付けられません: ${p}`);
  for (const s of config.seats ?? []) {
    const ceiling = SEAT_CEILING[s.role] ?? 'delegated';
    if (!SEAT_MODES.includes(s.mode) || modeRank(s.mode) > modeRank(ceiling)) {
      out.push(`${s.name ?? s.role}: 運用形態「${MODE_LABEL[s.mode] ?? s.mode}」は、席の上限「${MODE_LABEL[ceiling]}」を超えています(第5章 5.5.6)`);
    }
  }
  const a = config.answers ?? {};
  if ((a['q-criticality'] !== 'cl0' || a['q-quality'] === 'quality-regulated') && config.delegation?.allowed === true) {
    out.push('delegation.allowed が true ですが、安全重要度 CL1 以上、または規制業では委任を適用しません(第5章 5.5.4 条件1)');
  }
  for (const p of changeTypeProblems(config, { checkRegistrant: false })) out.push(`標準変更カタログ: ${p}`);
  out.push(...protectedPathsProblems(config));
  (Array.isArray(config.changeLog) ? config.changeLog : []).forEach((e, i) => {
    if (SIGNED_DIRECTIONS.includes(e?.direction) && !(e.decidedBy && e.reason)) {
      out.push(`changeLog[${i}]: ${DIRECTION_LABEL[e.direction]}向きの変更に、決定した者の記名または理由がありません(第3章 3.13.3)`);
    }
  });
  return out;
}

// ---------------------------------------------------------------- 委任の規則

/**
 * 委任の規則が対象にできないパス。強制層・構成の正本・判定の記録は、規則に当たっても
 * 委任の範囲へ入れない(標準 第5章 5.5.5: 委任の範囲の決定と指示資産の確定は、人が行う)
 */
export const NEVER_DELEGATED = [
  'process.config.json',
  'PROCESS-PROFILE.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CODEOWNERS',
  '.claude/**',
  '.github/**',
  'adapters/**',
  'scripts/gate/**',
  'scripts/init/**',
  'scripts/vendor/**',
  'docs/gates/**',
  'docs/D-0-governance.md',
];

/**
 * 対象のパスの指定が広すぎる場合、その理由を返す。
 *
 * 委任の範囲は、標準変更カタログに登録した変更種別に当たる変更に限る(標準 第3章 3.7.4)。
 * リポジトリの全域、ルート直下の全体、先頭の階層を特定しない指定は、種別を特定しない。
 */
export function broadPathReason(glob) {
  const g = String(glob ?? '').trim().replace(/\\/g, '/').replace(/^(\.?\/)+/, '');
  if (!g) return '空の指定である';
  if (g.split('/').includes('..')) return '上位の階層を指している';
  if (g.split('/')[0].includes('*')) {
    return 'リポジトリの全域またはルート直下の全体に当たる。先頭の階層を特定する(例: src/i18n/**)';
  }
  return null;
}

/**
 * 標準変更カタログへ登録した変更種別の一覧(delegation.changeTypes[])の問題を返す(標準 第3章 3.7.4)。
 *
 * 登録するのはリリース判定会(B-4)、置かない体制では D-0 表1「体制と運用形態」の決定者である
 * (governance.catalogRegistrar。'b4' は会議体を指し、構成員かどうかは機械で確かめない)。
 * 登録した者は記名の自然人とし、名簿と照合する。checkRegistrant を偽にすると、過去の登録者を
 * 現在の名簿・席と照合しない(離任した人の登録を残すため。AI の名義だけを拒否する)
 */
/**
 * 変更種別の登録の根拠(標準 第5章 5.5.4「登録の根拠の記録」)。3点の記録が無い種別は登録しない。
 * 機械が確かめるのは記入の有無だけである。内容は、登録する者が判定する
 */
export const CHANGE_TYPE_BASIS = [
  ['detection', '第5章 5.4.6 の検知条件を何で計測するか'],
  ['rollback', '取り消しを実行した実績の所在'],
  ['tests', '既存のテストで検出できることの根拠'],
];

export function changeTypeProblems(config, { checkRegistrant = true, only = null } = {}) {
  const list = config.delegation?.changeTypes;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['delegation.changeTypes が配列ではない'];
  const out = [];
  const ids = new Set();
  const registrar = config.governance?.catalogRegistrar ?? structureDeciderSeat(config);
  list.forEach((t, i) => {
    const id = String(t?.id ?? '').trim();
    const at = `delegation.changeTypes[${i}]`;
    if (!id) {
      out.push(`${at}: 変更種別の名称(id)がない`);
      return;
    }
    if (ids.has(id)) out.push(`${at}: 変更種別 "${id}" が重複している`);
    ids.add(id);
    if (!t.registeredBy || !isRealDay(t.registeredAt)) {
      out.push(`${at}: 変更種別 "${id}" に、登録した者(registeredBy)または登録日(registeredAt。実在する日付を YYYY-MM-DD で書く)がない`);
      return;
    }
    if (aiNameBlocked(config, t.registeredBy)) {
      out.push(`${at}: 変更種別 "${id}" を登録した者 "${t.registeredBy}" は ${aiNameBlocked(config, t.registeredBy)}。AI の名義の記名を受け付けない`);
      return;
    }
    if (only && !only.has(id)) return;
    // 様式の文言(<…>)や「—」「未定」などの記入でない値は、記入なしとして扱う(例外承認の記録の判定と同じ関数)
    const missing = CHANGE_TYPE_BASIS.filter(([k]) => typeof t.basis?.[k] !== 'string' || !isFilledValue(t.basis[k]));
    if (missing.length) {
      out.push(
        `${at}: 変更種別 "${id}" に、登録の根拠(basis)がない(${missing.map(([k, label]) => `${k}: ${label}`).join(' / ')})。` +
          '3点の記録が無い種別は登録しない(標準 第5章 5.5.4)。様式の文言(<…>)、「—」「未定」「なし」などは記入として扱わない。' +
          '機械が確かめるのは記入の有無だけであり、内容は登録する者が判定する'
      );
    }
    if (!checkRegistrant) return;
    for (const p of nameProblems(config, t.registeredBy, { requireRoster: true })) {
      out.push(`${at}: 変更種別 "${id}" を登録した者の記名を受け付けられない(${p})`);
    }
    if (registrar !== 'b4') {
      const seat = (config.seats ?? []).find((s) => s.role === registrar);
      if (!seat?.accountable || personKey(config, seat.accountable) !== personKey(config, t.registeredBy)) {
        out.push(
          `${at}: 変更種別 "${id}" を登録した者 "${t.registeredBy}" は、${seat?.name ?? registrar}の席の責任者ではない。` +
            '標準変更カタログへの登録は、D-0 表1「標準変更カタログへの登録」の決定者が行う'
        );
      }
    }
  });
  return out;
}

/** 確約範囲とコア指定のパス(delegation.protectedPaths[])の形式上の問題を返す。キーが無い構成は未宣言 */
export function protectedPathsProblems(config) {
  const list = config.delegation?.protectedPaths;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ['delegation.protectedPaths が配列ではない'];
  return list.filter((p) => typeof p !== 'string' || !p.trim()).map(() => 'delegation.protectedPaths に空の値、または文字列でない値がある');
}

/**
 * 委任の規則1件の、形式上の問題を返す。決定した者の照合は呼び出し側で行う。
 * config を渡すと、変更種別が標準変更カタログ(delegation.changeTypes[])に登録されているかも確かめる
 */
export function delegationRuleProblems(rule, config = null) {
  const out = [];
  if (!rule?.id) out.push('id がない');
  const changeType = String(rule?.changeType ?? '').trim();
  if (!changeType) {
    out.push('変更種別(changeType)がない。標準変更カタログ(標準 第3章 3.7.4)に登録した変更種別を書く');
  } else if (config && !(config.delegation?.changeTypes ?? []).some((t) => String(t?.id ?? '').trim() === changeType)) {
    out.push(
      `変更種別 "${changeType}" は、標準変更カタログ(delegation.changeTypes[])に登録されていない。` +
        '登録するのはリリース判定会(B-4)、置かない体制では D-0 表1「体制と運用形態」の決定者である(標準 第3章 3.7.4)'
    );
  }
  if (!Array.isArray(rule?.paths) || !rule.paths.length) {
    out.push('対象のパス(paths)がない。該当は観測できる属性で登録する');
  } else {
    for (const p of rule.paths) {
      const why = broadPathReason(p);
      if (why) out.push(`対象のパス "${p}" は${why}`);
    }
  }
  if (rule?.excludePaths !== undefined && !Array.isArray(rule.excludePaths)) out.push('excludePaths が配列ではない');
  return out;
}

/** 旧い指定 olds が、新しい指定 p を覆うか。ワイルドカードは代表値へ展開して確かめる */
function coveredBy(olds, p) {
  if (olds.includes(p)) return true;
  const probes = [
    p.replace(/\*\*/g, 'zq9').replace(/\*/g, 'zq8'),
    p.replace(/\*\*/g, 'zq9/zq7/zq6').replace(/\*/g, 'zq8'),
  ];
  return olds.some((g) => probes.every((x) => matchGlob(g, x)));
}

/**
 * 規則の変更の向きを返す(標準 第5章 5.5.7)。
 *   'same'    対象は変わらない(記名・理由だけの変更)
 *   'narrow'  対象が狭まる。厳しくする向きであり、即時に適用する
 *   'widen'   それ以外。狭まると示せない変更は、広がるものとして扱う
 */
export function ruleChangeDirection(before, after) {
  const bp = before.paths ?? [];
  const ap = after.paths ?? [];
  const be = before.excludePaths ?? [];
  const ae = after.excludePaths ?? [];
  if (before.seat !== after.seat || (before.changeType ?? null) !== (after.changeType ?? null)) return 'widen';
  const same = (x, y) => x.length === y.length && x.every((v) => y.includes(v));
  if (same(bp, ap) && same(be, ae)) return 'same';
  const pathsNarrow = ap.length > 0 && ap.every((p) => coveredBy(bp, p));
  const excludesKept = be.every((e) => coveredBy(ae, e));
  return pathsNarrow && excludesKept ? 'narrow' : 'widen';
}

// ---------------------------------------------------------------- 指示資産の版

/**
 * 指示資産(CLAUDE.md・AGENTS.md・.claude/)の内容から導いた識別子を返す。
 *
 * 担い手の識別のうち「指示資産の版」は自己申告の文字列であり、実ファイルと食い違っても
 * 分からない。performer.instructions の末尾へ `@<この値>` を書いておくと、契約検査が
 * 実ファイルと照合する。構成から生成する区間は、構成の変更記録で追えるため除く。
 */
export function instructionAssetsDigest() {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (!/\/(\.self-heal|settings\.local\.json)$/.test(r)) files.push(r);
    }
  };
  walk('.claude');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) if (fs.existsSync(path.join(ROOT, f))) files.push(f);
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) {
    let text = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    if (f === 'CLAUDE.md') {
      text = text.replace(/<!-- generated:process-rules start -->[\s\S]*?<!-- generated:process-rules end -->/, '');
    }
    h.update(f).update('\0').update(text).update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * performer.instructions の申告と、実ファイルの照合。
 * 末尾が `@<16進7桁以上>` でない申告は照合できない(match: null)
 */
export function instructionsCheck(performer) {
  const declared = String(performer?.instructions ?? '').match(/@([0-9a-f]{7,64})$/)?.[1] ?? null;
  if (!declared) return { declared: null, actual: null, match: null };
  const actual = instructionAssetsDigest();
  return { declared, actual, match: actual.startsWith(declared) || declared.startsWith(actual) };
}

/**
 * 適合性確認の記録に欠けているものを返す(標準 第3章 3.4.2)。空なら有効。
 * 担い手の識別が確認時と異なる場合は失効として扱う。
 */
export function qualificationProblems(seat) {
  const q = seat.qualification;
  if (!q) return ['適合性確認の記録がない'];
  // 承認者が名簿から外れた確認は失効として扱う。離脱の変化点を止めない(第3章 3.13.3 / 第5章 5.5.7)
  if (q.lapsed) return [`適合性確認が失効している(${q.lapsed.reason ?? '失効'})`];
  const out = [];
  for (const [k, label] of [
    ['confirmedAt', '実施日'],
    ['performedBy', '実施者'],
    ['approvedBy', '承認者'],
    ['cases', '用いた事例'],
    ['result', '結果'],
  ]) {
    if (!q[k]) out.push(`適合性確認の${label}(${k})がない`);
  }
  if (performerKey(q.performer) !== performerKey(seat.performer)) {
    out.push('適合性確認が失効している(確認した担い手の識別と、現在の担い手の識別が異なる)');
  }
  return out;
}

/** パスが glob に当たるか。** と * だけを解釈する */
export function matchGlob(glob, file) {
  const re = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${re}$`).test(file.replace(/\\/g, '/'));
}

// ---------------------------------------------------------------- 挙動要約の最低限の形(第4章 G-6 基準2・条件4。#288 第8巡 X8)
//
// 承認レビューの本文、または判定記録の「挙動要約」の節が、承認した者自身の挙動要約として数えられる最低限の形。
// 機械が確かめるのは形だけであり、中身(変更の挙動を述べているか、自分の言葉か)は確かめない(内部監査の抜き取り)。
//   - 承認の語だけの本文(LGTM / OK / approve / 承認 / 問題なし など)は数えない
//   - 見出し語「挙動要約」とコメント・記号を除いた本文が、SUMMARY_MIN_CHARS 文字(空白と句読点を除く)以上あること(1〜2文の下限)
export const SUMMARY_MIN_CHARS = 8;
const SUMMARY_STOCK_PHRASES = /^(lgtm|ok|okay|good|fine|approve[d]?|approval|ship ?it|\+1|👍|承認|承認します|問題なし|問題ありません|良い|よい|良さそう|よさそう|確認しました|確認済み|見ました|ok です|okです|了解|rgr)$/i;
/** 本文が挙動要約の最低限の形を満たすか。満たさない理由を返す(満たせば null) */
export function behaviorSummaryShortfall(text) {
  const raw = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .normalize('NFKC');
  const body = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[#>*\-・]+\s*)?(?:\*\*)?挙動要約(?:\*\*)?\s*[::]?\s*/u, '').trim())
    .filter(Boolean)
    .join(' ');
  const letters = body.replace(/[\s\p{P}\p{S}]+/gu, '');
  if (!letters) return '本文が空(見出し語だけ)';
  if (SUMMARY_STOCK_PHRASES.test(letters.toLowerCase().replace(/\s+/g, ' '))) return `承認の語だけ(「${body.slice(0, 20)}」)`;
  if ([...letters].length < SUMMARY_MIN_CHARS) return `${[...letters].length} 文字(${SUMMARY_MIN_CHARS} 文字未満。1〜2文の挙動要約に満たない)`;
  return null;
}
export const hasBehaviorSummary = (text) => behaviorSummaryShortfall(text) === null;

// ---------------------------------------------------------------- コア機能のパスと、コア機能の変更に要する承認者の数(第8章 軸C 高。#288 第8巡 Z7)
//
// 「コア機能」の機械の判定は、構成に既にある2つの宣言だけから導く(新しい欄を作らない)。
//   - 確約範囲・コア指定のパス(delegation.protectedPaths。委任を適用しない案件でも種別 mode で宣言できる)
//   - 区分の下限の規則のパス(riskFloor.rules[].paths。下限 R1・R2 のいずれも。kinds は見ない)
// どちらも無い構成では「未宣言」であり、コア機能の変更を判定できない(黙って通さず、未宣言と表示する)
export function corePathsOf(config) {
  const fromProtected = Array.isArray(config?.delegation?.protectedPaths) ? config.delegation.protectedPaths.filter((p) => typeof p === 'string' && p.trim()) : null;
  const fromFloor = (Array.isArray(config?.riskFloor?.rules) ? config.riskFloor.rules : []).flatMap((r) => (Array.isArray(r?.paths) ? r.paths.filter((p) => typeof p === 'string' && p.trim()) : []));
  const declared = fromProtected !== null || fromFloor.length > 0;
  const paths = [...new Set([...(fromProtected ?? []), ...fromFloor])];
  return { declared, paths, sources: { protectedPaths: fromProtected, riskFloorRules: (config?.riskFloor?.rules ?? []).length } };
}
/** G-6 に要する独立した人の承認者の数。全変更の数(review.reviewerCount)と、コア機能の変更の数(gates.g6.params.coreReviewerCount)。大きいほうが掛かる */
export function reviewersRequiredOf(config) {
  const all = Math.max(1, Number(config?.review?.reviewerCount ?? config?.review?.requiredApprovals ?? 1) || 1);
  const coreParam = Number(config?.gates?.g6?.params?.coreReviewerCount);
  const core = Number.isFinite(coreParam) && coreParam > 0 ? Math.max(all, coreParam) : all;
  return { all, core, coreDeclared: Number.isFinite(coreParam) && coreParam > 0, coreParam: Number.isFinite(coreParam) ? coreParam : null };
}
/** 変更したファイルがコア機能のパスに当たるか。未宣言なら null(判定できない) */
export function touchesCore(config, files) {
  const core = corePathsOf(config);
  if (!core.declared) return null;
  const hit = (files ?? []).filter((f) => core.paths.some((g) => matchGlob(g, f)));
  return { hit: hit.length > 0, files: hit, paths: core.paths };
}

/** git の --numstat の出力から、変更行数(追加 + 削除)を合計する */
export function sumNumstat(text) {
  return (text ?? '')
    .split('\n')
    .map((l) => l.split('\t'))
    .reduce((n, [add, del]) => n + (Number(add) || 0) + (Number(del) || 0), 0);
}

/**
 * 変更したファイルの組が委任の範囲に当たるかを、機械の規則で判定する(標準 第5章 5.5.4 条件2)。
 *
 * 1つの規則がすべてのファイルを覆う場合に限り、該当とする。規則で分類できない変更は
 * 該当なし(協働)へ落とす。行為する AI 自身に該当を判定させないための関数であり、
 * 条件3・4(G-5 の全通過、取り消しの実績)はここでは判定しない。条件5 は、構成に登録された
 * 確約範囲とコア指定のパス(delegation.protectedPaths[])に触れる変更を対象外にする。
 * キーが無い構成は未宣言であり、ここでは条件5 を判定しない(protectedPathsChecked: false)。
 * 未宣言の構成を該当なしとする判定は、delegation.mjs が行う。空の配列は「確約範囲・コア指定なし」の宣言
 */
export function classifyDelegation(config, files, ruleId = null, changedLines = null, { seat: seatRole = null } = {}) {
  const d = config.delegation ?? {};
  if (d.allowed !== true) return { rule: null, reasons: ['委任を適用できない構成である'] };
  if (!files.length) return { rule: null, reasons: ['変更したファイルがない'] };
  const guarded = files.filter((f) => NEVER_DELEGATED.some((g) => matchGlob(g, f)));
  if (guarded.length) {
    return {
      rule: null,
      reasons: [`強制層・構成の正本・判定の記録を含む(${guarded.slice(0, 5).join(', ')})。これらは委任の範囲へ入れない`],
    };
  }
  const protectedPaths = (d.protectedPaths ?? []).filter((g) => typeof g === 'string' && g.trim());
  const touched = files.filter((f) => protectedPaths.some((g) => matchGlob(g, f)));
  if (touched.length) {
    return {
      rule: null,
      reasons: [`確約範囲またはコア指定のパスに触れる(${touched.slice(0, 5).join(', ')})。委任の対象にできない(第5章 5.5.4 条件5)`],
    };
  }
  // 委任は変更単位の規模の上限を緩めない(第8章「対象にできる変更の境界」)
  const maxFiles = config.task?.maxChangedFiles;
  const maxLines = config.task?.maxChangedLines;
  if (maxFiles && files.length > maxFiles) {
    return { rule: null, reasons: [`変更ファイル数 ${files.length} が上限 ${maxFiles} を超えている`] };
  }
  if (maxLines && changedLines !== null && changedLines > maxLines) {
    return { rule: null, reasons: [`変更行数 ${changedLines} が上限 ${maxLines} を超えている`] };
  }
  const candidates = (d.rules ?? []).filter((r) => (!ruleId || r.id === ruleId) && (!seatRole || r.seat === seatRole));
  if (!candidates.length) {
    const why = ruleId
      ? `規則 ${ruleId} が delegation.rules にない`
      : seatRole
        ? `席 ${seatRole} の委任の規則が登録されていない`
        : '委任の規則が登録されていない';
    return { rule: null, reasons: [why] };
  }
  const reasons = [];
  for (const r of candidates) {
    const seat = (config.seats ?? []).find((s) => s.role === r.seat);
    const formal = delegationRuleProblems(r, config);
    if (formal.length) {
      reasons.push(`${r.id}: 規則が登録の要件を満たしていない(${formal[0]})`);
      continue;
    }
    // 承認待ち・決定した者を欠く規則は無効である。同じ席に有効な規則があっても、無効な規則では該当としない
    // 変更種別の登録(登録の根拠と、登録した者)を欠く規則も有効でない(第5章 5.5.4。生成側の ruleStanding と同じ)
    const standing = [
      ...ruleDeciderProblems(config, r),
      ...ruleApprovalProblems(config, r),
      ...changeTypeProblems(config, { only: new Set([String(r.changeType ?? '').trim()]) }),
    ];
    if (standing.length) {
      reasons.push(`${r.id}: 規則が有効でない(${standing[0]})`);
      continue;
    }
    if (seat?.mode !== 'delegated') {
      reasons.push(`${r.id}: ${seat?.name ?? r.seat} は委任を宣言していない`);
      continue;
    }
    if (qualificationProblems(seat).length) {
      reasons.push(`${r.id}: ${seat.name} の適合性確認が未実施または失効している`);
      continue;
    }
    const outside = files.filter(
      (f) => !(r.paths ?? []).some((g) => matchGlob(g, f)) || (r.excludePaths ?? []).some((g) => matchGlob(g, f))
    );
    if (outside.length) {
      reasons.push(`${r.id}: 規則の対象外のファイルを含む(${outside.slice(0, 5).join(', ')})`);
      continue;
    }
    return { rule: r.id, seat: seat.name, reasons: [], protectedPathsChecked: Array.isArray(d.protectedPaths) };
  }
  return { rule: null, reasons };
}

/**
 * ゲート判定記録(docs/gates/*.md)の冒頭の表から欄を読む。
 * 様式の選択肢を残したままの欄(「人確定 / 協働 / 委任」など)は未記入として扱う。
 */
export function readGateRecords() {
  const dir = path.join(ROOT, 'docs/gates');
  if (!fs.existsSync(dir)) return [];
  const raw = (text, key) => text.match(new RegExp(`^\\|\\s*${key}\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'm'))?.[1]?.trim() ?? null;
  const cell = (text, key) => {
    const v = raw(text, key) ?? '';
    return v && !v.includes(' / ') && !v.startsWith('<') ? v : null;
  };
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      return {
        file: `docs/gates/${f}`,
        gate: cell(text, 'ゲート'),
        target: cell(text, '対象'),
        result: cell(text, '結果'),
        // 結果欄の記載そのもの(様式の文言を残したままの値を含む)。2値のどちらとも読めない理由を示すために使う
        resultRaw: raw(text, '結果'),
        mode: cell(text, '確定の形態'),
        riskConfirmedBy: cell(text, 'リスク区分を確定した者'),
        d0Version: cell(text, '参照した D-0 の版'),
        judgedAt: cell(text, '判定日時'),
      };
    });
}

// ---------------------------------------------------------------- 変化点の記録の連鎖
//
// 構成(process.config.json)を書き換えるのは /process-change だけである。手で書き換えた構成を
// 検出するため、changeLog[] の各記録へ、適用後の構成の要約値(stateHash)と、直前の記録の
// 要約値(prevHash)を持たせる。最後の記録の stateHash が現在の構成と一致しなければ、構成は
// 変化点を経ずに書き換えられている。記録の切り詰め・差し替えは、連鎖の不一致として現れる。
//
// 限界: 要約値ごと書き換える改ざんは、ローカルだけでは検出できない。PR では基底ブランチの
// 構成と比べる(baseChainProblems)。過去の記録の書き換えはそこで止まるが、構成を手で書き換えて
// 要約値を計算し直した記録を追記する偽造は通る。要約値は鍵を持たず、記名した本人の決定を証明しない。
// 止めるのは、構成が強制層であること(変更は AI維持管理者の承認を要する)と、人による確認である。

/** 連鎖を持つ構成の schemaVersion。0 は連鎖を持たない旧い構成 */
export const CHAINED_SCHEMA_VERSION = 1;

/** キーの並びに依らない JSON の表現。要約値の計算に使う */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** changeLog を除いた構成の要約値 */
export function configDigest(config) {
  const { changeLog, ...rest } = config ?? {};
  return sha256(canonicalJson(rest));
}

/** 変化点の記録1件の要約値(記録の全体。stateHash と prevHash を含む) */
export function recordDigest(entry) {
  return sha256(canonicalJson(entry));
}

/**
 * 記録 i が持つべき prevHash。直前の記録が要約値を持てば、その記録の要約値(連鎖)。
 * 持たなければ(連鎖の起点)、それより前の旧い記録の全体の要約値とし、旧い記録の書き換えも検出する
 */
function prevDigest(log, i) {
  if (i === 0) return null;
  return log[i - 1]?.stateHash ? recordDigest(log[i - 1]) : sha256(canonicalJson(log.slice(0, i)));
}

/** 連鎖が始まっているか(要約値を持つ記録が1件でもあるか) */
export function chainStarted(config) {
  return (config?.changeLog ?? []).some((e) => e?.stateHash);
}

/**
 * 最後の記録へ要約値を書く。構成を書き出す直前に呼ぶ。
 * 旧い構成(要約値なし)へ最初に追記する記録は、連鎖の起点(chainStart)になる
 */
export function sealChangeLog(config) {
  const log = config.changeLog ?? [];
  const last = log.at(-1);
  if (!last) return config;
  const prev = log.at(-2) ?? null;
  if (prev && !prev.stateHash) last.chainStart = true;
  last.prevHash = prevDigest(log, log.length - 1);
  config.schemaVersion = CHAINED_SCHEMA_VERSION;
  last.stateHash = configDigest(config);
  return config;
}

/** 連鎖の検査。問題の一覧を返す。連鎖が始まっていない構成は legacy を真にして返す */
export function chainProblems(config) {
  const log = Array.isArray(config?.changeLog) ? config.changeLog : [];
  const first = log.findIndex((e) => e?.stateHash);
  if (first < 0) return { legacy: true, problems: [] };
  const problems = [];
  if ((config.schemaVersion ?? 0) < CHAINED_SCHEMA_VERSION) {
    problems.push(`schemaVersion が ${config.schemaVersion ?? 0} です。要約値の連鎖を持つ構成は ${CHAINED_SCHEMA_VERSION} 以上です`);
  }
  for (let i = first; i < log.length; i++) {
    const e = log[i];
    if (!e?.stateHash) {
      problems.push(`changeLog[${i}]: 要約値(stateHash)がありません。連鎖の途中の記録が差し替えられています`);
      continue;
    }
    if ((e.prevHash ?? null) !== prevDigest(log, i)) {
      problems.push(`changeLog[${i}]: 直前の記録の要約値(prevHash)が一致しません。記録の書き換え・切り詰め・差し替えの疑いがあります`);
    }
    if (i === first && first > 0 && e.chainStart !== true) {
      problems.push(`changeLog[${i}]: 連鎖の起点(chainStart)の印がありません。これより前の記録が差し替えられた疑いがあります`);
    }
  }
  const last = log.at(-1);
  if (last?.stateHash && last.stateHash !== configDigest(config)) {
    problems.push(
      '構成が、変化点の記録を経ずに書き換えられています(最後の記録の要約値と、現在の構成が一致しません)。' +
        '構成を書き換えるのは /process-change だけです。手での編集を戻し、/process-change で変化点として反映してください'
    );
  }
  return { legacy: false, problems };
}

/**
 * 基底ブランチの構成との比較(PR で使う)。問題の一覧を返す。
 *
 * 構成が変わっているのに changeLog の追記が無い場合と、基底の changeLog が先頭部分として
 * 保たれていない場合(書き換え・切り詰め)を検出する。要約値ごと書き換えた構成も、ここで止まる
 */
export function baseChainProblems(base, head) {
  if (!base || base.configured !== true) return [];
  const problems = [];
  if (head?.configured !== true) {
    return ['基底ブランチの構成は設定済みですが、この変更は構成を未設定へ戻しています'];
  }
  const bl = Array.isArray(base.changeLog) ? base.changeLog : [];
  const hl = Array.isArray(head.changeLog) ? head.changeLog : [];
  const broken = bl.findIndex((e, i) => i >= hl.length || canonicalJson(e) !== canonicalJson(hl[i]));
  if (broken >= 0) {
    problems.push(
      `基底ブランチの changeLog[${broken}] が保たれていません。変化点の記録は追記だけを認めます(書き換え・切り詰め・差し替えを認めません)`
    );
  }
  if (configDigest(base) !== configDigest(head) && hl.length <= bl.length) {
    problems.push('基底ブランチから構成が変わっていますが、changeLog への追記がありません。構成を書き換えるのは /process-change だけです');
  }
  if (chainStarted(base) && !chainStarted(head)) {
    problems.push('基底ブランチの構成は要約値の連鎖を持ちますが、この変更は連鎖を外しています');
  }
  return problems;
}

/**
 * AI が使えない期間の一覧を返す(保証の開示の項目7 へ出す)。
 *
 * 開始だけを記録した期間は、後の記録(outage.closes が添字を指す)で終了日を書いて閉じる。
 * 過去の記録は書き換えない。閉じていない期間は to が null(継続中)
 */
export function outagePeriods(config) {
  const log = Array.isArray(config?.changeLog) ? config.changeLog : [];
  const closer = new Map(log.filter((e) => e?.kind === 'outage' && Number.isInteger(e.outage?.closes)).map((e) => [e.outage.closes, e.outage]));
  return log
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e?.kind === 'outage' && e.outage && !Number.isInteger(e.outage.closes))
    .map(({ e, index }) => {
      const c = e.outage.to ? null : closer.get(index);
      return {
        index,
        from: e.outage.from,
        to: e.outage.to ?? c?.to ?? null,
        handling: c?.handling ?? e.outage.handling,
        switched: e.outage.switched === true,
        ongoing: !(e.outage.to ?? c?.to),
      };
    });
}

/**
 * 即時通知(標準 第3章 3.13.6)の記録が済んでいない変化点を返す。
 *
 * 即時通知の対象になった記録は notice: { to, at, reasons } を持つ。通知先と通知日が未記入の
 * 記録は、後から追記された種別 notice の記録(noticeFor が添字を指す)で埋まる。
 * 過去の記録は書き換えない
 */
export function pendingNotices(config) {
  const log = Array.isArray(config?.changeLog) ? config.changeLog : [];
  const filled = (n) => Boolean(n?.to && n?.at);
  const later = new Set(log.filter((e) => e?.kind === 'notice' && Number.isInteger(e.noticeFor) && filled(e.notice)).map((e) => e.noticeFor));
  return log
    .map((e, index) => ({ e, index }))
    .filter(({ e, index }) => e?.notice && !filled(e.notice) && !later.has(index))
    .map(({ e, index }) => ({ index, date: e.date ?? null, kind: e.kind, reasons: e.notice.reasons ?? [] }));
}

// ---------------------------------------------------------------- 日付と時刻
//
// スクリプトが自動で書く日付は、手元の時刻帯の日付で書く。協定世界時の日付で書くと、人が書く日付
// (判定記録の判定日時など)と、時刻帯によって1日ずれる。順序の比較には、オフセットつきの時刻を使う。

/** 手元の時刻帯の、オフセットつきの時刻(ISO 8601。例 2026-10-01T08:30:00+09:00) */
export function localIso(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 手元の時刻帯の日付(YYYY-MM-DD) */
export function localDay(d = new Date()) {
  return localIso(d).slice(0, 10);
}

/** 実在する日付(YYYY-MM-DD)か。2026-02-31 のような、暦に無い日付を受け付けない */
export function isRealDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** GitHub Actions の注釈として出す(ローカル実行では素の行として出る) */
export function notice(msg) {
  console.log(`::notice::${msg}`);
}
export function warn(msg) {
  console.log(`::warning::${msg}`);
}
export function fail(msg) {
  console.log(`::error::${msg}`);
}

export function hasTarget(adapter) {
  const adapterId = adapter.id;
  if (adapterId === 'node') {
    return fs.existsSync(path.join(ROOT, 'package.json'));
  }
  if (adapterId === 'python') {
    const pyFiles = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'];
    return pyFiles.some((f) => fs.existsSync(path.join(ROOT, f)));
  }
  if (adapterId === 'go') {
    return fs.existsSync(path.join(ROOT, 'go.mod'));
  }
  if (adapterId === 'none') {
    const cmds = Object.values(adapter.commands ?? {});
    return cmds.some((c) => (c ?? '').trim().length > 0);
  }
  if (adapterId === 'undetermined') {
    return false;
  }
  return true;
}

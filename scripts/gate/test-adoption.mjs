// 既存のリポジトリへの持ち込みの試験(標準 第1章 1.10.1・1.10.3。process-compass #315 / ADR-0085)。
//
//   node scripts/gate/test-adoption.mjs
//
// 固定する決定:
//   - 適用の開始の境は、既定ブランチの第1親の連鎖の上で configured が true になった最初のコミット。併合した別の履歴の中の
//     configured: true のコミットを境にしない(品質保証 V-4。先に旧い探し方で再現し、そのうえで直した探し方を確かめる)
//   - 開始より前の履歴は出所を問わず要求事項の対象外で、件数だけを開示する。開始の後に併合した共通の祖先の無い履歴は数える
//   - 事前点検(preflight.mjs)は、止める項目(雛形の所有者・フックの登録の欠け・CLAUDE.md の常駐の規則の欠け・既定ブランチの名・
//     gate-g5.yml の欠け・資産の一覧の欠け)と告げる項目を分ける。共通の祖先の無い履歴の併合とカバレッジの測定の穴は止めない(一覧へ載せる)
//   - 資産の一覧は、点検が検出した資産をすべて載せ、扱いを4つの値で書き、人が記名で確定する
//   - 初期化は事前点検の結果を changeLog[0] へ書く。無い構成は記録の欠落として注記する。--dry-run も止める項目があれば構成を出さない
//   - フックの登録の欠けと @OWNER の残りは、契約検査でも失敗にする
//   - 構成の形式の版(formatVersion)。知らない版は契約検査が拒否する。移行(種別 migrate)は値を変えず、要約値を記録し直さない
//   - 取り込んだ準拠テンプレートの記録(template.commit と強制層の要約値)。不一致は表示だけで、合否に使わない。記録し直すのは
//     種別 intake(記名の自然人の決定)だけで、取り直す直前の乖離と知識ベースの版の前後を道具が書く
// GitHub へ問い合わせません。リポジトリの状態を変えません。構成が設定済みのリポジトリでは省きます。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, findInitCommit, sealChangeLog, FORMAT_VERSION, hookRegistrationProblems, mergeHookRegistration, templateDrift } from './config.mjs';
import { RULES_BEGIN as PF_BEGIN, RULES_END as PF_END, TEMPLATE_WORKFLOWS, TEMPLATE_TOP, TEMPLATE_INSTRUCTION_FILES, TEMPLATE_CODEOWNERS_PATTERNS, preflight } from './preflight.mjs';
import { buildConfig, RULES_BEGIN, RULES_END } from '../init/generate-profile.mjs';

const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
if (own.configured !== false) {
  console.log('持ち込みの試験: 構成が設定済みのため省きます(テンプレートの初期の状態でだけ実行します)');
  process.exit(0);
}

const SKIP = new Set(['.git', 'node_modules', 'evidence', 'coverage', 'graft']);
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${name}${ok || !detail ? '' : `\n       ${String(detail).split('\n').slice(-10).join('\n       ')}`}`);
}
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

const COMMON = { 'q-quality': 'quality-standard', 'q-criticality': 'cl0', 'q-dev-form': 'inhouse', 'q-existing-gates': 'gates-none', 'q-ai-constraint': 'ai-free', 'q-biz-phase': 'growth' };
const PEOPLE = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `名簿 ${'甲乙丙丁戊己'[i]}`, accounts: [`acc${i}`] }));
const seatsOf = (map) => Object.entries(map).map(([role, accountable]) => ({ role, accountable }));
const SEATS3 = seatsOf({ 'value-owner': 'p0', 'tech-lead': 'p5', 'dev-verifier': 'p1', 'independent-reviewer': 'p2', 'qa-gatekeeper': 'p3', 'biz-approver': 'p4' });
const build = (answers, opts = {}) => quiet(() => buildConfig({ ...COMMON, ...answers }, { generatedAt: '2026-10-13T09:00:00+09:00', d0Version: null, ...opts }).config);
const sealed = (c) => sealChangeLog(JSON.parse(JSON.stringify(c)));
const base = build({ 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }, { people: PEOPLE, seats: SEATS3 });
const contractErrors = (out) => out.split('\n').filter((l) => /::error::/.test(l) && !/アダプタ none/.test(l));

function workspace({ keepOwner = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-adoption-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  if (!keepOwner) {
    const co = path.join(dir, '.github/CODEOWNERS');
    fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  }
  const env = { ...process.env, GITHUB_BASE_REF: '', GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...(git.dateEnv ?? {}) } });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  const node = (script, ...a) => {
    const r = spawnSync(process.execPath, [script, ...a], { cwd: dir, encoding: 'utf8', env });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const writeJson = (rel, v) => write(rel, JSON.stringify(v, null, 2) + '\n');
  const readJson = (rel) => JSON.parse(read(rel));
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD').trim();
  };
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, git, node, write, read, writeJson, readJson, commit, done };
}

// ---------------------------------------------------------------- 定数がテンプレートと一致する
{
  check('事前点検の生成区間の目印が、初期化の目印と一致する', PF_BEGIN === RULES_BEGIN && PF_END === RULES_END);
  const wf = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).sort();
  check('事前点検が知るテンプレートのワークフローが、テンプレートの .github/workflows と一致する', JSON.stringify(wf) === JSON.stringify([...TEMPLATE_WORKFLOWS].sort()), JSON.stringify(wf));
  const top = [...new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.split('/')[0]))];
  const outside = top.filter((t) => !TEMPLATE_TOP.includes(t));
  check('テンプレートの直下の配置が、事前点検の配置の一覧に収まる', outside.length === 0, outside.join(', '));
  const instr = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /(^|\/)(CLAUDE\.md|AGENTS\.md|CLAUDE\.local\.md)$/.test(f)).sort();
  check('事前点検が除くテンプレートの指示ファイルが、テンプレートの git ls-files と一致する', JSON.stringify(instr) === JSON.stringify([...TEMPLATE_INSTRUCTION_FILES].sort()), JSON.stringify(instr));
  const coPatterns = fs.readFileSync(path.join(ROOT, '.github/CODEOWNERS'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)[0]);
  check('事前点検が知るテンプレートの CODEOWNERS のパスの並びが、テンプレートの .github/CODEOWNERS と一致する', JSON.stringify(coPatterns) === JSON.stringify(TEMPLATE_CODEOWNERS_PATTERNS), JSON.stringify(coPatterns));
}

// ---------------------------------------------------------------- 適用の開始の境(V-4 の再現と直し)
{
  const w = workspace();
  w.commit('chore: template');
  w.writeJson('process.config.json', sealed(base));
  const initHash = w.commit('chore: init');
  // 共通の祖先の無い別の履歴。開始より古い日付で configured: true の構成を持つ
  w.git('checkout', '-q', '--orphan', 'other');
  w.git('rm', '-rqf', '.');
  const other = sealed(build({ 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }, { people: PEOPLE, seats: SEATS3, generatedAt: '2020-01-01T09:00:00+09:00' }));
  w.writeJson('process.config.json', other);
  w.write('src/other.js', 'export const other = 1;\n');
  w.git.dateEnv = { GIT_AUTHOR_DATE: '2020-01-01T09:00:00+09:00', GIT_COMMITTER_DATE: '2020-01-01T09:00:00+09:00' };
  const otherHash = w.commit('feat: 別の履歴');
  w.git.dateEnv = null;
  w.git('checkout', '-q', 'main');
  // 開始の後に、別の履歴を併合する(構成は併合した側の内容を採る)
  w.git('merge', '-q', '--allow-unrelated-histories', '-X', 'theirs', '--no-edit', 'other');
  const mergeHash = w.git('rev-parse', 'HEAD').trim();
  // 再現: 旧い探し方(全履歴を歩く git log --reverse)は、併合した別の履歴のコミットを境にする
  const oldFind = () => {
    for (const h of w.git('log', '--reverse', '--format=%H', '--', 'process.config.json').split('\n').filter(Boolean)) {
      try {
        if (JSON.parse(w.git('show', `${h}:process.config.json`)).configured === true) return h;
      } catch {
        // 読めない版は飛ばす
      }
    }
    return null;
  };
  const old = oldFind();
  check('V-4 の再現: 旧い探し方は、併合した別の履歴の configured: true のコミットを適用の開始にする', old === otherHash, `旧い探し方の結果 ${old} / 別の履歴 ${otherHash} / 本来の開始 ${initHash}`);
  // IMPL-0313:ok(適合の入力: 既定ブランチの第1親の連鎖の上の、最初の configured: true のコミット)
  check('適用の開始は、既定ブランチの第1親の連鎖の上の最初の configured: true のコミット', findInitCommit(w.dir)?.hash === initHash, `${findInitCommit(w.dir)?.hash} / ${initHash}`);
  // IMPL-0313:ng(違反の入力: 併合した別の履歴の中の configured: true のコミットを境にしない)
  check('併合した別の履歴の中のコミットを、適用の開始にしない', findInitCommit(w.dir)?.hash !== otherHash && findInitCommit(w.dir)?.hash !== mergeHash);
  const a = w.node('scripts/gate/aggregate-evidence.mjs');
  const errs = a.out.split('\n').filter((l) => /::error::/.test(l));
  // IMPL-0318:ng(違反の入力: 開始の後に併合した共通の祖先の無い履歴の、記録の無い製品の変更。免除しない)
  check('開始の後に併合した共通の祖先の無い履歴の製品の変更は、記録の欠落として数える', errs.some((l) => l.includes(`コミット ${otherHash.slice(0, 8)}`)), errs.join('\n') || a.out.slice(-1500));
  const ev = w.readJson('evidence/evidence.json');
  // IMPL-0318:ok(適合の入力: 開始より前の履歴は、出所を問わず件数だけ。内訳の区別をしない)
  check('開始より前の履歴は件数だけを開示し、出所の内訳を持たない', ev.preInit?.commits === 1 && ev.preInit?.outOfScope === true && Object.keys(ev.preInit).sort().join(',') === 'commits,initCommit,outOfScope', JSON.stringify(ev.preInit));
  w.done();
}
{
  // 開始のコミットがマージ(初期化を枝で行い、--no-ff で入れた)なら、枝の側の開始より前のコミットを開始の後に数えない
  const w = workspace();
  w.commit('chore: template');
  w.git('checkout', '-q', '-b', 'init-branch');
  w.write('src/a.js', 'export const a = 1;\n');
  w.commit('feat: 枝の上の開始より前の変更');
  w.writeJson('process.config.json', sealed(base));
  w.commit('chore: init(枝)');
  w.git('checkout', '-q', 'main');
  w.git('merge', '-q', '--no-ff', '--no-edit', 'init-branch');
  const mergeHash = w.git('rev-parse', 'HEAD').trim();
  check('初期化を --no-ff で入れた場合、開始は第1親の連鎖の上のマージのコミット', findInitCommit(w.dir)?.hash === mergeHash);
  w.node('scripts/gate/aggregate-evidence.mjs');
  const ev = w.readJson('evidence/evidence.json');
  check('開始のマージの第2親の側(枝の開始より前のコミット)も、開始より前として数える', ev.preInit?.commits === 3, JSON.stringify(ev.preInit));
  w.done();
}

// ---------------------------------------------------------------- 事前点検
{
  const w = workspace({ keepOwner: true });
  w.commit('chore: template');
  const ids = (r) => r.stops.map((s) => s.id);
  let r = preflight(w.dir);
  // IMPL-0320:ng(違反の入力: 雛形の所有者が残ったまま。黙って統制が外れる状態の2つ目)
  check('雛形の所有者 @OWNER が残れば、事前点検が止める', ids(r).some((i) => /owner/i.test(i)), JSON.stringify(r.stops));
  const co = path.join(w.dir, '.github/CODEOWNERS');
  fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  w.commit('chore: 所有者');
  r = preflight(w.dir);
  check('テンプレートから作り所有者を置き換えたリポジトリでは、止める項目が無い', r.stops.length === 0 && !r.needInventory, JSON.stringify(r.stops));

  // 強制層のワークフロー gate-g5.yml の欠け → 止める(#315 突合 X-15)
  const g5 = w.read('.github/workflows/gate-g5.yml');
  fs.rmSync(path.join(w.dir, '.github/workflows/gate-g5.yml'));
  r = preflight(w.dir);
  check('テンプレートのワークフロー gate-g5.yml が無ければ、事前点検が止める', r.stops.some((s) => s.id === 'gate-g5-workflow'), JSON.stringify(r.stops));
  w.write('.github/workflows/gate-g5.yml', g5);

  // フックの登録の欠け → 止める。--merge-hooks で既存の登録を残して併合する
  const settings = w.readJson('.claude/settings.json');
  const custom = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
  w.writeJson('.claude/settings.json', { ...settings, hooks: { PreToolUse: [custom] } });
  r = preflight(w.dir);
  check('既存の .claude/settings.json にテンプレートのフックの登録が無ければ、事前点検が止める', r.stops.some((s) => /settings\.json/.test(s.place) || /フック/.test(s.text)), JSON.stringify(r.stops));
  // 構成が未設定の契約検査は早く終わるため、ここでは関数で確かめる。契約検査の入口を通す場面は、設定済みの構成の節にある
  check('フックの登録の欠けを、登録の検査が問題にする', hookRegistrationProblems(w.readJson('.claude/settings.json')).problems.length > 0);
  const m = w.node('scripts/init/generate-profile.mjs', '--merge-hooks');
  const merged = w.readJson('.claude/settings.json');
  // IMPL-0320:ok(適合の入力: テンプレートの登録を併合した設定。既存の登録は残る)
  check('--merge-hooks は、既存の登録を残してテンプレートのフックを足す', m.ok && hookRegistrationProblems(merged).problems.length === 0 && JSON.stringify(merged.hooks.PreToolUse).includes('echo mine'), m.out);
  check('併合は冪等(2回目で登録が増えない)', JSON.stringify(mergeHookRegistration(merged)) === JSON.stringify(merged));
  w.commit('chore: フック');

  // CLAUDE.md の常駐の規則の欠け → 止める
  const claude = w.read('CLAUDE.md');
  w.write('CLAUDE.md', `# 既存の規約\n\n${RULES_BEGIN}\n${RULES_END}\n`);
  r = preflight(w.dir);
  check('CLAUDE.md にテンプレートの常駐の規則が欠ければ、事前点検が止める', r.stops.some((s) => s.place === 'CLAUDE.md'), JSON.stringify(r.stops));
  w.write('CLAUDE.md', claude);

  // 既存の資産 → 一覧が無ければ止める。下書き → 記名 → 通る
  w.write('AGENTS.md', '# 既存のエージェントの指示\n\nテストは pytest で書く。\n');
  w.write('.github/workflows/build.yml', 'name: build\non: [push]\njobs: {}\n');
  w.write('src/app.py', 'print(1)\n');
  w.commit('feat: 既存の資産');
  r = preflight(w.dir);
  check('既存の資産があり一覧が無ければ、事前点検が止める', r.needInventory && r.stops.some((s) => s.place === 'docs/adoption-inventory.md'), JSON.stringify(r.stops));
  check('独自の AGENTS.md・既存のワークフロー・既存の製品のコードを資産として告げる', ['agents-md', 'workflow', 'history'].every((id) => r.assets.some((a) => a.id === id)), JSON.stringify(r.assets.map((a) => a.id)));
  check('テンプレートの CODEOWNERS の所有者を置き換えただけのものは、資産に数えない', !r.assets.some((a) => a.id === 'codeowners'), JSON.stringify(r.assets.map((a) => a.id)));
  check('カバレッジの測定の穴は、止めずに告げる', !r.stops.some((s) => /カバレッジ/.test(s.place)));
  const draft = w.node('scripts/gate/preflight.mjs', '--draft').out;
  check('下書きは、扱いと確定した者の欄を空けて出す(AI は埋めない)', /<氏名>/.test(draft) && /\|  \|  \|$/m.test(draft), draft);
  const fill = (text, disposition, signer = '名簿 己') =>
    text
      .replace('<氏名>', signer)
      .replace('<YYYY-MM-DD>', '2026-10-24')
      .replace(/^(\| (?!資産 |---)[^|]+\| [^|]+\| [^|]+\| ) \|  \|$/gm, `$1${disposition} | 既存の資産 |`);
  w.write('docs/adoption-inventory.md', fill(draft, '取り込む', 'Claude'));
  r = preflight(w.dir);
  check('一覧の確定した者が AI の名義なら止める', r.stops.some((s) => /確定した者/.test(s.text)), JSON.stringify(r.stops));
  w.write('docs/adoption-inventory.md', fill(draft, '直す'));
  r = preflight(w.dir);
  check('扱いが4つの値(取り込む・置き換える・残して並存する・対象外とする)に無ければ止める', r.stops.some((s) => /扱い/.test(s.text)), JSON.stringify(r.stops));
  const signed = fill(draft, '残して並存する');
  w.write('docs/adoption-inventory.md', signed.split('\n').filter((l) => !l.includes('`AGENTS.md`')).join('\n'));
  r = preflight(w.dir);
  // IMPL-0319:ng(違反の入力: 点検が検出した資産が、資産の一覧に載っていない)
  check('点検が検出した資産が一覧に無ければ止める', r.stops.some((s) => /AGENTS\.md/.test(s.text)), JSON.stringify(r.stops));
  w.write('docs/adoption-inventory.md', signed);
  r = preflight(w.dir);
  // IMPL-0319:ok(適合の入力: 検出した資産をすべて載せ、人が記名で扱いを確定した一覧)
  check('検出した資産をすべて載せ、人が記名で扱いを確定した一覧なら、止める項目が無い', r.stops.length === 0, JSON.stringify(r.stops));

  // 入れ子の指示ファイル: テンプレート自身のファイルだけを除く(#315 突合 X-14)。製品の scripts/CLAUDE.md を見落とさない
  w.write('scripts/CLAUDE.md', '# 製品のスクリプトの指示\n');
  r = preflight(w.dir);
  check('製品の scripts/CLAUDE.md を入れ子の指示ファイルとして告げ、一覧に無ければ止める', r.assets.some((a) => a.place === 'scripts/CLAUDE.md') && r.stops.some((s) => s.place === 'scripts/CLAUDE.md'), JSON.stringify(r.assets.map((a) => a.place)));
  fs.rmSync(path.join(w.dir, 'scripts/CLAUDE.md'));
  // 既存の CODEOWNERS(テンプレートとパスの並びが違う)は、資産「コードオーナーの定め」として告げる
  const coText = w.read('.github/CODEOWNERS');
  w.write('.github/CODEOWNERS', `${coText}\n/src/ @team-app\n`);
  r = preflight(w.dir);
  check('既存の CODEOWNERS(パスの並びがテンプレートと違う)は、資産として告げ、一覧に無ければ止める', r.assets.some((a) => a.id === 'codeowners') && r.stops.some((s) => s.place === '.github/CODEOWNERS'), JSON.stringify(r.assets.map((a) => a.id)));
  w.write('.github/CODEOWNERS', coText);

  // 既定ブランチの名・共通の祖先の無い履歴
  w.git('branch', '-m', 'main', 'trunk');
  r = preflight(w.dir);
  check('既定ブランチが main でなければ止める', r.stops.some((s) => /既定ブランチ|main/.test(s.text)), JSON.stringify(r.stops));
  w.git('branch', '-m', 'trunk', 'main');
  w.git('checkout', '-q', '--orphan', 'other');
  w.git('rm', '-rqf', '.');
  w.write('x.txt', 'x\n');
  w.commit('chore: 別の根');
  w.git('checkout', '-q', '-f', 'main');
  w.git('merge', '-q', '--allow-unrelated-histories', '--no-edit', 'other');
  r = preflight(w.dir);
  // #315 突合 X-4: 止めずに、主系列の根でない根のコミットを一覧へ載せることを求める
  const rootRow = r.assets.find((a) => a.id === 'unrelated-histories');
  check('共通の祖先の無い履歴の併合は止めず、根のコミットを資産として告げる', !r.stops.some((s) => s.id === 'unrelated-histories') && Boolean(rootRow) && /定め1/.test(rootRow?.text ?? ''), JSON.stringify(r.assets.map((a) => a.id)));
  check('併合した別の履歴が一覧に無ければ、一覧の照合が止める', r.stops.some((s) => s.place === rootRow?.place), JSON.stringify(r.stops));
  const invLines = signed.split('\n');
  const lastRow = invLines.map((l) => /^\|/.test(l)).lastIndexOf(true);
  invLines.splice(lastRow + 1, 0, `| 併合した別の履歴 | \`${rootRow?.place}\` | 古い併合 | 対象外とする | 開始より前の履歴 |`);
  w.write('docs/adoption-inventory.md', invLines.join('\n'));
  r = preflight(w.dir);
  check('併合した別の履歴を一覧へ載せて扱いを確定すれば、止める項目が無い', r.stops.length === 0, JSON.stringify(r.stops));
  w.done();
}

// ---------------------------------------------------------------- 契約検査・形式の版・移行・取り込んだテンプレートの記録
{
  const w = workspace();
  w.commit('chore: template');
  const legacy = JSON.parse(JSON.stringify(base));
  delete legacy.formatVersion;
  w.writeJson('process.config.json', sealed(legacy));
  w.commit('chore: init(形式の版の欄の無い旧い構成)');
  let v = w.node('scripts/gate/verify-gate-contract.mjs');
  check('形式の版の欄の無い構成は失敗にせず、移行を注記する', !contractErrors(v.out).length && /形式の版は 0/.test(v.out), contractErrors(v.out).join('\n') || v.out.slice(-800));
  check('取り込んだテンプレートの記録の無い構成は、注記する', /取り込んだ準拠テンプレートの記録/.test(v.out), v.out.slice(-800));
  // #315 突合 X-2: 初期化を経ずに置いた構成(事前点検の結果の記録が無い)は、記録の欠落として注記し、失敗にしない
  // IMPL-0327:ng(違反の入力: 初期化を経ずに置いた構成。適用の開始の記録に事前点検の結果が無い)
  check('事前点検の結果の記録が無い構成は、記録の欠落として注記し、失敗にしない', !contractErrors(v.out).length && /事前点検の結果/.test(v.out), v.out.slice(-800));

  const change = (obj) => {
    w.writeJson('change.json', obj);
    const r = w.node('scripts/init/generate-profile.mjs', '--change', 'change.json');
    fs.rmSync(path.join(w.dir, 'change.json'), { force: true });
    return r;
  };
  const before = w.readJson('process.config.json');
  const bad = change({ kind: 'migrate', summary: '移行', settings: { task: { maxChangedLines: 900 } } });
  // IMPL-0322:ng(違反の入力: 移行の入力に値の変更を書く)
  check('移行は値を変える指定を受け付けない', !bad.ok, bad.out);
  const migCommit = change({ kind: 'migrate', summary: '移行', templateCommit: 'abcdef1' });
  check('移行は templateCommit を受け付けない(取り込んだテンプレートの記録は種別 intake で書く)', !migCommit.ok && /intake/.test(migCommit.out), migCommit.out);
  const mig = change({ kind: 'migrate', summary: '形式の版を移す' });
  const after = w.readJson('process.config.json');
  const strip = (c) => {
    const x = JSON.parse(JSON.stringify(c));
    for (const k of ['formatVersion', 'schemaVersion', 'template', 'changeLog']) delete x[k];
    return JSON.stringify(x);
  };
  // IMPL-0322:ok(適合の入力: 移行の前後で、ゲートの状態・席・閾値の値が同じ)
  check('移行(種別 migrate)は、形式の版を現行にし、値を変えない', mig.ok && after.formatVersion === FORMAT_VERSION && strip(after) === strip(before), mig.out);
  check('移行は、変化点の記録に移行元と移行先の版を残す', after.changeLog.at(-1).kind === 'migrate' && after.changeLog.at(-1).migrate?.from === 0 && after.changeLog.at(-1).migrate?.to === FORMAT_VERSION, JSON.stringify(after.changeLog.at(-1)));
  check('移行は、取り込んだテンプレートの記録(要約値)を書かない', after.template === undefined && JSON.stringify(after.changeLog.at(-1).migrate) === JSON.stringify({ from: 0, to: FORMAT_VERSION }), JSON.stringify(after.template ?? null));
  const migHash = w.commit('chore: migrate');

  // 取り込み(種別 intake): 記名の自然人の決定を要する。要約値を記録し直し、乖離と知識ベースの版の前後を道具が書く(#315 突合 X-6・X-18)
  const noSign = change({ kind: 'intake', summary: '取り込み', templateCommit: 'abcdef1' });
  const aiSign = change({ kind: 'intake', summary: '取り込み', templateCommit: 'abcdef1', decidedBy: 'Claude', reason: '更新' });
  check('取り込みは、記名(decidedBy)と理由が無ければ、または AI の名義なら受け付けない', !noSign.ok && !aiSign.ok && w.readJson('process.config.json').template === undefined, `${noSign.out}\n${aiSign.out}`);
  const intake = change({ kind: 'intake', summary: 'テンプレートの取り込み', templateCommit: 'abcdef1', decidedBy: '名簿 己', reason: '#315 の更新を取り込む' });
  const taken = w.readJson('process.config.json');
  const e1 = taken.changeLog.at(-1);
  check('取り込みは、取り込んだテンプレートのコミットと強制層の要約値を道具が書く', intake.ok && taken.template?.commit === 'abcdef1' && Object.keys(taken.template?.digests ?? {}).length > 10 && e1.kind === 'intake' && e1.decidedBy === '名簿 己', intake.out);
  check('取り込みの要約値は、権限設定と遮断の定義を含む', ['.claude/settings.json', '.claude/guard.json'].every((k) => k in (taken.template?.digests ?? {})), Object.keys(taken.template?.digests ?? {}).join(','));
  check('要約値の範囲は、スキル(.claude/skills/**)を含む', Object.keys(taken.template?.digests ?? {}).some((k) => k.startsWith('.claude/skills/')), Object.keys(taken.template?.digests ?? {}).slice(0, 5).join(','));
  check('取り込みは、知識ベースの生成元の前後(従う作業中の版の切り替え)を記録に書く', 'kbCommitBefore' in (e1.intake ?? {}) && e1.intake.kbCommitAfter === taken.template.kbCommit, JSON.stringify(e1.intake));
  check('取り込みの値は変えない', strip(taken) === strip(before), intake.out);
  w.commit('chore: intake');
  // 強制層を変え、同じ変更で記録を取り直す: 取り直す直前の乖離を記録し、基底との比較で取り直したパスを注記する
  fs.appendFileSync(path.join(w.dir, 'scripts/gate/next.mjs'), '\n// 弱める変更の模擬\n');
  const base2 = w.git('rev-parse', 'HEAD').trim();
  const again = change({ kind: 'intake', summary: '取り直し', decidedBy: '名簿 己', reason: '模擬' });
  const e2 = w.readJson('process.config.json').changeLog.at(-1);
  check('取り直す直前の乖離(変わったパス)を、取り込みの記録に道具が書く', again.ok && e2.intake?.drift?.changed?.includes('scripts/gate/next.mjs') && e2.result === 'changed', JSON.stringify(e2.intake?.drift));
  w.commit('chore: 取り直し');
  v = w.node('scripts/gate/verify-gate-contract.mjs', '--base', base2);
  check('基底と比べ、記録の上で要約値を取り直したパスを注記する', /取り直したパス: [^\n]*scripts\/gate\/next\.mjs/.test(v.out), v.out.slice(-1200));
  w.git('reset', '-q', '--hard', 'HEAD~1');
  w.git('checkout', '-q', '--', '.');
  v = w.node('scripts/gate/verify-gate-contract.mjs');
  // IMPL-0323:ok(適合の入力: 記録の直後の強制層のファイル。要約値が一致する)
  check('移行の後、契約検査が不整合を出さず、要約値が一致すると注記する', !contractErrors(v.out).length && /一致しています/.test(v.out), contractErrors(v.out).join('\n') || v.out.slice(-800));

  // 不一致は表示だけ
  fs.appendFileSync(path.join(w.dir, 'scripts/gate/next.mjs'), '\n// 採用者の手の変更\n');
  v = w.node('scripts/gate/verify-gate-contract.mjs');
  // IMPL-0323:ng(違反の入力: 記録の後に変えた強制層のファイル。注記に出し、合否には使わない)
  check('強制層のファイルが記録と一致しなければ注記するが、失敗にしない', !contractErrors(v.out).length && /scripts\/gate\/next\.mjs/.test(v.out) && /証明ではありません/.test(v.out), contractErrors(v.out).join('\n') || v.out.slice(-800));
  w.git('checkout', '-q', '--', 'scripts/gate/next.mjs');

  // 知らない版
  const future = w.readJson('process.config.json');
  w.writeJson('process.config.json', { ...future, formatVersion: FORMAT_VERSION + 1 });
  v = w.node('scripts/gate/verify-gate-contract.mjs');
  // IMPL-0321:ng(違反の入力: 知らない形式の版の構成)
  check('知らない形式の版(既知より大きい formatVersion)の構成は、契約検査が失敗にする', contractErrors(v.out).some((l) => /formatVersion/.test(l)), v.out.slice(-800));
  w.writeJson('process.config.json', { ...future, schemaVersion: 99 });
  v = w.node('scripts/gate/verify-gate-contract.mjs');
  check('知らない schemaVersion の構成も、契約検査が失敗にする', contractErrors(v.out).some((l) => /schemaVersion/.test(l)), v.out.slice(-800));
  w.writeJson('process.config.json', future);
  v = w.node('scripts/gate/verify-gate-contract.mjs');
  // IMPL-0321:ok(適合の入力: 現行の形式の版の構成)
  check('現行の形式の版の構成は、版の欄で失敗にしない', !contractErrors(v.out).some((l) => /formatVersion|schemaVersion/.test(l)), contractErrors(v.out).join('\n'));

  // 契約検査: フックの登録の欠けと @OWNER
  const settings = w.read('.claude/settings.json');
  const s = JSON.parse(settings);
  delete s.hooks;
  w.writeJson('.claude/settings.json', s);
  v = w.node('scripts/gate/verify-gate-contract.mjs');
  // IMPL-0320:ng(違反の入力: 5.8.5 の禁止事項3 の遮断のフックが登録されていない設定。契約検査の入口を通す)
  check('フックの登録が欠けた設定済みのリポジトリは、契約検査が失敗にする', contractErrors(v.out).some((l) => /merge-hooks/.test(l)), v.out.slice(-800));
  w.write('.claude/settings.json', settings);
  const co = w.read('.github/CODEOWNERS');
  w.write('.github/CODEOWNERS', `${co}\n/docs/ @OWNER\n`);
  v = w.node('scripts/gate/verify-gate-contract.mjs');
  check('雛形の所有者 @OWNER が残った設定済みのリポジトリは、契約検査が失敗にする', contractErrors(v.out).some((l) => /@OWNER/.test(l)), v.out.slice(-800));
  w.write('.github/CODEOWNERS', co);
  w.done();
}
{
  // 初期化: --template-commit の書式と、取り込んだテンプレートの記録
  const w = workspace();
  w.commit('chore: template');
  const answers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-answers-')), 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ ...COMMON, 'q-team-size': 'size-1-2', 'q-external-reviewer': 'reviewer-no' }));
  const badCommit = w.node('scripts/init/generate-profile.mjs', '--answers', answers, '--stack', 'none', '--template-commit', 'main');
  check('初期化の --template-commit は、コミットの識別でなければ拒否する', !badCommit.ok && w.readJson('process.config.json').configured === false, badCommit.out);
  const init = w.node('scripts/init/generate-profile.mjs', '--answers', answers, '--stack', 'none', '--template-commit', '0123456789abcdef0123456789abcdef01234567');
  const c = w.readJson('process.config.json');
  check('初期化は、形式の版と取り込んだテンプレートの記録を書く', init.ok && c.formatVersion === FORMAT_VERSION && c.template?.commit === '0123456789abcdef0123456789abcdef01234567', init.out);
  // #315 突合 X-2: 初期化は、事前点検の結果を適用の開始の記録(changeLog[0])へ道具が書く
  // IMPL-0327:ok(適合の入力: 初期化を経た構成。適用の開始の記録に事前点検の結果がある)
  check('初期化は、事前点検の結果(止める項目 0 件・資産の件数)を changeLog[0] へ書く', c.changeLog?.[0]?.preflight?.stops === 0 && c.changeLog[0].preflight.assets === 0, JSON.stringify(c.changeLog?.[0]?.preflight));
  // process-compass #317 / ADR-0087 決定2: 要約値は権限設定と遮断の定義を含み、初期化はテーラリングした後の内容で記録する
  const enf = ['.claude/settings.json', '.claude/guard.json'];
  check('要約値の範囲は、権限設定(.claude/settings.json)と遮断の定義(.claude/guard.json)を含む', enf.every((k) => k in (c.template?.digests ?? {})), Object.keys(c.template?.digests ?? {}).slice(0, 5).join(','));
  const d0 = templateDrift(c, w.dir);
  check('初期化の直後は、権限設定と遮断の定義に乖離を出さない(書いた内容で記録する)', d0 && !d0.changed.some((p) => enf.includes(p)) && !d0.added.some((p) => enf.includes(p)), JSON.stringify(d0));
  const sp = path.join(w.dir, '.claude/settings.json');
  const st = JSON.parse(fs.readFileSync(sp, 'utf8'));
  st.permissions.deny = st.permissions.deny.filter((r) => r !== 'Bash(gh pr merge:*)');
  fs.writeFileSync(sp, JSON.stringify(st, null, 2) + '\n');
  const d1 = templateDrift(c, w.dir);
  check('権限設定の遮断を外すと、強制層の要約値の乖離として出る', d1?.changed.includes('.claude/settings.json'), JSON.stringify(d1));
  w.done();
}
{
  // #315 突合 X-2: --dry-run でも、止める項目があれば構成を出さずに非0で終える
  const w = workspace({ keepOwner: true });
  w.commit('chore: template');
  const answers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-answers-')), 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ ...COMMON, 'q-team-size': 'size-1-2', 'q-external-reviewer': 'reviewer-no' }));
  const dry = w.node('scripts/init/generate-profile.mjs', '--answers', answers, '--stack', 'none', '--dry-run');
  check('--dry-run でも、止める項目があれば構成の JSON を出さずに非0で終える', !dry.ok && !/"configured": true/.test(dry.out) && /止める/.test(dry.out), dry.out.slice(-800));
  fs.rmSync(path.dirname(answers), { recursive: true, force: true });
  fs.rmSync(path.dirname(answers), { recursive: true, force: true });
  w.done();
}

console.log('');
if (failures) {
  console.log(`持ち込みの試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`持ち込みの試験: ${checks} 件が期待と一致しました`);

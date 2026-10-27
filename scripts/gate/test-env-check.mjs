// 実環境の統制の確認(env-check)の4値と確認の項目の試験(標準 附属書I I.11 要件⑦。process-compass #315 / ADR-0084 決定4)。
//
//   node scripts/gate/test-env-check.mjs
//
// 固定する決定:
//   - 結果は 確認済み / 不一致 / 未確認(理由: 権限不足で読めない・実行していない 等)/ 対象外 の4値。対象外を確認済みに数えない
//   - 読めた空の一覧(効いているルールセットが無い)は不一致、読めなかった場合は未確認で区別する
//   - G-6 が無効の構成(ルールセットの指定なし)でも、必須チェック gate-g5 の適用を確かめる(checks-only の穴を塞ぐ)
//   - 旧来のブランチ保護との重なり、効いている CODEOWNERS と codeowners/errors、ルールセットのバイパスの主体を読む
//   - 旧い形の記録(確かめる項目なしを確認済みとして書いた記録)は、確認済みにも対象外にも読み替えない
//   - 配備の統制を狭める措置の事実(Workflow permissions の既定・Actions による PR の承認・Environment の配備の参照の限定)を読む。
//     読めなければ未確認で通過にしない。G-8 の適合の判定には使わない(process-compass #346 / ADR-0089)
//   - Environment の項目は、タグの作成の限定と Environment の外の委任のトークン(名前だけ)を読み、一覧をページ送りで読む。
//     判定は構造の値(evidence.findings)で照合する。突合 X-6 の変異 M5〜M8 を落とす場面を置く(#346 突合 X-5・X-6・X-7・X-13)
// 本物の GitHub へ問い合わせません。PATH の先頭に模擬の gh を置き、固定の応答を返します。

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sealChangeLog } from './config.mjs';
import { readEnvCheck, ENV_CHECK_FILE } from './org-assurance.mjs';
import { buildConfig } from '../init/generate-profile.mjs';

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
// G-6 が有効でルールセット team の構成と、1〜2名でルールセットの指定が無い(G-6 が無効)構成
const TEAM = build({ 'q-team-size': 'size-3-9', 'q-external-reviewer': 'reviewer-yes' }, { people: PEOPLE, seats: SEATS3 });
const SOLO = build({ 'q-team-size': 'size-1-2', 'q-external-reviewer': 'reviewer-no' });

// 模擬の gh。引数を空白でつないだ文字列を鍵に、固定の応答を返す。鍵に無い呼び出しは 404
const BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-fake-gh-'));
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!${process.execPath}
const fs = require('node:fs');
const map = JSON.parse(fs.readFileSync(process.env.FAKE_GH_MAP, 'utf8'));
const key = process.argv.slice(2).join(' ');
const r = map[key] ?? { code: 1, stderr: 'gh: Not Found (HTTP 404)' };
if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout));
if (r.stderr) process.stderr.write(r.stderr + '\\n');
process.exit(r.code ?? 0);
`,
  { mode: 0o755 }
);

const R = 'o/r';
const RULES_TEAM = [
  { type: 'required_status_checks', ruleset_id: 11, parameters: { required_status_checks: [{ context: 'gate-g5' }] } },
  { type: 'pull_request', ruleset_id: 11, parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, require_code_owner_review: false } },
];
const RULES_CHECKS = [{ type: 'required_status_checks', ruleset_id: 12, parameters: { required_status_checks: [{ context: 'gate-g5' }] } }];
// ページ送りの1頁目の鍵(env-check は per_page=100 で読み、total_count と件数を突き合わせる。#346 突合 X-13)
const P = (api, page = 1) => `api ${api}${api.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
// Environment の判定の構造の値(説明の文ではなく値で照合する。#346 突合 X-6)
const kinds = (item) => (item?.evidence?.findings ?? []).map((f) => `${f.environment ?? '-'}:${f.kind}`).sort();
function ghMap(over = {}) {
  return {
    [`repo view --repo ${R} --json nameWithOwner,url`]: { stdout: { nameWithOwner: R, url: `https://github.com/${R}` } },
    [`repo view --repo ${R} --json defaultBranchRef`]: { stdout: { defaultBranchRef: { name: 'main' } } },
    [`api repos/${R}/rules/branches/main`]: { stdout: RULES_TEAM },
    [`api repos/${R}/branches/main/protection`]: { code: 1, stderr: 'gh: Branch not protected (HTTP 404)' },
    [`api repos/${R}/contents/.github/CODEOWNERS?ref=main`]: { stdout: { sha: 'a'.repeat(40), content: Buffer.from('* @tester\n').toString('base64') } },
    [`api repos/${R}/codeowners/errors?ref=main`]: { stdout: { errors: [] } },
    [`api repos/${R}/rulesets/11`]: { stdout: { id: 11, bypass_actors: [] } },
    [`api repos/${R}/rulesets/12`]: { stdout: { id: 12, bypass_actors: [] } },
    [`pr list --repo ${R} --state merged --limit 1 --json number`]: { stdout: [{ number: 5 }] },
    [`api repos/${R}/pulls/5/reviews`]: { stdout: [{ id: 99, user: { login: 'acc2' }, state: 'APPROVED', submitted_at: '2026-10-01T00:00:00Z' }] },
    [`run list --repo ${R} --workflow gate-g5 --status success --limit 1 --json databaseId,url,createdAt`]: { stdout: [{ databaseId: 77, url: `https://github.com/${R}/actions/runs/77`, createdAt: '2026-10-01T00:00:00Z' }] },
    [`api repos/${R}/actions/runs/77/artifacts`]: { stdout: { artifacts: [{ id: 1, name: 'license-scan' }, { id: 2, name: 'test-results' }] } },
    [`api repos/${R}/actions/permissions/workflow`]: { stdout: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } },
    [P(`repos/${R}/environments`)]: { stdout: { total_count: 1, environments: [{ id: 501, name: 'delegated-merge', can_admins_bypass: false, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }] } },
    [P(`repos/${R}/environments/delegated-merge/deployment-branch-policies`)]: { stdout: { total_count: 1, branch_policies: [{ id: 9, name: 'main', type: 'branch' }] } },
    [P(`repos/${R}/actions/secrets`)]: { stdout: { total_count: 1, secrets: [{ name: 'OTHER_SECRET' }] } },
    [P(`repos/${R}/actions/variables`)]: { stdout: { total_count: 1, variables: [{ name: 'DELEGATED_MERGE_ENABLED', value: 'true' }] } },
    [P(`repos/${R}/rulesets?targets=tag&includes_parents=true`)]: { stdout: [{ id: 21, target: 'tag' }] },
    [`api repos/${R}/rulesets/21?includes_parents=true`]: { stdout: { id: 21, target: 'tag', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] } },
    '--version': { stdout: 'gh version 2.60.0 (2026-01-01)\n' },
    ...over,
  };
}

function workspace(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pit-in-envcheck-'));
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    fs.cpSync(path.join(ROOT, e.name), path.join(dir, e.name), { recursive: true });
  }
  const co = path.join(dir, '.github/CODEOWNERS');
  fs.writeFileSync(co, fs.readFileSync(co, 'utf8').replace(/@OWNER\b/g, '@tester'));
  fs.writeFileSync(path.join(dir, 'process.config.json'), JSON.stringify(sealed(config), null, 2) + '\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: init');
  const mapFile = path.join(BIN, `map-${path.basename(dir)}.json`);
  const run = (map) => {
    fs.writeFileSync(mapFile, JSON.stringify(map));
    const r = spawnSync(process.execPath, ['scripts/gate/adoption-trial.mjs', 'env-check', '--by', '名簿 丙', '--repo', R], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_MAP: mapFile, GITHUB_REPOSITORY: '', GH_TOKEN: '', GITHUB_TOKEN: '' },
    });
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(path.join(dir, ENV_CHECK_FILE), 'utf8'));
    } catch {
      record = null;
    }
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, record, items: record?.items ?? {} };
  };
  return { dir, git, run, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

if (process.platform === 'win32') {
  console.log('env-check の試験: 模擬の gh を PATH へ置く方法が Windows では異なるため省きます');
  process.exit(0);
}

{
  const w = workspace(TEAM);
  const ok = w.run(ghMap());
  check('すべての応答が構成と一致すれば、9項目が確認済みで終了コード 0', ok.code === 0 && Object.values(ok.items).length === 9 && Object.values(ok.items).every((i) => i.status === 'confirmed'), ok.out);
  check('旧来のブランチ保護が無い(404 Branch not protected)は、重なりなしとして確認済み', ok.items.classicProtection?.status === 'confirmed' && ok.items.classicProtection?.evidence?.protected === false, JSON.stringify(ok.items.classicProtection));
  check('効いている CODEOWNERS の所在と blob の sha を記録する', ok.items.codeowners?.evidence?.path === '.github/CODEOWNERS' && ok.items.codeowners?.evidence?.blobSha === 'a'.repeat(40), JSON.stringify(ok.items.codeowners));
  check('必須チェックの発行元(integration_id)を確かめていないことを記録に書く', /integration_id/.test(ok.record?.integrationId ?? ''), JSON.stringify(ok.record?.integrationId));

  // IMPL-0310:ng(違反の入力: 読めた空の一覧。読めなかった場合と区別して不一致にする)
  const empty = w.run(ghMap({ [`api repos/${R}/rules/branches/main`]: { stdout: [] } }));
  check('読めた空のルールセットの一覧は「不一致」(未確認でない)', empty.items.ruleset?.status === 'mismatch' && empty.code === 1, JSON.stringify(empty.items.ruleset));
  check('効いているルールセットが無ければ、バイパスの主体は対象外(確認済みに数えない)', empty.items.bypass?.status === 'notApplicable', JSON.stringify(empty.items.bypass));
  // IMPL-0310:ok(適合の入力: 権限不足で読めない場合は、理由つきの未確認)
  const denied = w.run(ghMap({ [`api repos/${R}/rules/branches/main`]: { code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' } }));
  check('権限不足で読めないルールセットは「未確認(権限不足で読めない)」', denied.items.ruleset?.status === 'unconfirmed' && denied.items.ruleset?.reason === 'permission' && /権限不足で読めない/.test(denied.out), JSON.stringify(denied.items.ruleset));
  const mock = w.run(ghMap({ [`api repos/${R}/rules/branches/main`]: { stdout: '' } }));
  check('出力の無い gh(模擬)は「未確認(読めない)」で、権限不足と区別する', mock.items.ruleset?.status === 'unconfirmed' && mock.items.ruleset?.reason === 'unreadable', JSON.stringify(mock.items.ruleset));

  // バイパスの主体
  const bypass = w.run(ghMap({ [`api repos/${R}/rulesets/11`]: { stdout: { id: 11, bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }] } } }));
  // IMPL-0311:ng(違反の入力: バイパスの主体があるルールセット)
  check('バイパスの主体があれば「不一致」として主体を列挙する', bypass.items.bypass?.status === 'mismatch' && /RepositoryRole#5/.test(bypass.items.bypass?.detail ?? ''), JSON.stringify(bypass.items.bypass));
  const noAdmin = w.run(ghMap({ [`api repos/${R}/rulesets/11`]: { stdout: { id: 11 } } }));
  // IMPL-0311:ok(適合の入力: bypass_actors を返さない応答は、権限不足の未確認。確認済みにしない)
  check('bypass_actors を返さない応答(admin でない)は「未確認(権限不足で読めない)」', noAdmin.items.bypass?.status === 'unconfirmed' && noAdmin.items.bypass?.reason === 'permission', JSON.stringify(noAdmin.items.bypass));

  // 旧来のブランチ保護・CODEOWNERS
  const classic = w.run(ghMap({ [`api repos/${R}/branches/main/protection`]: { stdout: { url: `https://api.github.com/repos/${R}/branches/main/protection`, required_status_checks: { contexts: ['build'] }, enforce_admins: { enabled: false } } } }));
  check('旧来のブランチ保護があれば、重なりの内容を記録に書く', classic.items.classicProtection?.status === 'confirmed' && classic.items.classicProtection?.evidence?.protected === true && /build/.test(classic.items.classicProtection?.detail ?? ''), JSON.stringify(classic.items.classicProtection));
  // 旧来のブランチ保護だけで gate-g5 と承認の規則を効かせている構成(#315 突合 X-17)
  const classicOnlyBody = (enforce) => ({ url: `https://api.github.com/repos/${R}/branches/main/protection`, required_status_checks: { contexts: ['gate-g5'] }, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, enforce_admins: { enabled: enforce } });
  const classicOnly = w.run(ghMap({ [`api repos/${R}/rules/branches/main`]: { stdout: [] }, [`api repos/${R}/branches/main/protection`]: { stdout: classicOnlyBody(true) } }));
  check('旧来のブランチ保護だけで gate-g5 と承認の規則が効き、管理者にも適用されていれば、ルールセットの項目は確認済み', classicOnly.items.ruleset?.status === 'confirmed' && /旧来のブランチ保護/.test(classicOnly.items.ruleset?.detail ?? '') && classicOnly.items.bypass?.status === 'notApplicable', JSON.stringify([classicOnly.items.ruleset, classicOnly.items.bypass]));
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: classic');
  const classicRead = readEnvCheck(TEAM, { root: w.dir });
  check('旧来のブランチ保護だけの記録を読む側も、ルールセットとバイパスの主体を受け入れる', classicRead.items.find((i) => i.id === 'ruleset')?.status === 'confirmed' && classicRead.items.find((i) => i.id === 'bypass')?.status === 'notApplicable', classicRead.summary);
  const classicNoAdmin = w.run(ghMap({ [`api repos/${R}/rules/branches/main`]: { stdout: [] }, [`api repos/${R}/branches/main/protection`]: { stdout: classicOnlyBody(false) } }));
  check('旧来のブランチ保護が管理者に適用されなければ、旧来の保護を数えず「不一致」', classicNoAdmin.items.ruleset?.status === 'mismatch' && /enforce_admins/.test(classicNoAdmin.items.ruleset?.detail ?? ''), JSON.stringify(classicNoAdmin.items.ruleset));
  const coErr = w.run(ghMap({ [`api repos/${R}/codeowners/errors?ref=main`]: { stdout: { errors: [{ line: 3, kind: 'Unknown owner' }] } } }));
  check('codeowners/errors に誤りがあれば「不一致」', coErr.items.codeowners?.status === 'mismatch' && /Unknown owner/.test(coErr.items.codeowners?.detail ?? ''), JSON.stringify(coErr.items.codeowners));
  const noCo = w.run(ghMap({ [`api repos/${R}/contents/.github/CODEOWNERS?ref=main`]: { code: 1, stderr: 'gh: Not Found (HTTP 404)' } }));
  check('CODEOWNERS が無く、構成がコードオーナーの承認を要しなければ「対象外」', noCo.items.codeowners?.status === 'notApplicable' && noCo.code === 0, JSON.stringify(noCo.items.codeowners));

  // 配備の統制を狭める措置の事実(#346 / ADR-0089)
  // IMPL-0345:ok(適合の入力: 既定 read・承認不可・Environment を既定ブランチに限る応答は、事実として確認済み。読めた値を識別として残す)
  check('Workflow permissions の既定 read・Actions の承認不可・Environment の既定ブランチへの限定を確認済みとし、読めた値を記録する', ok.items.workflowPermissions?.status === 'confirmed' && ok.items.workflowPermissions?.evidence?.defaultWorkflowPermissions === 'read' && ok.items.actionsApproval?.status === 'confirmed' && ok.items.environments?.status === 'confirmed' && /G-8 の適合の判定には使わない/.test(ok.items.environments?.detail ?? '') && /管理者の迂回 不可/.test(ok.items.environments?.detail ?? ''), JSON.stringify([ok.items.workflowPermissions, ok.items.actionsApproval, ok.items.environments]));
  // IMPL-0345:ng(違反の入力: 権限不足で読めない応答。未確認(権限不足)とし、通過にしない)
  const permDenied = w.run(ghMap({ [`api repos/${R}/actions/permissions/workflow`]: { code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' } }));
  check('Actions の権限の応答が 403 なら、2項目とも未確認(権限不足で読めない)で、終了コード 1(通過にしない)', permDenied.items.workflowPermissions?.status === 'unconfirmed' && permDenied.items.workflowPermissions?.reason === 'permission' && permDenied.items.actionsApproval?.status === 'unconfirmed' && permDenied.code === 1, JSON.stringify([permDenied.items.workflowPermissions, permDenied.items.actionsApproval]));
  const envDenied = w.run(ghMap({ [P(`repos/${R}/environments`)]: { code: 1, stderr: 'gh: Must have admin rights to Repository. (HTTP 403)' } }));
  check('Environment の一覧が読めなければ未確認(権限不足で読めない)で、通過にしない', envDenied.items.environments?.status === 'unconfirmed' && envDenied.items.environments?.reason === 'permission' && envDenied.code === 1, JSON.stringify(envDenied.items.environments));
  const odd = w.run(ghMap({ [`api repos/${R}/actions/permissions/workflow`]: { stdout: { enabled: true } } }));
  check('応答に既定の権限の欄が無ければ未確認(読めない)で、確認済みにしない', odd.items.workflowPermissions?.status === 'unconfirmed' && odd.items.actionsApproval?.status === 'unconfirmed', JSON.stringify([odd.items.workflowPermissions, odd.items.actionsApproval]));
  const loose = w.run(ghMap({
    [`api repos/${R}/actions/permissions/workflow`]: { stdout: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true } },
    [P(`repos/${R}/environments`)]: { stdout: { total_count: 2, environments: [{ id: 501, name: 'delegated-merge', deployment_branch_policy: null }, { id: 502, name: 'production', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }] } },
    [P(`repos/${R}/environments/production/deployment-branch-policies`)]: { stdout: { total_count: 2, branch_policies: [{ id: 1, name: 'main', type: 'branch' }, { id: 2, name: 'feature/*', type: 'branch' }] } },
  }));
  check('既定 write・Actions の承認可・参照の限定の無い Environment・既定ブランチ以外へ開く Environment は「不一致」として、判定を構造の値に残す', loose.items.workflowPermissions?.status === 'mismatch' && loose.items.actionsApproval?.status === 'mismatch' && loose.items.environments?.status === 'mismatch' && kinds(loose.items.environments).join(',') === 'delegated-merge:noPolicy,production:otherBranch', JSON.stringify([loose.items.workflowPermissions, loose.items.actionsApproval, loose.items.environments]));
  // 突合 X-6 の変異 M7: delegated-merge の行を外し、feature/* の規則だけで不一致になることを、構造の値と判定の文で確かめる
  const branchOnly = w.run(ghMap({
    [P(`repos/${R}/environments`)]: { stdout: { total_count: 1, environments: [{ id: 502, name: 'production', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }] } },
    [P(`repos/${R}/environments/production/deployment-branch-policies`)]: { stdout: { total_count: 2, branch_policies: [{ id: 1, name: 'main', type: 'branch' }, { id: 2, name: 'feature/*', type: 'branch' }] } },
  }));
  const bo = branchOnly.items.environments;
  check('既定ブランチ以外のブランチ feature/* に開く規則だけで「不一致」(M7)', bo?.status === 'mismatch' && kinds(bo).join(',') === 'production:otherBranch' && JSON.stringify(bo?.evidence?.findings?.[0]?.value) === '["feature/*"]' && /以外のブランチ feature\/\* に開いている/.test(bo?.detail ?? ''), JSON.stringify(bo));
  // M6: protected_branches が true の Environment
  const protectedAll = w.run(ghMap({ [P(`repos/${R}/environments`)]: { stdout: { total_count: 1, environments: [{ id: 504, name: 'delegated-merge', deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }] } } }));
  check('保護されたブランチの全部に開く Environment(protected_branches: true)は「不一致」(M6)', protectedAll.items.environments?.status === 'mismatch' && kinds(protectedAll.items.environments).join(',') === 'delegated-merge:protectedBranches', JSON.stringify(protectedAll.items.environments));
  // M8: 選んだブランチとタグが空
  const emptyPol = w.run(ghMap({ [P(`repos/${R}/environments/delegated-merge/deployment-branch-policies`)]: { stdout: { total_count: 0, branch_policies: [] } } }));
  check('選んだブランチとタグが空の Environment は「不一致」(M8)', emptyPol.items.environments?.status === 'mismatch' && kinds(emptyPol.items.environments).join(',') === 'delegated-merge:emptyPolicies', JSON.stringify(emptyPol.items.environments));

  // タグの規則(突合 X-5): パターンとタグの作成の限定を読む
  const tagEnv = (pattern) => ({
    [P(`repos/${R}/environments`)]: { stdout: { total_count: 1, environments: [{ id: 503, name: 'production', deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }] } },
    [P(`repos/${R}/environments/production/deployment-branch-policies`)]: { stdout: { total_count: 2, branch_policies: [{ id: 1, name: 'main', type: 'branch' }, { id: 2, name: pattern, type: 'tag' }] } },
  });
  const tags = w.run(ghMap(tagEnv('v*')));
  check('既定ブランチとリリースのタグに限り、タグの作成を迂回なしのルールセットで限っていれば確認済み(タグのルールセットの id を記録する)', tags.items.environments?.status === 'confirmed' && JSON.stringify(tags.items.environments?.evidence?.tagRulesetIds) === '[21]', JSON.stringify(tags.items.environments));
  const tagAny = w.run(ghMap(tagEnv('*')));
  check('任意のタグ * に開く Environment は「不一致」', tagAny.items.environments?.status === 'mismatch' && kinds(tagAny.items.environments).join(',') === 'production:tagWildcard', JSON.stringify(tagAny.items.environments));
  const tagNoRs = w.run(ghMap({ ...tagEnv('v*'), [P(`repos/${R}/rulesets?targets=tag&includes_parents=true`)]: { stdout: [] } }));
  check('タグの作成を限るルールセットが無ければ「不一致」', tagNoRs.items.environments?.status === 'mismatch' && kinds(tagNoRs.items.environments).join(',') === 'production:tagCreationUnrestricted', JSON.stringify(tagNoRs.items.environments));
  const tagBypass = w.run(ghMap({ ...tagEnv('v*'), [`api repos/${R}/rulesets/21?includes_parents=true`]: { stdout: { id: 21, target: 'tag', enforcement: 'active', bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }], conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'creation' }] } } }));
  check('タグのルールセットに迂回の主体があれば、作成を限っていないとして「不一致」', tagBypass.items.environments?.status === 'mismatch' && kinds(tagBypass.items.environments).join(',') === 'production:tagCreationUnrestricted', JSON.stringify(tagBypass.items.environments));
  const tagNoCreate = w.run(ghMap({ ...tagEnv('v*'), [`api repos/${R}/rulesets/21?includes_parents=true`]: { stdout: { id: 21, target: 'tag', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'deletion' }] } } }));
  check('タグのルールセットに作成の規則が無ければ「不一致」', tagNoCreate.items.environments?.status === 'mismatch' && kinds(tagNoCreate.items.environments).join(',') === 'production:tagCreationUnrestricted', JSON.stringify(tagNoCreate.items.environments));
  const tagDenied = w.run(ghMap({ ...tagEnv('v*'), [P(`repos/${R}/rulesets?targets=tag&includes_parents=true`)]: { code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' } }));
  check('タグのルールセットを読めなければ未確認(権限不足で読めない)', tagDenied.items.environments?.status === 'unconfirmed' && tagDenied.items.environments?.reason === 'permission' && tagDenied.code === 1, JSON.stringify(tagDenied.items.environments));

  // 委任のトークンを Environment の外に置いた構成(突合 X-7)。名前だけを読み、値は読まない
  const noEnv = w.run(ghMap({ [P(`repos/${R}/environments`)]: { stdout: { total_count: 0, environments: [] } } }));
  check('Environment が無く、委任のトークンが Environment の外にも無ければ「対象外」(確認済みに数えない)', noEnv.items.environments?.status === 'notApplicable' && noEnv.code === 0 && JSON.stringify(noEnv.items.environments?.evidence?.credentialScopes) === '["repository-secrets","repository-variables"]', JSON.stringify(noEnv.items.environments));
  const repoToken = w.run(ghMap({ [P(`repos/${R}/environments`)]: { stdout: { total_count: 0, environments: [] } }, [P(`repos/${R}/actions/secrets`)]: { stdout: { total_count: 1, secrets: [{ name: 'DELEGATED_MERGE_TOKEN' }] } } }));
  check('Environment が無くても、リポジトリの秘密情報に DELEGATED_MERGE_TOKEN があれば「不一致」', repoToken.items.environments?.status === 'mismatch' && kinds(repoToken.items.environments).join(',') === '-:delegatedTokenOutside' && JSON.stringify(repoToken.items.environments?.evidence?.delegatedTokenOutside) === '["repository-secrets:DELEGATED_MERGE_TOKEN"]' && repoToken.code === 1, JSON.stringify(repoToken.items.environments));
  const varToken = w.run(ghMap({ [P(`repos/${R}/actions/variables`)]: { stdout: { total_count: 1, variables: [{ name: 'DELEGATED_MERGE_TOKEN', value: 'value-must-not-be-recorded' }] } } }));
  check('Environment があっても、リポジトリの変数に DELEGATED_MERGE_TOKEN があれば「不一致」', varToken.items.environments?.status === 'mismatch' && kinds(varToken.items.environments).join(',') === '-:delegatedTokenOutside', JSON.stringify(varToken.items.environments));
  check('秘密情報と変数は名前だけを記録し、値を記録に書かない', !JSON.stringify(varToken.record ?? {}).includes('value-must-not-be-recorded'), JSON.stringify(varToken.items.environments?.evidence));
  const secretDenied = w.run(ghMap({ [P(`repos/${R}/environments`)]: { stdout: { total_count: 0, environments: [] } }, [P(`repos/${R}/actions/secrets`)]: { code: 1, stderr: 'gh: Resource not accessible by integration (HTTP 403)' } }));
  check('Environment が無く、リポジトリの秘密情報の名前を読めなければ、対象外にせず未確認(権限不足で読めない)', secretDenied.items.environments?.status === 'unconfirmed' && secretDenied.items.environments?.reason === 'permission' && secretDenied.code === 1, JSON.stringify(secretDenied.items.environments));

  // ページ送り(突合 X-13): 31件目以降を読まずに判定しない
  const page1 = { total_count: 101, environments: Array.from({ length: 100 }, (_, i) => ({ id: 600 + i, name: `e${i}`, deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } })) };
  const pageMap = { [P(`repos/${R}/environments`)]: { stdout: page1 } };
  for (let i = 0; i < 100; i++) pageMap[P(`repos/${R}/environments/e${i}/deployment-branch-policies`)] = { stdout: { total_count: 1, branch_policies: [{ id: 1, name: 'main', type: 'branch' }] } };
  const truncated = w.run(ghMap({ ...pageMap, [P(`repos/${R}/environments`, 2)]: { stdout: { total_count: 101, environments: [] } } }));
  check('2頁目が空で、読めた件数が total_count と合わなければ未確認(確認済みにしない)', truncated.items.environments?.status === 'unconfirmed' && /total_count 101/.test(truncated.items.environments?.detail ?? ''), JSON.stringify(truncated.items.environments).slice(0, 400));
  const missingPage = w.run(ghMap(pageMap));
  check('2頁目を読めなければ未確認(1頁目の100件だけで確認済みにしない)', missingPage.items.environments?.status === 'unconfirmed', JSON.stringify(missingPage.items.environments).slice(0, 400));
  const paged = w.run(ghMap({ ...pageMap, [P(`repos/${R}/environments`, 2)]: { stdout: { total_count: 101, environments: [{ id: 999, name: 'late', deployment_branch_policy: null }] } } }));
  check('2頁目の Environment も判定に入れる(101件目の限定の無い Environment で「不一致」)', paged.items.environments?.status === 'mismatch' && kinds(paged.items.environments).join(',') === 'late:noPolicy', JSON.stringify(paged.items.environments?.evidence?.findings));

  // 記録を読む側: 対象外は確認済みに数えない。旧い形の記録は未確認に倒す
  w.run(ghMap());
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: env-check');
  const env = readEnvCheck(TEAM, { root: w.dir });
  check('記録を読む側も、9項目が確認済みなら全体を確認済みとする', env.confirmed === true && env.counts?.confirmed === 9, env.summary);
  const p = path.join(w.dir, ENV_CHECK_FILE);
  const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
  // 突合 X-6 の変異 M5: 識別の鍵(environmentIds)を欠く確認済みの Environment の記録は、読む側が未確認に倒す
  const noIds = JSON.parse(JSON.stringify(rec));
  delete noIds.items.environments.evidence.environmentIds;
  fs.writeFileSync(p, JSON.stringify(noIds, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: 識別なし');
  const m5 = readEnvCheck(TEAM, { root: w.dir });
  const m5Item = m5.items.find((i) => i.id === 'environments');
  check('environmentIds を欠く確認済みの Environment の記録は、未確認に倒し全体を確認済みにしない(M5)', m5.confirmed === false && m5Item?.status === 'unconfirmed', JSON.stringify(m5Item));
  // 判定の構造の値(findings)が空でない確認済みの記録も、未確認に倒す(説明の文ではなく値で確かめる)
  const withFinding = JSON.parse(JSON.stringify(rec));
  withFinding.items.environments.evidence.findings = [{ environment: 'production', kind: 'otherBranch', value: ['feature/*'] }];
  fs.writeFileSync(p, JSON.stringify(withFinding, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: findings');
  const wf = readEnvCheck(TEAM, { root: w.dir });
  check('判定の値 findings が空でない確認済みの Environment の記録は、未確認に倒す', wf.confirmed === false && wf.items.find((i) => i.id === 'environments')?.status === 'unconfirmed', JSON.stringify(wf.items.find((i) => i.id === 'environments')));
  // 対象外の記録で、秘密情報と変数の名前を読んでいない(credentialScopes が無い)ものは受け入れない(突合 X-7)
  const naNoScopes = JSON.parse(JSON.stringify(rec));
  naNoScopes.items.environments = { status: 'notApplicable', detail: 'Environment が無い', evidence: { environmentNames: [], environmentIds: [] } };
  fs.writeFileSync(p, JSON.stringify(naNoScopes, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: 名前を読まない対象外');
  const nns = readEnvCheck(TEAM, { root: w.dir });
  check('秘密情報と変数の名前を読んでいない Environment の対象外は、受け入れない', nns.confirmed === false && nns.items.find((i) => i.id === 'environments')?.reason === 'na-not-allowed', JSON.stringify(nns.items.find((i) => i.id === 'environments')));
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: 戻す');
  rec.items.ruleset = { status: 'confirmed', notApplicable: true, detail: '構成がブランチ保護を要しない。確かめる項目なし' };
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: 旧い形');
  const legacy = readEnvCheck(TEAM, { root: w.dir });
  // IMPL-0309:ng(違反の入力: 確かめる項目なしを確認済みとして書いた旧い形の記録)
  check('旧い形の記録(確認済み+対象外)は、未確認(旧い形の記録)に倒し、全体を確認済みにしない', legacy.confirmed === false && legacy.items.find((i) => i.id === 'ruleset')?.reason === 'legacy', legacy.summary);
  rec.items.codeowners = { status: 'notApplicable', detail: 'CODEOWNERS が無い' };
  rec.items.ruleset = JSON.parse(JSON.stringify(env.record.items.ruleset));
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: 対象外');
  const na = readEnvCheck(TEAM, { root: w.dir });
  // IMPL-0309:ok(適合の入力: 対象外は対象外として表示し、確認済みの件数に数えない)
  check('対象外の項目は「対象外」と表示し、確認済みの件数に数えない', na.confirmed === true && na.counts?.notApplicable === 1 && na.counts?.confirmed === 8 && /対象外 1 項目/.test(na.summary), na.summary);
  // 偽装の記録(#315 突合 X-1): 対象外にできない項目を notApplicable と書き、ship-evidence だけを確認済みにした手書きの記録
  const forged = JSON.parse(JSON.stringify(env.record));
  for (const id of ['ruleset', 'classicProtection', 'codeowners', 'bypass', 'prReviews', 'workflowPermissions', 'actionsApproval', 'environments']) forged.items[id] = { status: 'notApplicable', detail: '手で書いた対象外' };
  fs.writeFileSync(p, JSON.stringify(forged, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: 偽装');
  const fake = readEnvCheck(TEAM, { root: w.dir });
  const refused = fake.items.filter((i) => i.reason === 'na-not-allowed').map((i) => i.id);
  // IMPL-0309:ng(違反の入力: 対象外にできない項目を対象外と書き、対象外を重ねて全体を確認済みにしようとする記録)
  check('対象外にできない項目の対象外は未確認(対象外にできない項目)に倒し、全体を確認済みにしない', fake.confirmed === false && ['ruleset', 'classicProtection', 'bypass', 'prReviews', 'workflowPermissions', 'actionsApproval', 'environments'].every((id) => refused.includes(id)) && !refused.includes('codeowners'), JSON.stringify({ refused, summary: fake.summary }));
  const regulated = readEnvCheck({ ...TEAM, ruleset: 'regulated' }, { root: w.dir });
  check('コードオーナーの承認を要する構成では、CODEOWNERS の対象外も受け入れない', regulated.items.find((i) => i.id === 'codeowners')?.reason === 'na-not-allowed', JSON.stringify(regulated.items.find((i) => i.id === 'codeowners')));
  // 記録の時点の G-6 の状態が現在の構成と違えば、確認し直す
  fs.writeFileSync(p, JSON.stringify({ ...env.record, config: { ...env.record.config, g6: 'disabled' } }, null, 2) + '\n');
  w.git('add', '-A');
  w.git('commit', '-q', '-m', 'docs: g6');
  const g6 = readEnvCheck(TEAM, { root: w.dir });
  check('記録の時点の G-6 の状態が現在の構成と違えば、全体を確認済みにしない', g6.confirmed === false && g6.problems.some((x) => /G-6/.test(x)), JSON.stringify(g6.problems));
  w.done();
}

{
  // G-6 が無効の構成(ルールセットの指定なし)でも、必須チェック gate-g5 の適用を確かめる(checks-only の穴)
  const w = workspace(SOLO);
  const ok = w.run(ghMap({ [`api repos/${R}/rules/branches/main`]: { stdout: RULES_CHECKS } }));
  // IMPL-0308:ok(適合の入力: G-6 が無効でも、gate-g5 が必須チェックとして効いている)
  check('G-6 が無効の構成でも、ルールセットの項目は対象外でなく、必須チェック gate-g5 を確かめて確認済み', ok.items.ruleset?.status === 'confirmed' && /gate-g5/.test(ok.items.ruleset?.detail ?? ''), JSON.stringify(ok.items.ruleset));
  const none = w.run(ghMap({ [`api repos/${R}/rules/branches/main`]: { stdout: [{ type: 'deletion', ruleset_id: 12 }] } }));
  // IMPL-0308:ng(違反の入力: G-6 が無効の構成で、gate-g5 が必須チェックに無い)
  check('G-6 が無効の構成で gate-g5 が必須チェックに無ければ「不一致」', none.items.ruleset?.status === 'mismatch' && /gate-g5/.test(none.items.ruleset?.detail ?? ''), JSON.stringify(none.items.ruleset));
  w.done();
}

fs.rmSync(BIN, { recursive: true, force: true });
console.log('');
if (failures) {
  console.log(`env-check の試験: ${failures} 件が期待と一致しません`);
  process.exit(1);
}
console.log(`env-check の試験: ${checks} 件が期待と一致しました`);

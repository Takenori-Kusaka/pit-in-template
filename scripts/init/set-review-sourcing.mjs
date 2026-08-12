// 未達(unmet)ゲートのレビュー調達先を安全に記入するためのユーティリティ。
//
//   node scripts/init/set-review-sourcing.mjs --gate g6 --sourcing "コミュニティレビュー"
//
// 依存パッケージなし。Node 22 以上で動く。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function getArg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// 実際の書き換え処理を行うコア関数 (テスト用にパスを外注入可能にする)
export function updateSourcing({ configPath, profilePath, gate, sourcing }) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`${configPath} が存在しません。先に /process-init を実行してください。`);
  }

  // 1. process.config.json の更新
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.unmet || config.unmet.length === 0) {
    throw new Error('設定された未達のゲートはありません。');
  }

  const targetUnmet = config.unmet.find((u) => u.gate.toLowerCase() === gate.toLowerCase());
  if (!targetUnmet) {
    throw new Error(`指定されたゲート ${gate} は未達ゲートの一覧に存在しません。`);
  }

  targetUnmet.reviewSourcing = sourcing;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`Updated config: unmet[gate=${gate}].reviewSourcing = "${sourcing}"`);

  // 2. PROCESS-PROFILE.md の更新
  if (fs.existsSync(profilePath)) {
    let profile = fs.readFileSync(profilePath, 'utf8');
    const label = targetUnmet.label;
    const escapedLabel = label.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    // 表行をマッチングする正規表現
    // | G-6 独立レビュー | ... | ... | **未記入** |  のような行を探す。
    // 4列目（末尾のパイプの前）を sourcing で置き換える。
    const tableRowRegex = new RegExp(
      `(\\|\\s*${escapedLabel}\\s*\\|.*?\\|[^|]+\\|\\s*)([^|\\s][^|]*?|\\*\\*未記入\\*\\*)(\\s*\\|)`
    );

    if (tableRowRegex.test(profile)) {
      profile = profile.replace(tableRowRegex, `$1${sourcing}$3`);
      fs.writeFileSync(profilePath, profile, 'utf8');
      console.log(`Updated profile: Replaced sourcing for "${label}" with "${sourcing}"`);
    } else {
      console.warn(`[警告] profile 内に "${label}" の表行が見つからなかったため、MDファイルの自動更新をスキップしました。`);
    }
  }
}

// ---------------------------------------------------------------- セルフテスト用
function runSelfTest() {
  console.log('Running self test...');
  const testConfigPath = path.join(ROOT, 'test-process.config.json');
  const testProfilePath = path.join(ROOT, 'test-PROCESS-PROFILE.md');

  const dummyConfig = {
    unmet: [
      {
        gate: 'g6',
        label: 'G-6 独立レビュー',
        reason: '最小体制3名未満',
        compensation: ['ci-strict'],
        reviewSourcing: null,
      }
    ]
  };

  const dummyProfile = `# プロセス構成書\n\n## 未達のゲート\n\n| ゲート | 未達の理由 | 代償措置 | 外部レビューの調達先 |\n| --- | --- | --- | --- |\n| G-6 独立レビュー | 最小体制3名未満 | ci-strict | **未記入** |\n`;

  try {
    fs.writeFileSync(testConfigPath, JSON.stringify(dummyConfig, null, 2) + '\n', 'utf8');
    fs.writeFileSync(testProfilePath, dummyProfile, 'utf8');

    updateSourcing({
      configPath: testConfigPath,
      profilePath: testProfilePath,
      gate: 'g6',
      sourcing: 'GitHub コミュニティレビュー'
    });

    const updatedConfig = JSON.parse(fs.readFileSync(testConfigPath, 'utf8'));
    if (updatedConfig.unmet[0].reviewSourcing !== 'GitHub コミュニティレビュー') {
      throw new Error('Config reviewSourcing was not updated correctly!');
    }

    const updatedProfile = fs.readFileSync(testProfilePath, 'utf8');
    if (!updatedProfile.includes('| G-6 独立レビュー | 最小体制3名未満 | ci-strict | GitHub コミュニティレビュー |')) {
      throw new Error('Profile table cell was not updated correctly! Got: ' + updatedProfile);
    }

    console.log('Self test passed!');
  } finally {
    if (fs.existsSync(testConfigPath)) fs.unlinkSync(testConfigPath);
    if (fs.existsSync(testProfilePath)) fs.unlinkSync(testProfilePath);
  }
}

// ---------------------------------------------------------------- 実行
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);

  if (argv.includes('--test')) {
    runSelfTest();
    process.exit(0);
  }

  const gate = getArg(argv, '--gate');
  const sourcing = getArg(argv, '--sourcing');

  if (!gate || sourcing === null) {
    console.error('[エラー] 引数が不足しています。');
    console.error('使用方法: node scripts/init/set-review-sourcing.mjs --gate <g6> --sourcing "<調達先>"');
    process.exit(1);
  }

  try {
    updateSourcing({
      configPath: path.join(ROOT, 'process.config.json'),
      profilePath: path.join(ROOT, 'PROCESS-PROFILE.md'),
      gate,
      sourcing
    });
    console.log('完了しました。');
  } catch (e) {
    console.error(`[エラー] ${e.message}`);
    process.exit(1);
  }
}

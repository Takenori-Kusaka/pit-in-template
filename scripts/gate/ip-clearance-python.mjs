import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Read allowed licenses from environment or fallback to process.config.json
const allowedEnv = process.env.PIT_IN_ALLOWED_LICENSES;
let allowedLicenses = [];
if (allowedEnv) {
  allowedLicenses = allowedEnv.split(';').map(l => l.trim().toLowerCase());
} else {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'process.config.json'), 'utf8'));
    allowedLicenses = (config.ci?.allowedLicenses ?? []).map(l => l.trim().toLowerCase());
  } catch (e) {
    allowedLicenses = ['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'python-2.0', 'mpl-2.0'];
  }
}

// Find current project name to ignore it
let myProjectName = '';
try {
  const pyprojectPath = path.join(ROOT, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    const content = fs.readFileSync(pyprojectPath, 'utf8');
    // Try simple regex to find project name
    const match = content.match(/\[project\][^]*?name\s*=\s*["']([^"']+)["']/i) 
                  || content.match(/\[tool\.poetry\][^]*?name\s*=\s*["']([^"']+)["']/i);
    if (match) {
      myProjectName = match[1].trim().toLowerCase();
    }
  }
} catch (e) {
  // ignore
}
if (!myProjectName) {
  myProjectName = path.basename(ROOT).toLowerCase();
}

// Map common PyPI classifier strings or raw strings to standard/SPDX license identifiers
function mapClassifier(l) {
  if (!l) return '';
  const lic = l.toLowerCase().trim();
  
  if (lic === 'mit-0') return 'mit-0';
  if (lic.includes('mit license') || lic === 'mit') return 'mit';
  if (lic.includes('apache software license') || lic.includes('apache license') || lic.startsWith('apache-2.0') || lic === 'apache') return 'apache-2.0';
  if (lic.includes('bsd-2-clause') || lic === 'bsd-2-clause') return 'bsd-2-clause';
  if (lic.includes('bsd-3-clause') || lic === 'bsd-3-clause') return 'bsd-3-clause';
  if (lic.includes('bsd license') || lic === 'bsd') return 'bsd-3-clause'; // default fallback for raw 'BSD'
  if (lic.includes('isc license') || lic === 'isc') return 'isc';
  if (lic.includes('python software foundation') || lic.includes('psf') || lic === 'psf license' || lic === 'python-2.0') return 'python-2.0';
  if (lic.includes('mozilla public license 2.0') || lic.includes('mpl 2.0') || lic === 'mpl-2.0') return 'mpl-2.0';
  
  return lic;
}

// Check if a single license component is in the allowed list (exact matching)
function checkSingleLicense(lic) {
  if (!lic) return false;
  const mapped = mapClassifier(lic);
  
  // Exact match
  if (allowedLicenses.includes(mapped)) return true;
  
  // Strip trailing '+' if present and check exact match
  if (mapped.endsWith('+')) {
    const base = mapped.slice(0, -1).trim();
    if (allowedLicenses.includes(base)) return true;
  }
  
  return false;
}

// Tokenize SPDX expression
function tokenize(str) {
  const tokens = [];
  let i = 0;
  while (i < str.length) {
    const char = str[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'PAREN', value: char });
      i++;
      continue;
    }
    // Read identifier word
    let word = '';
    while (i < str.length && /[a-zA-Z0-9\-._\+]/.test(str[i])) {
      word += str[i];
      i++;
    }
    if (word.toUpperCase() === 'AND') {
      tokens.push({ type: 'AND', value: 'AND' });
    } else if (word.toUpperCase() === 'OR') {
      tokens.push({ type: 'OR', value: 'OR' });
    } else if (word.toUpperCase() === 'WITH') {
      tokens.push({ type: 'WITH', value: 'WITH' });
    } else {
      tokens.push({ type: 'LICENSE', value: word });
    }
  }
  return tokens;
}

// Evaluate SPDX license expression with exact logic (AND requires both, OR requires at least one)
function evaluateSPDX(str, checkFn) {
  const tokens = tokenize(str);
  if (tokens.length === 0) return false;

  let current = 0;

  function peek() {
    return tokens[current];
  }

  function consume(type) {
    const t = peek();
    if (t && t.type === type) {
      current++;
      return t;
    }
    return null;
  }

  function parseExpr() {
    return parseOr();
  }

  function parseOr() {
    let node = parseAnd();
    while (true) {
      const op = consume('OR');
      if (!op) break;
      const right = parseAnd();
      const leftNode = node;
      node = () => leftNode() || right();
    }
    return node;
  }

  function parseAnd() {
    let node = parsePrimary();
    while (true) {
      const op = consume('AND');
      if (!op) break;
      const right = parsePrimary();
      const leftNode = node;
      node = () => leftNode() && right();
    }
    return node;
  }

  function parsePrimary() {
    const token = peek();
    if (!token) return () => false;

    if (token.type === 'PAREN' && token.value === '(') {
      consume('PAREN'); // (
      const expr = parseExpr();
      consume('PAREN'); // )
      return expr;
    }

    if (token.type === 'LICENSE') {
      consume('LICENSE');
      if (peek() && peek().type === 'WITH') {
        consume('WITH');
        consume('LICENSE'); // Skip exception name
      }
      return () => checkFn(token.value);
    }

    current++;
    return () => false;
  }

  try {
    const evalFn = parseExpr();
    return evalFn();
  } catch (e) {
    // Fail-safe: if SPDX parsing fails, fall back to evaluating all licenses present in expression with AND
    return tokens
      .filter(t => t.type === 'LICENSE')
      .every(t => checkFn(t.value));
  }
}

// Read from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
});
process.stdin.on('end', () => {
  // Empty stdin indicates pipeline failure (Issue #25 Defect 3)
  if (!input) {
    console.error('::error::標準入力からデータを受け取れませんでした。パイプラインの接続状態または pip-licenses の動作を確認してください。');
    process.exit(1);
  }

  let packages = [];
  try {
    packages = JSON.parse(input);
  } catch (e) {
    console.error('Failed to parse JSON input:', e.message);
    process.exit(1);
  }

  const violations = [];
  for (const pkg of packages) {
    const name = (pkg.Name || pkg.name || '').trim();
    if (!name) continue;

    // Skip the project itself
    if (name.toLowerCase() === myProjectName) {
      continue;
    }

    const lic = (pkg.License || pkg.license || '').trim();
    if (!evaluateSPDX(lic, checkSingleLicense)) {
      violations.push({ name, version: pkg.Version || pkg.version || 'unknown', license: lic });
    }
  }

  if (violations.length > 0) {
    console.error(`::error::ライセンス違反が検出されました (${violations.length} 件):`);
    for (const v of violations) {
      console.error(`  - パッケージ: ${v.name} (${v.version}), ライセンス: ${v.license}`);
    }
    process.exit(1);
  }

  console.log(`依存ライセンス検証合格 (検証パッケージ数: ${packages.length} 件, すべて許可されたライセンスです)`);
  process.exit(0);
});

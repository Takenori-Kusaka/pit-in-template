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

// Map common PyPI classifier strings to simplified forms or standard SPDX identifiers
function normalizeLicense(lic) {
  if (!lic) return [];
  const l = lic.toLowerCase().trim();

  // If it's a known non-SPDX PyPI classifier string, map it
  if (l.includes('mit license') || l === 'mit') return ['mit'];
  if (l.includes('apache software license') || l.includes('apache license') || l === 'apache-2.0' || l === 'apache') return ['apache-2.0'];
  if (l.includes('bsd license') || l === 'bsd') return ['bsd-2-clause', 'bsd-3-clause'];
  if (l.includes('isc license') || l === 'isc') return ['isc'];
  if (l.includes('python software foundation') || l.includes('psf') || l === 'psf license') return ['python-2.0', 'psf'];
  if (l.includes('mozilla public license 2.0') || l.includes('mpl 2.0') || l === 'mpl-2.0') return ['mpl-2.0'];

  // Handle SPDX expressions like "Apache-2.0 OR BSD-2-Clause" or "Apache-2.0 AND BSD-2-Clause"
  // Split by logical operators/separators
  const parts = l.split(/\s+or\s+|\s+and\s+|[|/;,]/i).map(p => p.trim());
  return parts;
}

function checkLicense(licStr) {
  const normalizedParts = normalizeLicense(licStr);
  if (normalizedParts.length === 0) return false;

  // For "OR" conditions or simple cases, if any part is allowed, we accept it.
  return normalizedParts.some(part => {
    // Exact match
    if (allowedLicenses.includes(part)) return true;
    // Substring or prefix match
    for (const allowed of allowedLicenses) {
      if (part.includes(allowed) || allowed.includes(part)) return true;
    }
    return false;
  });
}

// Read from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
});
process.stdin.on('end', () => {
  if (!input.trim()) {
    console.log('No input received on stdin');
    process.exit(0);
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
    if (!checkLicense(lic)) {
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

  console.log('依存ライセンス検証合格 (すべて許可されたライセンスです)');
  process.exit(0);
});

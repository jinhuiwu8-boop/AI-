import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidenceDirectory = join(root, 'test/acceptance-mobile-legacy/evidence');
const finalUiProfile = process.argv.includes('--final-ui');
const sourcePaths = [
  'src/server.mjs', 'web/index.html', 'web/style.css', 'web/app.mjs',
  'web/mobile.html', 'web/mobile-app.mjs', 'web/mobile.css',
  'web/mobile-test.html', 'web/mobile-test.mjs', 'web/mobile-test.css',
  'src/business/service.mjs', 'src/business/masters.mjs', 'src/shared/store.mjs',
  'src/documents/store.mjs', 'src/printing/index.mjs',
  'test/acceptance-mobile-test/entry-boundaries.test.mjs',
  'test/acceptance-mobile-legacy/mobile-boundaries.test.mjs',
  'test/integration/http.test.mjs', 'test/acceptance/intake-http-negative.test.mjs',
  'test/acceptance-mobile-legacy/capture-evidence.mjs',
  'docs/功能逐页梳理_2026-10-30/02_22张页面逐项解析.md',
];
function identities() {
  return Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
}

const before = identities();
const startedAt = new Date().toISOString();
const selectedTests = ['test/acceptance-mobile-test/entry-boundaries.test.mjs', 'test/acceptance-mobile-legacy/mobile-boundaries.test.mjs'];
if (!finalUiProfile) selectedTests.push('test/integration/http.test.mjs', 'test/acceptance/intake-http-negative.test.mjs');
const args = ['--test', '--test-reporter=tap', ...selectedTests];
const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60000 });
const finishedAt = new Date().toISOString();
const after = identities();
const unchanged = sourcePaths.every(path => before[path] === after[path]);
const desktopBaseline = JSON.parse(readFileSync(join(root, 'docs/开发执行/W3_手机旧版布局/验证/电脑版布局基线哈希.json'), 'utf8').replace(/^\uFEFF/, ''));
const baselineMatches = Object.fromEntries(Object.entries(desktopBaseline).map(([path, hash]) => [path, after[path] === hash.toLowerCase()]));
const stdout = result.stdout ?? '';
const stderr = result.stderr ?? '';
const tapCounts = {};
for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
  const match = stdout.match(new RegExp(`^# ${key} (\\d+)\\s*$`, 'm'));
  tapCounts[key] = match ? Number(match[1]) : null;
}
const success = result.status === 0 && unchanged && Object.values(baselineMatches).every(Boolean);
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(join(evidenceDirectory, finalUiProfile ? '03_最终冻结增量HTTP验证.tap' : '01_手机旧版布局增量HTTP验证.tap'), stdout + (stderr ? `\n${stderr.split(/\r?\n/).map(line => `# runner stderr: ${line}`).join('\n')}\n` : ''), 'utf8');
writeFileSync(join(evidenceDirectory, finalUiProfile ? '04_最终冻结运行证据与源码身份.json' : '02_运行证据与源码身份.json'), JSON.stringify({
  scope: 'A07 W3 independent HTTP/API regression; no independent browser, native phone or hardware validation',
  profile: finalUiProfile ? 'final-ui-incremental' : 'incremental-and-existing-http-security',
  command: [process.execPath, ...args], runtime: process.version, platform: process.platform,
  startedAt, finishedAt, exitCode: result.status, signal: result.signal,
  spawnErrorCode: result.error?.code ?? null, counts: tapCounts,
  sourcesUnchangedDuringRun: unchanged, desktopBaselineMatches: baselineMatches,
  sha256Before: before, sha256After: after,
  testData: 'Synthetic data in isolated temporary directories owned by the selected tests; no production or data/mobile-test database used',
  passed: success,
}, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify({ passed: success, exitCode: result.status, counts: tapCounts, sourcesUnchangedDuringRun: unchanged, desktopBaselineMatches: baselineMatches }) + '\n');
process.exitCode = success ? 0 : 1;

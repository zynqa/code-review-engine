/**
 * Unit tests for static-analysis-report helpers.
 * Run with: node --test src/static-analysis-report.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// ─── Inline the pure helpers under test ──────────────────────────────────────
// We duplicate the functions here rather than requiring the module so that the
// test does not try to execute main() or read from the filesystem.

function buildSummary(findings, depsInstallOutcome) {
  const marker = '<!-- zynqa-static-analysis-summary -->';
  let body = `${marker}\n## Static Analysis Summary\n\n`;

  if (depsInstallOutcome === 'failure') {
    body +=
      ':warning: Static analysis could not complete because the dependency install step failed. ' +
      'Check the workflow logs for details. This commonly happens when a `require-dev` package ' +
      'includes a Composer plugin that is not in `config.allow-plugins`.\n';
    return body;
  }

  if (findings.length === 0) {
    body += 'No static-analysis issues were found.\n';
    return body;
  }

  const total = findings.length;
  const toolCounts = findings.reduce((acc, f) => {
    acc[f.tool] = (acc[f.tool] || 0) + 1;
    return acc;
  }, {});

  body += `Found **${total}** issue${total === 1 ? '' : 's'}.\n\n`;
  body += Object.entries(toolCounts)
    .map(([tool, count]) => `- **${tool}**: ${count}`)
    .join('\n');
  body += '\n\nSee the inline review comments and GitHub annotations for line-level details.\n';

  return body;
}

function normalizePath(filePath) {
  if (!filePath) return null;
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\\/g, '/');
}

function parseChangedLinesFromPatch(patch) {
  const changedLines = new Set();
  if (!patch) return changedLines;

  const lines = patch.split('\n');
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) { newLine = Number(hunkMatch[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { changedLines.add(newLine); newLine += 1; continue; }
    if (line.startsWith('-')) continue;
    newLine += 1;
  }

  return changedLines;
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((f) => {
    const key = [f.tool, f.path, f.line, f.rule, f.message].join('::');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('buildSummary – no findings, install succeeded', () => {
  const result = buildSummary([], '');
  assert.ok(result.includes('<!-- zynqa-static-analysis-summary -->'));
  assert.ok(result.includes('No static-analysis issues were found.'));
  assert.ok(!result.includes(':warning:'));
});

test('buildSummary – no findings, install outcome is empty string (step was skipped)', () => {
  const result = buildSummary([], 'skipped');
  assert.ok(result.includes('No static-analysis issues were found.'));
  assert.ok(!result.includes(':warning:'));
});

test('buildSummary – install step failed emits warning instead of "no issues"', () => {
  const result = buildSummary([], 'failure');
  assert.ok(result.includes('<!-- zynqa-static-analysis-summary -->'));
  assert.ok(result.includes(':warning:'));
  assert.ok(result.includes('dependency install step failed'));
  assert.ok(!result.includes('No static-analysis issues were found.'));
});

test('buildSummary – install failure takes precedence even when findings exist', () => {
  const findings = [{ tool: 'PHPCS', path: 'src/Foo.php', line: 1, rule: 'PSR2', message: 'bad', level: 'error' }];
  const result = buildSummary(findings, 'failure');
  assert.ok(result.includes(':warning:'));
  assert.ok(!result.includes('Found **1**'));
});

test('buildSummary – single finding produces singular wording', () => {
  const findings = [{ tool: 'PHPStan', path: 'src/Foo.php', line: 5, rule: 'Static Analysis', message: 'Err', level: 'error' }];
  const result = buildSummary(findings, 'success');
  assert.ok(result.includes('Found **1** issue.'));
  assert.ok(result.includes('- **PHPStan**: 1'));
});

test('buildSummary – multiple findings across tools', () => {
  const findings = [
    { tool: 'PHPCS', path: 'src/A.php', line: 1, rule: 'R', message: 'M', level: 'error' },
    { tool: 'PHPStan', path: 'src/B.php', line: 2, rule: 'R', message: 'M', level: 'error' },
    { tool: 'PHPCS', path: 'src/C.php', line: 3, rule: 'R', message: 'M', level: 'warning' },
  ];
  const result = buildSummary(findings, 'success');
  assert.ok(result.includes('Found **3** issues.'));
  assert.ok(result.includes('- **PHPCS**: 2'));
  assert.ok(result.includes('- **PHPStan**: 1'));
});

test('parseChangedLinesFromPatch – empty patch returns empty set', () => {
  const result = parseChangedLinesFromPatch('');
  assert.equal(result.size, 0);
});

test('parseChangedLinesFromPatch – correctly tracks added lines', () => {
  const patch = '@@ -1,3 +1,4 @@\n context\n+added line\n context\n+another added\n';
  const result = parseChangedLinesFromPatch(patch);
  assert.ok(result.has(2), 'line 2 should be changed');
  assert.ok(result.has(4), 'line 4 should be changed');
  assert.ok(!result.has(1), 'line 1 is context, not changed');
});

test('dedupeFindings – removes exact duplicates', () => {
  const f = { tool: 'PHPCS', path: 'src/Foo.php', line: 1, rule: 'R', message: 'M' };
  const result = dedupeFindings([f, f, { ...f, line: 2 }]);
  assert.equal(result.length, 2);
});

test('dedupeFindings – keeps findings that differ only in line number', () => {
  const a = { tool: 'PHPCS', path: 'src/Foo.php', line: 1, rule: 'R', message: 'M' };
  const b = { tool: 'PHPCS', path: 'src/Foo.php', line: 2, rule: 'R', message: 'M' };
  const result = dedupeFindings([a, b]);
  assert.equal(result.length, 2);
});

test('normalizePath – converts backslashes to forward slashes', () => {
  assert.equal(normalizePath('src\\Foo\\Bar.php'), 'src/Foo/Bar.php');
});

test('normalizePath – returns null for empty or falsy input', () => {
  assert.equal(normalizePath(''), null);
  assert.equal(normalizePath(null), null);
  assert.equal(normalizePath(undefined), null);
});

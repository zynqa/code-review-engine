const owner = process.env.REPO_OWNER;
const repo = process.env.REPO_NAME;
const pullNumber = process.env.PR_NUMBER;
const rawPatterns = process.env.FORBIDDEN_CONTENT_PATTERNS || '';
const rawAllowedTerms = process.env.CONTENT_POLICY_ALLOWED_TERMS || '';

const defaultAllowedPossessiveTerms = [
  'Adobe',
  'Amasty',
  'Brippo',
  'Composer',
  'Deployer',
  'GitHub',
  'Google',
  'Magento',
  'Microsoft',
  'PayPal',
  'PHPCS',
  'PHPMD',
  'PHPStan',
  'PHPUnit',
  'Playwright',
  'Redis',
  'Stripe',
  'Toolkit',
  'Varnish',
  'Webpack',
  'Zynqa',
];

function escapeAnnotationValue(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function parsePatterns() {
  return rawPatterns
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const separatorIndex = line.indexOf('::');
      const label = separatorIndex >= 0 ? line.slice(0, separatorIndex).trim() : `Forbidden content ${index + 1}`;
      const expression = separatorIndex >= 0 ? line.slice(separatorIndex + 2).trim() : line;

      return {
        label: label || `Forbidden content ${index + 1}`,
        regex: new RegExp(expression, 'g'),
      };
    });
}

function parseAllowedTerms() {
  return new Set(
    [
      ...defaultAllowedPossessiveTerms,
      ...rawAllowedTerms.split(/[\r\n,]+/),
    ]
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
  );
}

function isPersonalNamePolicy(pattern) {
  return /personal[-\s]?name/i.test(pattern.label);
}

function isAllowedPossessiveMatch(pattern, matchText, allowedTerms) {
  if (!isPersonalNamePolicy(pattern)) {
    return false;
  }

  const match = /^([A-Z][A-Za-z0-9_-]*)['’]s$/.exec(matchText);
  if (!match) {
    return false;
  }

  return allowedTerms.has(match[1].toLowerCase());
}

function hasBlockingMatch(content, pattern, allowedTerms) {
  pattern.regex.lastIndex = 0;
  let match;

  while ((match = pattern.regex.exec(content)) !== null) {
    if (!isAllowedPossessiveMatch(pattern, match[0], allowedTerms)) {
      return true;
    }

    if (match[0] === '') {
      pattern.regex.lastIndex += 1;
    }
  }

  return false;
}

async function paginate(url) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status}: ${body}`);
    }

    items.push(...(await response.json()));
    const link = response.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return items;
}

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }

  return response.json();
}

function parsePatchFindings(file, patterns, allowedTerms) {
  if (!file.patch) {
    return [];
  }

  const findings = [];
  let lineNumber = 0;
  const patchLines = file.patch.split('\n');

  for (const line of patchLines) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      lineNumber = Number(hunkMatch[1]);
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      for (const pattern of patterns) {
        if (!hasBlockingMatch(content, pattern, allowedTerms)) {
          continue;
        }

        findings.push({
          path: file.filename,
          line: lineNumber,
          label: pattern.label,
          message: `Forbidden content matched "${pattern.label}" on added line: ${content.trim()}`,
        });
      }
      lineNumber += 1;
      continue;
    }

    if (!line.startsWith('-') && !line.startsWith('---')) {
      lineNumber += 1;
    }
  }

  return findings;
}

function emitAnnotation(finding) {
  const props = [
    `file=${escapeAnnotationValue(finding.path)}`,
    `line=${finding.line}`,
    `title=${escapeAnnotationValue(`[Content Policy] ${finding.label}`)}`,
  ];
  console.log(`::error ${props.join(',')}::${escapeAnnotationValue(finding.message)}`);
}

async function upsertSummary(findings) {
  const marker = '<!-- zynqa-content-policy -->';
  const body = findings.length === 0
    ? `${marker}
## ✅ Content Policy Passed

No forbidden content patterns were found on added PR lines.`
    : `${marker}
## ❌ Content Policy Failed

Found **${findings.length}** content policy violation(s).

${findings.map((finding) => `- \`${finding.path}:${finding.line}\` matched **${finding.label}**`).join('\n')}

See the line annotations for details.`;

  const comments = await paginate(
    `https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments?per_page=100`
  );
  const existing = comments.find((comment) => comment.body && comment.body.includes(marker));

  if (existing) {
    await githubRequest(existing.url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return;
  }

  await githubRequest(`https://api.github.com/repos/${owner}/${repo}/issues/${pullNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

async function main() {
  const patterns = parsePatterns();
  const allowedTerms = parseAllowedTerms();
  if (patterns.length === 0) {
    console.log('No content policy patterns configured.');
    return;
  }

  const files = await paginate(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`
  );
  const findings = files.flatMap((file) => parsePatchFindings(file, patterns, allowedTerms));

  findings.forEach(emitAnnotation);
  await upsertSummary(findings);

  if (findings.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

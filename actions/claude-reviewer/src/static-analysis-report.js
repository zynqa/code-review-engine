const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readText(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function normalizePath(filePath) {
  if (!filePath) return null;
  const trimmed = filePath.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) {
    return path.relative(process.cwd(), trimmed).replace(/\\/g, '/');
  }
  return trimmed.replace(/\\/g, '/');
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeAnnotationValue(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function emitAnnotation(finding) {
  const level = finding.level === 'error' ? 'error' : 'warning';
  const props = [
    `file=${escapeAnnotationValue(finding.path)}`,
    `line=${finding.line}`,
    `title=${escapeAnnotationValue(`[${finding.tool}] ${finding.rule || 'Issue'}`)}`,
  ];

  console.log(`::${level} ${props.join(',')}::${escapeAnnotationValue(finding.message)}`);
}

function parsePhpcs(reportPath) {
  const report = readJson(reportPath);
  if (!report || !report.files) return [];

  const findings = [];
  for (const [filePath, fileReport] of Object.entries(report.files)) {
    const relativePath = normalizePath(filePath);
    for (const message of fileReport.messages || []) {
      findings.push({
        tool: 'PHPCS',
        path: relativePath,
        line: Number(message.line) || 1,
        message: message.message,
        rule: message.source || message.type || 'Coding Standard',
        level: message.type === 'ERROR' ? 'error' : 'warning',
      });
    }
  }

  return findings;
}

function parsePhpstan(reportPath) {
  const report = readJson(reportPath);
  if (!report || !report.files) return [];

  const findings = [];
  for (const [filePath, fileReport] of Object.entries(report.files)) {
    const relativePath = normalizePath(filePath);
    for (const message of fileReport.messages || []) {
      findings.push({
        tool: 'PHPStan',
        path: relativePath,
        line: Number(message.line) || 1,
        message: message.message,
        rule: 'Static Analysis',
        level: 'error',
      });
    }
  }

  return findings;
}

function parsePhpmd(reportPath) {
  const xml = readText(reportPath);
  if (!xml) return [];

  const findings = [];
  const fileRegex = /<file\s+name="([^"]+)">([\s\S]*?)<\/file>/g;
  let fileMatch;

  while ((fileMatch = fileRegex.exec(xml)) !== null) {
    const relativePath = normalizePath(decodeXml(fileMatch[1]));
    const fileBody = fileMatch[2];
    const violationRegex = /<violation\b([^>]*)>([\s\S]*?)<\/violation>/g;
    let violationMatch;

    while ((violationMatch = violationRegex.exec(fileBody)) !== null) {
      const attrs = violationMatch[1];
      const message = decodeXml(violationMatch[2]).replace(/\s+/g, ' ').trim();
      const beginLine = /beginline="(\d+)"/.exec(attrs);
      const rule = /rule="([^"]+)"/.exec(attrs);
      const priority = /priority="(\d+)"/.exec(attrs);
      const priorityValue = Number(priority ? priority[1] : 3);

      findings.push({
        tool: 'PHPMD',
        path: relativePath,
        line: Number(beginLine ? beginLine[1] : 1),
        message,
        rule: rule ? decodeXml(rule[1]) : 'Mess Detector',
        level: priorityValue <= 2 ? 'error' : 'warning',
      });
    }
  }

  return findings;
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = [
      finding.tool,
      finding.path,
      finding.line,
      finding.rule,
      finding.message,
    ].join('::');

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countByTool(findings) {
  return findings.reduce((acc, finding) => {
    acc[finding.tool] = (acc[finding.tool] || 0) + 1;
    return acc;
  }, {});
}

function buildSummary(findings) {
  const toolCounts = countByTool(findings);
  const total = findings.length;
  const marker = '<!-- zynqa-static-analysis-summary -->';

  let body = `${marker}\n## Static Analysis Summary\n\n`;

  if (total === 0) {
    body += 'No static-analysis issues were found.\n';
    return body;
  }

  body += `Found **${total}** issue${total === 1 ? '' : 's'}.\n\n`;
  body += Object.entries(toolCounts)
    .map(([tool, count]) => `- **${tool}**: ${count}`)
    .join('\n');
  body += '\n\nSee the inline review comments and GitHub annotations for line-level details.\n';

  return body;
}

function formatReviewComment(finding) {
  const marker = '<!-- zynqa-static-analysis-inline -->';
  return `${marker}\n**${finding.tool}** (${finding.rule || 'Issue'})\n\n${finding.message}`;
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

  if (response.status === 204) return null;
  return response.json();
}

async function upsertSummaryComment(body) {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const issueNumber = process.env.PR_NUMBER;
  const marker = '<!-- zynqa-static-analysis-summary -->';
  const comments = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
  );

  const existing = comments.find(
    (comment) =>
      comment.user?.type === 'Bot' &&
      typeof comment.body === 'string' &&
      comment.body.includes(marker)
  );

  if (existing) {
    await githubRequest(
      `https://api.github.com/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      }
    );
    return;
  }

  await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }
  );
}

async function listReviewComments() {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const pullNumber = process.env.PR_NUMBER;
  return githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100`
  );
}

async function deleteReviewComment(commentId) {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}`,
    { method: 'DELETE' }
  );
}

async function clearPreviousInlineComments() {
  const marker = '<!-- zynqa-static-analysis-inline -->';
  const comments = await listReviewComments();
  const previous = comments.filter(
    (comment) =>
      comment.user?.type === 'Bot' &&
      typeof comment.body === 'string' &&
      comment.body.includes(marker)
  );

  for (const comment of previous) {
    await deleteReviewComment(comment.id);
  }
}

async function postInlineComments(findings) {
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const pullNumber = process.env.PR_NUMBER;
  const commitId = process.env.HEAD_SHA;
  const maxInlineComments = Number(process.env.MAX_INLINE_COMMENTS || 30);

  const reviewable = findings
    .filter((finding) => finding.path && finding.line)
    .slice(0, maxInlineComments);

  await clearPreviousInlineComments();

  let posted = 0;
  for (const finding of reviewable) {
    try {
      await githubRequest(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: formatReviewComment(finding),
            commit_id: commitId,
            path: finding.path,
            line: finding.line,
            side: 'RIGHT',
          }),
        }
      );
      posted += 1;
    } catch (error) {
      console.warn(`Could not post inline comment for ${finding.path}:${finding.line}: ${error.message}`);
    }
  }

  return posted;
}

function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  fs.appendFileSync(outputPath, `${name}=${value}\n`);
}

async function main() {
  const reportsDir = process.env.STATIC_REPORTS_DIR || process.cwd();
  const findings = dedupeFindings([
    ...parsePhpcs(path.join(reportsDir, 'phpcs-report.json')),
    ...parsePhpstan(path.join(reportsDir, 'phpstan-report.json')),
    ...parsePhpmd(path.join(reportsDir, 'phpmd-report.xml')),
  ]).filter((finding) => finding.path && finding.line);

  findings.forEach(emitAnnotation);
  const inlineCommentsPosted = await postInlineComments(findings);

  const summary = buildSummary(findings);
  await upsertSummaryComment(summary);

  setOutput('total_findings', findings.length);
  setOutput('has_findings', findings.length > 0 ? 'true' : 'false');
  setOutput('inline_comments_posted', inlineCommentsPosted);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

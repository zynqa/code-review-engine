const { Octokit } = require('@octokit/rest');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.REPO_OWNER;
const repo = process.env.REPO_NAME;
const pull_number = parseInt(process.env.PR_NUMBER);

/**
 * Fetch the PR diff and file list
 */
async function fetchPRDiff() {
  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number,
    per_page: 100,
  });

  const diff = files
    .filter((f) => f.status !== 'removed')
    .map((f) => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch || ''}\n\`\`\``)
    .join('\n\n');

  return { diff, files };
}

/**
 * Post the Claude review to the PR
 * - Inline comments per file
 * - Summary comment
 * - Approve or Request Changes
 */
async function postReview(review) {
  const { summary, inlineComments, decision } = review;

  const comments = inlineComments
    .filter((c) => c.line && c.path)
    .map((c) => ({
      path: c.path,
      line: c.line,
      body: formatInlineComment(c),
    }));

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    commit_id: process.env.HEAD_SHA,
    body: formatSummary(summary),
    event: decision, // 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
    comments,
  });
}

function formatSummary(summary) {
  const { verdict, overview, blocking, warnings, info, missingContext } = summary;

  const emoji = verdict === 'APPROVE' ? '✅' : verdict === 'REQUEST_CHANGES' ? '❌' : '💬';

  let body = `## ${emoji} Zynqa AI Code Review\n\n`;
  body += `${overview}\n\n`;

  if (blocking?.length) {
    body += `### 🚨 Blocking Issues\n`;
    blocking.forEach((i) => (body += `- ${i}\n`));
    body += '\n';
  }

  if (warnings?.length) {
    body += `### ⚠️ Warnings\n`;
    warnings.forEach((i) => (body += `- ${i}\n`));
    body += '\n';
  }

  if (info?.length) {
    body += `### 💡 Suggestions\n`;
    info.forEach((i) => (body += `- ${i}\n`));
    body += '\n';
  }

  if (missingContext) {
    body += `### ℹ️ Context Note\n${missingContext}\n\n`;
  }

  body += `---\n*Reviewed by [Zynqa Claude Reviewer](https://github.com/zynqa/code-review-engine)*`;

  return body;
}

function formatInlineComment(comment) {
  const severityEmoji = {
    CRITICAL: '🚨',
    WARNING: '⚠️',
    INFO: '💡',
  };
  const emoji = severityEmoji[comment.severity] || '💬';
  return `${emoji} **${comment.severity}**: ${comment.message}`;
}

module.exports = { fetchPRDiff, postReview };

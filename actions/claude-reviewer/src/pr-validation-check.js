const owner = process.env.REPO_OWNER;
const repo = process.env.REPO_NAME;
const pullNumber = process.env.PR_NUMBER;
const prTitle = process.env.PR_TITLE || '';
const prBody = process.env.PR_BODY || '';
const headRef = process.env.GITHUB_HEAD_REF || '';
const projectKey = (process.env.JIRA_PROJECT_KEY || '').toUpperCase();
const allowedProjectKeys = (process.env.ALLOWED_JIRA_PROJECT_KEYS || '')
  .split(',')
  .map((key) => key.trim().toUpperCase())
  .filter(Boolean);
const jiraBaseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');

function getAllowedProjectKeys() {
  const keys = [...allowedProjectKeys];
  if (projectKey && !keys.includes(projectKey)) {
    keys.unshift(projectKey);
  }

  return [...new Set(keys)];
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

function getProjectPattern() {
  const keys = getAllowedProjectKeys();
  if (keys.length === 0) {
    return '[A-Z][A-Z0-9]{1,9}';
  }

  return keys
    .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

function getTicketPattern() {
  return `(?:${getProjectPattern()})-\\d+`;
}

function getDisplayKeyExample() {
  const keys = getAllowedProjectKeys();
  return keys.length > 0 ? keys.join(' or ') : 'PROJ';
}

function extractTicket(source) {
  const regex = new RegExp(`(${getTicketPattern()})`, 'i');
  const match = source.match(regex);
  return match ? match[1].toUpperCase() : null;
}

function validateTitle() {
  const regex = new RegExp(`^(${getTicketPattern()}):\\s+.+`);
  if (!regex.test(prTitle)) {
    return {
      ok: false,
      message: `PR title must match "${getDisplayKeyExample()}-123: Summary".`,
    };
  }

  return { ok: true, ticket: extractTicket(prTitle) };
}

function validateBranch(expectedTicket) {
  if (!expectedTicket || headRef.toUpperCase().includes(expectedTicket)) {
    return { ok: true };
  }

  return {
    ok: false,
    message: `Branch name must include the Jira ticket ${expectedTicket}. Current branch: ${headRef}`,
  };
}

function validateDescription(expectedTicket) {
  if (!expectedTicket) {
    return { ok: false, message: 'Could not determine Jira ticket from the PR title.' };
  }

  if (jiraBaseUrl) {
    const escaped = jiraBaseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`${escaped}/(?:browse/)?${expectedTicket}\\b`, 'i');
    if (regex.test(prBody)) {
      return { ok: true };
    }

    return {
      ok: false,
      message: `PR description must include a Jira link to ${jiraBaseUrl}/browse/${expectedTicket}.`,
    };
  }

  const genericRegex = new RegExp(`https?://[^\\s]+/(?:browse/)?${expectedTicket}\\b`, 'i');
  if (genericRegex.test(prBody)) {
    return { ok: true };
  }

  return {
    ok: false,
    message: `PR description must include a Jira link for ${expectedTicket}.`,
  };
}

function validateCommitMessages(commits, expectedTicket) {
  if (!expectedTicket) {
    return { ok: false, message: 'Could not determine Jira ticket from the PR title.' };
  }

  const failures = [];

  for (const commit of commits) {
    const message = commit.commit && commit.commit.message ? commit.commit.message.split('\n')[0] : '';
    if (!message || message.startsWith('Merge ')) {
      continue;
    }

    if (!new RegExp(`^${expectedTicket}:\\s+.+`).test(message)) {
      failures.push(message);
    }
  }

  if (failures.length === 0) {
    return { ok: true };
  }

  return {
    ok: false,
    message: `Commit subjects must start with "${expectedTicket}: ". Invalid commits: ${failures.join(' | ')}`,
  };
}

function emitError(message) {
  console.log(`::error title=PR Convention Validation::${message}`);
}

async function upsertSummary(ticket, failures) {
  const marker = '<!-- zynqa-pr-validation -->';
  const body = failures.length === 0
    ? `${marker}
## ✅ PR Validation Passed

- Ticket: ${ticket}
- PR title format is valid
- Branch name includes the Jira ticket
- PR description contains the Jira link
- Commit messages match the Jira ticket`
    : `${marker}
## ❌ PR Validation Failed

${failures.map((failure) => `- ${failure}`).join('\n')}`;

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
  const titleValidation = validateTitle();
  const expectedTicket = titleValidation.ticket;
  const failures = [];

  if (!titleValidation.ok) {
    failures.push(titleValidation.message);
  }

  const branchValidation = validateBranch(expectedTicket);
  if (!branchValidation.ok) {
    failures.push(branchValidation.message);
  }

  const descriptionValidation = validateDescription(expectedTicket);
  if (!descriptionValidation.ok) {
    failures.push(descriptionValidation.message);
  }

  const commits = await paginate(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=100`
  );
  const commitValidation = validateCommitMessages(commits, expectedTicket);
  if (!commitValidation.ok) {
    failures.push(commitValidation.message);
  }

  await upsertSummary(expectedTicket || getAllowedProjectKeys()[0] || 'Unknown', failures);

  if (failures.length === 0) {
    console.log('PR convention validation passed.');
    return;
  }

  failures.forEach((failure) => emitError(failure));
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

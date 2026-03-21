const { fetchPRDiff } = require('./github');
const { extractJiraTicketId, fetchJiraContext } = require('./jira');
const { fetchConfluenceContext } = require('./confluence');
const { fetchSlackContext } = require('./slack');
const { runClaudeReview } = require('./claude');
const { postReview } = require('./github');
const { loadConfig } = require('./config');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('🤖 Zynqa Claude Code Reviewer starting...');

  const config = loadConfig();

  // 1. Fetch PR diff from GitHub
  console.log('📄 Fetching PR diff...');
  const { diff, files } = await fetchPRDiff();

  if (!diff || diff.trim() === '') {
    console.log('No diff found. Skipping review.');
    return;
  }

  // 2. Extract Jira ticket ID from PR title, branch, or body
  console.log('🔍 Extracting Jira ticket reference...');
  const jiraTicketId = extractJiraTicketId({
    title: process.env.PR_TITLE,
    body: process.env.PR_BODY,
    branch: process.env.GITHUB_HEAD_REF,
    projectKey: process.env.JIRA_PROJECT_KEY,
  });

  // 3. Gather business context from MCP sources
  let jiraContext = null;
  let confluenceContext = null;
  let slackContext = null;

  if (jiraTicketId) {
    console.log(`📋 Fetching Jira context for ${jiraTicketId}...`);
    jiraContext = await fetchJiraContext(jiraTicketId);
  } else {
    console.log('⚠️  No Jira ticket found. Proceeding without Jira context.');
  }

  if (jiraContext) {
    console.log('📚 Fetching Confluence context...');
    confluenceContext = await fetchConfluenceContext(jiraContext);

    console.log('💬 Fetching Slack context...');
    slackContext = await fetchSlackContext(jiraTicketId, jiraContext);
  }

  // 4. Load system prompt
  const systemPrompt = fs.readFileSync(
    path.join(process.env.PROMPTS_PATH, 'magento-system.md'),
    'utf8'
  );

  // 5. Run Claude review
  console.log('🧠 Running Claude review...');
  const review = await runClaudeReview({
    diff,
    files,
    jiraContext,
    confluenceContext,
    slackContext,
    systemPrompt,
    config,
    magentoVersion: process.env.MAGENTO_VERSION,
    strictMode: process.env.STRICT_MODE === 'true',
  });

  // 6. Post review to GitHub PR
  console.log('📝 Posting review to GitHub...');
  await postReview(review);

  console.log('✅ Review complete.');
}

main().catch((err) => {
  console.error('❌ Review failed:', err);
  process.exit(1);
});

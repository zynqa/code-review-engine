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
    if (process.env.JIRA_TOKEN && process.env.JIRA_BASE_URL) {
      console.log(`📋 Fetching Jira context for ${jiraTicketId}...`);
      jiraContext = await fetchJiraContext(jiraTicketId);
    } else {
      console.log('⚠️  Jira credentials are not configured. Proceeding without Jira context.');
    }
  } else {
    console.log('⚠️  No Jira ticket found. Proceeding without Jira context.');
  }

  if (jiraContext) {
    if (process.env.CONFLUENCE_TOKEN && process.env.CONFLUENCE_BASE_URL) {
      console.log('📚 Fetching Confluence context...');
      confluenceContext = await fetchConfluenceContext(jiraContext);
    } else {
      console.log('⚠️  Confluence credentials are not configured. Proceeding without Confluence context.');
    }

    if (process.env.SLACK_TOKEN) {
      console.log('💬 Fetching Slack context...');
      slackContext = await fetchSlackContext(jiraTicketId, jiraContext);
    } else {
      console.log('⚠️  Slack credentials are not configured. Proceeding without Slack context.');
    }
  }

  // 4. Load the system prompt for this stack. The reviewer's expertise has to match the
  // codebase: Magento rules applied to Laravel (and vice versa) produce confident nonsense.
  // Unknown or absent values fall back to magento, which is what every existing caller gets.
  const stack = (process.env.REVIEW_STACK || 'magento').toLowerCase();
  const stackPrompts = {
    magento: 'magento-system.md',
    laravel: 'laravel-system.md',
  };
  const promptFile = stackPrompts[stack] || stackPrompts.magento;

  if (!stackPrompts[stack]) {
    console.log(`⚠️  Unknown stack "${stack}". Falling back to the Magento reviewer persona.`);
  }

  console.log(`🧭 Reviewing as a ${stack} expert (${promptFile}).`);

  const systemPrompt = fs.readFileSync(
    path.join(process.env.PROMPTS_PATH, promptFile),
    'utf8'
  );

  // 5. Run the AI review through the configured provider
  console.log('🧠 Running AI review...');
  const review = await runClaudeReview({
    diff,
    files,
    jiraContext,
    confluenceContext,
    slackContext,
    systemPrompt,
    config,
    stack,
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

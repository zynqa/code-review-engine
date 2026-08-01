const https = require('https');
const fs = require('fs');
const path = require('path');

/**
 * Run the Claude review against the PR diff with all gathered context
 */
async function runClaudeReview({
  diff,
  files,
  jiraContext,
  confluenceContext,
  slackContext,
  systemPrompt,
  config,
  stack,
  magentoVersion,
  strictMode,
}) {
  const userMessage = buildUserMessage({
    diff,
    files,
    jiraContext,
    confluenceContext,
    slackContext,
    stack,
    magentoVersion,
    strictMode,
    config,
  });

  const response = await callProvider(systemPrompt, userMessage);
  return parseClaudeResponse(response, files, config);
}

/**
 * Dispatch to the configured AI backend.
 *
 * The engine is not tied to one vendor: AI_PROVIDER selects the implementation, and adding
 * another means adding a branch here plus its API call. Anthropic is the default and the
 * only one wired up so far.
 */
async function callProvider(systemPrompt, userMessage) {
  const provider = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();

  switch (provider) {
    case 'anthropic':
      return callClaudeAPI(systemPrompt, userMessage);
    default:
      throw new Error(
        `Unsupported AI_PROVIDER "${provider}". Supported providers: anthropic.`
      );
  }
}

function buildUserMessage({ diff, files, jiraContext, confluenceContext, slackContext, stack, magentoVersion, strictMode, config }) {
  let message = `## PR Information\n`;
  message += `- **Title:** ${process.env.PR_TITLE}\n`;
  if ((stack || 'magento') === 'magento') {
    message += `- **Magento Version:** ${magentoVersion}\n`;
  }
  message += `- **Strict Mode:** ${strictMode}\n`;
  message += `- **Files Changed:** ${files.length}\n\n`;

  if (jiraContext) {
    message += `## Jira Ticket Context\n`;
    message += `- **Ticket:** ${jiraContext.ticketId} — ${jiraContext.summary}\n`;
    message += `- **Type:** ${jiraContext.issueType} | **Status:** ${jiraContext.status} | **Priority:** ${jiraContext.priority}\n`;
    if (jiraContext.description) {
      message += `- **Description:** ${jiraContext.description.slice(0, 800)}\n`;
    }
    if (jiraContext.comments?.length) {
      message += `\n**Recent Comments:**\n`;
      jiraContext.comments.forEach((c) => {
        message += `> [${c.author}]: ${c.body.slice(0, 300)}\n`;
      });
    }
    message += '\n';
  } else {
    message += `## ⚠️ No Jira Ticket Found\nNo Jira ticket was linked to this PR via title, branch, or description.\n\n`;
  }

  if (confluenceContext?.length) {
    message += `## Confluence Documentation\n`;
    confluenceContext.forEach((page) => {
      message += `### ${page.title}\n${page.excerpt}\n\n`;
    });
  }

  if (slackContext?.length) {
    message += `## Slack Discussions\n`;
    slackContext.forEach((msg) => {
      message += `> [#${msg.channel}] ${msg.user}: ${msg.text}\n`;
    });
    message += '\n';
  }

  message += `## Code Diff\n${diff}`;

  return message;
}

async function callClaudeAPI(systemPrompt, userMessage) {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed.content[0].text);
          } catch (e) {
            reject(new Error(`Failed to parse Claude response: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse Claude's structured JSON response into review actions
 */
function parseClaudeResponse(responseText, files, config) {
  let parsed;

  try {
    const jsonMatch = responseText.match(/```json\n?([\s\S]*?)\n?```/) ||
      responseText.match(/(\{[\s\S]*\})/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[1] : responseText);
  } catch (e) {
    // Fallback: treat entire response as summary comment only
    return {
      summary: {
        verdict: 'COMMENT',
        overview: responseText.slice(0, 500),
        blocking: [],
        warnings: [],
        info: [],
        missingContext: null,
      },
      inlineComments: [],
      decision: 'COMMENT',
    };
  }

  const hasBlocking = parsed.blocking?.length > 0;
  const decision = hasBlocking ? 'REQUEST_CHANGES' : 'APPROVE';

  // Map inline comments back to file paths and line numbers
  const inlineComments = (parsed.inline_comments || []).map((c) => {
    const file = files.find((f) => f.filename.includes(c.file));
    return {
      path: file?.filename || c.file,
      line: c.line,
      severity: c.severity,
      message: c.message,
    };
  });

  return {
    summary: {
      verdict: decision,
      overview: parsed.overview || '',
      blocking: parsed.blocking || [],
      warnings: parsed.warnings || [],
      info: parsed.suggestions || [],
      missingContext: parsed.missing_context || null,
    },
    inlineComments,
    decision,
  };
}

module.exports = { runClaudeReview };

const https = require('https');

/**
 * Extract Jira ticket ID from PR title, branch name, or body
 * Supports formats: PROJ-123, proj-123
 */
function extractJiraTicketId({ title, body, branch, projectKey }) {
  const sources = [title, branch, body].filter(Boolean);
  const projectPattern = projectKey ? projectKey.toUpperCase() : '[A-Z]{2,10}';
  const regex = new RegExp(`(${projectPattern}-\\d+)`, 'i');

  for (const source of sources) {
    const match = source.match(regex);
    if (match) return match[1].toUpperCase();
  }

  return null;
}

/**
 * Fetch Jira ticket details including summary, description, acceptance criteria
 */
async function fetchJiraContext(ticketId) {
  try {
    const baseUrl = process.env.JIRA_BASE_URL;
    const token = process.env.JIRA_TOKEN;

    const data = await apiGet(
      `${baseUrl}/rest/api/3/issue/${ticketId}?fields=summary,description,comment,status,issuetype,labels,priority`,
      token
    );

    const fields = data.fields || {};

    return {
      ticketId,
      summary: fields.summary || '',
      description: extractTextFromADF(fields.description),
      status: fields.status?.name || '',
      issueType: fields.issuetype?.name || '',
      labels: fields.labels || [],
      priority: fields.priority?.name || '',
      comments: extractComments(fields.comment?.comments || []),
    };
  } catch (err) {
    console.warn(`⚠️  Could not fetch Jira ticket ${ticketId}: ${err.message}`);
    return null;
  }
}

/**
 * Extract plain text from Atlassian Document Format (ADF)
 */
function extractTextFromADF(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;

  const texts = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'text') texts.push(node.text);
    if (node.content) node.content.forEach(walk);
  }
  walk(adf);
  return texts.join(' ');
}

function extractComments(comments) {
  return comments.slice(-5).map((c) => ({
    author: c.author?.displayName || 'Unknown',
    body: extractTextFromADF(c.body),
    created: c.created,
  }));
}

function apiGet(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
  });
}

module.exports = { extractJiraTicketId, fetchJiraContext };

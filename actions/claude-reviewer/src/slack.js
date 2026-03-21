const https = require('https');

/**
 * Search Slack for messages related to the Jira ticket
 */
async function fetchSlackContext(ticketId, jiraContext) {
  if (!ticketId) return null;

  try {
    const token = process.env.SLACK_TOKEN;

    // Search for the ticket ID in Slack
    const query = encodeURIComponent(ticketId);
    const data = await apiGet(
      `https://slack.com/api/search.messages?query=${query}&count=5&sort=timestamp`,
      token
    );

    if (!data.ok || !data.messages?.matches?.length) return null;

    return data.messages.matches.map((msg) => ({
      channel: msg.channel?.name || 'unknown',
      user: msg.username || 'unknown',
      text: msg.text?.slice(0, 500) || '',
      timestamp: msg.ts,
      permalink: msg.permalink,
    }));
  } catch (err) {
    console.warn(`⚠️  Could not fetch Slack context: ${err.message}`);
    return null;
  }
}

function apiGet(url, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
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
            reject(new Error(`Failed to parse Slack response`));
          }
        });
      }
    );
    req.on('error', reject);
  });
}

module.exports = { fetchSlackContext };

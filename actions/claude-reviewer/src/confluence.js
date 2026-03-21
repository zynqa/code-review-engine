const https = require('https');

/**
 * Search Confluence for pages related to the Jira ticket
 */
async function fetchConfluenceContext(jiraContext) {
  if (!jiraContext) return null;

  try {
    const baseUrl = process.env.CONFLUENCE_BASE_URL;
    const token = process.env.CONFLUENCE_TOKEN;

    // Search using ticket ID and summary keywords
    const query = encodeURIComponent(
      `"${jiraContext.ticketId}" OR "${jiraContext.summary.split(' ').slice(0, 5).join(' ')}"`
    );

    const data = await apiGet(
      `${baseUrl}/rest/api/content/search?cql=text~${query}&limit=3&expand=body.storage`,
      token
    );

    if (!data.results?.length) return null;

    return data.results.map((page) => ({
      title: page.title,
      url: `${baseUrl}/wiki${page._links?.webui || ''}`,
      excerpt: stripHtml(page.body?.storage?.value || '').slice(0, 1000),
    }));
  } catch (err) {
    console.warn(`⚠️  Could not fetch Confluence context: ${err.message}`);
    return null;
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
            reject(new Error(`Failed to parse Confluence response`));
          }
        });
      }
    );
    req.on('error', reject);
  });
}

module.exports = { fetchConfluenceContext };

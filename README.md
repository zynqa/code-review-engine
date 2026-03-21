# Zynqa Code Review Engine

Centralised AI-powered code review for all Zynqa Magento projects, powered by Claude.

## How It Works

```
PR Opened/Updated → GitHub Actions → Fetch Diff → Gather Context (Jira + Confluence + Slack) → Claude Review → Post Inline Comments + Summary → Approve or Request Changes
```

## Adding to a New Project

1. Copy `project-template/code-review.yml` into your repo at `.github/workflows/code-review.yml`
2. Update the three inputs:

```yaml
with:
  magento-version: "2.4.7"       # Your Magento version
  strict-mode: false             # true for sensitive/production repos
  jira-project-key: "PROJ"      # Your Jira project key
```

3. Done. The repo inherits all org-level secrets automatically.

## Org-Level Secrets Required

Set these once in **GitHub Organisation Settings → Secrets**:

| Secret | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `JIRA_TOKEN` | Jira API token |
| `JIRA_BASE_URL` | e.g. `https://zynqa.atlassian.net` |
| `CONFLUENCE_TOKEN` | Confluence API token |
| `CONFLUENCE_BASE_URL` | e.g. `https://zynqa.atlassian.net/wiki` |
| `SLACK_TOKEN` | Slack Bot OAuth token |

## Updating the Review Engine

All updates are made in this repo (`code-review-engine`). Since all projects consume `@main`, they benefit immediately — no changes needed in individual project repos.

## Repository Structure

```
code-review-engine/
├── .github/workflows/
│   └── review.yml              ← Reusable workflow (called by all projects)
├── actions/claude-reviewer/
│   ├── action.yml              ← Composite action definition
│   ├── package.json
│   └── src/
│       ├── index.js            ← Entry point
│       ├── github.js           ← Fetch diff, post review
│       ├── jira.js             ← Fetch ticket context
│       ├── confluence.js       ← Fetch spec docs
│       ├── slack.js            ← Fetch discussion context
│       ├── claude.js           ← Claude API call + response parsing
│       └── config.js           ← Load severity rules
├── prompts/
│   └── magento-system.md       ← Magento expert system prompt
├── config/
│   └── severity-rules.yml      ← What blocks vs warns vs suggests
└── project-template/
    └── code-review.yml         ← Copy this into each project
```

## Review Severity

| Level | Action | Examples |
|---|---|---|
| 🚨 **BLOCKING** | Requests changes, blocks merge | Security issues, contradicts Jira AC, ObjectManager abuse |
| ⚠️ **WARNING** | Comment only, merge allowed | N+1 queries, missing tests, plugin conflicts |
| 💡 **INFO** | Suggestion | Naming, PHPDoc, refactor opportunities |

## Customising Per Project

Even with `@main`, each project can tune behaviour via inputs:
- `strict-mode: true` — elevates warnings to blocking (for critical repos)
- `jira-project-key` — ensures Claude finds the right tickets
- `magento-version` — tailors review to PHP/Magento version specifics

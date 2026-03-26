# Zynqa Code Review Engine

Reusable GitHub Actions review engine for Zynqa Magento repositories.

The engine combines deterministic validation, PR-scoped static analysis, optional AI review, and automatic merge handling in a single reusable workflow.

## Workflow Overview

```
PR Opened/Updated
  → PR validation (optional)
  → Magento module registration validation (optional)
  → Static analysis on changed files only (optional)
  → Claude AI review (optional)
  → PHPUnit tests (optional)
  → Auto-approval + merge gate (optional, based only on enabled checks)
```

## What the Engine Does

### PR conventions

Optional validation for:
- PR title format: `KEY-123: Summary`
- branch name includes the Jira ticket
- PR description contains the Jira link
- commit subjects start with the Jira ticket

The job posts a sticky PR comment with pass/fail status.

### Magento module registration

Optional validation for newly introduced Magento modules.

- Local modules added under `app/code/<Vendor>/<Module>/` must be enabled in `app/etc/config.php`
- Composer-added Magento modules are inspected from `composer.lock`
- Composer modules are accepted when package metadata shows registration evidence

This check is usually enabled for Magento application repos and disabled for standalone module repos.

### Static analysis

Runs only against files changed in the PR, not the whole repository.

Tools:
- `PHP_CodeSniffer`
- `PHPStan`
- `PHPMD`

Outputs:
- GitHub file and line annotations
- inline PR review comments on offending lines
- sticky PR summary comment with counts by tool

Custom PHPCS rules in the engine currently include:
- required `declare(strict_types=1);`
- stateless Magento helpers
- forbidden superglobals and `global`
- forbidden runtime/debug functions such as `eval`, `die`, `var_dump`, `print_r`, `error_log`
- direct `ObjectManager` usage
- deprecated `Setup/InstallSchema.php`
- admin controller inheritance and `ADMIN_RESOURCE`
- inline presentation patterns in `.phtml`

### Claude AI review

Optional AI review that uses:
- GitHub PR context
- Jira context
- Confluence context
- Slack context

If AI review is enabled without `ANTHROPIC_API_KEY`, the job fails explicitly.

### Tests

Optional PHPUnit job for repos that have a working test suite.

### Auto-merge gate

The final gate only evaluates checks that are enabled for the consumer repository.

Behavior:
- optionally posts an approval review from `github-actions[bot]`
- selects an allowed repository merge method automatically
- updates the PR branch if needed
- prefers direct merge first
- falls back to GitHub native auto-merge when direct merge is blocked by repository rules

## Adding to a New Project

1. Copy [project-template/code-review.yml](project-template/code-review.yml) into the consumer repo as `.github/workflows/code-review.yml`
2. Update the project-specific inputs
3. Keep `secrets: inherit`

Example:

```yaml
name: Code Review

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

jobs:
  review:
    uses: zynqa/code-review-engine/.github/workflows/review.yml@main
    with:
      magento-version: "2.4.5-p5"
      strict-mode: false
      jira-project-key: "PROJ"

      enable-pr-validation: false
      enable-auto-approval: false
      enable-module-registration: true
      enable-static-analysis: true
      enable-ai-review: false
      enable-tests: false
    secrets: inherit
```

## Workflow Inputs

| Input | Default | Purpose |
|---|---|---|
| `magento-version` | `2.4.7` | Passed to the reviewer so AI guidance matches the target Magento version |
| `strict-mode` | `false` | Enables stricter AI review behavior |
| `jira-project-key` | `''` | Used for Jira ticket extraction and PR convention checks |
| `enable-pr-validation` | `false` | Enforces PR title, branch, description, and commit conventions |
| `enable-auto-approval` | `false` | Allows `github-actions[bot]` to approve the PR before merge |
| `enable-module-registration` | `true` | Validates Magento module registration consistency |
| `enable-static-analysis` | `true` | Runs PHPCS, PHPStan, and PHPMD on changed files |
| `enable-ai-review` | `true` | Runs Claude AI review |
| `enable-tests` | `false` | Runs PHPUnit tests |

## Secrets

All secrets are optional at the workflow level, but some features depend on them.

| Secret | Required For | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | AI review | Required if `enable-ai-review: true` |
| `JIRA_TOKEN` | Jira context lookup | Optional unless AI/Jira context is needed |
| `JIRA_BASE_URL` | Jira link validation and context | Example: `https://zynqa.atlassian.net` |
| `CONFLUENCE_TOKEN` | Confluence context lookup | Optional |
| `CONFLUENCE_BASE_URL` | Confluence context lookup | Example: `https://zynqa.atlassian.net/wiki` |
| `SLACK_TOKEN` | Slack context lookup | Optional |

## Recommended Profiles

### Magento application repository

Typical settings:

```yaml
with:
  magento-version: "2.4.5-p5"
  jira-project-key: "DPT"
  enable-pr-validation: true
  enable-auto-approval: true
  enable-module-registration: true
  enable-static-analysis: true
  enable-ai-review: false
  enable-tests: false
```

### Standalone Magento module repository

Typical settings:

```yaml
with:
  magento-version: "2.4.5-p5"
  jira-project-key: "ESHOP3"
  enable-pr-validation: false
  enable-auto-approval: true
  enable-module-registration: false
  enable-static-analysis: true
  enable-ai-review: false
  enable-tests: false
```

## Repository Structure

```
code-review-engine/
├── .github/workflows/review.yml
├── actions/claude-reviewer/
│   ├── action.yml
│   └── src/
│       ├── index.js
│       ├── github.js
│       ├── jira.js
│       ├── confluence.js
│       ├── slack.js
│       ├── claude.js
│       ├── config.js
│       ├── pr-validation-check.js
│       ├── module-registration-check.js
│       └── static-analysis-report.js
├── phpcs/Zynqa/
├── prompts/
├── config/
└── project-template/code-review.yml
```

## Operational Notes

- Consumer repositories using `@main` pick up engine changes automatically.
- Template changes still need to be copied into consumer repositories when new inputs are introduced.
- `enable-auto-approval` requires repository settings that allow GitHub Actions to approve pull requests.
- Auto-merge behavior also depends on the target repository's branch protection and ruleset configuration.
- Static analysis comments are PR-scoped and refreshed on each run.

## Local Development

Run commands from the repository root unless noted otherwise.

- `cd actions/claude-reviewer && npm ci`
- `cd actions/claude-reviewer && npm start`
- `node actions/claude-reviewer/src/index.js`
- `git diff -- .github/workflows/review.yml actions/claude-reviewer/src`

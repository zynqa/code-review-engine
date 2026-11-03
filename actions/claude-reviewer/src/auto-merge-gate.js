'use strict';

// The auto-merge gate used to trust github.event.pull_request from the start of
// the run. That payload stays open, non-draft, and pinned to the SHA that was
// current when the workflow was triggered, so a PR closed (or relabeled, or
// pushed to) while the review jobs ran was still approved and merged.
// Every decision below reloads the pull request from the GitHub API.

const DEFAULT_BLOCKING_LABELS = ['do not merge', 'do-not-merge', 'wip'];

function parseBlockingLabels(value) {
  const parsed = String(value ?? '')
    .split(/[,\n]/)
    .map((label) => label.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : [...DEFAULT_BLOCKING_LABELS];
}

function normalizeLabel(label) {
  return String(label ?? '').trim().toLowerCase();
}

function labelName(label) {
  if (typeof label === 'string') {
    return label;
  }

  if (label && typeof label.name === 'string') {
    return label.name;
  }

  return '';
}

function headShaOf(pullRequest) {
  if (!pullRequest || typeof pullRequest !== 'object') {
    return '';
  }

  if (typeof pullRequest.headSha === 'string') {
    return pullRequest.headSha;
  }

  if (pullRequest.head && typeof pullRequest.head.sha === 'string') {
    return pullRequest.head.sha;
  }

  return '';
}

function isDraft(pullRequest) {
  return pullRequest.draft === true
    || pullRequest.isDraft === true
    || pullRequest.is_draft === true;
}

function parentShasOf(commit) {
  const parents = commit && Array.isArray(commit.parents) ? commit.parents : [];

  return parents
    .map((parent) => (typeof parent === 'string' ? parent : parent && parent.sha))
    .filter(Boolean);
}

// updateBranch merges the base into the head, producing a merge commit whose
// parents include the reviewed SHA. A later push is a single-parent commit and
// must not be treated as that update.
function isUpdateMergeCommit(commit, reviewedSha) {
  if (!reviewedSha) {
    return false;
  }

  const parentShas = parentShasOf(commit);
  return parentShas.length >= 2 && parentShas.includes(reviewedSha);
}

/**
 * Decide from a freshly fetched pull request whether auto-merge may continue.
 * `allowedHeadSha` is the reviewed SHA, or the merge commit this gate just
 * created by updating the branch.
 *
 * @returns {{ proceed: true } | { proceed: false, reason: string }}
 */
function evaluateAutoMergeGuard(pullRequest, options = {}) {
  const reviewedSha = options.reviewedSha || '';
  const allowedHeadSha = options.allowedHeadSha || reviewedSha;
  const blockingLabels = (options.blockingLabels && options.blockingLabels.length
    ? options.blockingLabels
    : DEFAULT_BLOCKING_LABELS
  ).map(normalizeLabel);

  if (!pullRequest || typeof pullRequest !== 'object') {
    return {
      proceed: false,
      reason: 'Pull request could not be loaded from the GitHub API.',
    };
  }

  const state = String(pullRequest.state || '').toLowerCase();
  if (state !== 'open') {
    const observed = pullRequest.merged === true
      ? 'closed (already merged)'
      : (state || 'unknown');

    return {
      proceed: false,
      reason: `Pull request is ${observed}, not open.`,
    };
  }

  if (isDraft(pullRequest)) {
    return {
      proceed: false,
      reason: 'Pull request is a draft.',
    };
  }

  if (!reviewedSha) {
    return {
      proceed: false,
      reason: 'Reviewed head SHA is missing, so the gate cannot confirm this commit was reviewed.',
    };
  }

  const liveSha = headShaOf(pullRequest);
  if (!liveSha || liveSha !== allowedHeadSha) {
    const expected = allowedHeadSha === reviewedSha
      ? `the reviewed SHA ${reviewedSha}`
      : `the reviewed SHA ${reviewedSha} (allowed branch-update SHA ${allowedHeadSha})`;

    return {
      proceed: false,
      reason: `Pull request head SHA ${liveSha || '(missing)'} differs from ${expected}.`,
    };
  }

  const labels = (pullRequest.labels || [])
    .map(labelName)
    .filter(Boolean);
  const blocking = labels.find((label) => blockingLabels.includes(normalizeLabel(label)));
  if (blocking) {
    return {
      proceed: false,
      reason: `Pull request has blocking label "${blocking}".`,
    };
  }

  return { proceed: true };
}

function errorText(error) {
  const responseMessage = error
    && error.response
    && error.response.data
    && error.response.data.message;

  return [error && error.message, responseMessage]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isClosedOrDraftMergeError(error) {
  const message = errorText(error);
  return message.includes('pull request is closed')
    || message.includes('pull request is a draft')
    || message.includes('draft pull requests')
    || message.includes('pull request is still a draft');
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runAutoMergeGate({ github, context, sleep } = {}) {
  if (!github || !context || !context.repo || !context.payload) {
    throw new Error('Auto-merge gate requires the github and context objects from actions/github-script.');
  }

  const eventPullRequest = context.payload.pull_request;
  if (!eventPullRequest || !eventPullRequest.number) {
    throw new Error('Auto-merge gate requires a pull_request event payload.');
  }

  const pause = sleep || defaultSleep;
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const pullNumber = eventPullRequest.number;
  const reviewedSha = process.env.REVIEWED_SHA || (eventPullRequest.head && eventPullRequest.head.sha) || '';
  const blockingLabels = parseBlockingLabels(process.env.BLOCKING_LABELS);
  const enableAutoApproval = String(process.env.ENABLE_AUTO_APPROVAL || '').toLowerCase() === 'true';
  const skipUpdateBranchBases = String(process.env.SKIP_UPDATE_BRANCH_BASES || '')
    .split(',')
    .map((base) => base.trim())
    .filter(Boolean);

  // Heads this run is allowed to merge. Starts as the SHA the other jobs
  // reviewed. After this gate itself updates the branch, the update merge
  // commit is added. Any other SHA is a push the review did not see.
  let allowedHeadSha = reviewedSha;
  let branchUpdated = false;

  const skipLine = (phase, reason) =>
    `Auto-merge gate skipped before ${phase} pull request #${pullNumber}: ${reason} The pull request was not merged and its head branch was not deleted.`;

  const skipIfBlocked = (pullRequest, phase) => {
    const decision = evaluateAutoMergeGuard(pullRequest, {
      reviewedSha,
      allowedHeadSha,
      blockingLabels,
    });

    if (decision.proceed) {
      return false;
    }

    console.log(skipLine(phase, decision.reason));
    return true;
  };

  const fetchLivePull = async () => {
    const { data } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    return data;
  };

  const acceptUpdatedHead = async (pullRequest) => {
    if (!branchUpdated) {
      return;
    }

    const liveSha = headShaOf(pullRequest);
    if (!liveSha || liveSha === allowedHeadSha) {
      return;
    }

    const { data: commit } = await github.rest.repos.getCommit({
      owner,
      repo,
      ref: liveSha,
    });

    if (!isUpdateMergeCommit(commit, reviewedSha)) {
      return;
    }

    allowedHeadSha = liveSha;
    console.log(
      `Branch update moved the pull request head from ${reviewedSha} to ${allowedHeadSha}. The merge check will allow that SHA.`
    );
  };

  const refreshForMerge = async () => {
    const latest = await fetchLivePull();
    await acceptUpdatedHead(latest);
    if (skipIfBlocked(latest, 'merging')) {
      return null;
    }

    return latest;
  };

  const beforeApproval = await fetchLivePull();
  if (skipIfBlocked(beforeApproval, 'approving')) {
    return;
  }

  const { data: repository } = await github.rest.repos.get({
    owner,
    repo,
  });

  const mergeMethods = [
    repository.allow_merge_commit ? 'merge' : null,
    repository.allow_squash_merge ? 'squash' : null,
    repository.allow_rebase_merge ? 'rebase' : null,
  ].filter(Boolean);

  if (mergeMethods.length === 0) {
    throw new Error('No merge methods are enabled for this repository.');
  }

  const isMergeMethodRejected = (message) =>
    message.includes('merging is not allowed on this repository')
    || message.includes('Merge method');

  if (enableAutoApproval) {
    const { data: reviews } = await github.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
    });

    const latestStatesByAuthor = new Map();
    for (const review of reviews) {
      if (!review.user || !review.user.login) {
        continue;
      }

      latestStatesByAuthor.set(review.user.login, review.state);
    }

    if (latestStatesByAuthor.get('github-actions[bot]') !== 'APPROVED') {
      await github.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: 'APPROVE',
        body: 'Automatically approved after all configured review-engine checks passed.',
      });
    }
  }

  const beforeUpdate = await refreshForMerge();
  if (!beforeUpdate) {
    return;
  }

  const baseRef = (beforeUpdate.base && beforeUpdate.base.ref)
    || (eventPullRequest.base && eventPullRequest.base.ref)
    || '';

  if (skipUpdateBranchBases.includes(baseRef)) {
    console.log(`Not updating the PR branch from "${baseRef}" (listed in skip-update-branch-bases).`);
  } else {
    try {
      await github.rest.pulls.updateBranch({
        owner,
        repo,
        pull_number: pullNumber,
      });
      branchUpdated = true;
    } catch (error) {
      if (isClosedOrDraftMergeError(error)) {
        console.log(skipLine(
          'merging',
          `GitHub rejected the branch update because the pull request is closed or a draft (${error.message}).`
        ));
        return;
      }

      if (error.status !== 422 || !String(error.message).includes('There are no new commits on the base branch')) {
        throw error;
      }

      console.log('PR branch is already up to date with the base branch.');
    }
  }

  const fetchPullRequestNode = async () => github.graphql(`
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          mergeStateStatus
          autoMergeRequest {
            enabledAt
          }
        }
      }
    }
  `, {
    owner,
    repo,
    number: pullNumber,
  });

  if (branchUpdated) {
    console.log('PR branch was updated from the base branch. Waiting for the refreshed head before trying to merge.');

    for (let attempt = 1; attempt <= 6; attempt++) {
      const latest = (await fetchPullRequestNode()).repository.pullRequest;
      if (latest.mergeStateStatus !== 'UNSTABLE') {
        break;
      }

      console.log(`PR is still unstable after branch update (attempt ${attempt}/6). Waiting 10s...`);
      await pause(10000);
    }
  }

  const tryDirectMerge = async () => {
    let lastError = null;

    for (const mergeMethod of mergeMethods) {
      try {
        await github.rest.pulls.merge({
          owner,
          repo,
          pull_number: pullNumber,
          merge_method: mergeMethod,
          sha: allowedHeadSha,
        });
        return;
      } catch (error) {
        const message = String(error.message || error);
        if (!isMergeMethodRejected(message)) {
          throw error;
        }

        lastError = error;
        console.log(`Direct merge rejected method "${mergeMethod}". Trying next allowed method.`);
      }
    }

    throw lastError;
  };

  const shouldFallbackToAutoMerge = (error) => {
    const message = String(error.message || error);
    return error.status === 405
      || error.status === 409
      || message.includes('protected ref')
      || message.includes('Repository rule violations found')
      || message.includes('Head branch is out of date')
      || (branchUpdated && message.includes('Head branch was modified'));
  };

  const attemptDirectMerge = async () => {
    const candidate = await refreshForMerge();
    if (!candidate) {
      return 'skipped';
    }

    try {
      await tryDirectMerge();
      console.log(
        branchUpdated
          ? 'Pull request merged directly after branch update.'
          : 'Pull request merged directly.'
      );
      return 'merged';
    } catch (error) {
      const message = String(error.message || error);
      if (isClosedOrDraftMergeError(error)) {
        console.log(skipLine(
          'merging',
          `GitHub rejected the merge because the pull request is closed or a draft (${message}).`
        ));
        return 'skipped';
      }

      if (!shouldFallbackToAutoMerge(error)) {
        throw error;
      }

      const stillEligible = await refreshForMerge();
      if (!stillEligible) {
        return 'skipped';
      }

      console.log(
        branchUpdated
          ? `Direct merge after branch update is blocked (${message}). Falling back to native auto-merge.`
          : `Direct merge is blocked (${message}). Falling back to native auto-merge.`
      );
      return 'fallback';
    }
  };

  const directResult = await attemptDirectMerge();
  if (directResult === 'merged' || directResult === 'skipped') {
    return;
  }

  const enableAutoMerge = async (pullRequestId) => {
    let lastError = null;

    for (const mergeMethod of mergeMethods) {
      try {
        await github.graphql(`
          mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
            enablePullRequestAutoMerge(input: {
              pullRequestId: $pullRequestId
              mergeMethod: $mergeMethod
            }) {
              pullRequest {
                number
              }
            }
          }
        `, {
          pullRequestId,
          mergeMethod: mergeMethod.toUpperCase(),
        });
        return;
      } catch (error) {
        const message = String(error.message || error);
        if (!isMergeMethodRejected(message)) {
          throw error;
        }

        lastError = error;
        console.log(`Auto-merge rejected method "${mergeMethod}". Trying next allowed method.`);
      }
    }

    throw lastError;
  };

  let lastAutoMergeError = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ready = await refreshForMerge();
    if (!ready) {
      return;
    }

    const current = (await fetchPullRequestNode()).repository.pullRequest;
    if (current.autoMergeRequest) {
      console.log('Auto-merge is already enabled for this pull request.');
      return;
    }

    try {
      await enableAutoMerge(current.id);
      return;
    } catch (error) {
      const message = String(error.message || error);
      if (isClosedOrDraftMergeError(error)) {
        console.log(skipLine(
          'merging',
          `GitHub rejected auto-merge because the pull request is closed or a draft (${message}).`
        ));
        return;
      }

      if (!message.includes('unstable status')) {
        throw error;
      }

      lastAutoMergeError = error;
      console.log(`PR is still unstable for auto-merge (attempt ${attempt}/6). Waiting 10s...`);
      await pause(10000);
    }
  }

  if (lastAutoMergeError) {
    throw lastAutoMergeError;
  }
}

module.exports = {
  DEFAULT_BLOCKING_LABELS,
  parseBlockingLabels,
  evaluateAutoMergeGuard,
  isUpdateMergeCommit,
  isClosedOrDraftMergeError,
  runAutoMergeGate,
};

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_BLOCKING_LABELS,
  parseBlockingLabels,
  evaluateAutoMergeGuard,
  isUpdateMergeCommit,
  runAutoMergeGate,
} = require('./auto-merge-gate');

const REVIEWED_SHA = 'abc123';
const UPDATED_SHA = 'update456';

function openPull(overrides = {}) {
  return {
    number: 111,
    state: 'open',
    draft: false,
    merged: false,
    head: { sha: REVIEWED_SHA, ref: 'feature' },
    base: { ref: 'main' },
    labels: [],
    ...overrides,
  };
}

function guard(pullRequest, options = {}) {
  return evaluateAutoMergeGuard(pullRequest, {
    reviewedSha: REVIEWED_SHA,
    blockingLabels: DEFAULT_BLOCKING_LABELS,
    ...options,
  });
}

test('parseBlockingLabels keeps the defaults when the input is blank', () => {
  assert.deepEqual(parseBlockingLabels(undefined), DEFAULT_BLOCKING_LABELS);
  assert.deepEqual(parseBlockingLabels(''), DEFAULT_BLOCKING_LABELS);
  assert.deepEqual(parseBlockingLabels('  \n '), DEFAULT_BLOCKING_LABELS);
});

test('parseBlockingLabels replaces the defaults with a comma or newline list', () => {
  assert.deepEqual(parseBlockingLabels(' hold, wip '), ['hold', 'wip']);
  assert.deepEqual(parseBlockingLabels('hold\nwip'), ['hold', 'wip']);
});

test('guard rejects a pull request that could not be loaded', () => {
  const decision = guard(null);
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /could not be loaded/);
});

test('guard skips a closed pull request', () => {
  const decision = guard(openPull({ state: 'closed' }));
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /closed, not open/);
});

test('guard skips an already merged pull request', () => {
  const decision = guard(openPull({ state: 'closed', merged: true }));
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /already merged/);
});

test('guard skips a draft pull request', () => {
  for (const draftField of ['draft', 'isDraft', 'is_draft']) {
    const decision = guard(openPull({ [draftField]: true }));
    assert.equal(decision.proceed, false, draftField);
    assert.match(decision.reason, /draft/);
  }
});

test('guard skips when the head SHA differs from the reviewed SHA', () => {
  const decision = guard(openPull({ head: { sha: 'deadbeef' } }));
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /deadbeef/);
  assert.match(decision.reason, new RegExp(REVIEWED_SHA));
});

test('guard skips when the reviewed SHA is missing', () => {
  const decision = evaluateAutoMergeGuard(openPull(), {
    reviewedSha: '',
    blockingLabels: DEFAULT_BLOCKING_LABELS,
  });
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /Reviewed head SHA is missing/);
});

test('guard skips default blocking labels case-insensitively and ignores lookalikes', () => {
  for (const name of ['do not merge', 'DO NOT MERGE', 'do-not-merge', 'Do-Not-Merge', 'wip', 'WIP']) {
    const decision = guard(openPull({ labels: [{ name }, { name: 'enhancement' }] }));
    assert.equal(decision.proceed, false, name);
    assert.match(decision.reason, /blocking label/i);
    assert.match(decision.reason, new RegExp(name));
  }

  for (const name of ['swipe', 'do not merge later', 'wip-approved']) {
    const decision = guard(openPull({ labels: [{ name }] }));
    assert.equal(decision.proceed, true, name);
  }

  assert.equal(guard(openPull({ labels: ['ready'] })).proceed, true);
});

test('guard uses a custom blocking list instead of the defaults', () => {
  const held = guard(openPull({ labels: [{ name: 'Hold' }] }), {
    blockingLabels: ['hold'],
  });
  assert.equal(held.proceed, false);

  const wipAllowed = guard(openPull({ labels: [{ name: 'wip' }] }), {
    blockingLabels: ['hold'],
  });
  assert.equal(wipAllowed.proceed, true);
});

test('guard allows the merge commit created by this gate branch update', () => {
  const decision = guard(openPull({ head: { sha: UPDATED_SHA } }), {
    allowedHeadSha: UPDATED_SHA,
  });
  assert.equal(decision.proceed, true);
});

test('guard rejects a third SHA after a branch update', () => {
  const decision = guard(openPull({ head: { sha: 'someone-else' } }), {
    allowedHeadSha: UPDATED_SHA,
  });
  assert.equal(decision.proceed, false);
  assert.match(decision.reason, /someone-else/);
  assert.match(decision.reason, new RegExp(REVIEWED_SHA));
});

test('isUpdateMergeCommit accepts only a merge commit of the reviewed head', () => {
  assert.equal(isUpdateMergeCommit({
    parents: [{ sha: REVIEWED_SHA }, { sha: 'base999' }],
  }, REVIEWED_SHA), true);
  assert.equal(isUpdateMergeCommit({
    parents: [REVIEWED_SHA, 'base999'],
  }, REVIEWED_SHA), true);
  assert.equal(isUpdateMergeCommit({
    parents: [{ sha: REVIEWED_SHA }],
  }, REVIEWED_SHA), false);
  assert.equal(isUpdateMergeCommit({
    parents: [{ sha: 'other' }, { sha: 'base999' }],
  }, REVIEWED_SHA), false);
  assert.equal(isUpdateMergeCommit(null, REVIEWED_SHA), false);
});

function createGithub(options = {}) {
  const calls = {
    get: [],
    merge: [],
    createReview: [],
    updateBranch: [],
    listReviews: [],
    graphql: [],
    getCommit: [],
    deleteRef: [],
  };

  let getCount = 0;
  const github = {
    rest: {
      repos: {
        get: async () => ({
          data: {
            allow_merge_commit: true,
            allow_squash_merge: false,
            allow_rebase_merge: false,
            ...(options.repository || {}),
          },
        }),
        getCommit: async (args) => {
          calls.getCommit.push(args);
          if (options.getCommit) {
            return options.getCommit(args);
          }

          return { data: { parents: [] } };
        },
      },
      pulls: {
        get: async (args) => {
          calls.get.push(args);
          getCount += 1;
          const pull = options.get ? options.get(getCount, args) : openPull();
          return { data: pull };
        },
        merge: async (args) => {
          calls.merge.push(args);
          if (options.merge) {
            return options.merge(args);
          }

          return { data: { merged: true, sha: 'mergecommit' } };
        },
        createReview: async (args) => {
          calls.createReview.push(args);
          return { data: { id: 1, state: 'APPROVED' } };
        },
        updateBranch: async (args) => {
          calls.updateBranch.push(args);
          if (options.updateBranch) {
            return options.updateBranch(args);
          }

          const error = new Error('There are no new commits on the base branch');
          error.status = 422;
          throw error;
        },
        listReviews: async () => {
          calls.listReviews.push(true);
          return { data: options.reviews || [] };
        },
      },
      git: {
        deleteRef: async (args) => {
          calls.deleteRef.push(args);
          throw new Error('the auto-merge gate must not delete branches');
        },
      },
    },
    graphql: async (query, variables) => {
      calls.graphql.push({ query: String(query), variables });
      if (options.graphql) {
        return options.graphql(query, variables);
      }

      if (String(query).includes('enablePullRequestAutoMerge')) {
        return { enablePullRequestAutoMerge: { pullRequest: { number: 111 } } };
      }

      return {
        repository: {
          pullRequest: {
            id: 'PR_NODE',
            mergeStateStatus: 'CLEAN',
            autoMergeRequest: null,
          },
        },
      };
    },
  };

  return { github, calls };
}

function createContext(pullRequest = openPull()) {
  return {
    repo: { owner: 'zynqa', repo: 'zcp' },
    payload: {
      pull_request: {
        number: pullRequest.number,
        head: pullRequest.head,
        base: pullRequest.base,
        draft: pullRequest.draft,
        state: pullRequest.state,
      },
    },
  };
}

async function withEnv(env, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function runGate(options = {}) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  const { github, calls } = createGithub(options.github);
  try {
    await withEnv({
      ENABLE_AUTO_APPROVAL: 'true',
      REVIEWED_SHA: REVIEWED_SHA,
      BLOCKING_LABELS: '',
      SKIP_UPDATE_BRANCH_BASES: '',
      ...(options.env || {}),
    }, () => runAutoMergeGate({
      github,
      context: options.context || createContext(options.eventPull || openPull()),
      sleep: async () => {
        throw new Error('auto-merge gate slept; the test expected no retry delay');
      },
    }));
  } finally {
    console.log = originalLog;
  }

  return { logs, calls };
}

function assertNotMerged(calls) {
  assert.equal(calls.merge.length, 0);
  assert.equal(calls.deleteRef.length, 0);
  const enabled = calls.graphql.filter((call) => call.query.includes('enablePullRequestAutoMerge'));
  assert.equal(enabled.length, 0);
}

function skipLines(logs) {
  return logs.filter((line) => line.includes('Auto-merge gate skipped'));
}

test('happy path approves and merges the reviewed SHA and does not delete the branch', async () => {
  const { logs, calls } = await runGate();

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].event, 'APPROVE');
  assert.equal(calls.merge.length, 1);
  assert.equal(calls.merge[0].sha, REVIEWED_SHA);
  assert.equal(calls.merge[0].pull_number, 111);
  assert.equal(calls.deleteRef.length, 0);
  assert.equal(skipLines(logs).length, 0);
  assert.ok(logs.some((line) => line.includes('Pull request merged directly.')));
});

test('does not approve again when github-actions already approved', async () => {
  const { calls } = await runGate({
    github: {
      reviews: [{ user: { login: 'github-actions[bot]' }, state: 'APPROVED' }],
    },
  });

  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.merge.length, 1);
});

test('merges without approving when auto-approval is disabled', async () => {
  const { calls } = await runGate({
    env: { ENABLE_AUTO_APPROVAL: 'false' },
  });

  assert.equal(calls.listReviews.length, 0);
  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.merge.length, 1);
});

test('skips a closed pull request before approving or merging', async () => {
  const { logs, calls } = await runGate({
    github: {
      get: () => openPull({ state: 'closed' }),
    },
  });

  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.updateBranch.length, 0);
  assertNotMerged(calls);
  const skipped = skipLines(logs);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /skipped before approving pull request #111/);
  assert.match(skipped[0], /not open/);
  assert.match(skipped[0], /head branch was not deleted/);
});

test('skips a draft pull request before approving or merging', async () => {
  const { logs, calls } = await runGate({
    github: {
      get: () => openPull({ draft: true }),
    },
  });

  assert.equal(calls.createReview.length, 0);
  assertNotMerged(calls);
  assert.match(skipLines(logs)[0], /draft/);
  assert.match(skipLines(logs)[0], /head branch was not deleted/);
});

test('skips when the live head SHA differs from the reviewed SHA', async () => {
  const { logs, calls } = await runGate({
    github: {
      get: () => openPull({ head: { sha: 'deadbeef', ref: 'feature' } }),
    },
  });

  assert.equal(calls.createReview.length, 0);
  assert.equal(calls.getCommit.length, 0);
  assertNotMerged(calls);
  assert.match(skipLines(logs)[0], /deadbeef/);
  assert.match(skipLines(logs)[0], /abc123/);
});

test('skips a blocking label before approving or merging', async () => {
  const { logs, calls } = await runGate({
    github: {
      get: () => openPull({ labels: [{ name: 'Do Not Merge' }] }),
    },
  });

  assert.equal(calls.createReview.length, 0);
  assertNotMerged(calls);
  assert.match(skipLines(logs)[0], /Do Not Merge/);
});

test('a custom blocking-labels list replaces the defaults', async () => {
  const blocked = await runGate({
    env: { BLOCKING_LABELS: 'hold' },
    github: {
      get: () => openPull({ labels: [{ name: 'Hold' }] }),
    },
  });
  assert.equal(blocked.calls.createReview.length, 0);
  assertNotMerged(blocked.calls);

  const wipAllowed = await runGate({
    env: { BLOCKING_LABELS: 'hold' },
    github: {
      get: () => openPull({ labels: [{ name: 'wip' }] }),
    },
  });
  assert.equal(wipAllowed.calls.merge.length, 1);
});

test('closing the pull request after approval skips the merge and keeps the branch', async () => {
  const { logs, calls } = await runGate({
    github: {
      get: (attempt) => {
        if (attempt < 3) {
          return openPull();
        }

        return openPull({ state: 'closed' });
      },
    },
  });

  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.updateBranch.length, 1);
  assertNotMerged(calls);
  assert.match(skipLines(logs)[0], /skipped before merging pull request #111/);
  assert.match(skipLines(logs)[0], /not open/);
  assert.match(skipLines(logs)[0], /head branch was not deleted/);
});

test('a blocking label added before merge skips the merge', async () => {
  const { logs, calls } = await runGate({
    github: {
      get: (attempt) => openPull({
        labels: attempt < 3 ? [] : [{ name: 'wip' }],
      }),
    },
  });

  assert.equal(calls.createReview.length, 1);
  assertNotMerged(calls);
  assert.match(skipLines(logs)[0], /wip/);
});

test('does not enable native auto-merge when GitHub reports the pull request closed', async () => {
  for (const message of ['Pull Request is closed', 'Pull request is still a draft']) {
    const error = new Error(message);
    error.status = 405;
    const { logs, calls } = await runGate({
      github: {
        merge: async () => {
          throw error;
        },
      },
    });

    assert.equal(calls.merge.length, 1);
    assertNotMerged({ ...calls, merge: [] });
    assert.match(skipLines(logs).join('\n'), /closed or a draft/);
    assert.match(skipLines(logs).join('\n'), /head branch was not deleted/);
  }
});

test('falls back to native auto-merge when rulesets block a still-eligible pull request', async () => {
  const error = new Error('Required status check "ci" is expected.');
  error.status = 405;
  const { logs, calls } = await runGate({
    github: {
      merge: async () => {
        throw error;
      },
    },
  });

  assert.equal(calls.merge.length, 1);
  assert.equal(calls.deleteRef.length, 0);
  const enabled = calls.graphql.filter((call) => call.query.includes('enablePullRequestAutoMerge'));
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].variables.mergeMethod, 'MERGE');
  assert.ok(logs.some((line) => line.includes('Falling back to native auto-merge.')));
  assert.equal(skipLines(logs).length, 0);
});

test('merges the branch-update commit and refuses an unrelated push', async () => {
  const updated = await runGate({
    github: {
      updateBranch: async () => ({ status: 202 }),
      get: (attempt) => openPull({
        head: { sha: attempt < 3 ? REVIEWED_SHA : UPDATED_SHA, ref: 'feature' },
      }),
      getCommit: async () => ({
        data: { parents: [{ sha: REVIEWED_SHA }, { sha: 'base999' }] },
      }),
    },
  });

  assert.equal(updated.calls.merge.length, 1);
  assert.equal(updated.calls.merge[0].sha, UPDATED_SHA);
  assert.equal(updated.calls.deleteRef.length, 0);
  assert.ok(updated.logs.some((line) => line.includes('Branch update moved the pull request head')));
  assert.ok(updated.logs.some((line) => line.includes('Pull request merged directly after branch update.')));

  const pushed = await runGate({
    github: {
      updateBranch: async () => ({ status: 202 }),
      get: (attempt) => openPull({
        head: { sha: attempt < 3 ? REVIEWED_SHA : 'deadbeef', ref: 'feature' },
      }),
      getCommit: async () => ({
        data: { parents: [{ sha: REVIEWED_SHA }] },
      }),
    },
  });

  assertNotMerged(pushed.calls);
  assert.match(skipLines(pushed.logs)[0], /deadbeef/);
});

test('does not update the branch when the base is listed in skip-update-branch-bases', async () => {
  const { logs, calls } = await runGate({
    env: { SKIP_UPDATE_BRANCH_BASES: 'staging, release' },
    eventPull: openPull({ base: { ref: 'staging' } }),
    github: {
      get: () => openPull({ base: { ref: 'staging' } }),
    },
  });

  assert.equal(calls.updateBranch.length, 0);
  assert.equal(calls.merge.length, 1);
  assert.ok(logs.some((line) => line.includes('Not updating the PR branch from "staging"')));
});

test('uses the event head SHA when REVIEWED_SHA is not set', async () => {
  const { calls } = await runGate({
    env: { REVIEWED_SHA: null },
  });

  assert.equal(calls.merge.length, 1);
  assert.equal(calls.merge[0].sha, REVIEWED_SHA);
});

test('review workflow wires the live gate, draft skip, and blocking-labels input', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../../../.github/workflows/review.yml'),
    'utf8'
  );
  const gateStart = workflow.indexOf('  auto-merge-gate:');
  assert.ok(gateStart !== -1);
  const gate = workflow.slice(gateStart);

  assert.match(workflow, /blocking-labels:/);
  assert.match(workflow, /default: 'do not merge,do-not-merge,wip'/);
  assert.match(gate, /github\.event\.pull_request\.draft != true/);
  assert.match(gate, /job\.workflow_sha/);
  assert.match(gate, /runAutoMergeGate/);
  assert.match(gate, /REVIEWED_SHA:/);
  assert.match(gate, /BLOCKING_LABELS:/);
  assert.doesNotMatch(gate, /deleteRef|delete-branch|git push origin --delete/);
});

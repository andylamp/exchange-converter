import { appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const publisher = fileURLToPath(new URL('./publish-commit.mjs', import.meta.url));
const context = 'Check and test';
const workflow = 'ci.yml';
let pullRequestUrl;
let automationBranch;

function command(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    timeout: 60_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${program} exited with status ${result.status}`);
  }
  return result.stdout;
}

function api(endpoint, method = 'GET', body) {
  const args = ['api', endpoint, '--method', method];
  if (body !== undefined) args.push('--input', '-');
  const result = command('gh', args, {
    input: body === undefined ? undefined : JSON.stringify(body),
  });
  return result.trim() ? JSON.parse(result) : null;
}

function positiveLimit(name, fallback, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function requireOid(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{40}$/.test(value)) {
    throw new Error('GitHub returned an invalid commit SHA');
  }
  return value;
}

function verifiedCommit(repository, sha) {
  const commit = api(`repos/${repository}/commits/${sha}`);
  if (commit?.sha !== sha || commit.commit?.verification?.verified !== true) {
    throw new Error(`Commit ${sha} is not verified by GitHub`);
  }
  return commit;
}

function outputCommit(sha) {
  appendFileSync(process.env.GITHUB_OUTPUT, `commit_oid=${requireOid(sha)}\n`);
  console.log(`Verified deployment commit: ${sha}`);
}

function publishArgs(repository, baseSha, branch) {
  return [
    publisher,
    '--repo',
    repository,
    '--branch',
    branch,
    '--expected-head',
    baseSha,
    '--data-only',
    '--message',
    'chore(data): refresh exchange rates',
  ];
}

function workflowRuns(repository, branch) {
  const query = new URLSearchParams({
    branch,
    event: 'workflow_dispatch',
    per_page: '100',
  });
  const response = api(`repos/${repository}/actions/workflows/${workflow}/runs?${query}`);
  if (!Array.isArray(response?.workflow_runs)) throw new Error('Invalid CI workflow response');
  return response.workflow_runs;
}

async function waitForCi(repository, branch, headSha, priorIds, dispatchedAt, timeout, interval) {
  const deadline = Date.now() + timeout;
  let previousStatus = '';
  while (Date.now() < deadline) {
    const matches = workflowRuns(repository, branch)
      .filter(
        (run) =>
          !priorIds.has(run.id) &&
          run.event === 'workflow_dispatch' &&
          run.path === `.github/workflows/${workflow}` &&
          run.head_branch === branch &&
          run.head_sha === headSha &&
          Date.parse(run.created_at) >= dispatchedAt,
      )
      .sort((a, b) => b.id - a.id);
    const run = matches[0];
    const status = run ? `${run.id}: ${run.status}` : 'awaiting the dispatched run';
    if (status !== previousStatus) {
      console.log(`CI for ${headSha}: ${status}`);
      previousStatus = status;
    }
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') {
        throw new Error(`CI run ${run.html_url} concluded ${run.conclusion}`);
      }
      if (!Number.isInteger(run.id) || !Number.isInteger(run.run_attempt)) {
        throw new Error('CI returned an invalid run or attempt identifier');
      }
      const jobs = api(
        `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      ).jobs;
      const checks = Array.isArray(jobs) ? jobs.filter((job) => job.name === context) : [];
      if (
        checks.length !== 1 ||
        checks[0].status !== 'completed' ||
        checks[0].conclusion !== 'success' ||
        checks[0].head_sha !== headSha ||
        checks[0].run_id !== run.id
      ) {
        throw new Error(`CI must complete ${context} successfully for exactly ${headSha}`);
      }
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for successful CI on ${headSha}`);
}

function requireUnchangedPull(repository, number, branch, headSha, baseSha) {
  const reviewed = api(`repos/${repository}/pulls/${number}`);
  if (
    reviewed.state !== 'open' ||
    reviewed.draft ||
    reviewed.head?.sha !== headSha ||
    reviewed.head?.ref !== branch ||
    reviewed.head?.repo?.full_name !== repository ||
    reviewed.base?.ref !== 'main' ||
    reviewed.base?.sha !== baseSha ||
    reviewed.base?.repo?.full_name !== repository ||
    api(`repos/${repository}/git/ref/heads/main`).object?.sha !== baseSha
  ) {
    throw new Error('The pull request or main changed after validation; refusing to merge');
  }
}

async function mergeCheckedPull(repository, number, branch, headSha, baseSha, timeout, interval) {
  const deadline = Date.now() + timeout;
  while (true) {
    requireUnchangedPull(repository, number, branch, headSha, baseSha);
    try {
      const merge = api(`repos/${repository}/pulls/${number}/merge`, 'PUT', {
        sha: headSha,
        merge_method: 'squash',
        commit_title: `chore(data): refresh exchange rates (#${number})`,
      });
      if (merge?.merged !== true) {
        throw new Error(merge?.message || 'GitHub refused the protected merge');
      }
      return requireOid(merge.sha);
    } catch (error) {
      // Required-status evaluation is eventually consistent. Retry only the
      // documented merge-not-ready responses, retaining every SHA/ruleset guard.
      if (!/\(HTTP (405|409)\)/.test(error.message) || Date.now() >= deadline) throw error;
      console.log('Waiting for GitHub to evaluate the protected merge.');
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, 2000)));
    }
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must identify the destination repository explicitly');
  }
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)
  ) {
    throw new Error('Rate-update automation must run from main on schedule or manual dispatch');
  }
  if (
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') ||
    !process.env.GITHUB_OUTPUT
  ) {
    throw new Error('GitHub run identity and output file are required');
  }
  const timeout = positiveLimit('RATE_UPDATE_TIMEOUT_MS', 15 * 60_000, 15 * 60_000);
  const interval = positiveLimit('RATE_UPDATE_POLL_MS', 10_000, 60_000);
  const verificationTimeout = positiveLimit('RATE_UPDATE_VERIFICATION_MS', 30_000, 30_000);
  const mergeTimeout = positiveLimit('RATE_UPDATE_MERGE_TIMEOUT_MS', 30_000, 30_000);
  const baseSha = requireOid(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  );
  automationBranch = `automation/rates-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const args = publishArgs(repository, baseSha, automationBranch);
  // The existing publisher checks every changed/untracked file before any API mutation.
  const preview = JSON.parse(command(process.execPath, [...args, '--dry-run']));
  const current = api(`repos/${repository}/git/ref/heads/main`).object?.sha;
  if (current !== baseSha)
    throw new Error('Main changed after checkout; refusing an untested base');
  verifiedCommit(repository, baseSha);
  if (preview.additions.length + preview.deletions.length === 0) {
    console.log('Default rates are unchanged; no pull request is needed.');
    outputCommit(baseSha);
    return;
  }

  api(`repos/${repository}/git/refs`, 'POST', {
    ref: `refs/heads/${automationBranch}`,
    sha: baseSha,
  });
  // Never expose the pre-merge branch commit through the delivery step's outputs.
  const publishEnvironment = { ...process.env };
  delete publishEnvironment.GITHUB_OUTPUT;
  const publication = command(process.execPath, args, { env: publishEnvironment });
  const headSha = requireOid(publication.match(/^Verified commit: ([a-f\d]{40})$/m)?.[1]);
  if (headSha === baseSha) throw new Error('Changed data did not create a new commit');
  verifiedCommit(repository, headSha);
  const pull = api(`repos/${repository}/pulls`, 'POST', {
    title: 'chore(data): refresh exchange rates',
    head: automationBranch,
    base: 'main',
    body: 'Refresh the default exchange rates and rolling historical observations.\n\nThe complete dataset passed validation before this signed commit was created. The automated CI run must pass on this exact revision before the pull request can be merged.',
  });
  if (!Number.isInteger(pull?.number))
    throw new Error('GitHub did not return a pull request number');
  pullRequestUrl = pull.html_url;
  console.log(`Created rate-update pull request: ${pullRequestUrl}`);

  const priorIds = new Set(workflowRuns(repository, automationBranch).map((run) => run.id));
  // GitHub timestamps have second precision. Existing run IDs are separately excluded.
  const dispatchedAt = Math.floor(Date.now() / 1000) * 1000;
  api(`repos/${repository}/actions/workflows/${workflow}/dispatches`, 'POST', {
    ref: automationBranch,
  });
  const run = await waitForCi(
    repository,
    automationBranch,
    headSha,
    priorIds,
    dispatchedAt,
    timeout,
    interval,
  );

  requireUnchangedPull(repository, pull.number, automationBranch, headSha, baseSha);
  verifiedCommit(repository, headSha);
  // Dispatched workflow jobs are not eligible required PR checks. Report the
  // successful, exact-revision CI as a commit status without bypassing rulesets.
  api(`repos/${repository}/statuses/${headSha}`, 'POST', {
    state: 'success',
    context,
    target_url: run.html_url,
    description: 'Verified CI for automated rate update',
  });
  const mergeSha = await mergeCheckedPull(
    repository,
    pull.number,
    automationBranch,
    headSha,
    baseSha,
    mergeTimeout,
    interval,
  );
  const verificationDeadline = Date.now() + verificationTimeout;
  let mergedCommit;
  do {
    try {
      mergedCommit = verifiedCommit(repository, mergeSha);
      break;
    } catch {
      if (Date.now() >= verificationDeadline) {
        throw new Error(`Merged commit ${mergeSha} is not verified; deployment has been stopped`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(interval, 2000)));
    }
  } while (Date.now() <= verificationDeadline);
  if (mergedCommit?.parents?.length !== 1 || mergedCommit.parents[0].sha !== baseSha) {
    throw new Error(
      'The squash merge does not have the validated main revision as its only parent',
    );
  }
  try {
    api(`repos/${repository}/git/refs/heads/${automationBranch}`, 'DELETE');
  } catch {
    console.log('The merged automation branch was already deleted or could not be cleaned up.');
  }
  outputCommit(mergeSha);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (pullRequestUrl) {
    console.error(
      `Inspect ${pullRequestUrl} for recovery. No rebase or ruleset bypass was attempted.`,
    );
  } else if (automationBranch) {
    console.error(
      `If it was created, branch ${automationBranch} remains available for inspection.`,
    );
  }
  process.exitCode = 1;
});

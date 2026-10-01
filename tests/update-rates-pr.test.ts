import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/update-rates-pr.mjs', import.meta.url));
const repositoryName = 'owner/example';
const branch = 'automation/rates-123-1';
const headSha = '2'.repeat(40);
const mergeSha = '4'.repeat(40);
let root: string;
let repository: string;
let bin: string;
let output: string;
let log: string;
let baseSha: string;
let environment: NodeJS.ProcessEnv;

interface ApiCall {
  endpoint: string;
  method: string;
  body?: Record<string, unknown>;
}

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repository, env: environment, encoding: 'utf8' }).trim();
}

function calls(): ApiCall[] {
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ApiCall);
}

function run(mode = 'valid', override: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: repository,
    env: { ...environment, MOCK_MODE: mode, ...override },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function modifyData() {
  writeFileSync(join(repository, 'public/data/latest.json'), '{"rate":2}\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'exchange-rate-pr-test-'));
  repository = join(root, 'repository');
  bin = join(root, 'bin');
  output = join(root, 'output');
  log = join(root, 'api.jsonl');
  environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Rate update test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Rate update test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: repositoryName,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: output,
    RATE_UPDATE_TIMEOUT_MS: '150',
    RATE_UPDATE_POLL_MS: '5',
    RATE_UPDATE_VERIFICATION_MS: '30',
    RATE_UPDATE_MERGE_TIMEOUT_MS: '100',
    MOCK_LOG: log,
    MOCK_STATE: join(root, 'mock-state.json'),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  };
  mkdirSync(join(repository, 'public/data'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(output, '');
  writeFileSync(log, '');
  writeFileSync(environment.MOCK_STATE!, '{}');
  writeFileSync(join(repository, 'README.md'), 'Test repository\n');
  writeFileSync(join(repository, 'public/data/latest.json'), '{"rate":1}\n');
  git('init', '-q', '-b', 'main', '--template=');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  baseSha = git('rev-parse', 'HEAD');
  environment.MOCK_BASE = baseSha;

  const shim = join(bin, 'gh');
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args[1];
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'POST';
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ endpoint, method, body }) + '\\n');
const state = JSON.parse(fs.readFileSync(process.env.MOCK_STATE, 'utf8'));
const mode = process.env.MOCK_MODE;
const base = process.env.MOCK_BASE;
const head = '${headSha}';
const merged = '${mergeSha}';
const branch = '${branch}';
const prefix = 'repos/${repositoryName}';
const foreign = '${'3'.repeat(40)}';
function finish(value) {
  fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
  if (value !== undefined) console.log(JSON.stringify(value));
  process.exit(0);
}
if (endpoint === 'graphql') {
  if (!state.branchCreated) throw new Error('Publish ran before branch creation');
  const mutation = body.query.includes('mutation');
  if (mutation) state.published = true;
  const commit = { oid: mutation ? head : base, signature: { isValid: true, state: 'VALID', wasSignedByGitHub: true } };
  finish({ data: mutation ? { createCommitOnBranch: { commit } } : { repository: { ref: { target: commit } } } });
}
if (endpoint === prefix + '/git/ref/heads/main') {
  const changed = mode === 'changed-main' && state.dispatched || mode === 'changed-main-on-retry' && state.mergeAttempts;
  finish({ object: { sha: changed ? foreign : base } });
}
if (endpoint.startsWith(prefix + '/commits/')) {
  const sha = endpoint.split('/').at(-1);
  const verified = !(sha === base && mode === 'unverified-base') && !(sha === head && mode === 'unverified-head') && !(sha === merged && mode === 'unverified-merge');
  finish({ sha, commit: { verification: { verified } }, parents: [{ sha: base }] });
}
if (endpoint === prefix + '/git/refs' && method === 'POST') {
  state.branchCreated = true;
  finish({ ref: body.ref, object: { sha: base } });
}
if (endpoint === prefix + '/pulls' && method === 'POST') {
  if (!state.published) throw new Error('PR opened before signed publication');
  state.prCreated = true;
  finish({ number: 7, html_url: 'https://github.com/${repositoryName}/pull/7' });
}
if (endpoint === prefix + '/actions/workflows/ci.yml/dispatches') {
  state.dispatched = new Date().toISOString();
  finish();
}
if (endpoint.startsWith(prefix + '/actions/workflows/ci.yml/runs?')) {
  const prior = { id: 10, run_attempt: 1, event: 'workflow_dispatch', path: '.github/workflows/ci.yml', head_branch: branch, head_sha: head, created_at: new Date().toISOString(), status: 'completed', conclusion: 'success', html_url: 'https://github.com/${repositoryName}/actions/runs/10' };
  if (!state.dispatched) finish({ workflow_runs: [prior] });
  const current = { ...prior, id: 11, html_url: 'https://github.com/${repositoryName}/actions/runs/11', created_at: state.dispatched };
  if (mode === 'wrong-run-head') current.head_sha = foreign;
  if (mode === 'wrong-run-event') current.event = 'push';
  if (mode === 'wrong-run-path') current.path = '.github/workflows/unrelated.yml';
  if (mode === 'wrong-run-branch') current.head_branch = 'unrelated';
  if (mode === 'old-run') current.created_at = '2000-01-01T00:00:00Z';
  if (mode === 'failed-run') current.conclusion = 'failure';
  finish({ workflow_runs: [prior, current] });
}
if (endpoint === prefix + '/actions/runs/11/attempts/1/jobs?per_page=100') {
  const job = { name: 'Check and test', run_id: 11, head_sha: head, status: 'completed', conclusion: 'success' };
  if (mode === 'wrong-job-name') job.name = 'Other validation';
  if (mode === 'wrong-job-head') job.head_sha = foreign;
  if (mode === 'wrong-job-run') job.run_id = 12;
  if (mode === 'failed-job') job.conclusion = 'failure';
  state.jobsRead = true;
  finish({ jobs: [job] });
}
if (endpoint === prefix + '/pulls/7') {
  finish({ state: 'open', draft: false, head: { sha: mode === 'changed-head' ? foreign : head, ref: branch, repo: { full_name: '${repositoryName}' } }, base: { sha: base, ref: 'main', repo: { full_name: '${repositoryName}' } } });
}
if (endpoint === prefix + '/statuses/' + head) {
  if (!state.jobsRead) throw new Error('Status posted without inspecting the CI job');
  state.statusPosted = true;
  finish({ state: body.state });
}
if (endpoint === prefix + '/pulls/7/merge') {
  if (!state.statusPosted) throw new Error('Merge requested before reporting CI status');
  state.mergeAttempts = (state.mergeAttempts || 0) + 1;
  fs.writeFileSync(process.env.MOCK_STATE, JSON.stringify(state));
  if (mode === 'blocked-merge' || ['transient-merge', 'changed-main-on-retry'].includes(mode) && state.mergeAttempts === 1) { console.error('gh: Protected branch policy rejected merge (HTTP 405)'); process.exit(1); }
  state.merged = true;
  finish({ merged: true, sha: merged });
}
if (endpoint === prefix + '/git/refs/heads/' + branch && method === 'DELETE') {
  if (mode === 'already-deleted') { console.error('gh: Reference not found (HTTP 404)'); process.exit(1); }
  finish();
}
throw new Error('Unexpected API request: ' + method + ' ' + endpoint);
`,
  );
  chmodSync(shim, 0o755);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('protected rate-update automation', () => {
  it('returns the verified main revision without a PR when data is unchanged', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toHaveLength(2);
    expect(calls().every((call) => call.method === 'GET')).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe(`commit_oid=${baseSha}\n`);
  });

  it('rejects a non-main trigger before making any API request', () => {
    modifyData();
    const result = run('valid', { GITHUB_REF: 'refs/heads/untrusted' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must run from main');
    expect(calls()).toEqual([]);
  });

  it('rejects changes outside the data directory before creating a branch', () => {
    modifyData();
    writeFileSync(join(repository, 'README.md'), 'unexpected change');
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('outside public/data');
    expect(calls()).toEqual([]);
  });

  it('requires a verified base before creating any branch or PR', () => {
    modifyData();
    const result = run('unverified-base');
    expect(result.status).not.toBe(0);
    expect(calls().some((call) => call.method !== 'GET')).toBe(false);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('validates an exact new CI run and job before reporting status and requesting a guarded squash merge', () => {
    modifyData();
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const requests = calls();
    expect(requests.find((call) => call.endpoint.endsWith('/git/refs'))?.body).toEqual({
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
    expect(requests.find((call) => call.endpoint.endsWith('/dispatches'))?.body).toEqual({
      ref: branch,
    });
    expect(requests.find((call) => call.endpoint.endsWith(`/statuses/${headSha}`))?.body).toEqual({
      state: 'success',
      context: 'Check and test',
      target_url: 'https://github.com/owner/example/actions/runs/11',
      description: 'Verified CI for automated rate update',
    });
    expect(requests.find((call) => call.endpoint.endsWith('/merge'))).toMatchObject({
      method: 'PUT',
      body: { sha: headSha, merge_method: 'squash' },
    });
    expect(requests.at(-1)).toMatchObject({
      endpoint: `repos/${repositoryName}/git/refs/heads/${branch}`,
      method: 'DELETE',
    });
    expect(readFileSync(output, 'utf8')).toBe(`commit_oid=${mergeSha}\n`);
    expect(git('rev-parse', 'HEAD')).toBe(baseSha);
  });

  it.each([
    'wrong-run-head',
    'wrong-run-event',
    'wrong-run-path',
    'wrong-run-branch',
    'old-run',
    'failed-run',
    'wrong-job-name',
    'wrong-job-head',
    'wrong-job-run',
    'failed-job',
    'changed-main',
    'changed-head',
  ])('cannot report a passing status or merge when validation has %s', (mode) => {
    modifyData();
    const result = run(mode);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('https://github.com/owner/example/pull/7');
    expect(calls().some((call) => call.endpoint.includes('/statuses/'))).toBe(false);
    expect(calls().some((call) => call.endpoint.endsWith('/merge'))).toBe(false);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('leaves a blocked PR available instead of bypassing protection or emitting a deployable SHA', () => {
    modifyData();
    const result = run('blocked-merge');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Protected branch policy rejected merge');
    expect(result.stderr).toContain('No rebase or ruleset bypass');
    expect(calls().filter((call) => call.endpoint.endsWith('/merge')).length).toBeGreaterThan(0);
    expect(calls().some((call) => call.method === 'DELETE')).toBe(false);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('rechecks both heads before retrying a transient mergeability-cache failure', () => {
    modifyData();
    const result = run('transient-merge', { RATE_UPDATE_MERGE_TIMEOUT_MS: '1000' });
    expect(result.status, result.stderr).toBe(0);
    const requests = calls();
    const merges = requests
      .map((call, index) => (call.endpoint.endsWith('/merge') ? index : -1))
      .filter((index) => index >= 0);
    expect(merges).toHaveLength(2);
    expect(requests.slice(merges[0] + 1, merges[1]).map((call) => call.endpoint)).toEqual([
      'repos/owner/example/pulls/7',
      'repos/owner/example/git/ref/heads/main',
    ]);
    expect(readFileSync(output, 'utf8')).toBe(`commit_oid=${mergeSha}\n`);
  });

  it('stops a merge retry when main moved instead of merging against an untested base', () => {
    modifyData();
    const result = run('changed-main-on-retry', { RATE_UPDATE_MERGE_TIMEOUT_MS: '1000' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('main changed after validation');
    expect(calls().filter((call) => call.endpoint.endsWith('/merge'))).toHaveLength(1);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('does not deploy a merged commit whose signature cannot be verified', () => {
    modifyData();
    const result = run('unverified-merge');
    expect(result.status).not.toBe(0);
    expect(calls().some((call) => call.endpoint.endsWith('/merge'))).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('accepts an already deleted source branch after a verified merge', () => {
    modifyData();
    const result = run('already-deleted');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(`commit_oid=${mergeSha}\n`);
  });
});

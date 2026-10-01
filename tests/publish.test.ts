import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const publisher = fileURLToPath(new URL('../scripts/publish-commit.mjs', import.meta.url));
const publishedOid = '2222222222222222222222222222222222222222';
let root: string;
let repository: string;
let bin: string;
let head: string;
let requestLog: string;
let output: string;
let environment: NodeJS.ProcessEnv;

interface ApiRequest {
  query: string;
  variables: {
    input?: {
      branch: { repositoryNameWithOwner: string; branchName: string };
      expectedHeadOid: string;
      fileChanges: {
        additions: { path: string; contents: string }[];
        deletions: { path: string }[];
      };
    };
  };
}

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    env: environment,
    encoding: 'utf8',
  }).trim();
}

function changedData(): void {
  writeFileSync(join(repository, 'public/data/latest.json'), '{"rate":2}\n');
  writeFileSync(join(repository, 'public/data/history/NEW.json'), '{"rate":3}\n');
  unlinkSync(join(repository, 'public/data/history/OLD.json'));
}

function run(args: string[] = [], mode = 'valid') {
  return spawnSync(
    process.execPath,
    [publisher, '--repo', 'owner/example', '--message', 'test: signed publication', ...args],
    {
      cwd: repository,
      env: {
        ...environment,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        MOCK_HEAD: head,
        MOCK_MODE: mode,
        MOCK_LOG: requestLog,
        GITHUB_OUTPUT: output,
      },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

function requests(): ApiRequest[] {
  return readFileSync(requestLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ApiRequest);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'exchange-publish-test-'));
  repository = join(root, 'repository');
  bin = join(root, 'bin');
  requestLog = join(root, 'requests.jsonl');
  output = join(root, 'github-output');
  environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Publisher test',
    GIT_AUTHOR_EMAIL: 'test@example.test',
    GIT_COMMITTER_NAME: 'Publisher test',
    GIT_COMMITTER_EMAIL: 'test@example.test',
  };
  mkdirSync(join(repository, 'public/data/history'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(requestLog, '');
  writeFileSync(output, '');
  writeFileSync(join(repository, '.gitignore'), '.env\nnode_modules/\n');
  writeFileSync(join(repository, 'README.md'), 'Test repository\n');
  writeFileSync(join(repository, 'public/data/latest.json'), '{"rate":1}\n');
  writeFileSync(join(repository, 'public/data/history/OLD.json'), '{"rate":1}\n');
  git('init', '-q', '-b', 'main', '--template=');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base');
  head = git('rev-parse', 'HEAD');

  // The only gh executable available to the child is this deterministic shim.
  // No GitHub credentials, repository, network calls, or signing keys are used.
  const shim = join(bin, 'gh');
  writeFileSync(
    shim,
    `#!/usr/bin/env node
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(request) + '\\n');
const mutation = request.query.includes('mutation');
const mode = process.env.MOCK_MODE;
if (mutation && mode === 'mutation-conflict') {
  console.log(JSON.stringify({ errors: [{ message: 'Expected branch head changed' }] }));
  process.exit(0);
}
const valid = mode !== 'invalid-signature';
const commit = {
  oid: mutation ? '${publishedOid}' : mode === 'head-mismatch' ? '${'3'.repeat(40)}' : process.env.MOCK_HEAD,
  signature: mode === 'missing-signature' ? null : {
    isValid: valid, state: valid ? 'VALID' : 'INVALID', wasSignedByGitHub: mode !== 'wrong-signer'
  }
};
const data = mutation ? { createCommitOnBranch: { commit } } : { repository: { ref: { target: commit } } };
console.log(JSON.stringify({ data }));
`,
  );
  chmodSync(shim, 0o755);
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('verified commit publisher', () => {
  it('previews tracked changes and untracked additions without contacting GitHub', () => {
    changedData();
    writeFileSync(join(repository, '.env'), 'never-upload-this\n');
    mkdirSync(join(repository, 'node_modules'));
    writeFileSync(join(repository, 'node_modules/dependency.js'), 'ignored\n');
    const result = run(['--data-only', '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    const preview = JSON.parse(result.stdout);
    expect(preview.expectedHead).toBe(head);
    expect(preview.additions).toEqual(['public/data/history/NEW.json', 'public/data/latest.json']);
    expect(preview.deletions).toEqual(['public/data/history/OLD.json']);
    expect(requests()).toEqual([]);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('refuses unrelated untracked files in data-only mode before API access', () => {
    changedData();
    writeFileSync(join(repository, 'stray.txt'), 'unexpected\n');
    const result = run(['--data-only']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('outside public/data');
    expect(requests()).toEqual([]);
  });

  it('refuses a mismatched expected local revision before API access', () => {
    changedData();
    const result = run(['--expected-head', '0'.repeat(40)]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Local HEAD must equal');
    expect(requests()).toEqual([]);
  });

  it('publishes additions and deletions atomically with the checked head and emits only the verified SHA', () => {
    changedData();
    const result = run(['--data-only']);
    expect(result.status, result.stderr).toBe(0);
    const calls = requests();
    expect(calls).toHaveLength(2);
    const input = calls[1].variables.input!;
    expect(input.branch).toEqual({ repositoryNameWithOwner: 'owner/example', branchName: 'main' });
    expect(input.expectedHeadOid).toBe(head);
    expect(input.fileChanges.additions).toEqual([
      {
        path: 'public/data/history/NEW.json',
        contents: Buffer.from('{"rate":3}\n').toString('base64'),
      },
      { path: 'public/data/latest.json', contents: Buffer.from('{"rate":2}\n').toString('base64') },
    ]);
    expect(input.fileChanges.deletions).toEqual([{ path: 'public/data/history/OLD.json' }]);
    expect(input).not.toHaveProperty('author');
    expect(input).not.toHaveProperty('committer');
    expect(readFileSync(output, 'utf8')).toBe(`commit_oid=${publishedOid}\n`);
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('returns the existing verified revision without creating an empty commit', () => {
    const result = run(['--data-only']);
    expect(result.status, result.stderr).toBe(0);
    expect(requests()).toHaveLength(1);
    expect(readFileSync(output, 'utf8')).toBe(`commit_oid=${head}\n`);
  });

  it('rejects a remote branch that changed before the initial read', () => {
    changedData();
    const result = run(['--data-only'], 'head-mismatch');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('changed since checkout');
    expect(requests()).toHaveLength(1);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('does not retry or emit a deployment SHA if the branch changes between read and mutation', () => {
    changedData();
    const result = run(['--data-only'], 'mutation-conflict');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected branch head changed');
    expect(requests()).toHaveLength(2);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it.each(['invalid-signature', 'missing-signature', 'wrong-signer'])(
    'does not emit a deployment SHA when the created commit has %s',
    (mode) => {
      changedData();
      const result = run(['--data-only'], mode);
      expect(result.status).not.toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('');
    },
  );

  it('cannot bypass verification through an unchanged dataset', () => {
    const result = run(['--data-only'], 'missing-signature');
    expect(result.status).not.toBe(0);
    expect(requests()).toHaveLength(1);
    expect(readFileSync(output, 'utf8')).toBe('');
  });

  it('refuses symlinks instead of silently publishing their targets', () => {
    symlinkSync('README.md', join(repository, 'link.md'));
    const result = run(['--dry-run']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Only regular files');
    expect(requests()).toEqual([]);
  });
});

import { appendFileSync, lstatSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

// GitHub signs createCommitOnBranch commits with its own key. No signing key
// material is copied into this repository or its Actions secrets.
const options = {
  dataOnly: false,
  dryRun: false,
  expectedHead: undefined,
  message: undefined,
  repo: process.env.GITHUB_REPOSITORY || 'andylamp/exchange-converter',
};

function usage() {
  console.log(
    'Usage: node scripts/publish-commit.mjs --message TEXT [--data-only] [--dry-run] [--expected-head SHA] [--repo OWNER/REPO]',
  );
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function graphql(query, variables) {
  const result = spawnSync('gh', ['api', 'graphql', '--input', '-'], {
    input: JSON.stringify({ query, variables }),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'GitHub API request failed');
  }
  const response = JSON.parse(result.stdout);
  if (response.errors?.length) {
    throw new Error(response.errors.map(({ message }) => message).join('; '));
  }
  return response.data;
}

function requireVerified(commit) {
  if (!commit?.signature?.isValid || commit.signature.state !== 'VALID') {
    throw new Error(`Commit ${commit?.oid ?? '(unknown)'} is not verified by GitHub`);
  }
}

function outputCommit(oid) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `commit_oid=${oid}\n`);
  }
  console.log(`Verified commit: ${oid}`);
}

function main() {
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift();
    if (option === '--help') {
      usage();
      return;
    }
    if (option === '--data-only') options.dataOnly = true;
    else if (option === '--dry-run') options.dryRun = true;
    else {
      const key = {
        '--expected-head': 'expectedHead',
        '--message': 'message',
        '--repo': 'repo',
      }[option];
      if (!key || !args.length || args[0].startsWith('--')) {
        throw new Error(`Unknown or incomplete option: ${option}`);
      }
      options[key] = args.shift();
    }
  }
  if (!options.message?.trim()) throw new Error('--message is required');
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
    throw new Error('--repo must be OWNER/REPO');
  }

  process.chdir(git('rev-parse', '--show-toplevel').trim());
  const localHead = git('rev-parse', 'HEAD').trim();
  const expectedHead = options.expectedHead ?? localHead;
  if (!/^[a-f\d]{40}$/i.test(expectedHead) || localHead !== expectedHead) {
    throw new Error('Local HEAD must equal the expected GitHub branch revision');
  }
  const splitPaths = (value) => value.split('\0').filter(Boolean);
  const additions = [
    ...new Set([
      ...splitPaths(
        git('diff', '--no-renames', '--name-only', '--diff-filter=ACMRT', '-z', 'HEAD', '--'),
      ),
      ...splitPaths(git('ls-files', '--others', '--exclude-standard', '-z')),
    ]),
  ].sort();
  const deletions = splitPaths(
    git('diff', '--no-renames', '--name-only', '--diff-filter=D', '-z', 'HEAD', '--'),
  ).sort();
  const changedPaths = [...additions, ...deletions];
  if (options.dataOnly && changedPaths.some((path) => !/^public\/data\/.+\.json$/.test(path))) {
    throw new Error('Data-only publication refuses changes outside public/data/*.json');
  }
  const fileChanges = {
    additions: additions.map((path) => {
      if (!lstatSync(path).isFile()) {
        throw new Error(`Only regular files may be published: ${path}`);
      }
      return { path, contents: readFileSync(path).toString('base64') };
    }),
    deletions: deletions.map((path) => ({ path })),
  };

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          repository: options.repo,
          branch: 'main',
          expectedHead,
          message: options.message,
          additions,
          deletions,
        },
        null,
        2,
      ),
    );
    return;
  }

  const [owner, name] = options.repo.split('/');
  const current = graphql(
    `
      query ($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          ref(qualifiedName: "refs/heads/main") {
            target {
              ... on Commit {
                oid
                signature {
                  isValid
                  state
                  wasSignedByGitHub
                }
              }
            }
          }
        }
      }
    `,
    { owner, name },
  ).repository?.ref?.target;
  if (current?.oid !== expectedHead) {
    throw new Error('GitHub main changed since checkout; fetch, revalidate, and retry');
  }
  if (changedPaths.length === 0) {
    requireVerified(current);
    console.log('No file changes to publish.');
    outputCommit(current.oid);
    return;
  }

  const commit = graphql(
    `
      mutation ($input: CreateCommitOnBranchInput!) {
        createCommitOnBranch(input: $input) {
          commit {
            oid
            signature {
              isValid
              state
              wasSignedByGitHub
            }
          }
        }
      }
    `,
    {
      input: {
        branch: { repositoryNameWithOwner: options.repo, branchName: 'main' },
        expectedHeadOid: expectedHead,
        message: { headline: options.message },
        fileChanges,
      },
    },
  ).createCommitOnBranch.commit;
  requireVerified(commit);
  if (!commit.signature.wasSignedByGitHub) {
    throw new Error(`Commit ${commit.oid} was not signed with GitHub's key`);
  }
  outputCommit(commit.oid);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

# Contributing

Use Node.js 24 and npm. Fork the repository, create a branch, and install locked dependencies with `npm ci`. Start the app with `npm run dev` and open the printed URL under `/exchange-converter/`.

Before opening a pull request, run:

```sh
npm run verify
npx playwright install chromium firefox webkit
npm run test:e2e
```

`npm run verify` checks formatting, lint, types, unit tests, bundled data, the production build, and the 75 KiB gzip budget for all app JavaScript and CSS. Use `npm run format` to apply formatting. Generated `public/data` JSON is deliberately excluded from automatic formatting so updates remain deterministic.

Keep changes focused. Add behavior tests when changing conversion math, rate precedence, cookie persistence, data validation, or network-failure handling. Browser tests use deterministic provider responses; avoid making a test depend on today's exchange rates. Check keyboard access and small screens when changing UI.

Use decimal arithmetic for money and exchange rates. Never recalculate from a rounded displayed amount unless the user explicitly edits that box. Provider dates describe observations; download timestamps do not make an older observation newer. Keep custom rates separate from provider history.

## Signed commits and pull requests

The `main` branch policy requires verified signed commits, pull requests, resolved review conversations, and a passing **Check and test** check with the branch up to date. Merge with squash to keep a linear history. Force pushes and deletion of `main` are prohibited. A second reviewer's approval is not mandatory, but maintainers still use pull requests and pass the required checks.

Sign local commits with an SSH, GPG, or S/MIME key registered with GitHub. `gh auth login` authenticates GitHub requests; it does not sign `git commit`. See [GitHub's signing documentation](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits). Keep private signing keys on your machine; do not upload them to repository files or Actions secrets.

For the usual local-commit route, create a feature branch from the current `main`, make and stage the intended changes, and run the checks above. Then publish the signed commit and open a pull request:

```sh
git commit -S -m 'Describe the change'
git push -u origin my-change
gh pr create --base main --head my-change
```

Replace `my-change` with your feature branch. For fork contributions, push to your fork and open the pull request against this repository's `main`.

Maintainers without a local signing key can use GitHub's signed commit API instead. Start from a clean checkout, create the remote feature branch at the current verified `main` revision, then make changes locally:

```sh
git fetch origin
git switch -c my-change origin/main
git push -u origin my-change
```

After running checks, inspect what the publishing script will include before publishing:

```sh
node scripts/publish-commit.mjs --branch my-change --dry-run --message 'Describe the change'
node scripts/publish-commit.mjs --branch my-change --message 'Describe the change'
gh pr create --base main --head my-change
```

The script requires an authenticated `gh` credential with repository write access, plus workflow permission when changing workflow files. It appends changes and untracked nonignored files to an **existing** remote branch without creating a local commit, verifies GitHub's signature, and refuses a branch whose head differs from the expected local revision. Fetch the returned commit and reconcile your checkout before making further changes. Always pass the feature branch explicitly: the default `main` target does not bypass the required pull request. `--data-only` restricts publication to JSON files under `public/data/`.

Dependabot submits one weekly pull request for npm and GitHub Actions version updates together. Automatic security-update pull requests remain separate because GitHub does not include them in multi-ecosystem version groups. Keep grouped dependency updates passing the same checks before merging.

Do not include credentials, personal cookie contents, build output, or `node_modules`. Follow the [security policy](SECURITY.md) for vulnerabilities. By contributing, you agree that your contributions are licensed under the repository's MIT license.

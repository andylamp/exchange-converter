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

The live `main` branch must contain verified commits. Sign local commits with an SSH, GPG, or S/MIME key registered with GitHub, or use GitHub's signed commit API. `gh auth login` authenticates GitHub requests but does not sign `git commit`. See [GitHub's signing documentation](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits). The maintainer publishing script in `scripts/publish-commit.mjs` appends GitHub-signed commits directly to `main`; it is not the pull-request submission workflow.

Do not include credentials, personal cookie contents, build output, or `node_modules`. Follow the [security policy](SECURITY.md) for vulnerabilities. By contributing, you agree that your contributions are licensed under the repository's MIT license.

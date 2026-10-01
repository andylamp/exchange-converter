# Exchange Converter

[![Delivery](https://github.com/andylamp/exchange-converter/actions/workflows/delivery.yml/badge.svg)](https://github.com/andylamp/exchange-converter/actions/workflows/delivery.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A lightweight, responsive currency converter that runs entirely on GitHub Pages. Edit any amount and every selected currency updates immediately. Browser cookies remember your choices, rates, and custom overrides. There is no application server, account system, or database.

**[Open the app](https://andylamp.github.io/exchange-converter/)** · [Report an issue](https://github.com/andylamp/exchange-converter/issues)

## Features

- Select between 2 and 12 supported fiat currencies; start with GBP, EUR, and USD.
- Edit any currency amount, with decimal arithmetic and currency-aware display precision.
- Refresh reference rates manually or let the app check for updates every 24 hours while in use.
- Enter a custom rate, inspect its date, and reset it to the provider rate.
- Explore currency-pair history over one month, three months, or one year.
- Restore browser state across visits and clear it from the interface.
- Use the bundled rates when an upstream request fails, with visible rate dates and error feedback.
- Navigate the responsive interface using a keyboard or a touch screen.

## Rates and history

Rates come from [Frankfurter v2](https://frankfurter.dev/), a free public API requiring no API key. Its default feed blends rates from central banks and other official sources. This app offers the intersection of its current catalogue and an explicit fiat-currency allowlist; it excludes cryptocurrencies, precious metals, and obsolete currencies. Reference rates usually update on business days and are not transaction quotes. Fees, spreads, and bank-specific pricing are not included.

`public/data/latest.json` contains the shared fallback rates. `public/data/history/` contains one rolling year of observations per currency, loaded only when needed for a chart. A weekly action refreshes both. Browser refreshes can retrieve newer quotes directly without waiting for the next deployment; fetched chart history stays in memory for the current visit.

All rates use EUR as the internal reference. A conversion from currency A to B is `amount × EUR-to-B rate ÷ EUR-to-A rate`. Only the entered amount is authoritative; conversion results are rounded for display rather than fed back into subsequent calculations. Custom rates are entered as **1 EUR = X units of the selected currency**.

Rate selection follows these rules:

1. The newest provider observation date wins between bundled and browser-saved quotes. A later fetch breaks a tie between observations from the same date.
2. A custom rate is stamped with its UTC edit time. It wins against provider observations from that date or earlier.
3. A provider observation dated after the custom edit replaces the custom rate. The interface reports replacements; resetting an override immediately returns to the stored provider quote.
4. Missing or invalid responses never erase a last valid quote. Each currency retains its own observation date.

Charts show provider observations, not custom rates. Currency-pair points use observations available on matching dates, with missing periods represented honestly. Currency coverage and the length of available history vary.

The application code is [MIT licensed](LICENSE). Exchange-rate data remains subject to the [upstream providers' terms](https://frankfurter.dev/license/); the application license does not relicense that data. [Frankfurter's documentation](https://frankfurter.dev/) describes its sources and service limits.

## Browser state and privacy

A versioned cookie stores the selected currencies, authoritative amount, selected quote snapshots, custom rates, refresh time, and chart preferences. The encoded value is bounded to 3.5 KB. It is scoped to `/exchange-converter/`, uses `SameSite=Lax`, has a 365-day requested lifetime, and uses `Secure` on HTTPS. Browsers may clear or expire it sooner. Malformed or incompatible state falls back to defaults. When persistence is unavailable, the app remains usable and reports the limitation.

There is no server-side user-state storage, localStorage, analytics, or tracking integration. Cookies are still readable by JavaScript and are sent by browsers with matching requests to the Pages host; cookie paths do not isolate separate apps on the same origin. Requests to Frankfurter contain currency and date parameters, never your entered amount or this app's cookies. GitHub Pages and the rate provider remain external services with their own policies. Use the app's clear/reset control or browser site-data controls to remove saved state.

An already loaded page can calculate with its available rates during a network failure. This is not an installable offline app, and a first visit still needs connectivity.

## Development

Requirements: **Node.js 24**, npm, and Git. GitHub CLI (`gh`) is needed only for maintainer publishing and release administration.

```sh
npm ci
npm run dev
```

Open the URL printed by Vite under `/exchange-converter/`. The app uses Preact, TypeScript, Vite, `decimal.js`, and a native SVG chart. Fonts and app assets are served from the built site; no CDN runtime dependencies are required.

```sh
npm run verify
npx playwright install chromium firefox webkit
npm run test:e2e
npm run preview
```

`verify` runs formatting, lint, type checks, unit tests, bundled-data validation, a production build, and the 75 KiB gzip budget for all app JavaScript/CSS. Browser tests cover Chromium, Firefox, and WebKit. On Linux, install browser system packages with `npx playwright install --with-deps chromium firefox webkit` when needed. Tests use fixed provider fixtures to avoid depending on the network or today's rates.

To fetch and validate new shared data locally:

```sh
npm run data:update
npm run data:check
```

`npm run data:update -- --check` fetches and validates a proposed update without writing it. The updater validates the complete dataset before replacing the local data directory. Failed fetches or validation leave the existing data intact. Generated data is excluded from Prettier to preserve stable serialization.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## GitHub Pages and automation

The site publishes at `https://andylamp.github.io/exchange-converter/`. Its Vite base path and cookie path are `/exchange-converter/`; update both before hosting under a different project path. In repository **Settings → Pages**, set **Source → GitHub Actions**. Restrict the `github-pages` deployment environment to `main`.

| Workflow | Trigger                                                | Result                                                                              |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| CI       | Pull requests                                          | Validation, production build, and browser tests                                     |
| Delivery | `main` pushes, Wednesday 17:23 UTC, or manual dispatch | Tested Pages deployment; scheduled/manual refresh can update the bundled data first |
| Release  | A pushed `v*` tag matching `package.json`              | Tested static-site ZIP, SHA-256 checksums, and generated release notes              |

Actions are pinned to full commit SHAs and updated by Dependabot. Jobs use standard Ubuntu runners, restricted permissions, and short artifact retention. No provider API key, personal access token, or private signing key is required by the workflows.

The weekly update validates the complete dataset and publishes all changed JSON files in one **GitHub-signed, Verified commit** using `createCommitOnBranch`. The API's expected-head check refuses concurrent branch changes. The same delivery run builds the returned commit and deploys it; a `GITHUB_TOKEN`-created commit does not itself trigger another push workflow. A final branch-head check skips obsolete deployments. Failed updates leave the published site intact. [GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token) and [signed commit API](https://docs.github.com/en/graphql/reference/commits).

For a manual data refresh, run **Actions → Delivery → Run workflow** on `main` with `update_rates` selected. Clear the option to redeploy the existing data. GitHub schedules may be delayed, and public-repository scheduled workflows are disabled after 60 days without repository activity. Re-enable Delivery from the Actions page and run it manually if necessary. The browser's own refresh control remains available independently. [Scheduling documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

For maintainers publishing local work without a local signing key, first fetch the remote branch and base changes on its current verified commit, then run checks and inspect a dry run:

```sh
node scripts/publish-commit.mjs --dry-run --message 'Describe the change'
node scripts/publish-commit.mjs --message 'Describe the change'
```

This requires an authenticated `gh` credential with repository write access and workflow permission when changing workflow files. The script publishes changed and untracked nonignored files directly to `main`, without creating a local commit, and verifies GitHub's returned signature. It rejects an unexpected branch head. Fetch the returned commit and reconcile the local checkout before continuing work. Use `--data-only` to refuse changes outside `public/data/*.json`. Authentication alone does not sign ordinary local Git commits.

To release, update `package.json` and the lockfile version, publish the verified change to `main`, and push the matching tag, for example `v1.0.0`. The release workflow checks that the tagged revision is on `main` and verified. The live site continues to follow `main`; the release ZIP is a versioned download configured for the same project path. To roll back the live app, publish a verified revert on `main` and let Delivery rebuild it.

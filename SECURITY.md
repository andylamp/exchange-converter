# Security policy

Security fixes target the latest release and the current `main` branch.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/andylamp/exchange-converter/security/advisories/new). Include reproduction steps, affected browser/version, and the expected impact. Do not disclose an unfixed vulnerability in a public issue. If private reporting is unavailable, open a minimal issue asking the maintainer to enable a private reporting channel without including vulnerability details.

This is a static application with no account system or application database. Browser cookies contain selected currencies, the entered amount, rate snapshots, custom rates, and chart preferences. Treat cookie contents as untrusted input. The app must validate restored state and provider responses before use.

Cookies are readable by JavaScript, and matching requests to the GitHub Pages host may carry them. A cookie path scopes delivery but is not an isolation boundary from other applications on the same origin. Do not store credentials or sensitive financial records in this application. Provider requests must not include the entered amount or the app's cookies.

Workflows use pinned action commits and restricted permissions. Production publication requires a verified GitHub commit. Scheduled updates use GitHub's signing API and the built-in `GITHUB_TOKEN`; no personal signing key or provider API secret is required.

# Contributing

Thanks for taking the time to improve ShioriCode.

ShioriCode is early, maintainer-directed software. We welcome focused improvements, but we are strict about scope because this project touches local shells, coding-agent sessions, provider credentials, and long-running workflows.

By contributing, you agree that your contribution is provided under the repository's Elastic License 2.0 terms unless the maintainers agree otherwise in writing.

## Good First Contributions

- Bug fixes with a clear reproduction.
- Documentation fixes.
- Test coverage for existing behavior.
- Reliability improvements around reconnects, provider lifecycle, streaming, and failure states.
- Small UI polish with screenshots.

## Ask First

Open an issue before working on:

- New providers.
- New persistent data formats.
- Protocol changes.
- Major UI redesigns.
- New package dependencies.
- Release, signing, auto-update, or authentication changes.
- Large refactors.

Uncoordinated large changes may be closed even if the code is good.

## Local Setup

1. Install Bun and Node versions matching `package.json`.
2. Get a `NUCLEO_LICENSE_KEY` from [nucleoapp.com](https://nucleoapp.com/).
3. Copy `.env.example` to `.env` and set `NUCLEO_LICENSE_KEY`.
4. Install dependencies:

   ```bash
   bun install
   ```

5. Start development:

   ```bash
   bun run dev
   ```

## Validation

Before opening a pull request, run:

```bash
bun run fmt
bun run lint
bun run typecheck
```

For tests, use:

```bash
bun run test
```

Do not use `bun test`; this repo uses `bun run test`.

## Pull Request Expectations

- Keep the PR focused on one problem.
- Explain why the change is needed.
- Include screenshots or recordings for UI changes.
- Add or update tests when behavior changes.
- Document new commands, environment variables, or user-visible behavior.
- Avoid unrelated formatting churn.

Maintainers may close PRs that are too broad, difficult to review, or out of line with the current product direction.

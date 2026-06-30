# Contributing

Thanks for your interest! This is a reference sample, so the bar is "clear and
correct" over "feature-complete."

## Development

```bash
npm install
npm run build      # tsc --build across all workspaces
npm test           # unit tests for the authoritative game sim
npm run typecheck  # full type check
```

- **Language:** TypeScript, strict mode, ES modules. Match the surrounding style.
- **Shared types** live in `packages/shared` — change the wire protocol there, not
  in the client or server alone.
- **The sim** (`packages/game-server/src/sim`) is pure and deterministic (injected
  RNG + clock). New gameplay logic should keep it that way and add a unit test in
  `packages/game-server/test`.
- **Infra** is AWS CDK in `packages/infra`. Run `npx cdk diff` before proposing
  infra changes.

## Pull requests

1. Keep changes focused; explain the "why" in the description.
2. `npm run build && npm test` must pass.
3. Don't commit secrets, account IDs, or build artifacts (see `.gitignore`).

## Reporting issues

Open a GitHub issue with steps to reproduce. For anything security-sensitive,
please disclose privately rather than in a public issue.

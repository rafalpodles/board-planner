# Enterprise Edition (`src/ee/`)

Everything under this directory is licensed under [`src/ee/LICENSE`](./LICENSE), not under the
AGPL that covers the rest of the repository. Reading, building and modifying it needs nothing;
running it in production needs a valid Board Planner subscription or licence key.

The boundary is enforced two ways:

- `src/ee/ee-boundary.test.ts` fails if any `.ts` or `.tsx` source file here (tests excluded) does
  not begin with the header line below, or if either LICENSE file goes missing.
- Outside pull requests that touch this directory are closed. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

Every source file here starts with:

```ts
// Copyright (c) 2026 Rafał Podleś. Licensed under the Board Planner Enterprise Edition Licence, see src/ee/LICENSE.
```

`connectors/coda/` is the first paid connector (BP-651), gated by `integrations.coda`.

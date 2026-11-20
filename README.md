# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Kaixyzz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Kaixyzz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge — a one-process GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL v4 and MCP from its own in-memory store. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

Forge is a standalone, GitHub-compatible git forge in one Node 22 process, with no UI, no git binary, no outside service and no dependencies beyond the Node standard library. It serves git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql` and MCP at `/mcp`, all from its own in-memory store. It binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, and exits 0 when the suite says it is done.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vtc8r25b&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

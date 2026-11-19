# github-forge

A standalone, dependency-free GitHub-compatible git forge in a single Node
process. It serves four surfaces over one shared in-memory store:

- **Git smart HTTP** — protocol v2 advertisement and `ls-refs`, v2 and v0
  fetch (including shallow clones and deepening), and `receive-pack` pushes
  with report-status and fast-forward enforcement. The pack protocol is
  implemented in-process; no `git` binary is needed server-side.
- **REST v3** under `/api/v3` — repositories, contents (read/write/delete),
  branches and git refs, commits, labels, issues and comments, pull requests
  with changed files and squash/merge.
- **GraphQL** at `/api/graphql` — viewer, repository, issue and pull request
  queries, the create/close/merge/comment mutations, `node(id:)` round trips,
  cursor pagination, `__type` introspection, and batched operations.
- **MCP** at `/mcp` — JSON-RPC tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`,
  and more) over both the modern `server/discover` handshake and the legacy
  `initialize` one.

## Run

```
node --experimental-strip-types main.ts
```

The process binds an ephemeral port. When `MAKEFUN_ENV_URL` is set it
registers its port with the trial environment and serves until the
environment reports the trial done; otherwise it prints its local URL and
serves until interrupted. `MAKEFUN_SHOP_TOKEN`, when set, is the bearer
token every surface requires.

State is held in memory and addressed by content hash exactly as git
computes it, so anything written through one surface (a file via REST, a
branch via push) is immediately visible through all the others.

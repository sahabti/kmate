# Maintainers

The people below are responsible for reviewing and merging changes to KMate, for
the project's releases, and for responding to security reports.

| Name | GitHub ID | Company/Organization |
|------|-----------|----------------------|
| Asim Nabeel | [liquidvinal](https://github.com/liquidvinal) | Sahabti |

## Areas

Maintainers share responsibility for the whole repository. The rough split of
expertise is:

| Area | Paths |
|------|-------|
| Agent and cluster access | `cmd/agent/`, `internal/agent/` |
| Hub, API and authorization | `cmd/hub/`, `internal/hub/` |
| Contract | `proto/`, `gen/` |
| Web UI | `apps/web/` |
| Realm View | `apps/web/src/realm/`, `apps/web/themes/` |
| Packaging and deployment | `deploy/`, `hack/` |

## Becoming a maintainer

KMate is young and actively looking for maintainers. The path is:

1. Contribute changes that are reviewed and merged, over a period of time long
   enough to show sustained interest rather than a single burst.
2. Help with the parts of the project that are not code: reviewing other people's
   pull requests, triaging issues, improving `docs/`.
3. An existing maintainer nominates you by opening a pull request against this
   file. Nominations are approved by lazy consensus of the current maintainers
   over seven days.

New maintainers are added to this file in the same pull request that grants them
commit access, so this file is always the authoritative list.

## Stepping down

Open a pull request removing yourself. Maintainers who have been inactive for
twelve months may be moved to the list below by any other maintainer.

## Emeritus maintainers

None yet.

## Contact

For anything that should not be public, use the private reporting process in
[SECURITY.md](SECURITY.md). Everything else belongs in a GitHub issue or
discussion on <https://github.com/sahabti/kmate>.

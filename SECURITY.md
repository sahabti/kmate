# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, not as a public issue.

We aim to acknowledge reports within a few working days.

## Supported versions

KMate is pre-1.0. Only the latest commit on `main` receives fixes.

## Current posture

KMate is pre-1.0 and not yet hardened for exposure to untrusted networks. The current
implementation includes:

- Multi-user accounts. Each account has a global role (`viewer`, `operator` or `admin`).
  A global admin can reach every cluster; everyone else reaches a cluster only through
  an explicit grant, optionally limited to specific namespaces, and clusters without a
  grant are not listed.
- Local password login and optional OIDC single sign-on with any standards-compliant
  provider (authorization-code flow with PKCE). Password login can be turned off with
  `localLogin: false` once SSO works; it stays on when no issuer is configured.
- Kubernetes user/group impersonation, on by default in the agent chart
  (`rbac.impersonate: true`). User-scoped operations impersonate the signed-in user
  with their configured Kubernetes groups plus the `kmate:<global role>` group; cached
  reads come from an agent-run informer that checks the caller's access first. Within
  the KMate grant, your Kubernetes RBAC decides what each user may do. With
  impersonation off, every user shares the agent's ServiceAccount and the cluster
  shows a "shared identity" badge.
- Agents enrol with a single-use token that expires after 24 hours. Agent mutual TLS
  with certificate issuance and automatic renewal is available; it defaults to
  `agentMTLS: optional` for migration, so bearer tokens are still accepted. Set
  `agentMTLS: required` once every agent reports a certificate.

Until it is hardened, run the hub on a private network. The hub chart defaults to
`insecure: true` (plaintext inside the cluster): configure a TLS-terminating ingress or
gateway (neither is enabled by default), or set `insecure: false` with `tls.secretName`
to terminate in the hub.

By default the agent chart grants read-only verbs (`get`, `list`, `watch`) on all
resources, including Secrets (`rbac.secretsRead: true`), plus an impersonator
ClusterRole. `rbac.write` and `rbac.exec` are opt-in. Set `rbac.secretsRead: false` to
exclude Secrets from the generated reader/writer roles and deny Secret and Helm
requests; the agent keeps `get`/`update`/`patch` on its own identity Secret and
namespace-scoped permission to create Secrets.

See [docs/06-security.md](docs/06-security.md) for the threat model and
[docs/12-oidc.md](docs/12-oidc.md) for single sign-on setup.

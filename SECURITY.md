# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, not as a public issue.

We aim to acknowledge reports within a few working days.

## Supported versions

KMate is pre-1.0. Only the latest commit on `main` receives fixes.

## Current posture

KMate is not yet hardened for exposure to untrusted networks. The current implementation includes:

- Multi-user hub roles and grants, local password login, and optional OIDC.
- Kubernetes user/group impersonation when the agent's impersonation option is enabled.
- Agent mutual TLS with certificate issuance and automatic renewal. mTLS is optional
  for migration; configure `agentMTLS: required` after upgrading all agents.

Run the hub on a private network until those land. The agent ships with a read-only
ClusterRole by default; `rbac.write`, `rbac.exec` and `rbac.impersonate` are opt-in.

See [docs/06-security.md](docs/06-security.md) for the threat model.

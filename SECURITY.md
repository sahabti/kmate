# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, not as a public issue.

We aim to acknowledge reports within a few working days.

## Supported versions

KMate is pre-1.0. Only the latest commit on `main` receives fixes.

## Current posture

KMate is not yet hardened for exposure to untrusted networks. As of 0.1.0:

- Authentication is a single local admin account. OIDC is planned for phase 5.
- End users are not yet mapped to Kubernetes identities via impersonation, so the
  hub's own roles are the only authorization layer above the agent's ServiceAccount.
- Agents authenticate to the hub with a bearer token issued at enrolment. Mutual TLS
  is planned for phase 5.

Run the hub on a private network until those land. The agent ships with a read-only
ClusterRole by default; `rbac.write`, `rbac.exec` and `rbac.impersonate` are opt-in.

See [docs/06-security.md](docs/06-security.md) for the threat model.

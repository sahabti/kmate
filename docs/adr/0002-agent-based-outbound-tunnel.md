# ADR 0002 · Agent-based, outbound-only connectivity
**Status**: accepted · 2026-09-24

## Context
Lens-style tools need a kubeconfig and network reachability to the API server on every client. Mobile devices and private clusters make that impractical and risky.

## Decision
An in-cluster agent dials **out** to the Hub over one long-lived gRPC bidirectional stream (mTLS). All client traffic is multiplexed over that stream. The agent is configured only via env vars from a Secret; no ConfigMap, no inbound Service.

## Alternatives considered
- **Hub connects to API servers** (store kubeconfigs in Hub): rejected, Hub becomes a credential vault and needs inbound reachability.
- **WireGuard/Tailscale mesh**: powerful but heavy dependency and still ends with a kubeconfig on the client.
- **Per-client agent connections (no Hub)**: NAT traversal and auth become each client's problem; mobile can't hold sockets in background.

## Consequences
+ Works behind NAT/private subnets; no inbound firewall rules.
+ Zero cluster credentials on any client.
− The Hub is a required component (self-hostable; SQLite mode makes it a single binary).
− Agent must be robust to disconnects; we resync from cache.

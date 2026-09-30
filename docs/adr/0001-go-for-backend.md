# ADR 0001 · Go for agent and hub
**Status**: accepted · 2026-09-24

## Context
The agent must run inside arbitrary clusters as a tiny, static binary and talk to the Kubernetes API efficiently (informers, watch, exec). The Hub relays streams at scale.

## Decision
Both are written in Go. `client-go` is the reference Kubernetes client; informer/cache semantics, RESTMapper, remotecommand and port-forward are first-class. gRPC and Connect have mature Go implementations. Single static binary → distroless image ~20 MB.

## Consequences
+ Best-in-class Kubernetes client libraries.
+ One language for both backend components; shared `internal/` packages.
− Not the same language as the UI (TypeScript). Contracts are enforced via protobuf, so the gap is small.

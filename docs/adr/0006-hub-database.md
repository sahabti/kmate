# ADR 0006 · SQLite for dev/single-node, Postgres for production
**Status**: accepted · 2026-09-24

## Decision
Hub uses `sqlc` with a small schema that runs on both SQLite (pure-Go driver `modernc.org/sqlite`, zero-config single binary) and Postgres (`pgx`). Migrations via `goose`. Multi-replica requires Postgres (+ Redis for routing, phase 5).

## Consequences
+ `kmate-hub` with no flags just works for a solo user or a demo.
+ Production gets a real database.
− Two dialects to test in CI.

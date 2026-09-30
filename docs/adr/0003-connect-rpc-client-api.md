# ADR 0003 · Connect-RPC for the client API
**Status**: accepted · 2026-09-24

## Context
Clients are browsers, Tauri webviews (browser engines) and a Go CLI. Browsers can't do native gRPC. We want one typed contract.

## Decision
Client ⇄ Hub uses **Connect** (connectrpc.com). Same `.proto` gives us Connect-Go server and Connect-ES browser clients, JSON or binary, server-streaming over plain HTTP/1.1 or HTTP/2, and gRPC compatibility for the CLI. Terminal/port-forward use raw WebSocket because they need bidirectional byte streams from browsers.

Agent ⇄ Hub uses plain **gRPC** (Go both sides, bidi streaming, mTLS).

## Consequences
+ One proto, three targets (Go server, Go client, TS client), curl-able JSON for debugging.
− Two transports (Connect + WebSocket) on the Hub. Acceptable.

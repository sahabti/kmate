# 07 · Protocol Reference

Contracts live in `proto/kmate/v1/`. Generated with `buf` into `gen/go` and
`apps/web/src/gen`.

## Files

| File | Purpose |
|------|---------|
| `common.proto` | `Identity`, `GVR`, `ObjectRef`, `ListOptions`, `KubeObject` (JSON bytes + metadata), `Error` |
| `agent.proto` | `AgentService` (Hub ⇐ Agent): `Enroll`, `Tunnel` bidi stream, `Frame` and every payload type |
| `hub.proto` | `HubService` (Client ⇒ Hub): auth, clusters, tokens, audit |
| `cluster.proto` | `ClusterService` (Client ⇒ Hub ⇒ Agent): discover/list/get/watch/apply/logs/catalog/helm/metrics |
| `catalog.proto` | `Catalog`, `CatalogEntry`, `Exposure`, `WorkloadRef`, `Health` |

## Frame

```proto
message Frame {
  uint32 stream_id = 1;
  oneof payload {
    Hello hello = 10;                 // first frame from agent
    Heartbeat heartbeat = 11;
    WindowUpdate window_update = 12;
    Close close = 13;                 // either side; carries optional Error
    Request request = 20;             // hub → agent, opens a stream
    Response response = 21;           // agent → hub, unary result
    WatchEvent watch_event = 22;      // agent → hub, streamed
    Data data = 23;                   // opaque bytes: logs, exec, port-forward
    Resize resize = 24;               // hub → agent, terminal size
    CatalogSnapshot catalog = 30;     // agent → hub, agent-initiated stream
  }
}
```

`Request` is a `oneof` of `ListRequest`, `GetRequest`, `WatchRequest`, `ApplyRequest`,
`PatchRequest`, `DeleteRequest`, `ScaleRequest`, `LogsRequest`, `ExecRequest`,
`PortForwardRequest`, `DiscoverRequest`, `HelmListRequest`, `MetricsRequest`, each
with an `Identity` for impersonation.

## Object encoding

Kubernetes objects travel as JSON bytes inside `KubeObject { bytes json; string api_version; string kind; string namespace; string name; string uid; string resource_version; }`.
JSON keeps the agent generic (dynamic client), avoids proto generation for every
Kubernetes type, and is what the UI wants anyway.

## Versioning

- Package `kmate.v1`. Additive changes only. Breaking change ⇒ `kmate.v2` alongside.
- `Hello.capabilities` lets a newer Hub degrade gracefully with an older agent.

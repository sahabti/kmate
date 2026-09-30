# 01 · System Architecture

## Components

```mermaid
flowchart TB
    subgraph Clients
        D[Desktop<br/>Tauri 2 · Win/Mac/Linux]
        M[Mobile<br/>Tauri 2 · iOS/Android]
        W[Web<br/>React SPA]
        C[CLI<br/>kmate]
    end

    subgraph Hub["KMate Hub (Go)"]
        API[Client API<br/>Connect-RPC over HTTP/1.1 + HTTP/2<br/>WebSocket for streams]
        AUTH[Auth<br/>OIDC · local users · API tokens]
        REG[Agent Registry<br/>which cluster is online, on which hub replica]
        MUX[Stream Multiplexer<br/>client session ⇄ agent stream]
        DB[(Postgres / SQLite<br/>users · clusters · tokens · audit)]
    end

    subgraph Cluster["Kubernetes cluster"]
        subgraph Agent["KMate Agent (Go, Deployment)"]
            TUN[Tunnel client<br/>gRPC bidi stream, dials OUT]
            INF[Informer cache<br/>core + apps + networking + CRDs]
            DISC[Service Discovery<br/>Service Catalog builder]
            EXEC[Exec / Logs / Port-forward<br/>SPDY/WebSocket to kubelet via API]
            HELM[Helm reader<br/>release secrets]
        end
        KAPI[(kube-apiserver)]
        MET[metrics-server /<br/>Prometheus optional]
    end

    D & M & W & C -->|HTTPS| API
    API --> AUTH
    API --> MUX
    MUX <--> REG
    REG --- DB
    AUTH --- DB
    TUN -->|outbound mTLS gRPC| MUX
    TUN --- INF & DISC & EXEC & HELM
    INF & DISC & EXEC & HELM --> KAPI
    INF -.-> MET
```

### KMate Agent
- Single static Go binary, distroless image, runs as a `Deployment` (1 replica; HA via
  leader election in a later phase).
- Uses `client-go` informers with a shared factory. Keeps an in-memory cache and
  serves list/watch from that cache, so a client opening the pods view does not
  trigger a `LIST` on the API server.
- Opens **one** gRPC bidirectional stream to the Hub (`AgentService.Tunnel`). All
  traffic (requests, watch events, log bytes, exec frames) is multiplexed on it as
  `Frame` messages with a `stream_id`.
- Reconnects with jittered backoff. Stream resumption re-syncs watches from cache.
- Discovers Services, Ingresses, Gateway API routes and maintains the Service
  Catalog (see [05-service-discovery.md](05-service-discovery.md)).
- Enforces RBAC: every request carries the user identity from the Hub; the agent
  performs the Kubernetes call with `Impersonate-User` / `Impersonate-Group` headers.
  If the agent's ServiceAccount lacks `impersonate`, it falls back to its own identity
  and the Hub marks the cluster as "shared identity".

### KMate Hub
- Go service. Two listeners:
  - **Agent port (9090)**: gRPC + mTLS. Agents authenticate with a per-cluster
    enrollment token on first connect, then with an issued client certificate.
  - **Client port (8080)**: Connect-RPC (works from browsers, gRPC-compatible),
    plus WebSocket for terminal/log streams where HTTP/2 is unavailable (mobile
    proxies, corporate MITM).
- Stateless request routing. Cluster→hub-replica mapping stored in DB / Redis for
  multi-replica deployments (phase 5).
- Persists users, orgs, clusters, enrollment tokens, RBAC bindings and an audit log.
- Never stores kubeconfigs. Never has direct API-server access.

### Clients
- **Shared UI**: `apps/web` — React 19, TypeScript, Vite, TanStack Query/Router,
  Zustand, xterm.js, Monaco. Talks to the Hub via generated Connect-ES clients.
- **Desktop**: Tauri 2 wraps the same UI. Native menu, tray, keychain for tokens,
  local kubeconfig import as a *convenience* to auto-install the agent.
- **Mobile**: Tauri 2 mobile targets. Responsive layout of the same UI, plus push
  notifications (phase 6) and biometric unlock.
- **Web**: same SPA served by the Hub at `/`.

## Request flow example: "show me pods in namespace X"

```mermaid
sequenceDiagram
    participant UI as Client UI
    participant Hub
    participant Agent
    participant Cache as Informer cache
    UI->>Hub: ClusterService.Watch(cluster=A, gvr=pods, ns=X)  [Connect server-stream]
    Hub->>Hub: authz: user may access cluster A?
    Hub->>Agent: Frame{stream_id=42, WatchRequest{gvr=pods, ns=X, user=alice}}
    Agent->>Cache: List from cache (+ RBAC SubjectAccessReview for alice)
    Agent-->>Hub: Frame{42, WatchEvent{ADDED × n}}
    Hub-->>UI: stream events
    loop live
        Cache-->>Agent: informer event
        Agent-->>Hub: Frame{42, WatchEvent{MODIFIED}}
        Hub-->>UI: event
    end
    UI->>Hub: cancel
    Hub->>Agent: Frame{42, Close}
```

## Request flow example: "exec into pod"

```mermaid
sequenceDiagram
    participant UI as xterm.js
    participant Hub
    participant Agent
    participant API as kube-apiserver
    UI->>Hub: WebSocket /v1/clusters/A/exec (pod, container, cmd)
    Hub->>Agent: Frame{stream_id=77, ExecOpen}
    Agent->>API: POST .../exec (SPDY/WebSocket, impersonating user)
    par bidirectional
        UI-->>Hub-->>Agent-->>API: stdin bytes
        API-->>Agent-->>Hub-->>UI: stdout/stderr bytes
    end
    UI->>Hub: resize / close
```

## Data ownership

| Data | Lives in | Notes |
|------|----------|-------|
| Cluster resource state | Agent memory (informer cache) | Never persisted by KMate |
| Service Catalog | Agent memory, snapshot pushed to Hub on change | Hub keeps last snapshot for offline display |
| Users, orgs, cluster registrations, tokens | Hub DB | Postgres in prod, SQLite for dev / single-user |
| Audit log (who did what on which cluster) | Hub DB | Also forwarded to stdout as JSON |
| Client preferences | Client local storage / keychain | |

## Scaling model

- One agent per cluster. Agent memory is proportional to cluster size (same as
  any informer-based controller). Namespace-scoped mode for very large clusters.
- Hub replicas behind a load balancer. Agent stream stickiness by design (an agent
  is connected to exactly one replica). Cross-replica routing via a shared
  registry (Redis pub/sub or Postgres LISTEN/NOTIFY) — phase 5.
- Clients are thin; they hold only what is on screen.

## Technology choices (see ADRs)

| Concern | Choice | ADR |
|---------|--------|-----|
| Agent & Hub language | Go | [0001](adr/0001-go-for-backend.md) |
| Agent connectivity | Outbound gRPC bidi stream | [0002](adr/0002-agent-based-outbound-tunnel.md) |
| Client API | Connect-RPC (+ WebSocket for terminals) | [0003](adr/0003-connect-rpc-client-api.md) |
| UI framework | React + TypeScript, single codebase | [0004](adr/0004-single-ui-codebase.md) |
| Desktop & mobile shell | Tauri 2 | [0005](adr/0005-tauri-for-desktop-and-mobile.md) |
| Hub DB | Postgres (prod) / SQLite (dev) | [0006](adr/0006-hub-database.md) |
| UI component kit | shadcn/ui + Hirael | [0007](adr/0007-shadcn-hirael-ui-kit.md) |

# 00 · Vision & Product Definition

## One-liner

> KMate is Lens without the kubeconfig: a Kubernetes IDE for desktop, mobile and
> web, powered by an agent that lives inside your cluster.

## The problem with today's tools

| Tool | Model | Pain |
|------|-------|------|
| Lens / OpenLens / Freelens | Desktop app reads your kubeconfig, talks to the API server directly | Needs network path + credentials on every laptop. No mobile. Cluster behind private VPC needs VPN/bastion. |
| Headlamp | Web app; either in-cluster deploy or local kubeconfig | In-cluster mode means exposing the dashboard *inbound* through an Ingress. |
| k9s | Terminal UI | Great for ops, not for teams, and no mobile. |
| Cloud consoles (GKE/EKS/AKS) | Vendor-specific | Not multi-cloud, weak for on-prem / kind / k3s. |

Common thread: **the client needs credentials and inbound reachability to the API
server**. That breaks down for private clusters, edge clusters, mobile devices and
"just let me glance at prod from my phone" moments.

## KMate's answer

1. **Agent inside the cluster.** Installed once with Helm. Runs as a Deployment with a
   ServiceAccount. Uses informers to keep an in-memory cache of the resources that
   matter, and dials **out** to a Hub over a single long-lived, mutually-authenticated
   stream. No inbound port, no LoadBalancer, no Ingress needed for the agent itself.
2. **Hub as the meeting point.** Self-hosted (or hosted by us later). Authenticates
   users, knows which agents are online, and routes client requests to the right
   agent over the existing stream. Stateless enough to scale horizontally.
3. **Clients everywhere.** Same UI codebase delivered as Web, Desktop (Linux/Windows/
   macOS) and Mobile (Android/iOS). The client only ever knows the Hub URL and the
   user's identity token.
4. **Service auto-discovery.** The agent doesn't just list Services. It builds a
   *Service Catalog*: which workload backs each Service, which Ingress / Gateway
   HTTPRoute exposes it, which hostnames and paths, TLS or not, ready endpoints, and
   surfaces this as the first dashboard you see.

## Who is it for

- **Platform / SRE teams** managing many clusters across clouds and on-prem.
- **Developers** who want to see "is my service up and what URL is it on" without
  learning `kubectl`.
- **On-call engineers** who need to check pods, read logs, restart a deployment
  from a phone.

## Principles

1. **Zero client credentials.** A stolen laptop or phone must not leak cluster access.
   Tokens are short-lived, scoped and revocable at the Hub.
2. **Least privilege by default.** The agent ships with a read-only ClusterRole.
   Write verbs are opt-in via Helm values. The Hub impersonates the end user so
   Kubernetes RBAC still applies.
3. **Outbound only.** Agents initiate every connection. Works behind NAT, private
   subnets, air-gapped-with-egress-proxy.
4. **Streams, not polling.** Informer events are pushed to the client. The UI is
   always live.
5. **One UI, every platform.** Feature parity is the default; platform-specific
   features are additive (e.g. push notifications on mobile).
6. **Boring, well-supported tech.** Go, Protobuf, gRPC/Connect, React, Tauri.

## Non-goals (for v1)

- Replacing GitOps tools (Argo/Flux). KMate is an IDE/console, not a deployer.
- Being a monitoring system. We integrate with Prometheus/metrics-server; we don't
  store time series.
- Full multi-tenancy SaaS billing. The Hub is self-hostable first.

## Success criteria for v1.0

- Install agent with one `helm install`, see the cluster in the web UI in < 60 s.
- Browse all core resources with live updates, view logs, exec, port-forward.
- Service Catalog dashboard lists every service with its ingress URL and health.
- Desktop builds for Linux/Windows/macOS; mobile builds for Android/iOS.
- Read-only by default; RBAC-enforced writes.

# 10 · Deploying KMate in-cluster (GKE behind an internal gateway)

A reference deployment where the hub and the agent both run inside the cluster and
the hub is published only on a private, VPN-reachable hostname. Adapt the names to
your own project, registry and gateway.

```
VPN user ──https://kmate.internal.example.com──▶ istio-ingressgateway (TLS)
                                                      │ VirtualService kmate-system/kmate-hub
                                                      ▼
                                           Service kmate-hub:8080  ──▶ hub pod (SQLite on a PVC)
                                                      ▲ :9090 gRPC (cluster-internal only)
                                           agent pod (ServiceAccount, read-only RBAC)
```

## 1. Images

```bash
REG=<region>-docker.pkg.dev/<project>/<repository>/kmate
docker buildx build --platform linux/amd64 -f deploy/docker/agent.Dockerfile -t $REG/agent:0.1.0 --push .
docker buildx build --platform linux/amd64 -f deploy/docker/hub.Dockerfile   -t $REG/hub:0.1.0   --push .
```

Run `gcloud auth configure-docker <region>-docker.pkg.dev` once first. Build for
`linux/amd64` explicitly when your workstation is an Apple Silicon Mac.

## 2. Hub

```bash
helm upgrade --install kmate-hub deploy/helm/kmate-hub -n kmate-system --create-namespace \
  --set image.repository=$REG/hub --set image.tag=0.1.0 \
  --set publicUrl=https://kmate.internal.example.com \
  --set persistence.storageClass=<your-rwo-storage-class> \
  --set istio.enabled=true \
  --set istio.host=kmate.internal.example.com \
  --set istio.gateway=istio-system/<your-internal-gateway>
kubectl -n kmate-system get secret kmate-hub-auth -o jsonpath='{.data.adminPassword}' | base64 -d
```

The admin password and JWT secret are generated on first install and kept across
upgrades (`helm.sh/resource-policy: keep`). TLS is terminated at the gateway, so the
hub listens plaintext inside the cluster (`insecure=true`). Use `ingress.enabled=true`
instead of the Istio values if you publish through a plain Ingress.

## 3. Agent (same cluster)

Create the cluster in the UI (**Add cluster**), copy the enrollment token, then:

```bash
helm upgrade --install kmate-agent deploy/helm/kmate-agent -n kmate-system \
  --set image.repository=$REG/agent --set image.tag=0.1.0 \
  --set hub.addr=kmate-hub.kmate-system.svc.cluster.local:9090 --set hub.insecure=true \
  --set enrollment.token=kmt_enr_... --set clusterName=<display-name>
```

Defaults are read-only (`rbac.write=false`, `rbac.exec=false`, `rbac.impersonate=false`).
The agent stores its issued identity in Secret `kmate-agent-identity`, so pod restarts
do not need a new token.

## 4. Verify

```bash
kubectl -n kmate-system get pods
kubectl -n kmate-system logs deploy/kmate-agent | grep -E "enrolled|tunnel established"
# from a machine on the VPN:
curl -sk -o /dev/null -w "%{http_code}\n" https://kmate.internal.example.com/   # 200 = UI served through the gateway
```

Without the VPN, use `kubectl -n kmate-system port-forward svc/kmate-hub 18080:8080`
and open http://localhost:18080.

## Agents in other clusters

They need to reach the hub's port 9090. Options: a dedicated TLS-passthrough listener
on the gateway, an internal LoadBalancer, or gRPC-over-WebSocket through the same HTTPS
host (phase 5). Not set up in this reference deployment.

## Security posture of this deployment

- Not reachable from the internet. Internal gateway, VPN only.
- The agent cannot write or exec. The hub holds no cluster credentials.
- Still a single admin account, no per-user RBAC and no mTLS. See phase 5 before
  opening it to a wider audience.

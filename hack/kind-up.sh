#!/usr/bin/env bash
# Creates a local kind cluster for KMate development with ingress-nginx and a demo app.
set -euo pipefail
CLUSTER="${KIND_CLUSTER:-kmate-dev}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "kind cluster '$CLUSTER' already exists"
else
  cat <<KIND | kind create cluster --name "$CLUSTER" --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "ingress-ready=true"
  extraPortMappings:
  - containerPort: 80
    hostPort: 8081
    protocol: TCP
  - containerPort: 443
    hostPort: 8443
    protocol: TCP
KIND
fi

kubectl config use-context "kind-$CLUSTER" >/dev/null
echo "Installing ingress-nginx..."
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml >/dev/null
kubectl -n ingress-nginx wait --for=condition=Available deployment/ingress-nginx-controller --timeout=180s || true
# The admission webhook needs the controller pod to be Ready, not just the deployment Available.
kubectl -n ingress-nginx wait --for=condition=Ready pod -l app.kubernetes.io/component=controller --timeout=180s || true

echo "Installing metrics-server (insecure TLS for kind)..."
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml >/dev/null
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null 2>&1 || true

echo "Deploying demo app..."
for i in 1 2 3 4 5 6; do
  if kubectl apply -f "$HERE/deploy/demo/"; then break; fi
  echo "retrying demo app apply ($i)..."; sleep 10
done
echo
echo "Cluster '$CLUSTER' ready. Demo ingress: http://shop.127.0.0.1.nip.io:8081/"

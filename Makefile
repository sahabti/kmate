SHELL := /bin/bash
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/kmate-dev/kmate/internal/version.Version=$(VERSION)
KIND_CLUSTER ?= kmate-dev

.PHONY: all proto build test lint hub agent-local web kind-up kind-down demo-app images clean

all: proto build

proto: ## Generate Go + TS from proto/
	buf lint
	buf generate

build: ## Build hub and agent binaries into bin/
	mkdir -p bin
	go build -ldflags "$(LDFLAGS)" -o bin/kmate-hub ./cmd/kmate-hub
	go build -ldflags "$(LDFLAGS)" -o bin/kmate-agent ./cmd/kmate-agent

test:
	go test ./...

lint:
	go vet ./...
	buf lint

hub: ## Run hub locally (clients :8080, agents :9090, sqlite ./kmate.db)
	KMATE_INSECURE=true KMATE_ADMIN_EMAIL=admin@kmate.local KMATE_ADMIN_PASSWORD=admin \
	go run ./cmd/kmate-hub

agent-local: ## Run agent out-of-cluster against current kubeconfig. Needs KMATE_ENROLLMENT_TOKEN on first run; identity is then kept in .kmate-agent-identity.json.
	KMATE_HUB_ADDR=localhost:9090 KMATE_INSECURE_HUB=true \
	go run ./cmd/kmate-agent --kubeconfig $${KUBECONFIG:-$$HOME/.kube/config} --identity-file ./.kmate-agent-identity.json

web: ## Run web UI dev server
	cd apps/web && pnpm install && pnpm dev

web-build: ## Build web UI into apps/web/dist (embedded by hub)
	cd apps/web && pnpm install && pnpm build

kind-up: ## Create kind cluster with ingress-nginx and the demo app
	KIND_CLUSTER=$(KIND_CLUSTER) hack/kind-up.sh

kind-down:
	kind delete cluster --name $(KIND_CLUSTER)

demo-app:
	kubectl apply -f deploy/demo/

images: ## Build container images
	docker build -f deploy/docker/agent.Dockerfile -t kmate/agent:$(VERSION) .
	docker build -f deploy/docker/hub.Dockerfile   -t kmate/hub:$(VERSION) .

clean:
	rm -rf bin apps/web/dist kmate.db

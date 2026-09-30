FROM node:22 AS web
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml* apps/web/pnpm-workspace.yaml* ./
# pnpm-workspace.yaml carries allowBuilds (esbuild) so postinstall scripts are approved non-interactively
RUN corepack enable && pnpm install --frozen-lockfile || pnpm install
COPY apps/web .
RUN pnpm build

FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/apps/web/dist ./internal/hub/web/dist
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -o /out/kmate-hub ./cmd/kmate-hub

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/kmate-hub /kmate-hub
USER 65532:65532
EXPOSE 8080 9090
ENTRYPOINT ["/kmate-hub"]

FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -o /out/kmate-agent ./cmd/kmate-agent

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/kmate-agent /kmate-agent
USER 65532:65532
ENTRYPOINT ["/kmate-agent"]

// Command kmate-agent runs inside a Kubernetes cluster and dials out to a KMate Hub.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kmate-dev/kmate/internal/agent/cache"
	"github.com/kmate-dev/kmate/internal/agent/discovery"
	"github.com/kmate-dev/kmate/internal/agent/handlers"
	"github.com/kmate-dev/kmate/internal/agent/kube"
	"github.com/kmate-dev/kmate/internal/agent/tunnel"
	"github.com/kmate-dev/kmate/internal/version"
	"google.golang.org/protobuf/encoding/protojson"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string) bool {
	v := strings.ToLower(os.Getenv(key))
	return v == "true" || v == "1" || v == "yes"
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func main() {
	var (
		kubeconfig     = flag.String("kubeconfig", env("KUBECONFIG_PATH", ""), "path to kubeconfig (out-of-cluster mode); empty = in-cluster")
		kubeContext    = flag.String("context", env("KMATE_KUBE_CONTEXT", ""), "kubeconfig context to use")
		identitySecret = flag.String("identity-secret", env("KMATE_IDENTITY_SECRET", ""), "Secret name (in KMATE_NAMESPACE) to persist agent identity")
		identityFile   = flag.String("identity-file", env("KMATE_IDENTITY_FILE", ""), "file path to persist agent identity (out-of-cluster runs)")
		httpAddr       = flag.String("http-addr", env("KMATE_HTTP_ADDR", ":8082"), "listen address for /healthz /readyz /metrics")
		dumpCatalog    = flag.Bool("dump-catalog", false, "build the service catalog, print it as JSON and exit (debug)")
		showVersion    = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()
	if *showVersion {
		fmt.Println(version.Version)
		return
	}

	level := slog.LevelInfo
	switch strings.ToLower(env("KMATE_LOG_LEVEL", "info")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	canWrite := envBool("KMATE_CAN_WRITE")
	canExec := envBool("KMATE_CAN_EXEC")
	canImpersonate := envBool("KMATE_CAN_IMPERSONATE")
	namespaces := splitList(os.Getenv("KMATE_NAMESPACES"))

	clients, err := kube.New(kube.Options{Kubeconfig: *kubeconfig, Context: *kubeContext, CanImpersonate: canImpersonate, ClusterName: os.Getenv("KMATE_CLUSTER_NAME")})
	if err != nil {
		log.Error("kubernetes client", "err", err)
		os.Exit(1)
	}

	hideNS := splitList(env("KMATE_CATALOG_HIDE_NAMESPACES", discovery.DefaultHideNamespaces))
	catalog := discovery.New(clients.Clientset, clients.Dynamic, clients.Discovery, discovery.Options{
		HideNamespaces: hideNS,
		Namespaces:     namespaces,
		Probe:          envBool("KMATE_CATALOG_PROBE"),
		Log:            log.With("component", "catalog"),
	})
	go catalog.Run(ctx)
	clients.PodCount = catalog.PodCount

	if *dumpCatalog {
		wctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		if err := catalog.WaitSynced(wctx); err != nil {
			log.Error("catalog sync", "err", err)
			os.Exit(1)
		}
		b, _ := protojson.MarshalOptions{Multiline: true, Indent: "  ", EmitUnpopulated: false}.Marshal(catalog.Current())
		os.Stdout.Write(b)
		fmt.Println()
		return
	}

	hubAddr := os.Getenv("KMATE_HUB_ADDR")
	if hubAddr == "" {
		log.Error("KMATE_HUB_ADDR is required")
		os.Exit(2)
	}

	c := cache.New(clients, namespaces, log.With("component", "cache"))
	go c.Run(ctx)

	h := &handlers.Handler{Clients: clients, Cache: c, Catalog: catalog, Log: log.With("component", "handlers"), CanExec: canExec, CanWrite: canWrite}

	caps := []string{"read", "catalog", "logs", "helm", "metrics"}
	if canWrite {
		caps = append(caps, "write")
	}
	if canExec {
		caps = append(caps, "exec", "portforward")
	}
	if canImpersonate {
		caps = append(caps, "impersonate")
	}

	var store tunnel.IdentityStore = &tunnel.MemoryStore{}
	if *identityFile != "" {
		store = &tunnel.FileStore{Path: *identityFile, Log: log}
	} else if *identitySecret != "" {
		ns := env("KMATE_NAMESPACE", "kmate-system")
		store = &tunnel.SecretStore{Client: clients.Clientset, Namespace: ns, Name: *identitySecret, Log: log}
	}

	tc := tunnel.New(tunnel.Config{
		HubAddr:         hubAddr,
		EnrollmentToken: os.Getenv("KMATE_ENROLLMENT_TOKEN"),
		Insecure:        envBool("KMATE_INSECURE_HUB"),
		CAFile:          os.Getenv("KMATE_HUB_CA_FILE"),
		Capabilities:    caps,
	}, clients, h, catalog, store, log.With("component", "tunnel"))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if !tc.Connected() {
			http.Error(w, "tunnel not connected", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		connected := 0
		if tc.Connected() {
			connected = 1
		}
		fmt.Fprintf(w, "# HELP kmate_agent_tunnel_connected 1 when the tunnel to the hub is up\n# TYPE kmate_agent_tunnel_connected gauge\nkmate_agent_tunnel_connected %d\n", connected)
		fmt.Fprintf(w, "# HELP kmate_agent_catalog_version Current service catalog version\n# TYPE kmate_agent_catalog_version gauge\nkmate_agent_catalog_version %d\n", catalog.Version())
		fmt.Fprintf(w, "# HELP kmate_agent_catalog_entries Number of catalog entries\n# TYPE kmate_agent_catalog_entries gauge\nkmate_agent_catalog_entries %d\n", len(catalog.Current().Entries))
		fmt.Fprintf(w, "# HELP kmate_agent_cache_objects Objects held per informer\n# TYPE kmate_agent_cache_objects gauge\n")
		for gvr, n := range c.Stats() {
			fmt.Fprintf(w, "kmate_agent_cache_objects{gvr=%q} %d\n", gvr, n)
		}
	})
	mux.HandleFunc("/debug/catalog", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		b, _ := protojson.Marshal(catalog.Current())
		w.Write(b)
	})
	srv := &http.Server{Addr: *httpAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("http server", "err", err)
		}
	}()

	log.Info("kmate-agent starting", "version", version.Version, "hub", hubAddr, "capabilities", caps, "namespaces", namespaces)
	err = tc.Run(ctx)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	if err != nil && ctx.Err() == nil {
		log.Error("tunnel exited", "err", err)
		os.Exit(1)
	}
	log.Info("kmate-agent stopped")
	_ = json.Marshal
}

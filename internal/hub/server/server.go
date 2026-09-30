// Package server wires listeners, middleware and handlers together.
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"connectrpc.com/connect"
	connectcors "connectrpc.com/cors"
	"github.com/rs/cors"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/gen/go/kmate/v1/kmatev1connect"
	"github.com/kmate-dev/kmate/internal/hub/api"
	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/pf"
	"github.com/kmate-dev/kmate/internal/hub/registry"
	"github.com/kmate-dev/kmate/internal/hub/relay"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/hub/web"
	"github.com/kmate-dev/kmate/internal/hub/ws"
)

// Config for the server.
type Config struct {
	ClientAddr      string
	AgentAddr       string
	MetricsAddr     string
	PublicURL       string
	AgentPublicAddr string
	Insecure        bool
	TLSCert, TLSKey string
	CORSOrigins     []string
	WebDir          string
}

// Server holds all listeners.
type Server struct {
	cfg   Config
	log   *slog.Logger
	store *store.Store
	auth  *auth.Authenticator
	reg   *registry.Registry
	relay *relay.Relay

	client  *http.Server
	metrics *http.Server
	grpc    *grpc.Server
}

// New builds the server.
func New(cfg Config, st *store.Store, a *auth.Authenticator, log *slog.Logger) (*Server, error) {
	reg := registry.New()
	rl := relay.New(st, reg, log)
	s := &Server{cfg: cfg, log: log, store: st, auth: a, reg: reg, relay: rl}

	var tlsCfg *tls.Config
	if !cfg.Insecure {
		if cfg.TLSCert == "" || cfg.TLSKey == "" {
			return nil, errors.New("KMATE_TLS_CERT and KMATE_TLS_KEY are required unless KMATE_INSECURE=true")
		}
		cert, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			return nil, fmt.Errorf("load tls: %w", err)
		}
		tlsCfg = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}

	// ---- agent gRPC listener ----
	gopts := []grpc.ServerOption{
		grpc.KeepaliveParams(keepalive.ServerParameters{Time: 30 * time.Second, Timeout: 20 * time.Second}),
		grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{MinTime: 10 * time.Second, PermitWithoutStream: true}),
		grpc.MaxRecvMsgSize(16 << 20),
	}
	if tlsCfg != nil {
		gopts = append(gopts, grpc.Creds(credentials.NewTLS(tlsCfg)))
	}
	s.grpc = grpc.NewServer(gopts...)
	kmatev1.RegisterAgentServiceServer(s.grpc, rl)

	// ---- client HTTP listener ----
	m := http.NewServeMux()
	apiCfg := api.Config{PublicURL: cfg.PublicURL, AgentPublicAddr: cfg.AgentPublicAddr, Insecure: cfg.Insecure}
	interceptors := connect.WithInterceptors(a.Interceptor(kmatev1connect.HubServiceLoginProcedure))
	hubPath, hubH := kmatev1connect.NewHubServiceHandler(api.NewHubService(st, a, reg, rl, apiCfg, log), interceptors)
	clPath, clH := kmatev1connect.NewClusterServiceHandler(api.NewClusterService(st, reg, rl, log), interceptors)
	m.Handle(hubPath, hubH)
	m.Handle(clPath, clH)
	wsh := ws.New(a, rl, st, cfg.CORSOrigins, log)
	wsh.Register(m)
	pf.New(a, rl, st, !cfg.Insecure, log).Register(m)
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	m.Handle("/", web.Handler(cfg.WebDir))

	c := cors.New(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   connectcors.AllowedMethods(),
		AllowedHeaders:   append(connectcors.AllowedHeaders(), "Authorization"),
		ExposedHeaders:   connectcors.ExposedHeaders(),
		AllowCredentials: true,
		MaxAge:           7200,
	})
	var handler http.Handler = c.Handler(logging(log, m))
	if tlsCfg == nil {
		handler = h2c.NewHandler(handler, &http2.Server{})
	}
	s.client = &http.Server{Addr: cfg.ClientAddr, Handler: handler, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}

	// ---- metrics ----
	mm := http.NewServeMux()
	mm.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mm.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "# HELP kmate_hub_connected_agents Number of connected agents.\n# TYPE kmate_hub_connected_agents gauge\nkmate_hub_connected_agents %d\n", reg.Count())
		fmt.Fprintf(w, "# HELP kmate_hub_open_streams Number of open relayed streams.\n# TYPE kmate_hub_open_streams gauge\nkmate_hub_open_streams %d\n", rl.OpenStreams())
		fmt.Fprintf(w, "# HELP kmate_hub_watch_sockets Open multiplexed watch websockets.\n# TYPE kmate_hub_watch_sockets gauge\nkmate_hub_watch_sockets %d\n", wsh.WatchSockets())
		fmt.Fprintf(w, "# HELP kmate_hub_watch_subscriptions Active watch subscriptions over websockets.\n# TYPE kmate_hub_watch_subscriptions gauge\nkmate_hub_watch_subscriptions %d\n", wsh.WatchSubs())
	})
	s.metrics = &http.Server{Addr: cfg.MetricsAddr, Handler: mm, ReadHeaderTimeout: 10 * time.Second}
	return s, nil
}

// Run starts all listeners and blocks until ctx is done.
func (s *Server) Run(ctx context.Context) error {
	_ = s.store.MarkAllOffline(ctx)
	errc := make(chan error, 3)

	agentLn, err := net.Listen("tcp", s.cfg.AgentAddr)
	if err != nil {
		return fmt.Errorf("agent listener: %w", err)
	}
	go func() {
		s.log.Info("agent gRPC listening", "addr", s.cfg.AgentAddr, "tls", !s.cfg.Insecure)
		errc <- s.grpc.Serve(agentLn)
	}()
	go func() {
		s.log.Info("client API listening", "addr", s.cfg.ClientAddr, "tls", !s.cfg.Insecure, "public_url", s.cfg.PublicURL)
		if s.client.TLSConfig != nil {
			errc <- s.client.ListenAndServeTLS("", "")
		} else {
			errc <- s.client.ListenAndServe()
		}
	}()
	go func() {
		s.log.Info("metrics listening", "addr", s.cfg.MetricsAddr)
		errc <- s.metrics.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
	case err := <-errc:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	s.log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = s.client.Shutdown(shutdownCtx)
	_ = s.metrics.Shutdown(shutdownCtx)
	done := make(chan struct{})
	go func() { s.grpc.GracefulStop(); close(done) }()
	select {
	case <-done:
	case <-shutdownCtx.Done():
		s.grpc.Stop()
	}
	return nil
}

func logging(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/kmate.v1.") || strings.HasPrefix(r.URL.Path, "/ws/") || strings.HasPrefix(r.URL.Path, "/pf/") {
			log.Debug("http", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start).String())
		}
	})
}

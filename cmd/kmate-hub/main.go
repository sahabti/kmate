// Command kmate-hub is the KMate control plane and relay.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/kmate-dev/kmate/internal/hub/auth"
	"github.com/kmate-dev/kmate/internal/hub/server"
	"github.com/kmate-dev/kmate/internal/hub/store"
	"github.com/kmate-dev/kmate/internal/version"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	level := slog.LevelInfo
	if strings.EqualFold(env("KMATE_LOG_LEVEL", "info"), "debug") {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, log); err != nil {
		log.Error("hub exited", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, log *slog.Logger) error {
	cfg := server.Config{
		ClientAddr:      env("KMATE_CLIENT_ADDR", ":8080"),
		AgentAddr:       env("KMATE_AGENT_ADDR", ":9090"),
		MetricsAddr:     env("KMATE_METRICS_ADDR", ":9091"),
		PublicURL:       env("KMATE_PUBLIC_URL", "http://localhost:8080"),
		AgentPublicAddr: env("KMATE_AGENT_PUBLIC_ADDR", "localhost:9090"),
		Insecure:        strings.EqualFold(env("KMATE_INSECURE", "false"), "true"),
		TLSCert:         os.Getenv("KMATE_TLS_CERT"),
		TLSKey:          os.Getenv("KMATE_TLS_KEY"),
		CORSOrigins:     strings.Split(env("KMATE_CORS_ORIGINS", "http://localhost:5173,http://localhost:1420,tauri://localhost"), ","),
		WebDir:          os.Getenv("KMATE_WEB_DIR"),
	}
	log.Info("starting kmate-hub", "version", version.Version, "insecure", cfg.Insecure)

	st, err := store.Open(ctx, env("KMATE_DB_URL", "sqlite://kmate.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	secret := os.Getenv("KMATE_JWT_SECRET")
	if secret == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return err
		}
		secret = hex.EncodeToString(b)
		log.Warn("KMATE_JWT_SECRET not set; generated a random secret, sessions will not survive restarts")
	}
	a := auth.New([]byte(secret))

	if err := bootstrapAdmin(ctx, st, log); err != nil {
		return err
	}

	srv, err := server.New(cfg, st, a, log)
	if err != nil {
		return err
	}
	return srv.Run(ctx)
}

func bootstrapAdmin(ctx context.Context, st *store.Store, log *slog.Logger) error {
	email, pw := os.Getenv("KMATE_ADMIN_EMAIL"), os.Getenv("KMATE_ADMIN_PASSWORD")
	n, err := st.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if email == "" || pw == "" {
		log.Warn("no users exist and KMATE_ADMIN_EMAIL/KMATE_ADMIN_PASSWORD not set; nobody can log in")
		return nil
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}
	if err := st.CreateUser(ctx, &store.User{Email: email, Name: "Admin", PasswordHash: hash, Role: auth.RoleAdmin}); err != nil {
		return errors.New("bootstrap admin: " + err.Error())
	}
	log.Info("bootstrapped admin user", "email", email)
	return nil
}

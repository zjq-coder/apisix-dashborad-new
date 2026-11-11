package main

import (
	"apisix-dashboard-next/internal/console"
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	app, err := console.NewServer(ctx, console.Config{DatabaseURL: os.Getenv("DATABASE_URL"), EncryptionKey: os.Getenv("DASHBOARD_ENCRYPTION_KEY"), Username: env("DASHBOARD_USERNAME", "admin"), Password: os.Getenv("DASHBOARD_PASSWORD"), StaticDir: env("STATIC_DIR", "../web/dist"), SecureCookie: os.Getenv("SECURE_COOKIE") == "true"})
	cancel()
	if err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
	server := &http.Server{Addr: env("LISTEN_ADDR", "127.0.0.1:8080"), Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		slog.Info("APISIX Console started", "address", server.Addr)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel = context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	app.Close()
}

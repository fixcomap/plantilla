// App de asistencia a entrenos y convocatorias para entrenadores de fútbol base.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// notReady responde mientras falte configuración o base de datos: el servicio
// arranca igual (/health verde, deploy no bloqueado) pero no sirve datos.
func notReady(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "servicio sin configurar", http.StatusServiceUnavailable)
}

// newApp monta la app si hay configuración y BD; si no, devuelve el motivo.
func newApp(ctx context.Context) (*app, error) {
	a := &auth{
		httpClient: &http.Client{Timeout: 10 * time.Second},
		tokenURL:   "https://oauth2.googleapis.com/token",
	}
	// DEV_USER solo fuera de Cloud Run (K_SERVICE lo define Cloud Run): en
	// producción es imposible saltarse el login aunque alguien lo configure.
	if dev := os.Getenv("DEV_USER"); dev != "" && os.Getenv("K_SERVICE") == "" {
		a.devUser = normEmail(dev)
	} else {
		cfg, err := loadConfig()
		if err != nil {
			return nil, err
		}
		a.cfg = cfg
	}
	pages, err := parsePages()
	if err != nil {
		return nil, err
	}
	dbCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	db, err := openDB(dbCtx)
	if err != nil {
		return nil, err
	}
	return &app{st: store{db: db}, auth: a, pages: pages}, nil
}

// lazyApp sirve 503 (fallback) hasta que newApp funciona y reintenta con
// espera creciente: una caída de la BD al arrancar no deja la instancia
// colgada en 503 hasta el próximo deploy.
type lazyApp struct {
	fallback http.Handler
	app      atomic.Pointer[app]
	handler  atomic.Pointer[http.Handler]
}

// try monta la app; el primer intento va antes de escuchar, para que un
// arranque en frío normal no sirva ningún 503.
func (l *lazyApp) try(ctx context.Context) error {
	a, err := newApp(ctx)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /dbcheck", dbcheck)
	a.routes(mux)
	h := canonicalHost(a.auth.cfg.BaseURL, mux)
	l.app.Store(a)
	l.handler.Store(&h)
	return nil
}

func (l *lazyApp) retry(ctx context.Context, err error) {
	for wait := 5 * time.Second; err != nil; wait = min(wait*2, 5*time.Minute) {
		slog.Error("app sin arrancar, se sirve 503 y se reintenta", "err", err, "en", wait.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		err = l.try(ctx)
	}
	slog.Info("app arrancada tras reintentar")
}

func (l *lazyApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h := l.handler.Load(); h != nil {
		(*h).ServeHTTP(w, r)
		return
	}
	l.fallback.ServeHTTP(w, r)
}

func (l *lazyApp) close() {
	if a := l.app.Load(); a != nil {
		_ = a.st.db.Close()
	}
}

func health(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func main() {
	// Logs JSON en stdout: Cloud Logging los parsea (severity, trace) sin agente.
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.LevelKey {
				a.Key = "severity" // clave que entiende Cloud Logging
			}
			return a
		},
	})))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	shutdownOTel, err := setupOTel(ctx)
	if err != nil {
		// Sin telemetría se sirve igual: es preferible a no arrancar.
		slog.Error("otel: no se pudo iniciar, se sigue sin exportar", "err", err)
		shutdownOTel = func(context.Context) error { return nil }
	}

	// Cloud Run inyecta PORT; el default solo sirve para ejecutar en local.
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	mux := http.NewServeMux()
	// /health y no /healthz: Cloud Run reserva algunas rutas acabadas en "z" y
	// /healthz la contesta su frontend con un 404 sin llegar al contenedor.
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /dbcheck", dbcheck)
	mux.HandleFunc("/", notReady)
	ready := &lazyApp{fallback: mux}
	if err := ready.try(ctx); err != nil {
		go ready.retry(ctx, err)
	}
	defer ready.close()
	var handler http.Handler = ready

	// otelhttp: un span por petición y las métricas http.server.* (duración,
	// tamaño) etiquetadas por ruta y código de estado. /health queda fuera
	// para no llenar las trazas con la sonda de Cloud Monitoring.
	srv := &http.Server{
		Addr: ":" + port,
		// CrossOriginProtection: CSRF por Sec-Fetch-Site/Origin, sin tokens en
		// cada formulario. Junto a SameSite=Lax en la cookie de sesión.
		Handler: otelhttp.NewHandler(http.NewCrossOriginProtection().Handler(handler), "http",
			otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/health" }),
			// Con el patrón del mux (/t/{team}/...) y no la ruta real: los ids
			// dispararían la cardinalidad de spans y métricas.
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
				if r.Pattern != "" {
					return r.Pattern
				}
				return r.Method + " " + r.URL.Path
			}),
		),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		slog.Info("listening", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server", "err", err)
			stop()
		}
	}()

	// Apagado ordenado: Cloud Run manda SIGTERM y da 10 s; se vacían las
	// peticiones en curso y los buffers de telemetría antes de salir.
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown", "err", err)
	}
	if err := shutdownOTel(shutdownCtx); err != nil {
		slog.Error("otel shutdown", "err", err)
	}
}

# fixcomap/plantilla

App para que los entrenadores pasen lista, gestionen la plantilla y generen la imagen de convocados.
Go (sin framework), Postgres en Neon, servida en Cloud Run.

Producción: https://plantilla.fixcomap.com

## Desarrollo local

Requisitos: Go (versión de `go.mod`) y un Postgres.

```sh
printf '%s' 'postgres://user:pass@localhost:5432/plantilla?sslmode=disable' > /tmp/database-url
export DATABASE_URL_FILE=/tmp/database-url
DEV_USER=tu@email go run .                 # http://localhost:8080, sesión iniciada como DEV_USER
TEST_DATABASE_URL=postgres://… go test -race ./...   # sin la variable, los tests de integración se saltan
```

`DEV_USER` se salta el login de Google y solo funciona en local. Las migraciones (`migrations/*.sql`,
embebidas) se aplican solas al arrancar.

## Despliegue

Pipeline estándar de [fixcomap/platform](https://github.com/fixcomap/platform): PR → checks;
`develop` → entorno de desarrollo (privado); `main` → producción con aprobación.

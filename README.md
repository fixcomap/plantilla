# fixcomap/plantilla

App para que los entrenadores pasen lista, gestionen la plantilla y generen la imagen de convocados.
Go (sin framework), Postgres en Neon, servida en Cloud Run.

| Entorno | URL | Rama | Servicio Cloud Run |
|---|---|---|---|
| Producción | https://plantilla.fixcomap.com (`app.fixcomap.com` redirige) | `main` | `plantilla` |
| Desarrollo | https://plantilla.dev.fixcomap.com (`dev.fixcomap.com` redirige) | `develop` | `plantilla-dev` |

## Cómo se despliega

Este repo no tiene pipeline propio. `.github/workflows/ci.yml` es el mismo en todos los repos de
fixcomap y llama al pipeline estándar de [`fixcomap/platform`](https://github.com/fixcomap/platform),
que lee [`catalog/plantilla.yaml`](https://github.com/fixcomap/platform/blob/main/catalog/plantilla.yaml)
para saber qué es este repo (`type: webapp`) y cómo desplegarlo.

| Evento | Qué pasa |
|---|---|
| PR a `develop` o `main` | gitflow, gitleaks + trivy, `gofmt`, `go vet`, golangci-lint, `go test -race`, build de la imagen + trivy (sin publicar) |
| Merge a `develop` | lo anterior + imagen a Artifact Registry, firma cosign y despliegue en `plantilla-dev` |
| Merge a `main` | igual sobre `plantilla`, tras aprobar el environment `production`; crea el tag `vX.Y.Z` de `VERSION` |

El único check obligatorio es `cicd / ok`. Si un deploy falla, Cloud Run sigue sirviendo la revisión
anterior.

Flujo de ramas (GitFlow):

```sh
git switch develop && git pull && git switch -c feature/<cambio>
# ... cambios, commits "<tipo>(<ámbito>): <descripción>" ...
gh pr create --base develop --fill          # checks en verde, sin aprobación
# probar en plantilla.dev.fixcomap.com; para publicar:
git switch develop && git pull && git switch -c release/<x.y.z>
printf '<x.y.z>\n' > VERSION && git commit -am "chore(release): <x.y.z>"
gh pr create --base main --fill             # 1 aprobación (o bypass de admin)
# tras el merge: PR de main a develop (back-merge)
```

## Desarrollo local

Requisitos: Go (versión de `go.mod`) y un Postgres.

```sh
printf '%s' 'postgres://user:pass@localhost:5432/plantilla?sslmode=disable' > /tmp/database-url
export DATABASE_URL_FILE=/tmp/database-url
DEV_USER=tu@email go run .                 # http://localhost:8080, sesión iniciada como DEV_USER
TEST_DATABASE_URL=postgres://… go test -race ./...   # sin la variable, los tests de integración se saltan
```

`DEV_USER` se salta el login de Google y solo funciona fuera de Cloud Run (`K_SERVICE` vacío). Para
probar el login real, `APP_CONFIG` con el JSON de `Config` (`auth.go`) y la redirect URI
`http://localhost:8080/auth/callback` en el cliente OAuth. Las migraciones (`migrations/*.sql`,
embebidas) se aplican solas al arrancar.

## Configuración en Cloud Run

Contrato con el pipeline estándar: la app escucha en `8080` y `/health` responde 200 sin tocar la
base de datos. `/dbcheck` hace `SELECT 1` y responde `db ok` o 503.

| Variable | Origen |
|---|---|
| `APP_CONFIG` | secreto `plantilla-config` (JSON de `Config` en `auth.go`) |
| `DATABASE_URL_FILE` | secreto `plantilla-database-url`, montado en `/secrets/database-url` |
| `DB_NAME` | catálogo: `app_dev` en desarrollo; en producción, la de la cadena de conexión |
| `APP_BASE_URL` | catálogo: primer hostname del entorno; el resto redirigen a él |
| `OTEL_*` | solo producción exporta a Grafana Cloud |

Los secretos los crea `platform` con un placeholder; el valor real se carga a mano y nunca pasa por
un repo:

```sh
printf '%s' '<valor>' | gcloud secrets versions add plantilla-config --project fixcomap-core --data-file=-
printf '%s' 'postgresql://USER:PASS@HOST/neondb?sslmode=require' | \
  gcloud secrets versions add plantilla-database-url --project fixcomap-core --data-file=-
```

`plantilla-database-url` se lee al arrancar cada instancia (basta con que escale a cero);
`plantilla-config` necesita un despliegue nuevo. Si falta la configuración o la base de datos, la app
arranca igual y responde 503 (log `app sin arrancar`), así que `/health` no lo detecta: mirar `/dbcheck`.

## Verificar la firma de una imagen

```sh
cosign verify \
  --certificate-identity-regexp '^https://github.com/fixcomap/platform/\.github/workflows/cicd\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  europe-west1-docker.pkg.dev/fixcomap-core/docker/plantilla@sha256:<digest>
```

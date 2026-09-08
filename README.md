# Marketplace API con Elysia

Backend para una app Android de compraventa. Incluye autenticación por OTP y contraseña, perfiles y reputación, publicaciones con borradores, imágenes, favoritos, búsquedas guardadas, preguntas, ofertas, operaciones y calificaciones. La persistencia usa Drizzle ORM sobre SQLite nativo de Bun.

## Requisitos y ejecución

- [Bun](https://bun.sh/) 1.2 o posterior.
- No requiere una base externa: Drizzle usa el driver `bun:sqlite`.

```bash
bun install
cp .env.example .env
bun run dev
```

En Windows PowerShell, el segundo comando se puede reemplazar por `Copy-Item .env.example .env`.

La API queda disponible en `http://localhost:3000`. `GET /health` verifica el estado y `GET /docs` devuelve un índice de rutas. Para probar:

```bash
bun run typecheck
bun test
```

## Base de datos con Drizzle

El esquema tipado está en `src/db/schema.ts`, la conexión y ejecución automática de migraciones en `src/database.ts`, y las migraciones versionadas en `drizzle/`. No hay consultas SQL directas en las rutas.

Después de modificar el esquema:

```bash
bun run db:generate
bun run db:migrate
```

Para inspeccionar los datos visualmente:

```bash
bun run db:studio
```

Para cargar datos de prueba (el comando es idempotente y no borra datos existentes):

```bash
bun run db:seed
```

El seed crea publicaciones, favoritos, búsquedas, preguntas, ofertas, una operación y reseñas.
También crea `ana@example.com`, `bruno@example.com` y `carla@example.com`; los tres usuarios
pueden iniciar sesión con la contraseña `password123`.

Al iniciar la API también se aplican automáticamente las migraciones pendientes, incluyendo en los tests con una base SQLite en memoria.

## Estructura

```
src/
  index.ts       arranque del servidor
  app.ts         creación de la app, CORS, manejo de errores e índice de rutas
  config.ts      configuración leída del entorno (falla al arrancar si es inválida)
  database.ts    conexión SQLite y ejecución de migraciones
  auth.ts        sesiones: hash de token, requireUser / optionalUser
  queries.ts     consultas compartidas entre rutas (perfil público, imágenes)
  types.ts       constantes del dominio y schemas de validación reutilizables
  utils.ts       helpers sin dependencias (fechas, precios, paginación)
  db/schema.ts   esquema Drizzle
  routes/        auth, users, publications, interactions
```

Las rutas reciben la instancia de base por parámetro (`authRoutes(db)`), así los tests pueden
inyectar una base en memoria sin tocar el disco.

## Autenticación

1. Enviar `{ "email": "...", "purpose": "registration" }` a `POST /auth/otp/request`.
2. En desarrollo, la respuesta incluye `devCode`. En producción hay que conectar el envío de email en `src/routes/auth.ts`; el código nunca se devuelve si `NODE_ENV=production`.
3. Confirmar con `POST /auth/otp/verify`. En registro también acepta `name`, `username`, `password`, `phone` y `zone`.
4. Enviar el token resultante en las rutas privadas: `Authorization: Bearer <token>`.

Para entrar con OTP se usa `purpose: "login"`. También existe `POST /auth/login/password` con `{ "login": "email-o-usuario", "password": "..." }`. Los OTP vencen, se invalidan al reenviar, tienen espera de 30 segundos y se bloquean tras cinco intentos fallidos.

## Rutas principales

| Área | Método y ruta | Uso |
|---|---|---|
| Auth | `POST /auth/otp/request`, `/auth/otp/resend`, `/auth/otp/verify` | Registro y acceso por código |
| Auth | `POST /auth/login/password`, `POST /auth/logout` | Login tradicional y cierre de sesión |
| Perfil | `GET /me`, `PATCH /me` | Perfil privado |
| Perfil | `GET /users/:id` | Reputación, antigüedad y publicaciones activas |
| Home | `GET /publications` | Paginación, texto, categoría, precio, condición, zona y orden |
| Home | `GET /categories` | Categorías disponibles |
| Detalle | `GET /publications/:id` | Galería, vendedor, preguntas y acciones disponibles |
| Publicación | `POST /publications/drafts` | Crear un borrador persistente |
| Publicación | `PATCH /publications/:id` | Guardar cualquier paso del borrador o editar una publicación |
| Publicación | `POST /publications/:id/publish` | Validar y activar un borrador completo |
| Publicación | `PATCH /publications/:id/status` | Pausar o reactivar |
| Publicación | `GET /me/publications` | Listar publicaciones propias por estado |
| Imágenes | `POST /uploads/images`, `GET /uploads/:filename` | Subir y servir JPG, PNG o WebP de hasta 5 MB |
| Favoritos | `POST/DELETE /publications/:id/favorite` | Agregar o quitar |
| Favoritos | `GET /me/favorites`, `POST /me/favorites/read` | Listado e indicador por cambios de precio |
| Búsquedas | `POST/GET /saved-searches` | Guardar filtros y ver novedades |
| Búsquedas | `POST /saved-searches/:id/read`, `DELETE /saved-searches/:id` | Marcar como leída o eliminar |
| Preguntas | `POST /publications/:id/questions`, `POST /questions/:id/answer` | Consulta y respuesta |
| Ofertas | `POST /publications/:id/offers`, `POST /offers/:id/respond` | Ofertar y aceptar/rechazar |
| Ofertas | `POST /offers/:id/cancel`, `GET /me/offers` | Cancelar una oferta propia y listar las propias |
| Operaciones | `GET /me/operations`, `POST /operations/:id/reviews` | Historial y calificaciones |

`GET /docs` devuelve este mismo índice en JSON.

### Parámetros del home

`GET /publications` acepta `page`, `pageSize`, `q`, `category`, `minPrice`, `maxPrice`, `condition`, `zone` y `sort`. Los órdenes son `recent`, `price_asc` y `price_desc`. La cercanía actual es coincidencia por zona; si la app incorpora coordenadas, se puede reemplazar por un radio geográfico.

Las condiciones son `new`, `like_new` y `used`. Las categorías se consultan con `GET /categories`.

## Borradores e imágenes

Android puede subir cada foto como `multipart/form-data` a `POST /uploads/images` (campo `file`) y guardar las URLs devueltas en `imageUrls`. Cada `PATCH /publications/:id` persiste además `draftStep`, por lo que la app puede volver exactamente al paso pendiente.

Una publicación solo se activa si tiene título, descripción, categoría, precio, condición, zona y al menos una imagen.

## Novedades y reputación

- Si cambia el precio de una publicación favorita, `GET /me/favorites` devuelve `hasUpdate` y `priceChanged`.
- Al publicar un artículo nuevo se incrementa `unreadCount` de cada búsqueda guardada compatible.
- Aceptar una oferta marca el artículo como vendido, rechaza las demás ofertas pendientes y crea una operación.
- Comprador y vendedor pueden calificar una vez por operación. El perfil público calcula promedio, cantidad de calificaciones, compras y ventas concretadas.

## Configuración

| Variable | Default | Descripción |
|---|---:|---|
| `PORT` | `3000` | Puerto HTTP |
| `DATABASE_PATH` | `data/marketplace.sqlite` | Archivo SQLite |
| `OTP_TTL_MINUTES` | `10` | Vigencia del código |
| `SESSION_DAYS` | `30` | Duración de la sesión |
| `NODE_ENV` | `development` | En `production` oculta el OTP |

Para producción conviene reemplazar el almacenamiento local de imágenes por S3/Cloudinary, conectar un proveedor de correo, restringir CORS al dominio de la app/API y servir todo detrás de HTTPS.

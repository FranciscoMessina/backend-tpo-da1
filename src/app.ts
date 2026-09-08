import { lte } from "drizzle-orm";
import { Elysia } from "elysia";
import { config } from "./config";
import { createDatabase, type AppDatabase } from "./database";
import { otpCodes, sessions } from "./db/schema";
import { ApiError } from "./errors";
import { authRoutes } from "./routes/auth";
import { interactionRoutes } from "./routes/interactions";
import { publicationRoutes } from "./routes/publications";
import { userRoutes } from "./routes/users";
import { nowIso } from "./utils";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-max-age": "600",
};

/** Índice de rutas que devuelve `GET /docs`, agrupado por área funcional. */
const ROUTE_INDEX = {
  authentication: [
    "POST /auth/otp/request",
    "POST /auth/otp/resend",
    "POST /auth/otp/verify",
    "POST /auth/login/password",
    "POST /auth/logout",
  ],
  profiles: ["GET /me", "PATCH /me", "GET /users/:id"],
  publications: [
    "GET /categories",
    "GET /publications",
    "GET /publications/:id",
    "POST /publications/drafts",
    "PATCH /publications/:id",
    "POST /publications/:id/publish",
    "PATCH /publications/:id/status",
    "GET /me/publications",
    "POST /uploads/images",
    "GET /uploads/:filename",
  ],
  favorites: [
    "POST /publications/:id/favorite",
    "DELETE /publications/:id/favorite",
    "GET /me/favorites",
    "POST /me/favorites/read",
  ],
  savedSearches: [
    "POST /saved-searches",
    "GET /saved-searches",
    "POST /saved-searches/:id/read",
    "DELETE /saved-searches/:id",
  ],
  questions: ["POST /publications/:id/questions", "POST /questions/:id/answer"],
  offers: ["POST /publications/:id/offers", "POST /offers/:id/respond", "POST /offers/:id/cancel", "GET /me/offers"],
  operations: ["GET /me/operations", "POST /operations/:id/reviews"],
};

/** Descarta sesiones y códigos OTP vencidos: no aportan nada y sólo hacen crecer las tablas. */
function purgeExpiredRecords(db: AppDatabase) {
  const now = nowIso();
  db.delete(sessions).where(lte(sessions.expiresAt, now)).run();
  db.delete(otpCodes).where(lte(otpCodes.expiresAt, now)).run();
}

export function createApp(db: AppDatabase = createDatabase()) {
  purgeExpiredRecords(db);

  return new Elysia()
    .error({ ApiError })
    .onRequest(({ set }) => {
      Object.assign(set.headers, CORS_HEADERS);
    })
    .onAfterResponse(({ request, set }) => {
      console.log(`${request.method} ${new URL(request.url).pathname} ${set.status ?? 200}`);
    })
    .onError(({ code, error, status }) => {
      if (error instanceof ApiError)
        return status(error.statusCode, { error: { code: error.code, message: error.message } });
      if (code === "VALIDATION")
        return status(422, { error: { code: "VALIDATION_ERROR", message: "Los datos enviados no son válidos" } });
      if (code === "NOT_FOUND")
        return status(404, { error: { code: "ROUTE_NOT_FOUND", message: "Ruta no encontrada" } });

      console.error(error);
      return status(500, { error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" } });
    })
    .as("global")
    .options("/*", ({ status }) => status(204))
    .get("/", () => ({
      name: config.name,
      version: config.version,
      health: "/health",
      documentation: "/docs",
    }))
    .get("/health", () => ({ status: "ok", timestamp: nowIso() }))
    .get("/docs", () => ROUTE_INDEX)
    .use(authRoutes(db))
    .use(userRoutes(db))
    .use(publicationRoutes(db))
    .use(interactionRoutes(db));
}

import pkg from "../package.json";

/** Lee una variable numérica del entorno y falla al arrancar si tiene un valor imposible. */
function envNumber(name: string, fallback: number) {
  const raw = Bun.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`La variable de entorno ${name} debe ser un número positivo (recibido: "${raw}")`);
  return parsed;
}

const nodeEnv = Bun.env.NODE_ENV ?? "development";

export const config = {
  name: "Marketplace API",
  version: pkg.version,
  port: envNumber("PORT", 3000),
  databasePath: Bun.env.DATABASE_PATH ?? "data/marketplace.sqlite",
  otpTtlMinutes: envNumber("OTP_TTL_MINUTES", 10),
  sessionDays: envNumber("SESSION_DAYS", 30),
  nodeEnv,
  isProduction: nodeEnv === "production",
} as const;

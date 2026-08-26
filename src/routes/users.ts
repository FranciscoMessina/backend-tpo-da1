import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { publications, users } from "../db/schema";
import { ApiError } from "../errors";
import { getCoverImages, getPublicUser } from "../queries";
import { zoneSchema } from "../types";
import { normalizeEmail, priceFromCents } from "../utils";

const profileColumns = {
  id: users.id,
  email: users.email,
  username: users.username,
  name: users.name,
  phone: users.phone,
  zone: users.zone,
  createdAt: users.createdAt,
};

const updateProfileBody = t.Object({
  name: t.Optional(t.String({ minLength: 2, maxLength: 80 })),
  email: t.Optional(t.String({ format: "email", maxLength: 254 })),
  phone: t.Optional(t.Nullable(t.String({ minLength: 6, maxLength: 30 }))),
  zone: t.Optional(t.Nullable(zoneSchema)),
});

export function userRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/me", async ({ headers }) => {
      const user = await requireUser(db, headers);
      return { ...user, reputation: getPublicUser(db, user.id) };
    })
    .patch(
      "/me",
      async ({ headers, body }) => {
        const user = await requireUser(db, headers);
        const current = db
          .select({ email: users.email, name: users.name, phone: users.phone, zone: users.zone })
          .from(users)
          .where(eq(users.id, user.id))
          .get()!;

        // `phone` y `zone` son nullables: distinguimos "no lo mandaron" de "lo mandaron en null".
        const next = {
          name: body.name ?? current.name,
          email: body.email ? normalizeEmail(body.email) : current.email,
          phone: ("phone" in body ? body.phone : current.phone) ?? null,
          zone: ("zone" in body ? body.zone : current.zone) ?? null,
        };

        try {
          db.update(users).set(next).where(eq(users.id, user.id)).run();
        } catch (error) {
          if (String(error).includes("users.email"))
            throw new ApiError(409, "EMAIL_ALREADY_REGISTERED", "El email ya está registrado");
          throw error;
        }
        return db.select(profileColumns).from(users).where(eq(users.id, user.id)).get();
      },
      { body: updateProfileBody },
    )
    .get("/users/:id", ({ params }) => {
      const profile = getPublicUser(db, params.id);
      if (!profile) throw new ApiError(404, "USER_NOT_FOUND", "Usuario no encontrado");

      const rows = db
        .select({
          id: publications.id,
          title: publications.title,
          priceCents: publications.priceCents,
          itemCondition: publications.itemCondition,
          zone: publications.zone,
          publishedAt: publications.publishedAt,
        })
        .from(publications)
        .where(and(eq(publications.sellerId, params.id), eq(publications.status, "active")))
        .orderBy(desc(publications.publishedAt))
        .all();
      const covers = getCoverImages(db, rows.map((row) => row.id));

      const activePublications = rows.map(({ priceCents, ...row }) => ({
        ...row,
        price: priceFromCents(priceCents),
        coverImage: covers.get(row.id) ?? null,
      }));
      return { ...profile, activePublications };
    });
}

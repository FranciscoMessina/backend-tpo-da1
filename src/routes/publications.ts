import { and, asc, count, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { optionalUser, requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { favorites, publications, questions, savedSearches, users } from "../db/schema";
import { ApiError } from "../errors";
import { getCoverImages, getPublicUser, listImages, replaceImages } from "../queries";
import {
  categories,
  categorySchema,
  conditionSchema,
  priceSchema,
  publicationStatusSchema,
  sortSchema,
  zoneSchema,
} from "../types";
import { centsFromPrice, nowIso, parsePositiveInt, priceFromCents } from "../utils";

type Publication = typeof publications.$inferSelect;
type SavedSearch = typeof savedSearches.$inferSelect;

/** Campos obligatorios para que un borrador pueda pasar a `active`. */
const REQUIRED_TO_PUBLISH = ["title", "description", "category", "priceCents", "itemCondition", "zone"] as const;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const ALLOWED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const UPLOADS_DIR = "uploads";
const UPLOAD_FILENAME_PATTERN = /^[a-f0-9-]+\.(jpg|jpeg|png|webp)$/i;

const publicationBody = t.Object({
  title: t.Optional(t.String({ minLength: 3, maxLength: 120 })),
  description: t.Optional(t.String({ minLength: 10, maxLength: 5000 })),
  category: t.Optional(categorySchema),
  price: t.Optional(priceSchema),
  condition: t.Optional(conditionSchema),
  zone: t.Optional(zoneSchema),
  draftStep: t.Optional(t.Integer({ minimum: 1, maximum: 7 })),
  imageUrls: t.Optional(t.Array(t.String({ format: "uri", maxLength: 2000 }), { maxItems: 10 })),
});

const feedQuery = t.Object({
  page: t.Optional(t.String()),
  pageSize: t.Optional(t.String()),
  q: t.Optional(t.String({ maxLength: 200 })),
  category: t.Optional(categorySchema),
  condition: t.Optional(conditionSchema),
  zone: t.Optional(t.String({ maxLength: 100 })),
  minPrice: t.Optional(t.Numeric({ minimum: 0 })),
  maxPrice: t.Optional(t.Numeric({ minimum: 0 })),
  sort: t.Optional(sortSchema),
});

function matchesSearch(search: SavedSearch, publication: Publication) {
  const text = (search.queryText ?? "").toLowerCase();
  if (text && !`${publication.title} ${publication.description}`.toLowerCase().includes(text)) return false;
  if (search.category && search.category !== publication.category) return false;
  if (search.itemCondition && search.itemCondition !== publication.itemCondition) return false;
  if (search.zone && search.zone.toLowerCase() !== publication.zone?.toLowerCase()) return false;
  if (search.minPriceCents != null && (publication.priceCents ?? 0) < search.minPriceCents) return false;
  if (search.maxPriceCents != null && (publication.priceCents ?? 0) > search.maxPriceCents) return false;
  return true;
}

/** Suma una novedad a cada búsqueda guardada (ajena) que matchee la publicación recién activada. */
function notifySavedSearches(db: AppDatabase, publication: Publication) {
  const searches = db.select().from(savedSearches).where(ne(savedSearches.userId, publication.sellerId)).all();
  const matched = searches.filter((search) => matchesSearch(search, publication));
  if (matched.length === 0) return;
  db.transaction((tx) => {
    for (const search of matched) {
      tx.update(savedSearches)
        .set({ unreadCount: sql`${savedSearches.unreadCount} + 1` })
        .where(eq(savedSearches.id, search.id))
        .run();
    }
  });
}

/** Busca una publicación y valida que la request venga de su vendedor. */
function findOwnedPublication(db: AppDatabase, publicationId: string, userId: string, action: string) {
  const publication = db.select().from(publications).where(eq(publications.id, publicationId)).get();
  if (!publication) throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publicación no encontrada");
  if (publication.sellerId !== userId) throw new ApiError(403, "NOT_OWNER", `Solo el vendedor puede ${action}`);
  return publication;
}

export function publicationRoutes(db: AppDatabase) {
  return new Elysia()
    .get("/categories", () => ({ items: categories }))
    .get(
      "/publications",
      ({ query }) => {
        if (query.minPrice != null && query.maxPrice != null && query.minPrice > query.maxPrice)
          throw new ApiError(400, "INVALID_PRICE_RANGE", "El precio mínimo no puede superar al máximo");

        const page = parsePositiveInt(query.page, 1, 10_000);
        const pageSize = parsePositiveInt(query.pageSize, 20, 50);

        const clauses: SQL[] = [eq(publications.status, "active")];
        if (query.q) {
          const pattern = `%${query.q.toLowerCase()}%`;
          clauses.push(
            sql`(lower(${publications.title}) LIKE ${pattern} OR lower(${publications.description}) LIKE ${pattern})`,
          );
        }
        if (query.category) clauses.push(eq(publications.category, query.category));
        if (query.condition) clauses.push(eq(publications.itemCondition, query.condition));
        if (query.zone) clauses.push(sql`lower(${publications.zone}) = lower(${query.zone})`);
        if (query.minPrice != null) clauses.push(sql`${publications.priceCents} >= ${centsFromPrice(query.minPrice)}`);
        if (query.maxPrice != null) clauses.push(sql`${publications.priceCents} <= ${centsFromPrice(query.maxPrice)}`);
        const where = and(...clauses);

        const order =
          query.sort === "price_asc"
            ? asc(publications.priceCents)
            : query.sort === "price_desc"
              ? desc(publications.priceCents)
              : desc(publications.publishedAt);

        const total = db.select({ value: count() }).from(publications).where(where).get()?.value ?? 0;
        const rows = db
          .select({
            id: publications.id,
            title: publications.title,
            description: publications.description,
            category: publications.category,
            priceCents: publications.priceCents,
            itemCondition: publications.itemCondition,
            zone: publications.zone,
            publishedAt: publications.publishedAt,
            sellerId: users.id,
            sellerName: users.name,
          })
          .from(publications)
          .innerJoin(users, eq(users.id, publications.sellerId))
          .where(where)
          .orderBy(order)
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .all();

        const covers = getCoverImages(db, rows.map((row) => row.id));
        const items = rows.map(({ priceCents, ...row }) => ({
          ...row,
          price: priceFromCents(priceCents),
          coverImage: covers.get(row.id) ?? null,
        }));
        return { items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
      },
      { query: feedQuery },
    )
    .get("/publications/:id", async ({ params, headers }) => {
      const publication = db.select().from(publications).where(eq(publications.id, params.id)).get();
      const viewer = await optionalUser(db, headers);
      const isOwner = !!viewer && viewer.id === publication?.sellerId;
      // Los borradores y las pausadas solo son visibles para su vendedor.
      if (!publication || (["draft", "paused"].includes(publication.status) && !isOwner))
        throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publicación no encontrada");

      const questionRows = db
        .select({
          id: questions.id,
          text: questions.text,
          answer: questions.answer,
          createdAt: questions.createdAt,
          answeredAt: questions.answeredAt,
          askerId: users.id,
          askerName: users.name,
        })
        .from(questions)
        .innerJoin(users, eq(users.id, questions.askerId))
        .where(eq(questions.publicationId, params.id))
        .orderBy(desc(questions.createdAt))
        .all();
      const isFavorite =
        !!viewer &&
        !!db
          .select({ userId: favorites.userId })
          .from(favorites)
          .where(and(eq(favorites.userId, viewer.id), eq(favorites.publicationId, params.id)))
          .get();

      const canInteract = !!viewer && !isOwner && publication.status === "active";
      const { priceCents, ...rest } = publication;
      return {
        ...rest,
        price: priceFromCents(priceCents),
        images: listImages(db, params.id),
        seller: getPublicUser(db, publication.sellerId),
        questions: questionRows,
        isFavorite,
        actions: {
          canAsk: canInteract,
          canOffer: canInteract,
          canFavorite: !!viewer && !isOwner,
          canManage: isOwner,
        },
      };
    })
    .post(
      "/publications/drafts",
      async ({ headers, body }) => {
        const user = await requireUser(db, headers);
        const id = crypto.randomUUID();
        const now = nowIso();
        const draftStep = body.draftStep ?? 1;
        db.insert(publications)
          .values({
            id,
            sellerId: user.id,
            title: body.title ?? "",
            description: body.description ?? "",
            category: body.category ?? null,
            priceCents: centsFromPrice(body.price),
            itemCondition: body.condition ?? null,
            zone: body.zone ?? user.zone,
            status: "draft",
            draftStep,
            publishedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        if (body.imageUrls) replaceImages(db, id, body.imageUrls);
        return { id, status: "draft", draftStep };
      },
      { body: publicationBody },
    )
    .patch(
      "/publications/:id",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        const current = findOwnedPublication(db, params.id, user.id, "editarla");
        if (current.status === "sold")
          throw new ApiError(409, "PUBLICATION_SOLD", "Una publicación vendida no se puede editar");

        const priceCents = body.price === undefined ? current.priceCents : centsFromPrice(body.price);
        db.update(publications)
          .set({
            title: body.title ?? current.title,
            description: body.description ?? current.description,
            category: body.category ?? current.category,
            priceCents,
            itemCondition: body.condition ?? current.itemCondition,
            zone: body.zone ?? current.zone,
            draftStep: body.draftStep ?? current.draftStep,
            updatedAt: nowIso(),
          })
          .where(eq(publications.id, params.id))
          .run();
        if (body.imageUrls) replaceImages(db, params.id, body.imageUrls);
        // Un cambio de precio le avisa a quienes la tienen en favoritos.
        if (current.priceCents !== priceCents)
          db.update(favorites).set({ hasUpdate: true }).where(eq(favorites.publicationId, params.id)).run();

        const updated = db.select().from(publications).where(eq(publications.id, params.id)).get()!;
        return { ...updated, images: listImages(db, params.id) };
      },
      { body: publicationBody },
    )
    .post("/publications/:id/publish", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      const publication = findOwnedPublication(db, params.id, user.id, "publicarla");
      if (publication.status !== "draft")
        throw new ApiError(409, "INVALID_STATUS", "Solo se puede publicar un borrador");

      const missing = REQUIRED_TO_PUBLISH.filter(
        (field) => publication[field] == null || publication[field] === "",
      );
      if (missing.length) throw new ApiError(400, "INCOMPLETE_DRAFT", `Faltan campos: ${missing.join(", ")}`);
      if (listImages(db, params.id).length === 0)
        throw new ApiError(400, "INCOMPLETE_DRAFT", "Debe haber al menos una imagen");

      const now = nowIso();
      db.update(publications)
        .set({ status: "active", publishedAt: now, updatedAt: now })
        .where(eq(publications.id, params.id))
        .run();
      notifySavedSearches(db, { ...publication, status: "active", publishedAt: now, updatedAt: now });
      return { id: params.id, status: "active", publishedAt: now };
    })
    .patch(
      "/publications/:id/status",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        const publication = findOwnedPublication(db, params.id, user.id, "cambiar el estado");
        const isValidTransition =
          (publication.status === "active" && body.status === "paused") ||
          (publication.status === "paused" && body.status === "active");
        if (!isValidTransition)
          throw new ApiError(409, "INVALID_STATUS_TRANSITION", "La publicación solo se puede pausar o reactivar");

        db.update(publications)
          .set({ status: body.status, updatedAt: nowIso() })
          .where(eq(publications.id, params.id))
          .run();
        return { id: params.id, status: body.status };
      },
      { body: t.Object({ status: t.Union([t.Literal("active"), t.Literal("paused")]) }) },
    )
    .get(
      "/me/publications",
      async ({ headers, query }) => {
        const user = await requireUser(db, headers);
        const where = query.status
          ? and(eq(publications.sellerId, user.id), eq(publications.status, query.status))
          : eq(publications.sellerId, user.id);
        const items = db
          .select()
          .from(publications)
          .where(where)
          .orderBy(desc(publications.updatedAt))
          .all()
          .map((item) => ({ ...item, images: listImages(db, item.id) }));
        return { items };
      },
      { query: t.Object({ status: t.Optional(publicationStatusSchema) }) },
    )
    .post(
      "/uploads/images",
      async ({ headers, body, request }) => {
        await requireUser(db, headers);
        const extension = EXTENSION_BY_MIME[body.file.type] ?? extname(body.file.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(extension))
          throw new ApiError(400, "INVALID_IMAGE", "Formato de imagen no soportado");

        mkdirSync(UPLOADS_DIR, { recursive: true });
        const filename = `${crypto.randomUUID()}${extension}`;
        await Bun.write(join(UPLOADS_DIR, filename), body.file);
        return { url: new URL(`/uploads/${filename}`, request.url).toString() };
      },
      { body: t.Object({ file: t.File({ type: "image", maxSize: "5m" }) }) },
    )
    .get("/uploads/:filename", ({ params }) => {
      // El nombre siempre lo generamos nosotros (uuid + extensión): cualquier otra cosa es path traversal.
      if (!UPLOAD_FILENAME_PATTERN.test(params.filename))
        throw new ApiError(404, "IMAGE_NOT_FOUND", "Imagen no encontrada");
      return Bun.file(join(UPLOADS_DIR, params.filename));
    });
}

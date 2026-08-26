import { and, desc, eq, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Elysia, t } from "elysia";
import { requireUser } from "../auth";
import type { AppDatabase } from "../database";
import { favorites, offers, operations, publications, questions, reviews, savedSearches, users } from "../db/schema";
import { ApiError } from "../errors";
import { getCoverImages } from "../queries";
import { categorySchema, conditionSchema, priceSchema, sortSchema, zoneSchema } from "../types";
import { centsFromPrice, nowIso, priceFromCents } from "../utils";

const savedSearchBody = t.Object({
  name: t.String({ minLength: 2, maxLength: 80 }),
  query: t.Optional(t.String({ maxLength: 200 })),
  category: t.Optional(categorySchema),
  minPrice: t.Optional(t.Number({ minimum: 0 })),
  maxPrice: t.Optional(t.Number({ minimum: 0 })),
  condition: t.Optional(conditionSchema),
  zone: t.Optional(zoneSchema),
  sort: t.Optional(sortSchema),
});

/** Forma pública de una búsqueda guardada: precios en unidades de moneda y nombres de campo de la API. */
function serializeSavedSearch(search: typeof savedSearches.$inferSelect) {
  const { queryText, minPriceCents, maxPriceCents, itemCondition, ...rest } = search;
  return {
    ...rest,
    query: queryText,
    minPrice: priceFromCents(minPriceCents),
    maxPrice: priceFromCents(maxPriceCents),
    condition: itemCondition,
  };
}

/** Trae la publicación y valida que esté publicada y no sea del propio usuario. */
function findInteractablePublication(db: AppDatabase, publicationId: string, userId: string, action: string) {
  const publication = db
    .select({ sellerId: publications.sellerId, status: publications.status })
    .from(publications)
    .where(eq(publications.id, publicationId))
    .get();
  if (!publication || publication.status !== "active")
    throw new ApiError(404, "PUBLICATION_NOT_FOUND", "La publicación no está activa");
  if (publication.sellerId === userId) throw new ApiError(400, "OWN_PUBLICATION", action);
  return publication;
}

export function interactionRoutes(db: AppDatabase) {
  return new Elysia()
    .post("/publications/:id/favorite", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      const publication = db
        .select({ sellerId: publications.sellerId, status: publications.status, priceCents: publications.priceCents })
        .from(publications)
        .where(eq(publications.id, params.id))
        .get();
      if (!publication || publication.status === "draft")
        throw new ApiError(404, "PUBLICATION_NOT_FOUND", "Publicación no encontrada");
      if (publication.sellerId === user.id)
        throw new ApiError(400, "OWN_PUBLICATION", "No podés guardar tu propia publicación");

      db.insert(favorites)
        .values({
          userId: user.id,
          publicationId: params.id,
          savedPriceCents: publication.priceCents,
          createdAt: nowIso(),
        })
        .onConflictDoNothing()
        .run();
      return { publicationId: params.id, isFavorite: true };
    })
    .delete("/publications/:id/favorite", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      db.delete(favorites)
        .where(and(eq(favorites.userId, user.id), eq(favorites.publicationId, params.id)))
        .run();
      return { publicationId: params.id, isFavorite: false };
    })
    .get("/me/favorites", async ({ headers }) => {
      const user = await requireUser(db, headers);
      const rows = db
        .select({ publication: publications, favorite: favorites })
        .from(favorites)
        .innerJoin(publications, eq(publications.id, favorites.publicationId))
        .where(eq(favorites.userId, user.id))
        .orderBy(desc(favorites.createdAt))
        .all();
      const covers = getCoverImages(db, rows.map(({ publication }) => publication.id));

      const items = rows.map(({ publication, favorite }) => ({
        id: publication.id,
        title: publication.title,
        price: priceFromCents(publication.priceCents),
        itemCondition: publication.itemCondition,
        zone: publication.zone,
        status: publication.status,
        hasUpdate: favorite.hasUpdate,
        favoritedAt: favorite.createdAt,
        priceChanged: favorite.savedPriceCents !== publication.priceCents ? 1 : 0,
        coverImage: covers.get(publication.id) ?? null,
      }));
      return { items, unreadCount: items.filter((item) => item.hasUpdate).length };
    })
    .post("/me/favorites/read", async ({ headers }) => {
      const user = await requireUser(db, headers);
      const rows = db
        .select({ publicationId: favorites.publicationId, priceCents: publications.priceCents })
        .from(favorites)
        .innerJoin(publications, eq(publications.id, favorites.publicationId))
        .where(eq(favorites.userId, user.id))
        .all();
      db.transaction((tx) => {
        for (const row of rows) {
          tx.update(favorites)
            .set({ hasUpdate: false, savedPriceCents: row.priceCents })
            .where(and(eq(favorites.userId, user.id), eq(favorites.publicationId, row.publicationId)))
            .run();
        }
      });
      return { unreadCount: 0 };
    })
    .post(
      "/saved-searches",
      async ({ headers, body }) => {
        const user = await requireUser(db, headers);
        const now = nowIso();
        const search = {
          id: crypto.randomUUID(),
          userId: user.id,
          name: body.name,
          queryText: body.query ?? null,
          category: body.category ?? null,
          minPriceCents: centsFromPrice(body.minPrice),
          maxPriceCents: centsFromPrice(body.maxPrice),
          itemCondition: body.condition ?? null,
          zone: body.zone ?? null,
          sort: body.sort ?? "recent",
          unreadCount: 0,
          createdAt: now,
          lastCheckedAt: now,
        } satisfies typeof savedSearches.$inferSelect;

        db.insert(savedSearches).values(search).run();
        return serializeSavedSearch(search);
      },
      { body: savedSearchBody },
    )
    .get("/saved-searches", async ({ headers }) => {
      const user = await requireUser(db, headers);
      const items = db
        .select()
        .from(savedSearches)
        .where(eq(savedSearches.userId, user.id))
        .orderBy(desc(savedSearches.createdAt))
        .all()
        .map(serializeSavedSearch);
      return { items, unreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0) };
    })
    .post("/saved-searches/:id/read", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      const result = db
        .update(savedSearches)
        .set({ unreadCount: 0, lastCheckedAt: nowIso() })
        .where(and(eq(savedSearches.id, params.id), eq(savedSearches.userId, user.id)))
        .run();
      if (result.changes === 0) throw new ApiError(404, "SAVED_SEARCH_NOT_FOUND", "Búsqueda guardada no encontrada");
      return { id: params.id, unreadCount: 0 };
    })
    .delete("/saved-searches/:id", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      const result = db
        .delete(savedSearches)
        .where(and(eq(savedSearches.id, params.id), eq(savedSearches.userId, user.id)))
        .run();
      if (result.changes === 0) throw new ApiError(404, "SAVED_SEARCH_NOT_FOUND", "Búsqueda guardada no encontrada");
      return { message: "Búsqueda eliminada" };
    })
    .post(
      "/publications/:id/questions",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        findInteractablePublication(db, params.id, user.id, "No podés preguntarte a vos mismo");
        const id = crypto.randomUUID();
        const createdAt = nowIso();
        db.insert(questions)
          .values({ id, publicationId: params.id, askerId: user.id, text: body.text, createdAt })
          .run();
        return { id, publicationId: params.id, text: body.text, createdAt };
      },
      { body: t.Object({ text: t.String({ minLength: 2, maxLength: 1000 }) }) },
    )
    .post(
      "/questions/:id/answer",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        const question = db
          .select({ sellerId: publications.sellerId })
          .from(questions)
          .innerJoin(publications, eq(publications.id, questions.publicationId))
          .where(eq(questions.id, params.id))
          .get();
        if (!question) throw new ApiError(404, "QUESTION_NOT_FOUND", "Pregunta no encontrada");
        if (question.sellerId !== user.id) throw new ApiError(403, "NOT_OWNER", "Solo el vendedor puede responder");

        const answeredAt = nowIso();
        db.update(questions).set({ answer: body.answer, answeredAt }).where(eq(questions.id, params.id)).run();
        return { id: params.id, answer: body.answer, answeredAt };
      },
      { body: t.Object({ answer: t.String({ minLength: 2, maxLength: 1000 }) }) },
    )
    .post(
      "/publications/:id/offers",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        findInteractablePublication(db, params.id, user.id, "No podés ofertar en tu publicación");
        const id = crypto.randomUUID();
        const now = nowIso();
        db.insert(offers)
          .values({
            id,
            publicationId: params.id,
            buyerId: user.id,
            amountCents: centsFromPrice(body.amount)!,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return { id, publicationId: params.id, amount: body.amount, status: "pending", createdAt: now };
      },
      { body: t.Object({ amount: priceSchema }) },
    )
    .post(
      "/offers/:id/respond",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        const offer = db
          .select({
            id: offers.id,
            publicationId: offers.publicationId,
            buyerId: offers.buyerId,
            amountCents: offers.amountCents,
            status: offers.status,
            sellerId: publications.sellerId,
          })
          .from(offers)
          .innerJoin(publications, eq(publications.id, offers.publicationId))
          .where(eq(offers.id, params.id))
          .get();
        if (!offer) throw new ApiError(404, "OFFER_NOT_FOUND", "Oferta no encontrada");
        if (offer.sellerId !== user.id) throw new ApiError(403, "NOT_OWNER", "Solo el vendedor puede responder");
        if (offer.status !== "pending")
          throw new ApiError(409, "OFFER_ALREADY_RESOLVED", "La oferta ya fue respondida");

        const now = nowIso();
        if (body.action === "reject") {
          db.update(offers).set({ status: "rejected", updatedAt: now }).where(eq(offers.id, offer.id)).run();
          return { id: offer.id, status: "rejected" };
        }

        // Aceptar cierra la venta: marca la publicación, descarta el resto de las ofertas y crea la operación.
        const operationId = crypto.randomUUID();
        db.transaction((tx) => {
          const sold = tx
            .update(publications)
            .set({ status: "sold", updatedAt: now })
            .where(and(eq(publications.id, offer.publicationId), eq(publications.status, "active")))
            .run();
          if (sold.changes === 0)
            throw new ApiError(409, "PUBLICATION_NOT_ACTIVE", "La publicación ya no está activa");

          tx.update(offers).set({ status: "accepted", updatedAt: now }).where(eq(offers.id, offer.id)).run();
          tx.update(offers)
            .set({ status: "rejected", updatedAt: now })
            .where(
              and(
                eq(offers.publicationId, offer.publicationId),
                ne(offers.id, offer.id),
                eq(offers.status, "pending"),
              ),
            )
            .run();
          tx.insert(operations)
            .values({
              id: operationId,
              publicationId: offer.publicationId,
              offerId: offer.id,
              buyerId: offer.buyerId,
              sellerId: offer.sellerId,
              amountCents: offer.amountCents,
              completedAt: now,
            })
            .run();
        });
        return { id: offer.id, status: "accepted", operationId };
      },
      { body: t.Object({ action: t.Union([t.Literal("accept"), t.Literal("reject")]) }) },
    )
    .post("/offers/:id/cancel", async ({ params, headers }) => {
      const user = await requireUser(db, headers);
      const result = db
        .update(offers)
        .set({ status: "cancelled", updatedAt: nowIso() })
        .where(and(eq(offers.id, params.id), eq(offers.buyerId, user.id), eq(offers.status, "pending")))
        .run();
      if (result.changes === 0) throw new ApiError(404, "PENDING_OFFER_NOT_FOUND", "Oferta pendiente no encontrada");
      return { id: params.id, status: "cancelled" };
    })
    .get("/me/offers", async ({ headers }) => {
      const user = await requireUser(db, headers);
      const rows = db
        .select({
          id: offers.id,
          amountCents: offers.amountCents,
          status: offers.status,
          createdAt: offers.createdAt,
          buyerId: offers.buyerId,
          publicationId: publications.id,
          title: publications.title,
        })
        .from(offers)
        .innerJoin(publications, eq(publications.id, offers.publicationId))
        .where(or(eq(offers.buyerId, user.id), eq(publications.sellerId, user.id)))
        .orderBy(desc(offers.createdAt))
        .all();

      const items = rows.map(({ amountCents, buyerId, ...row }) => ({
        ...row,
        amount: amountCents / 100,
        role: buyerId === user.id ? "buyer" : "seller",
      }));
      return { items };
    })
    .get("/me/operations", async ({ headers }) => {
      const user = await requireUser(db, headers);
      const buyer = alias(users, "buyer");
      const seller = alias(users, "seller");
      const rows = db
        .select({
          id: operations.id,
          amountCents: operations.amountCents,
          completedAt: operations.completedAt,
          publicationId: operations.publicationId,
          title: publications.title,
          buyerId: operations.buyerId,
          buyerName: buyer.name,
          sellerId: operations.sellerId,
          sellerName: seller.name,
          myRating: reviews.rating,
        })
        .from(operations)
        .innerJoin(publications, eq(publications.id, operations.publicationId))
        .innerJoin(buyer, eq(buyer.id, operations.buyerId))
        .innerJoin(seller, eq(seller.id, operations.sellerId))
        .leftJoin(reviews, and(eq(reviews.operationId, operations.id), eq(reviews.reviewerId, user.id)))
        .where(or(eq(operations.buyerId, user.id), eq(operations.sellerId, user.id)))
        .orderBy(desc(operations.completedAt))
        .all();

      const items = rows.map(({ amountCents, ...row }) => ({ ...row, amount: amountCents / 100 }));
      return { items };
    })
    .post(
      "/operations/:id/reviews",
      async ({ params, headers, body }) => {
        const user = await requireUser(db, headers);
        const operation = db.select().from(operations).where(eq(operations.id, params.id)).get();
        if (!operation) throw new ApiError(404, "OPERATION_NOT_FOUND", "Operación no encontrada");
        if (user.id !== operation.buyerId && user.id !== operation.sellerId)
          throw new ApiError(403, "NOT_PARTICIPANT", "Solo las partes de la operación pueden calificar");

        const reviewedUserId = user.id === operation.buyerId ? operation.sellerId : operation.buyerId;
        const comment = body.comment ?? null;
        const id = crypto.randomUUID();
        try {
          db.insert(reviews)
            .values({
              id,
              operationId: operation.id,
              reviewerId: user.id,
              reviewedUserId,
              rating: body.rating,
              comment,
              createdAt: nowIso(),
            })
            .run();
        } catch (error) {
          if (String(error).includes("reviews.operation_id"))
            throw new ApiError(409, "ALREADY_REVIEWED", "Ya calificaste esta operación");
          throw error;
        }
        return { id, operationId: operation.id, reviewedUserId, rating: body.rating, comment };
      },
      {
        body: t.Object({
          rating: t.Integer({ minimum: 1, maximum: 5 }),
          comment: t.Optional(t.String({ maxLength: 1000 })),
        }),
      },
    );
}

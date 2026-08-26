import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createDatabase } from "../src/database";

const db = createDatabase(":memory:");
const app = createApp(db);

async function api(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    }),
  );
  const data = await response.json();
  return { response, data };
}

async function register(email: string, name: string) {
  const requested = await api("/auth/otp/request", {
    method: "POST",
    body: { email, purpose: "registration" },
  });
  expect(requested.response.status).toBe(200);
  const verified = await api("/auth/otp/verify", {
    method: "POST",
    body: { email, purpose: "registration", code: requested.data.devCode, name, password: "password123" },
  });
  expect(verified.response.status).toBe(200);
  return { id: verified.data.userId as string, token: verified.data.session.token as string };
}

/** Crea un borrador completo y lo publica. Devuelve el id de la publicación activa. */
async function publish(token: string, overrides: Record<string, unknown> = {}) {
  const draft = await api("/publications/drafts", {
    method: "POST",
    token,
    body: {
      title: "Bicicleta urbana",
      description: "Bicicleta en excelente estado y poco uso",
      category: "sports",
      price: 450,
      condition: "like_new",
      zone: "Palermo",
      draftStep: 7,
      imageUrls: ["https://images.example.com/bike.jpg"],
      ...overrides,
    },
  });
  expect(draft.response.status).toBe(200);
  const published = await api(`/publications/${draft.data.id}/publish`, { method: "POST", token });
  expect(published.data.status).toBe("active");
  return draft.data.id as string;
}

afterAll(() => db.$client.close());

describe("Marketplace API", () => {
  test("flujo completo: registro, publicación, favorito, venta y reputación", async () => {
    const seller = await register("seller@example.com", "Seller");
    const buyer = await register("buyer@example.com", "Buyer");

    const savedSearch = await api("/saved-searches", {
      method: "POST",
      token: buyer.token,
      body: { name: "Bicis cerca", query: "bicicleta", category: "sports", zone: "Palermo" },
    });
    expect(savedSearch.response.status).toBe(200);
    expect(savedSearch.data.query).toBe("bicicleta");
    expect(savedSearch.data.unreadCount).toBe(0);

    const publicationId = await publish(seller.token);

    const feed = await api("/publications?q=bicicleta&category=sports&sort=price_asc");
    expect(feed.data.pagination.total).toBe(1);
    expect(feed.data.items[0].price).toBe(450);
    expect(feed.data.items[0].coverImage).toBe("https://images.example.com/bike.jpg");

    const searches = await api("/saved-searches", { token: buyer.token });
    expect(searches.data.items[0].unreadCount).toBe(1);

    const favorite = await api(`/publications/${publicationId}/favorite`, { method: "POST", token: buyer.token });
    expect(favorite.data.isFavorite).toBe(true);

    await api(`/publications/${publicationId}`, { method: "PATCH", token: seller.token, body: { price: 440 } });
    const favorites = await api("/me/favorites", { token: buyer.token });
    expect(favorites.data.unreadCount).toBe(1);
    expect(favorites.data.items[0].priceChanged).toBe(1);
    expect(favorites.data.items[0].coverImage).toBe("https://images.example.com/bike.jpg");

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 425 },
    });
    const accepted = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });
    expect(accepted.data.status).toBe("accepted");

    const review = await api(`/operations/${accepted.data.operationId}/reviews`, {
      method: "POST",
      token: buyer.token,
      body: { rating: 5, comment: "Excelente vendedor" },
    });
    expect(review.data.rating).toBe(5);

    const profile = await api(`/users/${seller.id}`);
    expect(profile.data.ratingAverage).toBe(5);
    expect(profile.data.salesCompleted).toBe(1);

    const operations = await api("/me/operations", { token: buyer.token });
    expect(operations.data.items).toHaveLength(1);
    expect(operations.data.items[0]).toMatchObject({
      amount: 425,
      title: "Bicicleta urbana",
      buyerName: "Buyer",
      sellerName: "Seller",
      myRating: 5,
    });

    // El vendedor participa de la misma operación pero todavía no calificó.
    const sellerOperations = await api("/me/operations", { token: seller.token });
    expect(sellerOperations.data.items[0].myRating).toBeNull();
  });

  test("ofertas: ambas partes las ven, el comprador puede cancelar y el vendedor rechazar", async () => {
    const seller = await register("offers-seller@example.com", "Offers Seller");
    const buyer = await register("offers-buyer@example.com", "Offers Buyer");
    const publicationId = await publish(seller.token, { title: "Guitarra criolla", category: "other", price: 300 });

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 250 },
    });
    expect(offer.data.status).toBe("pending");

    const asBuyer = await api("/me/offers", { token: buyer.token });
    expect(asBuyer.data.items).toHaveLength(1);
    expect(asBuyer.data.items[0]).toMatchObject({ amount: 250, role: "buyer", title: "Guitarra criolla" });

    const asSeller = await api("/me/offers", { token: seller.token });
    expect(asSeller.data.items).toHaveLength(1);
    expect(asSeller.data.items[0].role).toBe("seller");

    // Un tercero no ve ofertas ajenas.
    const stranger = await register("offers-stranger@example.com", "Stranger");
    expect((await api("/me/offers", { token: stranger.token })).data.items).toHaveLength(0);

    const cancelled = await api(`/offers/${offer.data.id}/cancel`, { method: "POST", token: buyer.token });
    expect(cancelled.data.status).toBe("cancelled");

    const rejected = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });
    expect(rejected.response.status).toBe(409);
    expect(rejected.data.error.code).toBe("OFFER_ALREADY_RESOLVED");
  });

  test("preguntas: sólo el vendedor responde", async () => {
    const seller = await register("questions-seller@example.com", "Q Seller");
    const buyer = await register("questions-buyer@example.com", "Q Buyer");
    const publicationId = await publish(seller.token, { title: "Notebook usada", category: "electronics" });

    const question = await api(`/publications/${publicationId}/questions`, {
      method: "POST",
      token: buyer.token,
      body: { text: "¿Aceptás envío?" },
    });
    expect(question.response.status).toBe(200);

    const byBuyer = await api(`/questions/${question.data.id}/answer`, {
      method: "POST",
      token: buyer.token,
      body: { answer: "Me respondo solo" },
    });
    expect(byBuyer.response.status).toBe(403);

    const answered = await api(`/questions/${question.data.id}/answer`, {
      method: "POST",
      token: seller.token,
      body: { answer: "Sí, hago envíos a todo el país" },
    });
    expect(answered.response.status).toBe(200);

    const detail = await api(`/publications/${publicationId}`);
    expect(detail.data.questions[0].answer).toBe("Sí, hago envíos a todo el país");
    expect(detail.data.questions[0].askerName).toBe("Q Buyer");
  });

  test("pausar oculta la publicación del feed y del detalle ajeno", async () => {
    const seller = await register("paused-seller@example.com", "Paused Seller");
    const publicationId = await publish(seller.token, { title: "Mesa ratona", category: "home", price: 120 });

    const paused = await api(`/publications/${publicationId}/status`, {
      method: "PATCH",
      token: seller.token,
      body: { status: "paused" },
    });
    expect(paused.data.status).toBe("paused");

    const feed = await api("/publications?q=ratona");
    expect(feed.data.pagination.total).toBe(0);
    expect((await api(`/publications/${publicationId}`)).response.status).toBe(404);
    // El dueño sí la ve.
    expect((await api(`/publications/${publicationId}`, { token: seller.token })).response.status).toBe(200);

    const reactivated = await api(`/publications/${publicationId}/status`, {
      method: "PATCH",
      token: seller.token,
      body: { status: "active" },
    });
    expect(reactivated.data.status).toBe("active");
    expect((await api("/publications?q=ratona")).data.pagination.total).toBe(1);
  });

  test("las rutas privadas rechazan requests sin sesión", async () => {
    const result = await api("/me");
    expect(result.response.status).toBe(401);
    expect(result.data.error.code).toBe("UNAUTHORIZED");

    const withBadToken = await api("/me", { token: "no-existe" });
    expect(withBadToken.response.status).toBe(401);
    expect(withBadToken.data.error.code).toBe("INVALID_SESSION");
  });
});

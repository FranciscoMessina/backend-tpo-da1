import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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

/** El código ya no viaja en la respuesta HTTP: se loguea por consola (dev), así que lo interceptamos. */
async function requestOtp(email: string, purpose: "registration" | "login" | "set_password") {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  let requested: Awaited<ReturnType<typeof api>>;
  try {
    requested = await api("/auth/otp/request", { method: "POST", body: { email, purpose } });
  } finally {
    console.log = originalLog;
  }
  expect(requested.response.status).toBe(200);
  const code = logs.join("\n").match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`No se logueó el código OTP para ${email}`);
  return code;
}

async function register(email: string, name: string, password = "password123") {
  const code = await requestOtp(email, "registration");
  const verified = await api("/auth/otp/verify", {
    method: "POST",
    body: { email, purpose: "registration", code, name, password },
  });
  expect(verified.response.status).toBe(200);
  return { id: verified.data.userId as string, token: verified.data.session.token as string };
}

/** Crea una publicación completa (el alta guiada vive en el cliente, acá siempre se manda entera). Devuelve el id, ya activa. */
async function publish(token: string, overrides: Record<string, unknown> = {}) {
  const created = await api("/publications", {
    method: "POST",
    token,
    body: {
      title: "Bicicleta urbana",
      description: "Bicicleta en excelente estado y poco uso",
      category: "sports",
      price: 450,
      condition: "like_new",
      zone: "Palermo",
      address: "Av. Santa Fe 3253, Palermo, CABA",
      latitude: -34.5895,
      longitude: -58.4173,
      imageUrls: ["https://images.example.com/bike.jpg"],
      ...overrides,
    },
  });
  expect(created.response.status).toBe(200);
  expect(created.data.status).toBe("active");
  return created.data.id as string;
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

  test("consigna 4/8: la dirección exacta se oculta hasta que se acepta la oferta", async () => {
    const seller = await register("address-seller@example.com", "Address Seller");
    const buyer = await register("address-buyer@example.com", "Address Buyer");
    const stranger = await register("address-stranger@example.com", "Address Stranger");
    const publicationId = await publish(seller.token, { title: "Sommier dos plazas", category: "home" });

    const asStranger = await api(`/publications/${publicationId}`, { token: stranger.token });
    expect(asStranger.data.addressLocked).toBe(true);
    expect(asStranger.data.address).toBeNull();
    expect(asStranger.data.mapsUrl).toBeNull();

    const asSeller = await api(`/publications/${publicationId}`, { token: seller.token });
    expect(asSeller.data.addressLocked).toBe(false);
    expect(asSeller.data.address).toBe("Av. Santa Fe 3253, Palermo, CABA");

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 100, message: "¿Cerramos en 100?" },
    });
    expect(offer.data.message).toBe("¿Cerramos en 100?");

    const beforeAccept = await api(`/publications/${publicationId}`, { token: buyer.token });
    expect(beforeAccept.data.addressLocked).toBe(true);

    await api(`/offers/${offer.data.id}/respond`, { method: "POST", token: seller.token, body: { action: "accept" } });

    const afterAccept = await api(`/publications/${publicationId}`, { token: buyer.token });
    expect(afterAccept.data.addressLocked).toBe(false);
    expect(afterAccept.data.address).toBe("Av. Santa Fe 3253, Palermo, CABA");
    expect(afterAccept.data.mapsUrl).toContain("destination=");
  });

  test("consigna 7: el vendedor contraoferta y el comprador la acepta, cerrando la venta al nuevo precio", async () => {
    const seller = await register("counter-seller@example.com", "Counter Seller");
    const buyer = await register("counter-buyer@example.com", "Counter Buyer");
    const publicationId = await publish(seller.token, { title: "Heladera usada", category: "home", price: 500 });

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 400 },
    });

    const countered = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "counter", counterAmount: 450 },
    });
    expect(countered.data.status).toBe("countered");

    // El vendedor ya no puede volver a responder la oferta original: espera al comprador.
    const secondAttempt = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });
    expect(secondAttempt.response.status).toBe(409);

    const accepted = await api(`/offers/${offer.data.id}/respond-to-counter`, {
      method: "POST",
      token: buyer.token,
      body: { action: "accept" },
    });
    expect(accepted.data.status).toBe("accepted");

    const operations = await api("/me/operations", { token: buyer.token });
    expect(operations.data.items[0].amount).toBe(450);
    expect(operations.data.items[0].type).toBe("buy");
  });

  test("consigna 9: no se puede calificar pasados los 7 días de la entrega", async () => {
    const seller = await register("late-review-seller@example.com", "Late Seller");
    const buyer = await register("late-review-buyer@example.com", "Late Buyer");
    const publicationId = await publish(seller.token, { title: "Ventilador de pie", category: "home", price: 80 });

    const offer = await api(`/publications/${publicationId}/offers`, {
      method: "POST",
      token: buyer.token,
      body: { amount: 80 },
    });
    const accepted = await api(`/offers/${offer.data.id}/respond`, {
      method: "POST",
      token: seller.token,
      body: { action: "accept" },
    });

    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    db.run(sql`UPDATE operations SET completed_at = ${eightDaysAgo} WHERE id = ${accepted.data.operationId}`);

    const review = await api(`/operations/${accepted.data.operationId}/reviews`, {
      method: "POST",
      token: buyer.token,
      body: { rating: 5 },
    });
    expect(review.response.status).toBe(409);
    expect(review.data.error.code).toBe("REVIEW_WINDOW_EXPIRED");
  });

  test("consigna 2: el perfil se puede editar con foto de perfil", async () => {
    const user = await register("avatar-user@example.com", "Avatar User");
    const updated = await api("/me", {
      method: "PATCH",
      token: user.token,
      body: { avatarUrl: "https://example.com/avatar.jpg" },
    });
    expect(updated.data.avatarUrl).toBe("https://example.com/avatar.jpg");

    const me = await api("/me", { token: user.token });
    expect(me.data.avatarUrl).toBe("https://example.com/avatar.jpg");
  });

  test("registro sin contraseña: se puede agregar después vía OTP y luego loguearse con ella", async () => {
    const email = "no-password-user@example.com";
    const registerCode = await requestOtp(email, "registration");
    const registered = await api("/auth/otp/verify", {
      method: "POST",
      body: { email, purpose: "registration", code: registerCode, name: "No Password" },
    });
    expect(registered.response.status).toBe(200);

    // Sin contraseña todavía no puede loguearse por password.
    const failedLogin = await api("/auth/login/password", {
      method: "POST",
      body: { email, password: "newpassword123" },
    });
    expect(failedLogin.response.status).toBe(401);

    // El código no se consume si falla por falta de password, así que se puede reintentar con el mismo.
    const setPasswordCode = await requestOtp(email, "set_password");
    const withoutPassword = await api("/auth/otp/verify", {
      method: "POST",
      body: { email, purpose: "set_password", code: setPasswordCode },
    });
    expect(withoutPassword.response.status).toBe(422);
    expect(withoutPassword.data.error.code).toBe("PASSWORD_REQUIRED");

    const setPassword = await api("/auth/otp/verify", {
      method: "POST",
      body: { email, purpose: "set_password", code: setPasswordCode, password: "newpassword123" },
    });
    expect(setPassword.response.status).toBe(200);
    expect(setPassword.data.userId).toBe(registered.data.userId);

    const login = await api("/auth/login/password", {
      method: "POST",
      body: { email, password: "newpassword123" },
    });
    expect(login.response.status).toBe(200);
    expect(login.data.userId).toBe(registered.data.userId);
  });
});

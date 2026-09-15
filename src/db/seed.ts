import { eq } from "drizzle-orm";
import { createDatabase } from "../database";
import {
  favorites,
  offers,
  operations,
  publicationImages,
  publications,
  questions,
  reviews,
  savedSearches,
  users,
} from "./schema";

const db = createDatabase();

// Como los IDs ahora son UUIDs generados en cada corrida (no strings fijos), no se puede confiar
// en `onConflictDoNothing` por id para que reinsertar el seed sea un no-op: se chequea acá con un
// dato natural (el email) si el seed ya se aplicó antes.
const alreadySeeded = db.select({ id: users.id }).from(users).where(eq(users.email, "ana@example.com")).get();
if (alreadySeeded) {
  console.log("Seed ya aplicado (existe ana@example.com); no se modifica nada.");
  db.$client.close();
  process.exit(0);
}

// Los IDs de todas las entidades son UUIDs generados en runtime (no strings fijos), tal como
// se pide para el resto de la aplicación; se guardan en este mapa solo para poder referenciarlos
// entre sí dentro del propio seed.
const ids = {
  ana: crypto.randomUUID(),
  bruno: crypto.randomUUID(),
  carla: crypto.randomUUID(),
  bike: crypto.randomUUID(),
  notebook: crypto.randomUUID(),
  chair: crypto.randomUUID(),
  phone: crypto.randomUUID(),
  guitar: crypto.randomUUID(),
  bikeOffer: crypto.randomUUID(),
  phoneOffer: crypto.randomUUID(),
  phoneOperation: crypto.randomUUID(),
};

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

try {
  const passwordHash = await Bun.password.hash("password123");

  db.transaction((tx) => {
    tx.insert(users)
      .values([
        {
          id: ids.ana,
          email: "ana@example.com",
          username: "ana.ventas",
          passwordHash,
          name: "Ana Gómez",
          phone: "+54 11 5555-0101",
          zone: "Palermo",
          avatarUrl: "https://images.unsplash.com/photo-1494790108377-be9c29b29330",
          createdAt: daysAgo(180),
          emailVerifiedAt: daysAgo(180),
        },
        {
          id: ids.bruno,
          email: "bruno@example.com",
          username: "bruno.compra",
          passwordHash,
          name: "Bruno Díaz",
          phone: "+54 11 5555-0102",
          zone: "Caballito",
          avatarUrl: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e",
          createdAt: daysAgo(120),
          emailVerifiedAt: daysAgo(120),
        },
        {
          id: ids.carla,
          email: "carla@example.com",
          username: "carla.market",
          passwordHash,
          name: "Carla Ruiz",
          phone: "+54 11 5555-0103",
          zone: "Belgrano",
          avatarUrl: "https://images.unsplash.com/photo-1517841905240-472988babdf9",
          createdAt: daysAgo(75),
          emailVerifiedAt: daysAgo(75),
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(publications)
      .values([
        {
          id: ids.bike,
          sellerId: ids.ana,
          title: "Bicicleta urbana rodado 28",
          description: "Bicicleta liviana, con cambios Shimano y muy poco uso.",
          category: "sports",
          priceCents: 450_000,
          itemCondition: "like_new",
          zone: "Palermo",
          address: "Av. Santa Fe 3253, Palermo, CABA",
          latitude: -34.5895,
          longitude: -58.4173,
          status: "active",
          publishedAt: daysAgo(5),
          createdAt: daysAgo(6),
          updatedAt: daysAgo(2),
        },
        {
          id: ids.notebook,
          sellerId: ids.carla,
          title: "Notebook Lenovo ThinkPad",
          description: "16 GB de RAM, SSD de 512 GB y cargador original.",
          category: "electronics",
          priceCents: 780_000,
          itemCondition: "used",
          zone: "Belgrano",
          address: "Av. Cabildo 2085, Belgrano, CABA",
          latitude: -34.5623,
          longitude: -58.4562,
          status: "active",
          publishedAt: daysAgo(2),
          createdAt: daysAgo(3),
          updatedAt: daysAgo(2),
        },
        {
          id: ids.chair,
          sellerId: ids.ana,
          title: "Silla ergonómica de oficina",
          description: "Respaldo de red y altura regulable.",
          category: "home",
          priceCents: 185_000,
          itemCondition: "like_new",
          zone: "Palermo",
          address: "Av. Santa Fe 3253, Palermo, CABA",
          latitude: -34.5895,
          longitude: -58.4173,
          status: "paused",
          publishedAt: daysAgo(15),
          createdAt: daysAgo(16),
          updatedAt: daysAgo(1),
        },
        {
          id: ids.phone,
          sellerId: ids.carla,
          title: "Celular Samsung Galaxy",
          description: "Equipo liberado con caja y funda.",
          category: "electronics",
          priceCents: 320_000,
          itemCondition: "used",
          zone: "Belgrano",
          address: "Av. Cabildo 2085, Belgrano, CABA",
          latitude: -34.5623,
          longitude: -58.4562,
          status: "sold",
          publishedAt: daysAgo(30),
          createdAt: daysAgo(31),
          updatedAt: daysAgo(10),
        },
        {
          id: ids.guitar,
          sellerId: ids.bruno,
          title: "Guitarra criolla",
          description: "Guitarra con funda incluida, ideal para arrancar.",
          category: "other",
          priceCents: 210_000,
          itemCondition: "used",
          zone: "Caballito",
          address: "Av. Rivadavia 5401, Caballito, CABA",
          latitude: -34.6178,
          longitude: -58.4386,
          status: "paused",
          publishedAt: daysAgo(1),
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(publicationImages)
      .values([
        { id: crypto.randomUUID(), publicationId: ids.bike, url: "https://images.unsplash.com/photo-1571068316344-75bc76f77890", position: 0 },
        { id: crypto.randomUUID(), publicationId: ids.bike, url: "https://images.unsplash.com/photo-1558981806-ec527fa84c39", position: 1 },
        { id: crypto.randomUUID(), publicationId: ids.notebook, url: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853", position: 0 },
        { id: crypto.randomUUID(), publicationId: ids.chair, url: "https://images.unsplash.com/photo-1505797149-43b0069ec26b", position: 0 },
        { id: crypto.randomUUID(), publicationId: ids.phone, url: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9", position: 0 },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(favorites)
      .values([
        { userId: ids.bruno, publicationId: ids.bike, savedPriceCents: 470_000, hasUpdate: true, createdAt: daysAgo(4) },
        { userId: ids.ana, publicationId: ids.notebook, savedPriceCents: 780_000, hasUpdate: false, createdAt: daysAgo(1) },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(savedSearches)
      .values({
        id: crypto.randomUUID(),
        userId: ids.bruno,
        name: "Bicicletas cerca",
        queryText: "bicicleta",
        category: "sports",
        minPriceCents: 100_000,
        maxPriceCents: 600_000,
        itemCondition: "like_new",
        zone: "Palermo",
        sort: "recent",
        unreadCount: 1,
        createdAt: daysAgo(10),
        lastCheckedAt: daysAgo(6),
      })
      .onConflictDoNothing()
      .run();

    tx.insert(questions)
      .values([
        {
          id: crypto.randomUUID(),
          publicationId: ids.bike,
          askerId: ids.bruno,
          text: "¿Incluye luces y guardabarros?",
          answer: "Sí, incluye ambos accesorios.",
          createdAt: daysAgo(4),
          answeredAt: daysAgo(3),
        },
        {
          id: crypto.randomUUID(),
          publicationId: ids.notebook,
          askerId: ids.ana,
          text: "¿Cuánto dura la batería?",
          answer: null,
          createdAt: daysAgo(1),
          answeredAt: null,
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(offers)
      .values([
        {
          id: ids.bikeOffer,
          publicationId: ids.bike,
          buyerId: ids.bruno,
          amountCents: 420_000,
          message: "¿Aceptás este precio? Puedo pasar a buscarla el finde.",
          counterAmountCents: null,
          status: "pending",
          expiresAt: daysFromNow(2),
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
        {
          id: ids.phoneOffer,
          publicationId: ids.phone,
          buyerId: ids.bruno,
          amountCents: 300_000,
          message: null,
          counterAmountCents: null,
          status: "accepted",
          expiresAt: daysAgo(9),
          createdAt: daysAgo(12),
          updatedAt: daysAgo(10),
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(operations)
      .values({
        id: ids.phoneOperation,
        publicationId: ids.phone,
        offerId: ids.phoneOffer,
        buyerId: ids.bruno,
        sellerId: ids.carla,
        amountCents: 300_000,
        completedAt: daysAgo(10),
      })
      .onConflictDoNothing()
      .run();

    tx.insert(reviews)
      .values([
        {
          id: crypto.randomUUID(),
          operationId: ids.phoneOperation,
          reviewerId: ids.bruno,
          reviewedUserId: ids.carla,
          rating: 5,
          comment: "Todo perfecto, muy recomendable.",
          createdAt: daysAgo(9),
        },
        {
          id: crypto.randomUUID(),
          operationId: ids.phoneOperation,
          reviewerId: ids.carla,
          reviewedUserId: ids.bruno,
          rating: 5,
          comment: "Comprador puntual y amable.",
          createdAt: daysAgo(9),
        },
      ])
      .onConflictDoNothing()
      .run();
  });

  console.log("Seed completado.");
  console.log("Usuarios: ana@example.com, bruno@example.com y carla@example.com");
  console.log("Contraseña para todos: password123");
} finally {
  db.$client.close();
}

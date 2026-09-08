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

const ids = {
  ana: "seed-user-ana",
  bruno: "seed-user-bruno",
  carla: "seed-user-carla",
  bike: "seed-publication-bike",
  notebook: "seed-publication-notebook",
  chair: "seed-publication-chair",
  phone: "seed-publication-phone",
  guitar: "seed-publication-guitar",
  bikeOffer: "seed-offer-bike",
  phoneOffer: "seed-offer-phone",
  phoneOperation: "seed-operation-phone",
} as const;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

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
          status: "active",
          draftStep: 7,
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
          status: "active",
          draftStep: 7,
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
          status: "paused",
          draftStep: 7,
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
          status: "sold",
          draftStep: 7,
          publishedAt: daysAgo(30),
          createdAt: daysAgo(31),
          updatedAt: daysAgo(10),
        },
        {
          id: ids.guitar,
          sellerId: ids.bruno,
          title: "Guitarra criolla",
          description: "Borrador de una guitarra con funda incluida.",
          category: "other",
          priceCents: 210_000,
          itemCondition: "used",
          zone: "Caballito",
          status: "draft",
          draftStep: 4,
          publishedAt: null,
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
      ])
      .onConflictDoNothing()
      .run();

    tx.insert(publicationImages)
      .values([
        { id: "seed-image-bike-1", publicationId: ids.bike, url: "https://images.unsplash.com/photo-1571068316344-75bc76f77890", position: 0 },
        { id: "seed-image-bike-2", publicationId: ids.bike, url: "https://images.unsplash.com/photo-1558981806-ec527fa84c39", position: 1 },
        { id: "seed-image-notebook", publicationId: ids.notebook, url: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853", position: 0 },
        { id: "seed-image-chair", publicationId: ids.chair, url: "https://images.unsplash.com/photo-1505797149-43b0069ec26b", position: 0 },
        { id: "seed-image-phone", publicationId: ids.phone, url: "https://images.unsplash.com/photo-1511707171634-5f897ff02aa9", position: 0 },
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
        id: "seed-search-bruno-bikes",
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
          id: "seed-question-bike",
          publicationId: ids.bike,
          askerId: ids.bruno,
          text: "¿Incluye luces y guardabarros?",
          answer: "Sí, incluye ambos accesorios.",
          createdAt: daysAgo(4),
          answeredAt: daysAgo(3),
        },
        {
          id: "seed-question-notebook",
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
          status: "pending",
          createdAt: daysAgo(1),
          updatedAt: daysAgo(1),
        },
        {
          id: ids.phoneOffer,
          publicationId: ids.phone,
          buyerId: ids.bruno,
          amountCents: 300_000,
          status: "accepted",
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
          id: "seed-review-phone-buyer",
          operationId: ids.phoneOperation,
          reviewerId: ids.bruno,
          reviewedUserId: ids.carla,
          rating: 5,
          comment: "Todo perfecto, muy recomendable.",
          createdAt: daysAgo(9),
        },
        {
          id: "seed-review-phone-seller",
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

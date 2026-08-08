import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createFudabaCard,
  createFudabaOffice,
  deleteFudabaCard,
  deleteFudabaCardPlacement,
  fudabaCardPlacementDeleteResponseSchema,
  fudabaCardPlacementDeleteSchema,
  fudabaCardPlacementSaveResponseSchema,
  fudabaCardPlacementSaveSchema,
  fudabaCardPageSchema,
  fudabaCardUpdateSchema,
  fudabaMapConfigSchema,
  fudabaMapOfficeListSchema,
  fudabaOfficeDetailSchema,
  fudabaOfficePageSchema,
  fudabaOwnerCardListSchema,
  fudabaOwnerLocationDetailSchema,
  fudabaOwnerOfficeListSchema,
  fudabaSeriesListSchema,
  getFudabaOwnerLocation,
  getFudabaOwnerOffice,
  getFudabaOwnerOffices,
  getFudabaOwnerCard,
  getFudabaOwnerCards,
  getFudabaOwnerSeries,
  getFudabaMapConfig,
  getFudabaMapOffices,
  updateFudabaCard,
  updateFudabaOwnerOffice,
  uploadFudabaCardMedia,
  saveFudabaOwnerLocation,
  saveFudabaCardPlacement,
  withdrawFudabaOwnerLocation,
} from "~/lib/api/endpoints/fudaba"
import { CSRF_HEADER_NAME } from "~/lib/api/request"

const card = {
  id: "card-1",
  producerName: "春香P",
  displayName: "交换会用名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  frontImageUrl: "/media/card-1-front.webp",
  backImageUrl: "/media/card-1-back.webp",
  accent: "#f34e6c",
  bio: "周末参加线下活动",
  tradeNote: "希望交换同系列名片",
  available: true,
  source: null,
  createdAt: "2026-08-02T08:00:00.000Z",
  interactions: {
    likes: 2,
    favorites: 1,
    viewerLiked: false,
    viewerFavorited: true,
  },
}

const office = {
  id: "office-1",
  slug: "shanghai-weekend",
  name: "上海周末交换事务所",
  intro: "面向线下活动的交换点。",
  city: "上海",
  accent: "#2581c7",
  coverUrl: null,
  isOpen: true,
  visitorCount: 12,
  seriesCodes: ["765", "cg"],
}

const placement = {
  pinnedAt: "2026-08-02T09:00:00.000Z",
  x: 55,
  y: 42,
  rotation: -4,
  zIndex: 8,
  revision: 3,
  updatedAt: "2026-08-02T10:00:00.000Z",
}

const ownerCard = {
  id: "owner-card",
  producerName: "春香P",
  displayName: "交换会用名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  frontImageUrl: "/api/community/exchange/me/cards/owner-card/media/front?v=1",
  backImageUrl: "/api/community/exchange/me/cards/owner-card/media/back?v=1",
  accent: "#f34e6c",
  bio: "周末参加线下活动",
  tradeNote: "希望交换同系列名片",
  available: true,
  mediaRightsStatus: "unknown" as const,
  publicationStatus: "pending" as const,
  revision: 1,
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
}

const ownerOffice = {
  id: "owner-office",
  slug: "shanghai-owner-office",
  name: "上海制作人交换事务所",
  intro: "周末线下交换",
  city: "上海",
  address: "西岸艺术中心入口",
  location: {
    latitude: 31.18452,
    longitude: 121.45678,
    precision: "exact" as const,
  },
  accent: "#2581c7",
  coverUrl: null,
  pendingCoverUrl: null,
  pendingCoverSubmittedAt: null,
  isOpen: true,
  visitorCount: 12,
  status: "active" as const,
  revision: 3,
  seriesCodes: ["765"],
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
  archivedAt: null,
}

const ownerLocation = {
  officeId: ownerOffice.id,
  location: {
    latitude: 31.2,
    longitude: 121.5,
    precision: "regional" as const,
  },
  reviewState: "published" as const,
  revision: 2,
  submittedAt: "2026-08-02T09:00:00.000Z",
  reviewedAt: "2026-08-02T10:00:00.000Z",
  reviewNote: "区域范围合适",
}

const cardFields = {
  producerName: "春香P",
  displayName: "交换会用名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  accent: "#f34e6c",
  bio: "周末参加线下活动",
  tradeNote: "希望交换同系列名片",
  available: true,
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.cookie = "ims_platform_csrf=; Max-Age=0; path=/"
})

describe("Fudaba Web API contracts", () => {
  it("accepts the public discovery responses", () => {
    const parsedSeries = fudabaSeriesListSchema.parse({
      items: [
        {
          id: 1,
          code: "765",
          displayName: "765PRO",
          color: "#f34f6d",
          iconUrl: "https://assets.example.test/icon/765.webp",
          imageTransform: {
            fit: "contain",
            focalX: 0.4,
            focalY: 0.6,
            zoom: 1.2,
            rotation: 0,
          },
          displayOrder: 0,
          activeOfficeCount: 1,
        },
      ],
    })
    expect(parsedSeries.items[0]).toMatchObject({
      id: 1,
      code: "765",
      color: "#f34f6d",
      iconUrl: "https://assets.example.test/icon/765.webp",
      imageTransform: { fit: "contain", focalX: 0.4, focalY: 0.6 },
    })
    expect(() =>
      fudabaSeriesListSchema.parse({
        items: [
          {
            ...parsedSeries.items[0],
            color: "red",
          },
        ],
      })
    ).toThrow()

    expect(
      fudabaOfficePageSchema.parse({
        items: [office],
        pageInfo: { hasNextPage: false, nextCursor: null },
      }).items[0]?.city
    ).toBe("上海")

    expect(
      fudabaCardPageSchema.parse({
        items: [card],
        pageInfo: { hasNextPage: true, nextCursor: "next-page" },
      }).items[0]?.interactions.viewerFavorited
    ).toBe(true)
  })

  it("accepts placement metadata only within the public wall bounds", () => {
    const parsed = fudabaOfficeDetailSchema.parse({
      office: {
        ...office,
        cards: [{ ...card, viewerOwned: true, placement }],
      },
    })
    expect(parsed.office.cards[0]).toMatchObject({
      viewerOwned: true,
      placement,
    })

    for (const boundaryPlacement of [
      {
        ...placement,
        x: 0,
        y: 100,
        rotation: -12,
        zIndex: 1,
        revision: 0,
      },
      {
        ...placement,
        x: 100,
        y: 0,
        rotation: 12,
        zIndex: 999,
        revision: Number.MAX_SAFE_INTEGER,
      },
    ]) {
      expect(() =>
        fudabaOfficeDetailSchema.parse({
          office: {
            ...office,
            cards: [
              { ...card, viewerOwned: false, placement: boundaryPlacement },
            ],
          },
        })
      ).not.toThrow()
    }

    for (const invalidPlacement of [
      { ...placement, x: -0.01 },
      { ...placement, x: 100.01 },
      { ...placement, y: Number.POSITIVE_INFINITY },
      { ...placement, rotation: -12.01 },
      { ...placement, rotation: 12.01 },
      { ...placement, zIndex: 1.5 },
      { ...placement, zIndex: 0 },
      { ...placement, zIndex: 1000 },
      { ...placement, revision: -1 },
      { ...placement, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...placement, updatedAt: "not-a-timestamp" },
    ]) {
      expect(() =>
        fudabaOfficeDetailSchema.parse({
          office: {
            ...office,
            cards: [
              {
                ...card,
                viewerOwned: true,
                placement: invalidPlacement,
              },
            ],
          },
        })
      ).toThrow()
    }

    expect(() =>
      fudabaOfficeDetailSchema.parse({
        office: {
          ...office,
          cards: [
            {
              ...card,
              placement,
            },
          ],
        },
      })
    ).toThrow()
  })

  it("uses strict placement mutation input and response contracts", () => {
    const saveInput = {
      x: 0,
      y: 100,
      rotation: 12,
      zIndex: 999,
      expectedRevision: null,
    }
    expect(fudabaCardPlacementSaveSchema.parse(saveInput)).toEqual(saveInput)
    expect(
      fudabaCardPlacementDeleteSchema.parse({ expectedRevision: 0 })
    ).toEqual({ expectedRevision: 0 })
    expect(
      fudabaCardPlacementSaveResponseSchema.parse({
        success: true,
        placement,
      }).placement.revision
    ).toBe(3)
    expect(
      fudabaCardPlacementDeleteResponseSchema.parse({
        success: true,
        revision: Number.MAX_SAFE_INTEGER,
      }).revision
    ).toBe(Number.MAX_SAFE_INTEGER)

    for (const input of [
      { ...saveInput, x: Number.NaN },
      { ...saveInput, y: -1 },
      { ...saveInput, rotation: 13 },
      { ...saveInput, zIndex: 2.5 },
      { ...saveInput, expectedRevision: -1 },
      { ...saveInput, unexpected: true },
    ]) {
      expect(() => fudabaCardPlacementSaveSchema.parse(input)).toThrow()
    }
    expect(() =>
      fudabaCardPlacementDeleteSchema.parse({
        expectedRevision: 1,
        unexpected: true,
      })
    ).toThrow()
    expect(() =>
      fudabaCardPlacementSaveResponseSchema.parse({
        success: true,
        placement: { ...placement, privateOwnerId: "owner-1" },
      })
    ).toThrow()
    expect(() =>
      fudabaCardPlacementDeleteResponseSchema.parse({
        success: true,
        revision: 1.5,
      })
    ).toThrow()
  })

  it("accepts only regional map DTOs and same-origin style paths", () => {
    const mapOffice = {
      id: office.id,
      slug: office.slug,
      name: office.name,
      city: office.city,
      accent: office.accent,
      isOpen: office.isOpen,
      seriesCodes: office.seriesCodes,
      location: {
        latitude: 31.2,
        longitude: 121.5,
        precision: "regional" as const,
      },
    }

    expect(
      fudabaMapOfficeListSchema.parse({
        items: [mapOffice],
        truncated: false,
      }).items[0]?.location.precision
    ).toBe("regional")
    expect(() =>
      fudabaMapOfficeListSchema.parse({
        items: [{ ...mapOffice, intro: "private precision leak" }],
        truncated: false,
      })
    ).toThrow()
    expect(() =>
      fudabaMapOfficeListSchema.parse({
        items: [
          {
            ...mapOffice,
            location: { ...mapOffice.location, latitude: 31.25 },
          },
        ],
        truncated: false,
      })
    ).toThrow(/0.1 degree grid/)
    for (const latitude of [-60.1, 60.1]) {
      expect(() =>
        fudabaMapOfficeListSchema.parse({
          items: [
            {
              ...mapOffice,
              location: { ...mapOffice.location, latitude },
            },
          ],
          truncated: false,
        })
      ).toThrow()
    }

    expect(
      fudabaMapConfigSchema.parse({
        styleUrl: " /api/community/exchange/map/style.json ",
      }).styleUrl
    ).toBe("/api/community/exchange/map/style.json")
    for (const styleUrl of [
      "",
      "style.json",
      "https://maps.example/style",
      "//maps.example/style",
      "/styles//map.json",
      "/styles\\map.json",
      "/styles/map.json?key=secret",
      "/styles/map.json#layer",
      "/styles/map\n.json",
      `/styles/${"x".repeat(2048)}`,
    ]) {
      expect(() => fudabaMapConfigSchema.parse({ styleUrl })).toThrow()
    }
  })

  it("requests map config and bounded offices with Platform auth", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://ims.test")
        requests.push({ url, init })
        if (url.pathname.endsWith("/map/config")) {
          return Response.json({
            styleUrl: "/api/community/exchange/map/style.json",
          })
        }
        return Response.json({ items: [], truncated: false })
      })
    )

    await getFudabaMapConfig().send()
    await getFudabaMapOffices({
      bbox: [100, 20, 130, 45],
      city: " 上海 ",
      series: "765",
      open: true,
      limit: 200,
    }).send()

    expect(requests.map(({ url }) => url.pathname)).toEqual([
      "/api/community/exchange/map/config",
      "/api/community/exchange/map/offices",
    ])
    const query = requests[1]?.url.searchParams
    expect(query?.get("bbox")).toBe("100,20,130,45")
    expect(query?.get("city")).toBe("上海")
    expect(query?.get("series")).toBe("765")
    expect(query?.get("open")).toBe("true")
    expect(query?.get("limit")).toBe("200")
    for (const request of requests) {
      expect(request.init?.credentials).toBe("same-origin")
      expect(
        new Headers(request.init?.headers).get(CSRF_HEADER_NAME)
      ).toBeNull()
    }
  })

  it("strips privacy-only fields and rejects inconsistent pagination", () => {
    expect(() =>
      fudabaOfficePageSchema.parse({
        items: [{ ...office, ownerAccountId: "private-owner" }],
        pageInfo: { hasNextPage: false, nextCursor: null },
      })
    ).not.toThrow()

    const parsed = fudabaOfficePageSchema.parse({
      items: [{ ...office, ownerAccountId: "private-owner" }],
      pageInfo: { hasNextPage: false, nextCursor: null },
    })
    expect(parsed.items[0]).not.toHaveProperty("ownerAccountId")
    expect(parsed.items[0]).not.toHaveProperty("address")
    expect(parsed.items[0]).not.toHaveProperty("latitude")

    expect(() =>
      fudabaOfficePageSchema.parse({
        items: [],
        pageInfo: { hasNextPage: true, nextCursor: null },
      })
    ).toThrow(/pagination state is inconsistent/)
  })

  it("accepts only the exact owner card projection and mutation fields", () => {
    expect(
      fudabaOwnerCardListSchema.parse({ items: [ownerCard] }).items[0]
        ?.publicationStatus
    ).toBe("pending")

    expect(() =>
      fudabaOwnerCardListSchema.parse({
        items: [{ ...ownerCard, frontObjectKey: "protected/front.webp" }],
      })
    ).toThrow()
    expect(() =>
      fudabaCardUpdateSchema.parse({
        ...cardFields,
        expectedRevision: 1,
        publicationStatus: "published",
      })
    ).toThrow()
  })

  it("keeps exact owner office data separate from regional public locations", () => {
    expect(
      fudabaOwnerOfficeListSchema.parse({ items: [ownerOffice] }).items[0]
        ?.location
    ).toEqual({
      latitude: 31.18452,
      longitude: 121.45678,
      precision: "exact",
    })
    expect(
      fudabaOwnerLocationDetailSchema.parse({ location: ownerLocation })
        .location?.location
    ).toEqual({ latitude: 31.2, longitude: 121.5, precision: "regional" })
    expect(() =>
      fudabaOwnerLocationDetailSchema.parse({
        location: {
          ...ownerLocation,
          location: { ...ownerLocation.location, latitude: 31.25 },
        },
      })
    ).toThrow(/0.1 degree grid/)
    expect(() =>
      fudabaOwnerOfficeListSchema.parse({
        items: [{ ...ownerOffice, ownerAccountId: "private-owner" }],
      })
    ).toThrow()
  })

  it("uses authenticated owner reads and URL-encodes card IDs", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const encodedCardId = "owner%20card%3F%23"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        requests.push({ url: pathname, init })
        if (pathname.endsWith("/me/series")) {
          return Response.json({
            items: [
              {
                id: 1,
                code: "765",
                displayName: "765PRO",
                color: "#f34f6d",
                iconUrl: "https://assets.example.test/icon/765.webp",
                imageTransform: {
                  fit: "contain",
                  focalX: 0.5,
                  focalY: 0.5,
                  zoom: 1,
                  rotation: 0,
                },
                displayOrder: 0,
                activeOfficeCount: 1,
              },
            ],
          })
        }
        if (pathname.endsWith("/me/cards")) {
          return Response.json({ items: [ownerCard] })
        }
        if (pathname.endsWith(`/${encodedCardId}`)) {
          return Response.json({
            card: { ...ownerCard, id: "owner card?#" },
          })
        }
        throw new Error(`Unexpected request: ${pathname}`)
      })
    )

    await expect(getFudabaOwnerSeries().send()).resolves.toMatchObject({
      items: [{ code: "765" }],
    })
    await expect(getFudabaOwnerCards().send()).resolves.toMatchObject({
      items: [{ id: "owner-card" }],
    })
    await expect(
      getFudabaOwnerCard("owner card?#").send()
    ).resolves.toMatchObject({ card: { id: "owner card?#" } })

    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["/api/community/exchange/me/series", "GET"],
      ["/api/community/exchange/me/cards", "GET"],
      [`/api/community/exchange/me/cards/${encodedCardId}`, "GET"],
    ])
    for (const request of requests) {
      expect(
        new Headers(request.init?.headers).get(CSRF_HEADER_NAME)
      ).toBeNull()
    }
  })

  it("uses strict JSON and multipart bodies with Platform CSRF for writes", async () => {
    document.cookie = "ims_platform_csrf=owner-write-csrf; path=/"
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        requests.push({ url: pathname, init })
        if (init?.method === "DELETE") {
          return Response.json({ success: true, revision: 2 })
        }
        return Response.json({ success: true, card: ownerCard })
      })
    )
    const front = new File(["front"], "front.png", { type: "image/png" })
    const back = new File(["back"], "back.png", { type: "image/png" })
    const replacement = new File(["next"], "next.png", {
      type: "image/png",
    })

    await createFudabaCard({ ...cardFields, front, back }).send()
    await updateFudabaCard("owner card?#", {
      ...cardFields,
      displayName: "  Updated card  ",
      expectedRevision: 1,
    }).send()
    await uploadFudabaCardMedia("owner card?#", "front", replacement, 1).send()
    await deleteFudabaCard("owner card?#", 1).send()

    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["/api/community/exchange/cards", "POST"],
      ["/api/community/exchange/me/cards/owner%20card%3F%23", "PUT"],
      ["/api/community/exchange/uploads/front", "PUT"],
      ["/api/community/exchange/me/cards/owner%20card%3F%23", "DELETE"],
    ])
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get(CSRF_HEADER_NAME)).toBe(
        "owner-write-csrf"
      )
    }

    expect(requests[0]?.init?.body).toBeInstanceOf(FormData)
    const create = requests[0]?.init?.body as FormData
    expect(create.get("front")).toBe(front)
    expect(create.get("back")).toBe(back)
    expect(create.get("available")).toBe("true")
    expect(create.get("displayName")).toBe(cardFields.displayName)

    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      ...cardFields,
      displayName: "Updated card",
      expectedRevision: 1,
    })

    expect(requests[2]?.init?.body).toBeInstanceOf(FormData)
    const media = requests[2]?.init?.body as FormData
    expect(media.get("image")).toBe(replacement)
    expect(media.get("cardId")).toBe("owner card?#")
    expect(media.get("expectedRevision")).toBe("1")

    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
      expectedRevision: 1,
    })
  })

  it("saves and deletes encoded wall placements with Platform CSRF", async () => {
    document.cookie = "ims_platform_csrf=wall-write-csrf; path=/"
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        requests.push({ url: pathname, init })
        if (init?.method === "DELETE") {
          return Response.json({ success: true, revision: 4 })
        }
        return Response.json({ success: true, placement })
      })
    )

    const saved = await saveFudabaCardPlacement("office ?#", "card ?#", {
      x: 20,
      y: 80,
      rotation: 4,
      zIndex: 7,
      expectedRevision: null,
    }).send()
    const deleted = await deleteFudabaCardPlacement(
      "office ?#",
      "card ?#",
      3
    ).send()

    expect(saved.placement).toEqual(placement)
    expect(deleted).toEqual({ success: true, revision: 4 })
    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      [
        "/api/community/exchange/offices/office%20%3F%23/cards/card%20%3F%23/placement",
        "PUT",
      ],
      [
        "/api/community/exchange/offices/office%20%3F%23/cards/card%20%3F%23/placement",
        "DELETE",
      ],
    ])
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get(CSRF_HEADER_NAME)).toBe(
        "wall-write-csrf"
      )
    }
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      x: 20,
      y: 80,
      rotation: 4,
      zIndex: 7,
      expectedRevision: null,
    })
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      expectedRevision: 3,
    })
  })

  it("rejects invalid placement paths and values before requesting", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const validInput = {
      x: 20,
      y: 80,
      rotation: 4,
      zIndex: 7,
      expectedRevision: 0,
    }

    for (const invalidId of [
      "",
      "bad/id",
      "bad\\id",
      "bad\nid",
      "x".repeat(129),
    ]) {
      expect(() =>
        saveFudabaCardPlacement(invalidId, "card-1", validInput)
      ).toThrow()
      expect(() =>
        saveFudabaCardPlacement("office-1", invalidId, validInput)
      ).toThrow()
      expect(() => deleteFudabaCardPlacement(invalidId, "card-1", 0)).toThrow()
      expect(() =>
        deleteFudabaCardPlacement("office-1", invalidId, 0)
      ).toThrow()
    }
    expect(() =>
      saveFudabaCardPlacement("office-1", "card-1", {
        ...validInput,
        x: 101,
      })
    ).toThrow()
    expect(() => deleteFudabaCardPlacement("office-1", "card-1", -1)).toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("uses owner office CAS, idempotency, and independent location endpoints", async () => {
    document.cookie = "ims_platform_csrf=owner-office-csrf; path=/"
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), "http://ims.test").pathname
        requests.push({ url: pathname, init })
        if (init?.method === "DELETE") return Response.json({ success: true })
        if (pathname.endsWith("/location") && init?.method === "PUT") {
          return Response.json({
            success: true,
            officeLocation: {
              ...ownerLocation,
              reviewState: "pending",
              revision: 3,
              reviewedAt: null,
              reviewNote: "",
            },
          })
        }
        if (pathname.endsWith("/location")) {
          return Response.json({ location: ownerLocation })
        }
        if (pathname.endsWith("/me/offices") && init?.method === "GET") {
          return Response.json({ items: [ownerOffice] })
        }
        if (pathname.endsWith("/owner-office") && init?.method === "GET") {
          return Response.json({ office: ownerOffice })
        }
        return Response.json({ success: true, office: ownerOffice })
      })
    )
    const fields = {
      name: ownerOffice.name,
      intro: ownerOffice.intro,
      city: ownerOffice.city,
      address: ownerOffice.address,
      latitude: ownerOffice.location.latitude,
      longitude: ownerOffice.location.longitude,
      accent: ownerOffice.accent,
      isOpen: ownerOffice.isOpen,
      seriesCodes: ownerOffice.seriesCodes,
    }

    await getFudabaOwnerOffices().send()
    await getFudabaOwnerOffice(ownerOffice.id).send()
    await getFudabaOwnerLocation(ownerOffice.id).send()
    await createFudabaOffice(fields, "office-create-1").send()
    await updateFudabaOwnerOffice(ownerOffice.id, {
      ...fields,
      expectedRevision: 3,
    }).send()
    await saveFudabaOwnerLocation(ownerOffice.id, {
      latitude: 31.2,
      longitude: 121.5,
      expectedRevision: 2,
    }).send()
    await withdrawFudabaOwnerLocation(ownerOffice.id, 3).send()

    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ["/api/community/exchange/me/offices", "GET"],
      ["/api/community/exchange/me/offices/owner-office", "GET"],
      ["/api/community/exchange/me/offices/owner-office/location", "GET"],
      ["/api/community/exchange/offices", "POST"],
      ["/api/community/exchange/me/offices/owner-office", "PUT"],
      ["/api/community/exchange/me/offices/owner-office/location", "PUT"],
      ["/api/community/exchange/me/offices/owner-office/location", "DELETE"],
    ])

    for (const [index, request] of requests.entries()) {
      expect(new Headers(request.init?.headers).get(CSRF_HEADER_NAME)).toBe(
        index < 3 ? null : "owner-office-csrf"
      )
    }
    expect(new Headers(requests[3]?.init?.headers).get("Idempotency-Key")).toBe(
      "office-create-1"
    )
    expect(JSON.parse(String(requests[4]?.init?.body))).toMatchObject({
      expectedRevision: 3,
      latitude: 31.18452,
      longitude: 121.45678,
    })
    expect(JSON.parse(String(requests[5]?.init?.body))).toEqual({
      latitude: 31.2,
      longitude: 121.5,
      expectedRevision: 2,
    })
    expect(JSON.parse(String(requests[6]?.init?.body))).toEqual({
      expectedRevision: 3,
    })
  })
})

import { describe, expect, it } from "vitest"

import type { FudabaMapOffice, FudabaSeries } from "~/lib/api"
import {
  groupMapOffices,
  mergeMapOfficeResponses,
  resolveAllowedMapResourceUrl,
  splitViewportBounds,
} from "~/pages/community/exchange/exchange-map-model"

const office: FudabaMapOffice = {
  id: "office-1",
  slug: "shanghai-weekend",
  name: "上海周末交换事务所",
  city: "上海",
  accent: "#f34e6c",
  isOpen: true,
  seriesCodes: ["765"],
  location: {
    latitude: 31.2,
    longitude: 121.5,
    precision: "regional",
  },
}

const seriesCatalog: FudabaSeries[] = [
  {
    id: 1,
    code: "765",
    displayName: "765PRO",
    color: "#f34f6d",
    iconUrl: "/icon/agencies/1.webp",
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
  {
    id: 3,
    code: "cg",
    displayName: "灰姑娘女孩",
    color: "#2681c8",
    iconUrl: null,
    imageTransform: {
      fit: "contain",
      focalX: 0.5,
      focalY: 0.5,
      zoom: 1,
      rotation: 0,
    },
    displayOrder: 2,
    activeOfficeCount: 1,
  },
  {
    id: 4,
    code: "ml",
    displayName: "百万现场",
    color: "#ffc30b",
    iconUrl: null,
    imageTransform: {
      fit: "contain",
      focalX: 0.5,
      focalY: 0.5,
      zoom: 1,
      rotation: 0,
    },
    displayOrder: 3,
    activeOfficeCount: 0,
  },
  {
    id: 6,
    code: "sc",
    displayName: "闪耀色彩",
    color: "#8dbbff",
    iconUrl: null,
    imageTransform: {
      fit: "contain",
      focalX: 0.5,
      focalY: 0.5,
      zoom: 1,
      rotation: 0,
    },
    displayOrder: 5,
    activeOfficeCount: 0,
  },
]

describe("exchange map model", () => {
  it("allows same-origin and official OpenFreeMap HTTPS resources", () => {
    expect(
      resolveAllowedMapResourceUrl(
        "/api/community/exchange/map/style.json",
        "https://ims.test"
      )
    ).toBe("https://ims.test/api/community/exchange/map/style.json")
    expect(
      resolveAllowedMapResourceUrl(
        "https://ims.test/assets/map/tile.pbf",
        "https://ims.test"
      )
    ).toBe("https://ims.test/assets/map/tile.pbf")
    expect(
      resolveAllowedMapResourceUrl(
        "https://tiles.openfreemap.org/planet/20260726/3/6/3.pbf",
        "https://ims.test"
      )
    ).toBe("https://tiles.openfreemap.org/planet/20260726/3/6/3.pbf")
    expect(
      resolveAllowedMapResourceUrl(
        "https://tiles.openfreemap.org:443/fonts/Noto%20Sans/0-255.pbf",
        "https://ims.test"
      )
    ).toBe("https://tiles.openfreemap.org/fonts/Noto%20Sans/0-255.pbf")

    for (const resource of [
      "https://tiles.example.test/map.pbf",
      "http://tiles.openfreemap.org/map.pbf",
      "https://tiles.openfreemap.org:444/map.pbf",
      "https://tiles.openfreemap.org.example.test/map.pbf",
      "https://tiles.openfreemap.org./map.pbf",
      "https://user@tiles.openfreemap.org/map.pbf",
      "data:application/json,%7B%7D",
      "mapbox://styles/example/style",
      "file:///tmp/map.json",
    ]) {
      expect(() =>
        resolveAllowedMapResourceUrl(resource, "https://ims.test")
      ).toThrow(/OpenFreeMap/)
    }
  })

  it("keeps an ordinary viewport as one bounded request", () => {
    expect(
      splitViewportBounds({ west: 100, south: 20, east: 130, north: 45 })
    ).toEqual([[100, 20, 130, 45]])
  })

  it("splits an antimeridian viewport into non-empty requests", () => {
    expect(
      splitViewportBounds({ west: 170, south: -20, east: -170, north: 20 })
    ).toEqual([
      [170, -20, 180, 20],
      [-180, -20, -170, 20],
    ])
    expect(
      splitViewportBounds({ west: 170, south: -20, east: -180, north: 20 })
    ).toEqual([[170, -20, 180, 20]])
    expect(
      splitViewportBounds({ west: 180, south: -20, east: -170, north: 20 })
    ).toEqual([[-180, -20, -170, 20]])
  })

  it("uses one world request and rejects invalid vertical bounds", () => {
    expect(
      splitViewportBounds({ west: -200, south: -100, east: 200, north: 100 })
    ).toEqual([[-180, -90, 180, 90]])
    expect(
      splitViewportBounds({ west: 100, south: 30, east: 120, north: 30 })
    ).toEqual([])
  })

  it("deduplicates split responses and ORs their truncated state", () => {
    const second = { ...office, id: "office-2", slug: "second" }
    expect(
      mergeMapOfficeResponses([
        { items: [office], truncated: false },
        { items: [office, second], truncated: true },
      ])
    ).toEqual({ items: [office, second], truncated: true })
  })

  it("groups the same regional coordinate without jittering its position", () => {
    const sameGridOffice: FudabaMapOffice = {
      ...office,
      id: "office-2",
      slug: "same-grid",
      name: "同区域事务所",
      accent: "#2581c7",
      seriesCodes: ["cg"],
    }
    const groups = groupMapOffices([office, sameGridOffice], seriesCatalog)

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      key: "31.2,121.5",
      latitude: 31.2,
      longitude: 121.5,
      offices: [office, sameGridOffice],
      colors: ["#f34f6d", "#2681c8"],
    })
  })

  it("uses the catalog colors for canonical agency codes", () => {
    const groups = groupMapOffices(
      [{ ...office, seriesCodes: ["ml", "sc"] }],
      seriesCatalog
    )
    expect(groups[0]?.colors).toEqual(["#ffc30b", "#8dbbff"])
  })
})

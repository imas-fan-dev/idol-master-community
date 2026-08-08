import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

interface MapStyleAsset {
  version: number
  sources: Record<
    string,
    {
      type?: string
      url?: string
      tiles?: string[]
    }
  >
  sprite?: string
  glyphs?: string
  layers: Array<{ id: string; type: string; source?: string }>
}

async function readExchangeStyle() {
  const raw = await readFile(
    resolve(process.cwd(), "public/maps/exchange-style.json"),
    "utf8"
  )
  return JSON.parse(raw) as MapStyleAsset
}

describe("exchange world map style asset", () => {
  it("keeps the detailed OpenFreeMap world sources and label layers", async () => {
    const style = await readExchangeStyle()
    const layerIds = new Set(style.layers.map((layer) => layer.id))

    expect(style.version).toBe(8)
    expect(style.sources.openmaptiles).toEqual({
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
    })
    expect(style.sources.ne2_shaded?.tiles).toEqual([
      "https://tiles.openfreemap.org/natural_earth/ne2sr/{z}/{x}/{y}.png",
    ])
    expect(style.sprite).toMatch(
      /^https:\/\/tiles\.openfreemap\.org\/sprites\//
    )
    expect(style.glyphs).toBe(
      "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf"
    )
    expect(style.layers.length).toBeGreaterThanOrEqual(100)
    for (const layerId of [
      "water",
      "highway-primary",
      "boundary_2",
      "label_city",
      "label_country_1",
    ]) {
      expect(layerIds).toContain(layerId)
    }
    expect(JSON.stringify(style)).not.toContain("china-provinces")
  })
})

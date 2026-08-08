import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const series = {
  items: [
    {
      id: 1,
      code: "765",
      displayName: "765PRO",
      color: "#f34f6d",
      iconUrl: "/brand/series/765pro.png",
      imageTransform: {
        fit: "contain",
        focalX: 0.5,
        focalY: 0.5,
        zoom: 1,
        rotation: 0,
      },
      displayOrder: 0,
      activeOfficeCount: 2,
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
  ],
}

const directoryOffice = {
  id: "office-1",
  slug: "shanghai-weekend",
  name: "上海周末交换事务所",
  intro: "每周末开放的线下交换点。",
  city: "上海",
  accent: "#f34e6c",
  coverUrl: null,
  isOpen: true,
  visitorCount: 21,
  seriesCodes: ["765"],
}

const mapOffices = [
  {
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
  },
  {
    id: "office-2",
    slug: "shanghai-event",
    name: "上海活动交换事务所",
    city: "上海",
    accent: "#2581c7",
    isOpen: false,
    seriesCodes: ["cg"],
    location: {
      latitude: 31.2,
      longitude: 121.5,
      precision: "regional",
    },
  },
]

const card = {
  id: "card-1",
  producerName: "春香P",
  displayName: "周末交换会名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  frontImageUrl: "/brand/series/wall/765pro.webp",
  backImageUrl: "/brand/series/wall/cinderella-girls.webp",
  accent: "#f34e6c",
  bio: "上海地区制作人",
  tradeNote: "现场交换同系列名片",
  available: true,
  source: null,
  createdAt: "2026-08-02T08:00:00.000Z",
  interactions: {
    likes: 12,
    favorites: 4,
    viewerLiked: false,
    viewerFavorited: false,
  },
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("imsweb.language", "zh-CN")
  })
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    ) {
      await route.abort("blockedbyclient")
      return
    }
    await route.continue()
  })
  await page.route("**/api/community/exchange/series", async (route) => {
    await route.fulfill({ json: series })
  })
  await page.route("**/api/community/exchange/offices?*", async (route) => {
    await route.fulfill({
      json: {
        items: [directoryOffice],
        pageInfo: { hasNextPage: false, nextCursor: null },
      },
    })
  })
  await page.route("**/api/community/exchange/cards?*", async (route) => {
    await route.fulfill({
      json: {
        items: [card],
        pageInfo: { hasNextPage: false, nextCursor: null },
      },
    })
  })
  await page.route(
    "**/api/community/exchange/offices/shanghai-weekend",
    async (route) => {
      await route.fulfill({
        json: { office: { ...directoryOffice, cards: [] } },
      })
    }
  )
  await page.route("**/api/community/exchange/map/config", async (route) => {
    await route.fulfill({
      json: { styleUrl: "/api/community/exchange/map/style.json" },
    })
  })
  await page.route(
    "**/api/community/exchange/map/style.json",
    async (route) => {
      await route.fulfill({
        json: {
          version: 8,
          name: "IMSWeb regional map test style",
          sources: {
            "china-provinces": {
              type: "geojson",
              data: "/maps/china-provinces.json",
            },
          },
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": "#e8f2f4" },
            },
            {
              id: "province-fill",
              type: "fill",
              source: "china-provinces",
              paint: { "fill-color": "#f6f7f4", "fill-opacity": 0.96 },
            },
            {
              id: "province-boundary",
              type: "line",
              source: "china-provinces",
              paint: {
                "line-color": "#66736d",
                "line-opacity": 0.9,
                "line-width": 1,
              },
            },
          ],
        },
      })
    }
  )
})

test("fills the public workspace with a responsive map and keeps both directories reachable", async ({
  page,
  isMobile,
}, testInfo) => {
  const requests: string[] = []
  const externalRequests: string[] = []
  const consoleErrors: string[] = []
  const controlledWarnings: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    requests.push(url.href)
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !["127.0.0.1", "localhost"].includes(url.hostname)
    ) {
      externalRequests.push(url.href)
    }
  })
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
    if (/controlled|uncontrolled/i.test(message.text())) {
      controlledWarnings.push(message.text())
    }
  })
  await page.route("**/api/community/exchange/map/offices?*", async (route) => {
    await route.fulfill({ json: { items: mapOffices, truncated: false } })
  })

  await page.goto("/community/exchange/?view=map&bbox=100,20,130,45")
  await expect(page).not.toHaveURL(/bbox=/)
  await expect(page).not.toHaveURL(/view=/)
  expect(new URL(page.url()).pathname).toBe("/community/exchange/")

  const canvas = page.locator("canvas.maplibregl-canvas")
  await expect(canvas).toBeVisible()
  await expect(page.locator(".maplibregl-ctrl-compass")).toHaveCount(0)
  await expect(page.locator(".maplibregl-ctrl-zoom-in")).toBeVisible()
  await expect(page.locator(".maplibregl-ctrl-zoom-out")).toBeVisible()
  expect(requests.some((url) => url.includes("/exchange/map/config"))).toBe(
    true
  )
  await expect
    .poll(() => requests.some((url) => url.includes("maplibre-gl-worker")))
    .toBe(true)

  if (!isMobile) {
    const agencyChannel = page.getByRole("button", { name: /765PRO/ })
    await expect(agencyChannel.locator("img")).toHaveAttribute(
      "src",
      "/brand/series/765pro.png"
    )
    await agencyChannel.click()
    await expect(page).toHaveURL(/series=765/)
    await expect
      .poll(() =>
        requests
          .filter((url) => url.includes("/api/community/exchange/map/offices?"))
          .some((url) => new URL(url).searchParams.get("series") === "765")
      )
      .toBe(true)
  }

  const groupMarker = page
    .getByLabel("区域事务所地图工作面", { exact: true })
    .getByRole("button", {
      name: /上海周末交换事务所、上海活动交换事务所，2 个事务所/,
    })
  await expect(groupMarker).toBeVisible()
  await expect
    .poll(async () => {
      const screenshot = await canvas.screenshot()
      return page.evaluate(async (base64) => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const probe = document.createElement("canvas")
        probe.width = image.naturalWidth
        probe.height = image.naturalHeight
        const context = probe.getContext("2d", { willReadFrequently: true })
        if (!context || !probe.width || !probe.height) return false
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(
          0,
          0,
          probe.width,
          probe.height
        ).data
        let firstColor = ""
        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index + 3] === 0) continue
          const color = `${pixels[index]},${pixels[index + 1]},${pixels[index + 2]},${pixels[index + 3]}`
          if (!firstColor) firstColor = color
          else if (color !== firstColor) return true
        }
        return false
      }, screenshot.toString("base64"))
    })
    .toBe(true)

  if (!isMobile) {
    const readMarkerPosition = async () => {
      const box = await groupMarker.boundingBox()
      if (!box) return null
      return {
        x: Math.round(box.x * 10) / 10,
        y: Math.round(box.y * 10) / 10,
      }
    }
    const markerPosition = await readMarkerPosition()
    const mapBox = await canvas.boundingBox()
    expect(markerPosition).not.toBeNull()
    expect(mapBox).not.toBeNull()
    if (!mapBox) throw new Error("Map canvas has no rendered bounds")

    await page.mouse.move(
      mapBox.x + mapBox.width * 0.55,
      mapBox.y + mapBox.height * 0.55
    )
    await page.mouse.down({ button: "right" })
    await page.mouse.move(
      mapBox.x + mapBox.width * 0.75,
      mapBox.y + mapBox.height * 0.3,
      { steps: 8 }
    )
    await page.mouse.up({ button: "right" })
    await canvas.focus()
    await page.keyboard.press("Shift+ArrowRight")
    await page.keyboard.press("Shift+ArrowUp")

    await expect.poll(readMarkerPosition).toEqual(markerPosition)
  }

  const readMapGeometry = () =>
    page.evaluate(() => {
      const header = document.querySelector("header")
      const workspace = document.querySelector<HTMLElement>("main#main-content")
      const mapRegion = document.querySelector<HTMLElement>(
        'section[aria-label="区域地图"]'
      )
      const discoveryRail = document.querySelector<HTMLElement>(
        'aside[aria-label="交换发现栏"]'
      )
      const mapContainer = document.querySelector<HTMLElement>(
        '[aria-label="区域事务所地图工作面"]'
      )
      const mapCanvas = document.querySelector<HTMLCanvasElement>(
        "canvas.maplibregl-canvas"
      )
      if (
        !header ||
        !workspace ||
        !mapRegion ||
        !discoveryRail ||
        !mapContainer ||
        !mapCanvas
      ) {
        return null
      }
      const headerRect = header.getBoundingClientRect()
      const workspaceRect = workspace.getBoundingClientRect()
      const mapRegionRect = mapRegion.getBoundingClientRect()
      const discoveryRailRect = discoveryRail.getBoundingClientRect()
      const containerRect = mapContainer.getBoundingClientRect()
      const canvasRect = mapCanvas.getBoundingClientRect()
      return {
        headerBottom: headerRect.bottom,
        workspaceLeft: workspaceRect.left,
        workspaceRight: workspaceRect.right,
        workspaceTop: workspaceRect.top,
        workspaceBottom: workspaceRect.bottom,
        workspaceWidth: workspaceRect.width,
        workspaceHeight: workspaceRect.height,
        mapRegionLeft: mapRegionRect.left,
        mapRegionRight: mapRegionRect.right,
        mapRegionTop: mapRegionRect.top,
        mapRegionBottom: mapRegionRect.bottom,
        mapRegionWidth: mapRegionRect.width,
        mapRegionHeight: mapRegionRect.height,
        discoveryRailDisplay: getComputedStyle(discoveryRail).display,
        discoveryRailLeft: discoveryRailRect.left,
        discoveryRailRight: discoveryRailRect.right,
        discoveryRailTop: discoveryRailRect.top,
        discoveryRailBottom: discoveryRailRect.bottom,
        discoveryRailWidth: discoveryRailRect.width,
        containerLeft: containerRect.left,
        containerRight: containerRect.right,
        containerTop: containerRect.top,
        containerBottom: containerRect.bottom,
        containerWidth: containerRect.width,
        containerHeight: containerRect.height,
        canvasLeft: canvasRect.left,
        canvasRight: canvasRect.right,
        canvasTop: canvasRect.top,
        canvasBottom: canvasRect.bottom,
        canvasWidth: canvasRect.width,
        canvasHeight: canvasRect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      }
    })

  const isSourceLayoutMap = (
    geometry: Awaited<ReturnType<typeof readMapGeometry>>,
    narrow: boolean
  ) => {
    if (geometry === null) return false
    const commonGeometryMatches =
      Math.abs(geometry.headerBottom - geometry.workspaceTop) <= 1 &&
      Math.abs(geometry.workspaceLeft) <= 1 &&
      Math.abs(geometry.workspaceRight - geometry.viewportWidth) <= 1 &&
      Math.abs(geometry.workspaceBottom - geometry.viewportHeight) <= 1 &&
      Math.abs(geometry.workspaceWidth - geometry.viewportWidth) <= 1 &&
      Math.abs(geometry.workspaceTop - geometry.mapRegionTop) <= 1 &&
      Math.abs(geometry.workspaceBottom - geometry.mapRegionBottom) <= 1 &&
      Math.abs(geometry.workspaceRight - geometry.mapRegionRight) <= 1 &&
      Math.abs(geometry.mapRegionLeft - geometry.containerLeft) <= 1 &&
      Math.abs(geometry.mapRegionRight - geometry.containerRight) <= 1 &&
      Math.abs(geometry.mapRegionTop - geometry.containerTop) <= 1 &&
      Math.abs(geometry.mapRegionBottom - geometry.containerBottom) <= 1 &&
      Math.abs(geometry.mapRegionWidth - geometry.containerWidth) <= 1 &&
      Math.abs(geometry.mapRegionHeight - geometry.containerHeight) <= 1 &&
      Math.abs(geometry.containerLeft - geometry.canvasLeft) <= 1 &&
      Math.abs(geometry.containerRight - geometry.canvasRight) <= 1 &&
      Math.abs(geometry.containerTop - geometry.canvasTop) <= 1 &&
      Math.abs(geometry.containerBottom - geometry.canvasBottom) <= 1 &&
      Math.abs(geometry.containerWidth - geometry.canvasWidth) <= 1 &&
      Math.abs(geometry.containerHeight - geometry.canvasHeight) <= 1 &&
      geometry.scrollWidth <= geometry.viewportWidth &&
      geometry.scrollHeight <= geometry.viewportHeight
    if (!commonGeometryMatches) return false

    if (narrow) {
      return (
        geometry.discoveryRailDisplay === "none" &&
        geometry.discoveryRailWidth === 0 &&
        Math.abs(geometry.mapRegionLeft) <= 1
      )
    }

    return (
      geometry.discoveryRailDisplay !== "none" &&
      geometry.discoveryRailWidth >= 300 &&
      geometry.discoveryRailWidth <= 360 &&
      Math.abs(geometry.discoveryRailLeft) <= 1 &&
      Math.abs(geometry.discoveryRailRight - geometry.mapRegionLeft) <= 1 &&
      Math.abs(geometry.discoveryRailTop - geometry.workspaceTop) <= 1 &&
      Math.abs(geometry.discoveryRailBottom - geometry.workspaceBottom) <= 1
    )
  }

  await expect
    .poll(async () => isSourceLayoutMap(await readMapGeometry(), isMobile))
    .toBe(true)

  await page.setViewportSize(
    isMobile ? { width: 412, height: 780 } : { width: 1180, height: 760 }
  )
  await expect
    .poll(async () => isSourceLayoutMap(await readMapGeometry(), isMobile))
    .toBe(true)

  await groupMarker.click()

  if (isMobile) {
    await expect(
      page.getByRole("dialog").getByText("上海活动交换事务所")
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "查看事务所" }).first()
    ).toHaveAttribute("href", "/community/exchange/offices/shanghai-weekend")
    await page.keyboard.press("Escape")
  } else {
    await expect(page.getByText("上海活动交换事务所")).toBeVisible()
    await expect(
      page.getByRole("link", { name: "查看事务所" }).first()
    ).toHaveAttribute("href", "/community/exchange/offices/shanghai-weekend")
    await page.setViewportSize({ width: 900, height: 760 })
    await expect(
      page
        .getByRole("dialog", { name: "区域交换事务所" })
        .getByText("上海活动交换事务所")
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await page.setViewportSize({ width: 1180, height: 760 })
    await expect(page.getByText("上海活动交换事务所")).toBeVisible()
  }

  const mapRequestCount = requests.filter((url) =>
    url.includes("/api/community/exchange/map/offices?")
  ).length
  if (isMobile) {
    await page.getByRole("button", { name: "打开筛选" }).click()
  }
  await page.getByRole("checkbox", { name: "仅看开放事务所" }).click()
  await expect(page).toHaveURL(/open=true/)
  await expect
    .poll(() =>
      requests
        .filter((url) => url.includes("/api/community/exchange/map/offices?"))
        .some((url) => new URL(url).searchParams.get("open") === "true")
    )
    .toBe(true)
  expect(
    requests.filter((url) =>
      url.includes("/api/community/exchange/map/offices?")
    ).length
  ).toBeGreaterThan(mapRequestCount)
  for (const url of requests.filter((url) =>
    url.includes("/api/community/exchange/map/offices?")
  )) {
    expect(new URL(url).searchParams.get("bbox")).toBeTruthy()
    expect(new URL(url).searchParams.get("limit")).toBe("200")
  }

  if (isMobile) await page.keyboard.press("Escape")
  await page
    .getByRole("button", {
      name: isMobile ? "打开事务所名录" : "事务所",
      exact: true,
    })
    .click()
  const directory = page.getByRole("dialog", { name: "公开交换名录" })
  await expect(
    directory.getByRole("link", { name: "上海周末交换事务所" })
  ).toBeVisible()
  await page.getByRole("tab", { name: "名片" }).click()
  await expect(page.getByText("周末交换会名片")).toBeVisible()

  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])
  expect(externalRequests).toEqual([])
  expect(controlledWarnings).toEqual([])
  expect(consoleErrors).toEqual([])

  if (process.env.CAPTURE_FUDABA_QA === "1") {
    await directory.getByRole("button", { name: "关闭" }).click()
    await expect(directory).toBeHidden()
    await page.screenshot({
      path: `/tmp/imsweb-fudaba-map-${testInfo.project.name}.png`,
    })
  }
})

test("falls back to the directory without hiding cards when config fails", async ({
  page,
}) => {
  await page.route("**/api/community/exchange/map/config", async (route) => {
    await route.fulfill({ status: 503, json: { error: "map disabled" } })
  })
  await page.goto("/community/exchange?view=map")

  await expect(page.getByText("地图暂时不可用")).toBeVisible()
  const fallbackGeometry = await page.evaluate(() => {
    const header = document.querySelector("header")
    const workspace = document.querySelector("main")
    if (!header || !workspace) return null
    const headerRect = header.getBoundingClientRect()
    const workspaceRect = workspace.getBoundingClientRect()
    return {
      headerBottom: headerRect.bottom,
      workspaceLeft: workspaceRect.left,
      workspaceRight: workspaceRect.right,
      workspaceTop: workspaceRect.top,
      workspaceBottom: workspaceRect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      footerPresent: Boolean(document.querySelector("footer")),
    }
  })
  expect(fallbackGeometry).not.toBeNull()
  expect(
    Math.abs(fallbackGeometry!.headerBottom - fallbackGeometry!.workspaceTop)
  ).toBeLessThanOrEqual(1)
  expect(Math.abs(fallbackGeometry!.workspaceLeft)).toBeLessThanOrEqual(1)
  expect(
    Math.abs(fallbackGeometry!.workspaceRight - fallbackGeometry!.viewportWidth)
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      fallbackGeometry!.workspaceBottom - fallbackGeometry!.viewportHeight
    )
  ).toBeLessThanOrEqual(1)
  expect(fallbackGeometry!.scrollWidth).toBeLessThanOrEqual(
    fallbackGeometry!.viewportWidth
  )
  expect(fallbackGeometry!.scrollHeight).toBeLessThanOrEqual(
    fallbackGeometry!.viewportHeight
  )
  expect(fallbackGeometry!.footerPresent).toBe(false)
  await page.getByRole("button", { name: "查看事务所名录" }).click()
  await expect(page).not.toHaveURL(/view=map/)
  const fallbackDirectory = page.getByRole("dialog", { name: "公开交换名录" })
  await expect(
    fallbackDirectory.getByRole("link", { name: "上海周末交换事务所" })
  ).toBeVisible()
  await fallbackDirectory.getByRole("tab", { name: "名片" }).click()
  await expect(fallbackDirectory.getByText("周末交换会名片")).toBeVisible()
  await fallbackDirectory
    .getByRole("button", { name: "查看周末交换会名片正面" })
    .click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await fallbackDirectory.getByRole("tab", { name: "事务所" }).click()
  await fallbackDirectory
    .getByRole("link", { name: "上海周末交换事务所" })
    .click()
  await expect(page).toHaveURL(
    /\/community\/exchange\/offices\/shanghai-weekend$/
  )
  await expect(
    page.getByRole("heading", { name: "上海周末交换事务所" })
  ).toBeVisible()
})

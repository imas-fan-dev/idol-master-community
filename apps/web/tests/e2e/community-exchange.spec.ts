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
  ],
}

const office = {
  id: "office-1",
  slug: "shanghai-weekend",
  name: "上海周末交换事务所",
  intro: "每周末开放的线下交换点，欢迎现场交换公开名片。",
  city: "上海",
  accent: "#2581c7",
  coverUrl: "/brand/series/wall/cinderella-girls.webp",
  isOpen: true,
  visitorCount: 21,
  seriesCodes: ["765", "cg"],
}

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
  await page.route("**/api/community/exchange/series", async (route) => {
    await route.fulfill({ json: series })
  })
  await page.route("**/api/community/exchange/offices?*", async (route) => {
    await route.fulfill({
      json: {
        items: [office],
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
        json: {
          office: {
            ...office,
            cards: [
              {
                ...card,
                viewerOwned: false,
                placement: {
                  pinnedAt: "2026-08-02T09:00:00.000Z",
                  x: 46,
                  y: 51,
                  rotation: -3,
                  zIndex: 2,
                  revision: 0,
                  updatedAt: "2026-08-02T09:00:00.000Z",
                },
              },
            ],
          },
        },
      })
    }
  )
})

test("discovers an exchange office and preserves the detail deep link", async ({
  page,
  isMobile,
}, testInfo) => {
  await page.goto("/community")
  const exchangeLink = page.getByRole("link", { name: /名片交换事务所/ })
  await expect(exchangeLink).toBeVisible()
  await exchangeLink.click()

  await expect(page).toHaveURL(/\/community\/exchange$/)
  await expect(
    page.getByRole("heading", {
      name: isMobile ? "名片交换事务所" : "名片交换信号地图",
      exact: true,
    })
  ).toBeVisible()

  if (isMobile) {
    await page.getByRole("button", { name: "打开筛选" }).click()
  }
  await page.getByRole("checkbox", { name: "仅看开放事务所" }).click()
  await expect(page).toHaveURL(/open=true/)
  if (isMobile) await page.keyboard.press("Escape")

  await page
    .getByRole("button", {
      name: isMobile ? "打开事务所名录" : "事务所",
      exact: true,
    })
    .click()
  await expect(
    page.getByRole("link", { name: "上海周末交换事务所" })
  ).toBeVisible()
  await page.getByRole("tab", { name: "名片" }).click()
  await expect(page.getByText("周末交换会名片")).toBeVisible()
  await page.getByRole("tab", { name: "事务所" }).click()

  const mainOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  )
  expect(mainOverflow).toBe(false)

  const mainAccessibility = await new AxeBuilder({ page }).analyze()
  expect(mainAccessibility.violations).toEqual([])

  if (process.env.CAPTURE_FUDABA_QA === "1") {
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: `/tmp/imsweb-fudaba-discovery-${testInfo.project.name}.png`,
      fullPage: true,
    })
  }

  await page.getByRole("link", { name: "上海周末交换事务所" }).click()
  await expect(page).toHaveURL(
    /\/community\/exchange\/offices\/shanghai-weekend$/
  )
  await expect(
    page.getByRole("heading", { name: "上海周末交换事务所" })
  ).toBeVisible()
  await expect(page.getByRole("tab", { name: "墙面" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  await expect(
    page.getByRole("button", { name: "查看周末交换会名片正面" })
  ).toBeVisible()

  if (process.env.CAPTURE_FUDABA_QA === "1") {
    await focusCardWallForScreenshot(page)
    await page.screenshot({
      path: `/tmp/imsweb-fudaba-office-wall-${testInfo.project.name}.png`,
    })
  }

  await page.getByRole("tab", { name: "列表" }).click()
  await expect(
    page.getByRole("button", { name: "查看周末交换会名片背面" })
  ).toBeVisible()

  const detailOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  )
  expect(
    detailOverflow,
    `${isMobile ? "mobile" : "desktop"} detail overflow`
  ).toBe(false)

  const detailAccessibility = await new AxeBuilder({ page }).analyze()
  expect(detailAccessibility.violations).toEqual([])

  if (process.env.CAPTURE_FUDABA_QA === "1") {
    await focusCardWallForScreenshot(page)
    await page.screenshot({
      path: `/tmp/imsweb-fudaba-office-list-${testInfo.project.name}.png`,
    })
  }

  await page.goto("/community/exchange/offices/shanghai-weekend")
  await expect(
    page.getByRole("heading", { name: "上海周末交换事务所" })
  ).toBeVisible()
})

test("keeps boundary card placements inside the visible wall", async ({
  page,
}) => {
  await page.route(
    "**/api/community/exchange/offices/shanghai-weekend",
    async (route) => {
      await route.fulfill({
        json: {
          office: {
            ...office,
            cards: [
              {
                ...card,
                id: "card-north-west",
                displayName: "左上边界名片",
                viewerOwned: false,
                placement: {
                  pinnedAt: "2026-08-02T09:00:00.000Z",
                  x: 0,
                  y: 0,
                  rotation: -12,
                  zIndex: 1,
                  revision: 0,
                  updatedAt: "2026-08-02T09:00:00.000Z",
                },
              },
              {
                ...card,
                id: "card-south-east",
                displayName: "右下边界名片",
                viewerOwned: false,
                placement: {
                  pinnedAt: "2026-08-02T09:01:00.000Z",
                  x: 100,
                  y: 100,
                  rotation: 12,
                  zIndex: 2,
                  revision: 0,
                  updatedAt: "2026-08-02T09:01:00.000Z",
                },
              },
            ],
          },
        },
      })
    }
  )

  await page.goto("/community/exchange/offices/shanghai-weekend")
  const wall = page.getByLabel("名片墙放置区域")
  await expect(wall).toBeVisible()
  const wallBox = await wall.boundingBox()
  expect(wallBox).not.toBeNull()

  for (const name of ["左上边界名片", "右下边界名片"]) {
    const cardBox = await page
      .getByRole("button", { name: `查看${name}正面` })
      .boundingBox()
    expect(cardBox).not.toBeNull()
    expect(cardBox!.x).toBeGreaterThanOrEqual(wallBox!.x)
    expect(cardBox!.y).toBeGreaterThanOrEqual(wallBox!.y)
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(
      wallBox!.x + wallBox!.width
    )
    expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(
      wallBox!.y + wallBox!.height
    )
  }
})

test("lets a card owner arrange and persist the free-placement wall", async ({
  context,
  page,
}, testInfo) => {
  await context.addCookies([
    {
      name: "ims_platform_csrf",
      value: "card-wall-csrf",
      domain: "127.0.0.1",
      path: "/",
    },
  ])

  const ownerCards = [
    {
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
      mediaRightsStatus: "approved",
      publicationStatus: "published",
      revision: 2,
      createdAt: "2026-08-02T08:00:00.000Z",
      updatedAt: "2026-08-02T09:00:00.000Z",
    },
    {
      id: "card-2",
      producerName: "春香P",
      displayName: "第二张公开名片",
      seriesCode: "765",
      favoriteIdol: "天海春香",
      frontImageUrl: "/brand/series/wall/cinderella-girls.webp",
      backImageUrl: "/brand/series/wall/765pro.webp",
      accent: "#2581c7",
      bio: "自由摆放测试",
      tradeNote: "也欢迎交换",
      available: true,
      mediaRightsStatus: "approved",
      publicationStatus: "published",
      revision: 1,
      createdAt: "2026-08-02T08:10:00.000Z",
      updatedAt: "2026-08-02T09:10:00.000Z",
    },
  ]
  const placements = new Map([
    [
      "card-1",
      {
        pinnedAt: "2026-08-02T09:00:00.000Z",
        x: 32,
        y: 55,
        rotation: -3,
        zIndex: 2,
        revision: 3,
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
    ],
  ])
  const placementWrites: Array<{
    cardId: string
    method: string
    body: Record<string, unknown>
  }> = []

  function publicCard(ownerCard: (typeof ownerCards)[number]) {
    return {
      id: ownerCard.id,
      producerName: ownerCard.producerName,
      displayName: ownerCard.displayName,
      seriesCode: ownerCard.seriesCode,
      favoriteIdol: ownerCard.favoriteIdol,
      frontImageUrl: ownerCard.frontImageUrl,
      backImageUrl: ownerCard.backImageUrl,
      accent: ownerCard.accent,
      bio: ownerCard.bio,
      tradeNote: ownerCard.tradeNote,
      available: ownerCard.available,
      source: null,
      createdAt: ownerCard.createdAt,
      interactions: {
        likes: 0,
        favorites: 0,
        viewerLiked: false,
        viewerFavorited: false,
      },
      viewerOwned: true,
      placement: placements.get(ownerCard.id),
    }
  }

  await page.route("**/api/platform/auth/session", async (route) => {
    await route.fulfill({
      json: {
        success: true,
        account: { id: "platform-wall-owner", status: "active" },
        profile: {
          displayName: "春香P",
          avatarUrl: null,
          homeCity: "上海",
          bio: "上海地区制作人",
        },
      },
    })
  })
  await page.route("**/api/platform/me", async (route) => {
    await route.fulfill({
      json: {
        success: true,
        account: { id: "platform-wall-owner", status: "active" },
        capabilities: { fudabaWrite: true },
        profile: {
          displayName: "春香P",
          avatarUrl: null,
          homeCity: "上海",
          bio: "上海地区制作人",
          updatedAt: 1,
        },
      },
    })
  })
  await page.route("**/api/community/exchange/me/cards", async (route) => {
    await route.fulfill({ json: { items: ownerCards } })
  })
  await page.route(
    "**/api/community/exchange/offices/shanghai-weekend",
    async (route) => {
      await route.fulfill({
        json: {
          office: {
            ...office,
            cards: ownerCards
              .filter((ownerCard) => placements.has(ownerCard.id))
              .map(publicCard),
          },
        },
      })
    }
  )
  await page.route(
    /\/api\/community\/exchange\/offices\/office-1\/cards\/[^/]+\/placement$/,
    async (route) => {
      const request = route.request()
      const cardId = new URL(request.url()).pathname.split("/").at(-2)!
      const body = request.postDataJSON() as Record<string, unknown>
      placementWrites.push({ cardId, method: request.method(), body })

      if (request.method() === "DELETE") {
        placements.delete(cardId)
        await route.fulfill({
          json: {
            success: true,
            revision: Number(body.expectedRevision) + 1,
          },
        })
        return
      }

      const previous = placements.get(cardId)
      const revision = previous ? previous.revision + 1 : 0
      const next = {
        pinnedAt: previous?.pinnedAt ?? "2026-08-02T10:00:00.000Z",
        x: Number(body.x),
        y: Number(body.y),
        rotation: Number(body.rotation),
        zIndex: Number(body.zIndex),
        revision,
        updatedAt: `2026-08-02T10:0${revision}:00.000Z`,
      }
      placements.set(cardId, next)
      await route.fulfill({
        status: previous ? 200 : 201,
        json: { success: true, placement: next },
      })
    }
  )

  await page.goto("/community/exchange/offices/shanghai-weekend")
  await page.getByRole("button", { name: "布置名片墙" }).click()
  await page.getByRole("button", { name: "放到墙上" }).click()

  await expect(
    page.getByRole("button", { name: "移动第二张公开名片" })
  ).toBeVisible()
  expect(placementWrites[0]).toMatchObject({
    cardId: "card-2",
    method: "PUT",
    body: { expectedRevision: null, x: 50, y: 50, rotation: 0 },
  })

  const moveHandle = page.getByRole("button", {
    name: "移动第二张公开名片",
  })
  await focusCardWallForScreenshot(page)
  await moveHandle.scrollIntoViewIfNeeded()
  const handleBox = await moveHandle.boundingBox()
  expect(handleBox).not.toBeNull()
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + handleBox!.height / 2
  )
  await page.mouse.down()
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2 + 52,
    handleBox!.y + handleBox!.height / 2 + 28,
    { steps: 4 }
  )
  await page.mouse.up()

  await expect.poll(() => placementWrites.length).toBe(2)
  expect(placementWrites[1]).toMatchObject({
    cardId: "card-2",
    method: "PUT",
    body: { expectedRevision: 0 },
  })
  const draggedPlacement = placements.get("card-2")!
  expect(draggedPlacement.x).toBeGreaterThan(50)
  expect(draggedPlacement.y).toBeGreaterThan(50)

  await page.reload()
  const placedCard = page.locator('[data-card-id="card-2"]')
  await expect(placedCard).toHaveAttribute(
    "data-placement-x",
    String(draggedPlacement.x)
  )

  await page.getByRole("button", { name: "布置名片墙" }).click()
  await focusCardWallForScreenshot(page)
  await page.getByRole("button", { name: "移动第二张公开名片" }).focus()
  await page.getByRole("button", { name: "向右旋转名片" }).click()
  await expect.poll(() => placementWrites.length).toBe(3)
  expect(placementWrites[2]).toMatchObject({
    cardId: "card-2",
    method: "PUT",
    body: { expectedRevision: 1, rotation: 2 },
  })

  await page.getByRole("button", { name: "翻转选中名片" }).click()
  await expect(
    page.getByRole("button", { name: "查看第二张公开名片背面" })
  ).toBeVisible()

  await page.getByRole("tab", { name: "墙面" }).focus()
  await page.keyboard.press("Escape")
  await page.mouse.move(0, 0)
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(accessibility.violations).toEqual([])

  const viewportGeometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollX: window.scrollX,
    overflowingElements: Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const bounds = element.getBoundingClientRect()
        return {
          tag: element.tagName,
          className: element.getAttribute("class"),
          label: element.getAttribute("aria-label"),
          left: Math.round(bounds.left),
          right: Math.round(bounds.right),
          width: Math.round(bounds.width),
        }
      })
      .filter(
        (element) =>
          element.width > 0 &&
          (element.left < -1 ||
            element.right > document.documentElement.clientWidth + 1)
      )
      .slice(0, 12),
  }))
  expect(viewportGeometry.scrollX).toBe(0)
  expect(viewportGeometry.overflowingElements).toEqual([])
  expect(viewportGeometry.scrollWidth).toBeLessThanOrEqual(
    viewportGeometry.clientWidth
  )

  if (process.env.CAPTURE_FUDABA_QA === "1") {
    await focusCardWallForScreenshot(page)
    await page.screenshot({
      path: `/tmp/imsweb-fudaba-card-wall-editor-${testInfo.project.name}.png`,
    })
  }

  await page.getByRole("button", { name: "从名片墙移除" }).click()
  await page.getByRole("button", { name: "移除" }).click()
  await expect.poll(() => placementWrites.length).toBe(4)
  expect(placementWrites[3]).toMatchObject({
    cardId: "card-2",
    method: "DELETE",
    body: { expectedRevision: 2 },
  })
  await expect(
    page.getByRole("button", { name: "查看第二张公开名片背面" })
  ).toHaveCount(0)

  await page.reload()
  await expect(page.locator('[data-card-id="card-2"]')).toHaveCount(0)
})

async function focusCardWallForScreenshot(
  page: import("@playwright/test").Page
) {
  await page
    .locator('section[aria-labelledby="office-card-wall-title"]')
    .evaluate((section) => {
      const top = section.getBoundingClientRect().top + window.scrollY
      const previousBehavior = document.documentElement.style.scrollBehavior
      document.documentElement.style.scrollBehavior = "auto"
      window.scrollTo({
        left: 0,
        top: Math.max(0, top - 80),
        behavior: "auto",
      })
      document.documentElement.style.scrollBehavior = previousBehavior
    })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
}

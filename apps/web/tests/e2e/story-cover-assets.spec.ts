import { expect, test } from "@playwright/test"

const coverAsset = {
  id: 12,
  agencyId: 6,
  name: "通用主线封面",
  imageUrl: "/brand/imsweb-logo.png",
  presentationPolicy: "contain",
  displayOrder: 0,
  isActive: true,
  revision: 0,
  usageCount: 2,
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/admin/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: {
          id: 1,
          username: "story-cover-qa",
          producername: "剧情封面检查",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
  await page.route("**/api/admin/wiki/catalog", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "success",
        agencies: [
          {
            id: 6,
            code: "sc",
            name: "闪耀色彩",
            color: "#8dbbff",
            wikiEnabled: true,
            bannerTitle: "闪耀色彩",
            displayOrder: 0,
            layoutRevision: 0,
            iconUrl: null,
            mediaRevision: 0,
            idols: [],
            groups: [],
          },
        ],
      }),
    })
  })
  await page.route(
    "**/api/admin/wiki/agencies/6/story-cover-assets",
    async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          status: "success",
          agency: { id: 6, code: "sc", name: "闪耀色彩" },
          assets: [coverAsset],
        }),
      })
    }
  )
})

test("full-image shared covers stay complete across preview canvases", async ({
  page,
}, testInfo) => {
  await page.goto("/admin/stories/assets?agencyId=6")

  await expect(
    page.getByRole("heading", { name: "企划剧情封面素材库" })
  ).toBeVisible()
  await expect(page.getByText("完整显示", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "编辑" }).click()

  const dialog = page.getByRole("dialog", { name: "编辑共享封面" })
  const preview = dialog.getByRole("img", { name: "通用主线封面预览" })
  await expect(preview).toBeVisible()
  await expect
    .poll(() =>
      preview.evaluate((image) => (image as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0)
  expect(
    await preview.evaluate((image) => getComputedStyle(image).objectFit)
  ).toBe("contain")

  for (const [label, ratio] of [
    ["宽幅", 2.8],
    ["标准", 16 / 9],
    ["方形", 1],
  ] as const) {
    await dialog.getByRole("button", { name: label }).click()
    const canvas = await preview.locator("..").boundingBox()
    expect(canvas).not.toBeNull()
    expect(canvas!.width / canvas!.height).toBeCloseTo(ratio, 1)
    expect(
      await preview.evaluate((image) => getComputedStyle(image).objectFit)
    ).toBe("contain")
  }

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)

  if (process.env.CAPTURE_STORY_COVER_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-story-cover-${testInfo.project.name}.png`,
      fullPage: false,
    })
  }
})

test("public story cards render full-image shared covers without cropping", async ({
  page,
}, testInfo) => {
  await page.route("**/api/wiki/stories?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        status: "success",
        agency: {
          id: 6,
          code: "sc",
          name: "闪耀色彩",
          color: "#8dbbff",
        },
        idol: {
          id: 6,
          name: "樱木真乃",
          folderName: "sakuragi_mano",
          color: "#f1b0c9",
          imageUrl: "/brand/series/shiny-colors.png",
          imageFit: "cover",
          textColor: "#ffffff",
        },
        categories: [
          {
            name: "enza主线",
            cards: [
              {
                id: 401,
                name: "【主线标识】",
                img: coverAsset.imageUrl,
                subtitle: "全话",
                imageTransform: {
                  fit: "contain",
                  focalX: 0.5,
                  focalY: 0.5,
                  zoom: 1,
                  rotation: 0,
                },
                links: [],
              },
            ],
          },
        ],
      }),
    })
  })

  await page.goto(
    "/story?agency=%E9%97%AA%E8%80%80%E8%89%B2%E5%BD%A9&idol=%E6%A8%B1%E6%9C%A8%E7%9C%9F%E4%B9%83"
  )

  const cardImage = page.getByRole("img", { name: "【主线标识】" })
  await expect(cardImage).toBeVisible()
  await expect
    .poll(() =>
      cardImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0)
  expect(
    await cardImage.evaluate((image) => ({
      fit: getComputedStyle(image).objectFit,
      position: getComputedStyle(image).objectPosition,
      transform: getComputedStyle(image).transform,
    }))
  ).toMatchObject({
    fit: "contain",
    position: "50% 50%",
  })
  const cardCanvas = await cardImage.locator("..").boundingBox()
  expect(cardCanvas).not.toBeNull()
  expect(cardCanvas!.width / cardCanvas!.height).toBeCloseTo(2.8, 1)

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)

  if (process.env.CAPTURE_STORY_COVER_QA === "1") {
    await cardImage.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `/tmp/imsweb-story-cover-public-${testInfo.project.name}.png`,
      fullPage: false,
    })
  }
})

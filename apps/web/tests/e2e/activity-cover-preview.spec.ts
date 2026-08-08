import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const coverUrl = "/brand/series/wall/cinderella-girls.webp"

async function expectFullPageGlass(
  page: import("@playwright/test").Page,
  dialog: import("@playwright/test").Locator
) {
  const dialogBox = await dialog.boundingBox()
  const viewportSize = page.viewportSize()
  expect(dialogBox).not.toBeNull()
  expect(viewportSize).not.toBeNull()
  if (dialogBox && viewportSize) {
    expect(dialogBox.x).toBe(0)
    expect(dialogBox.y).toBe(0)
    expect(dialogBox.width).toBe(viewportSize.width)
    expect(dialogBox.height).toBe(viewportSize.height)
  }
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCSS(
    "backdrop-filter",
    /blur\(40px\).*saturate\(1\.5\)/
  )
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/admin/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: {
          id: 1,
          username: "information-qa",
          producername: "活动内容检查",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
  await page.route("**/api/admin/information", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        version: 1,
        cards: [
          {
            id: "summer-live",
            category: "activity",
            contentType: "external",
            image: coverUrl,
            link: "https://example.com/summer-live",
            title: "夏日活动",
            updatedAt: "2026-07-26T00:00:00.000Z",
          },
        ],
        assets: [coverUrl],
      }),
    })
  })
})

test("activity covers open in an accessible zoomable viewer", async ({
  page,
}, testInfo) => {
  await page.goto("/admin/information")

  await expect(
    page.getByRole("heading", { name: "活动内容", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "查看夏日活动封面" }).click()

  const dialog = page.getByRole("dialog", { name: "夏日活动封面" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText("100%", { exact: true })).toBeVisible()

  await expectFullPageGlass(page, dialog)

  await dialog.getByRole("button", { name: "放大封面" }).click()
  await expect(dialog.getByText("125%", { exact: true })).toBeVisible()

  const viewport = dialog.getByLabel("封面查看区域")
  await viewport.dispatchEvent("wheel", { deltaY: -100 })
  await expect(dialog.getByText("150%", { exact: true })).toBeVisible()

  const viewportBox = await viewport.boundingBox()
  expect(viewportBox).not.toBeNull()
  if (viewportBox) {
    await page.mouse.move(
      viewportBox.x + viewportBox.width / 2,
      viewportBox.y + viewportBox.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      viewportBox.x + viewportBox.width / 2 + 48,
      viewportBox.y + viewportBox.height / 2 + 32
    )
    await page.mouse.up()
  }
  await expect(dialog.getByRole("img", { name: "夏日活动封面" })).toHaveCSS(
    "transform",
    /matrix\(1\.5, 0, 0, 1\.5, 48, 32\)/
  )

  if (process.env.CAPTURE_INFORMATION_COVER_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-information-cover-${testInfo.project.name}.png`,
      fullPage: false,
    })
  }

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)

  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
  expect(results.violations).toEqual([])
})

test("public activity covers use the same full-page viewer", async ({
  page,
}, testInfo) => {
  await page.route("**/api/events?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: 1,
            title: "公开夏日活动",
            name: "公开活动发布者",
            contact: null,
            image_url: coverUrl,
            created_at: "2026-07-26T00:00:00.000Z",
          },
        ],
        pageInfo: {
          nextCursor: null,
          hasNextPage: false,
          snapshotAt: "1",
        },
      }),
    })
  })

  await page.goto("/events")
  await page.getByRole("button", { name: "查看公开夏日活动封面" }).click()

  const dialog = page.getByRole("dialog", { name: "公开夏日活动封面" })
  await expect(dialog).toBeVisible()
  await expectFullPageGlass(page, dialog)

  if (process.env.CAPTURE_INFORMATION_COVER_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-public-activity-cover-${testInfo.project.name}.png`,
      fullPage: false,
    })
  }
})

test("namecard images show a shimmer until the network response completes", async ({
  page,
}, testInfo) => {
  const slowImageUrl = "/test-assets/slow-namecard-front.png"
  let releaseImage: () => void = () => undefined
  let markImageRequested: () => void = () => undefined
  const imageRequested = new Promise<void>((resolve) => {
    markImageRequested = resolve
  })
  const imageResponseGate = new Promise<void>((resolve) => {
    releaseImage = resolve
  })

  await page.route("**/api/cards?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        list: [
          {
            id: 42,
            image1_url: slowImageUrl,
            image2_url: coverUrl,
            status: "approved",
            created_at: null,
          },
        ],
        total: 1,
        totalPage: 1,
      }),
    })
  })
  await page.route("**/api/reactions?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })
  await page.route(`**${slowImageUrl}`, async (route) => {
    markImageRequested()
    await imageResponseGate
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64"
      ),
    })
  })

  await page.goto("/community/cards", { waitUntil: "domcontentloaded" })
  await imageRequested

  const image = page
    .getByRole("button", { name: "查看制作人名片 42 正面" })
    .locator("img")

  try {
    await expect(image).toHaveAttribute("data-image-state", "loading")
    await expect(image).not.toHaveAttribute("aria-busy")
    await expect(image).toHaveCSS("animation-name", "image-loading-shimmer")
    await expect(image).toHaveCSS("background-image", /linear-gradient/)

    if (process.env.CAPTURE_IMAGE_LOADING_QA === "1") {
      await page.screenshot({
        path: `/tmp/imsweb-image-loading-${testInfo.project.name}.png`,
        fullPage: false,
      })
    }
  } finally {
    releaseImage()
  }

  await expect(image).toHaveAttribute("data-image-state", "loaded")
  await expect(image).not.toHaveAttribute("aria-busy")
  await expect(image).toHaveCSS("animation-name", "none")
})

test("namecard images use the shared full-page viewer", async ({
  page,
}, testInfo) => {
  await page.route("**/api/cards?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        list: [
          {
            id: 42,
            image1_url: coverUrl,
            image2_url: "/brand/series/wall/shiny-colors.webp",
            status: "approved",
            created_at: null,
          },
        ],
        total: 1,
        totalPage: 1,
      }),
    })
  })
  await page.route("**/api/reactions?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  await page.goto("/community/cards")
  await page.getByRole("button", { name: "查看制作人名片 42 正面" }).click()

  const dialog = page.getByRole("dialog", { name: "制作人名片 42 正面" })
  await expect(dialog).toBeVisible()
  await expectFullPageGlass(page, dialog)
  await expect(dialog.getByLabel("名片查看区域")).toBeVisible()
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "data-image-state",
    "loaded"
  )

  await dialog.getByRole("button", { name: "放大名片" }).click()
  await expect(dialog.getByText("125%", { exact: true })).toBeVisible()

  if (process.env.CAPTURE_INFORMATION_COVER_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-namecard-preview-${testInfo.project.name}.png`,
      fullPage: false,
    })
  }

  await dialog.getByRole("button", { name: "关闭名片预览" }).click()
  await page.getByRole("button", { name: "查看制作人名片 42 背面" }).click()
  await expect(
    page.getByRole("dialog", { name: "制作人名片 42 背面" })
  ).toBeVisible()
})

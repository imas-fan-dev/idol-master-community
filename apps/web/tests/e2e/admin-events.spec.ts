import { expect, test } from "@playwright/test"

const longTitle =
  "【广O无料配送】交流站做了一些小偶像的钥匙扣物料，到时候会在广州 only 发，有喜欢的到时候可以找梦想之边拿。因为制作时间紧张，目前还没有成品照片。"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/admin/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: {
          id: 1,
          username: "event-layout-qa",
          producername: "活动布局检查",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
  await page.route("**/api/events?*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.abort()
      return
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          {
            id: "35",
            title: longTitle,
            name: "梦想之边",
            contact:
              "https://example.com/events/very-long-contact-path-that-must-not-expand-the-row?source=community&campaign=offline",
            image_url: "/brand/series/wall/765pro.webp",
            created_at: "2026-07-13T09:59:26.000Z",
          },
          {
            id: "34",
            title: "【娃娃群】",
            name: "财布乐园",
            contact: "群号：692897344",
            image_url: "/brand/series/wall/cinderella-girls.webp",
            created_at: "2026-05-17T04:40:53.000Z",
          },
        ],
        pageInfo: {
          nextCursor: null,
          hasNextPage: false,
          snapshotAt: "35",
        },
      }),
    })
  })
})

test("admin event rows keep delete actions inside the panel", async ({
  page,
}, testInfo) => {
  await page.goto("/admin/events")

  const panel = page.getByRole("region", { name: "现有活动" })
  await expect(panel.getByRole("article")).toHaveCount(2)

  const longRow = panel.getByRole("article").filter({ hasText: longTitle })
  const deleteButton = longRow.getByRole("button", { name: "删除" })
  await expect(deleteButton).toBeVisible()

  const panelBox = await panel.boundingBox()
  const rowBox = await longRow.boundingBox()
  const deleteButtonBox = await deleteButton.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(rowBox).not.toBeNull()
  expect(deleteButtonBox).not.toBeNull()
  const panelRight = panelBox!.x + panelBox!.width
  const rowRight = rowBox!.x + rowBox!.width
  const deleteButtonRight = deleteButtonBox!.x + deleteButtonBox!.width
  expect(rowRight).toBeLessThanOrEqual(panelRight + 1)
  expect(deleteButtonRight).toBeLessThanOrEqual(rowRight + 1)

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)

  await longRow.scrollIntoViewIfNeeded()
  if (process.env.CAPTURE_ADMIN_EVENTS_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-admin-events-${testInfo.project.name}.png`,
      fullPage: false,
    })
  }
})

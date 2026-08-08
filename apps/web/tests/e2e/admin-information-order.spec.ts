import { expect, test } from "@playwright/test"

const informationCards = [
  {
    id: "information-first",
    category: "activity",
    contentType: "external",
    image: "/brand/series/wall/765pro.webp",
    link: "https://example.test/first",
    title: "活动资讯第一项",
    updatedAt: "2026-07-31T00:00:00.000Z",
  },
  {
    id: "information-second",
    category: "fan",
    contentType: "external",
    image: "/brand/series/wall/cinderella-girls.webp",
    link: "https://example.test/second",
    title: "同人活动第二项",
    updatedAt: "2026-07-31T00:00:00.000Z",
  },
]

test("admin reorders activity information with the drag handle", async ({
  context,
  page,
}) => {
  let orderedCards = informationCards
  let submittedOrder: string[] | undefined

  await context.addCookies([
    {
      name: "ims_admin_csrf",
      value: "information-order-e2e",
      domain: "127.0.0.1",
      path: "/",
    },
  ])
  await page.route("**/api/admin/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: {
          id: 1,
          username: "information-operator",
          producername: "活动运营",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
  await page.route("**/api/admin/information**", async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname

    if (
      request.method() === "PUT" &&
      pathname === "/api/admin/information/order"
    ) {
      const body = request.postDataJSON() as { ids: string[] }
      submittedOrder = body.ids
      const byId = new Map(orderedCards.map((card) => [card.id, card]))
      orderedCards = body.ids.map((id) => byId.get(id)!)
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      })
      return
    }

    if (request.method() === "GET" && pathname === "/api/admin/information") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ version: 1, cards: orderedCards, assets: [] }),
      })
      return
    }

    await route.abort()
  })

  await page.goto("/admin/information")

  const panel = page.getByRole("region", { name: "已发布活动内容" })
  await expect(panel.getByRole("article")).toHaveCount(2)

  const firstHandle = panel.getByRole("button", {
    name: "拖动排序：活动资讯第一项",
  })
  await firstHandle.focus()
  await page.keyboard.press("Space")
  await page.waitForTimeout(100)
  await page.keyboard.press("ArrowDown")
  await page.waitForTimeout(100)
  await page.keyboard.press("Space")

  await expect
    .poll(() => submittedOrder)
    .toEqual(["information-second", "information-first"])
  await expect(panel.locator("article h3")).toHaveText([
    "同人活动第二项",
    "活动资讯第一项",
  ])

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)
})

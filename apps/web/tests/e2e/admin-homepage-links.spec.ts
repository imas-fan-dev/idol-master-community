import { expect, test } from "@playwright/test"

const navigationLinks = [
  {
    id: "navigation-events",
    section: "navigation",
    title: "活动中心",
    description: "浏览近期活动与公开信息",
    href: "/events",
    icon: "calendar",
    accent: "franchise-765",
    displayOrder: 0,
  },
  {
    id: "navigation-recommendations",
    section: "navigation",
    title: "内容推荐",
    description: "发现社区作品与精选内容",
    href: "/recommendations",
    icon: "book-open",
    accent: "franchise-cg",
    displayOrder: 1,
  },
]

test("admin reorders homepage links with the drag handle", async ({
  context,
  page,
}) => {
  let orderedLinks = navigationLinks
  let submittedOrder: string[] | undefined

  await context.addCookies([
    {
      name: "ims_admin_csrf",
      value: "homepage-links-e2e",
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
          username: "homepage-operator",
          producername: "首页运营",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
  await page.route("**/api/admin/homepage-links**", async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname

    if (
      request.method() === "PUT" &&
      pathname === "/api/admin/homepage-links/navigation/order"
    ) {
      const body = request.postDataJSON() as { ids: string[] }
      submittedOrder = body.ids
      const byId = new Map(orderedLinks.map((link) => [link.id, link]))
      orderedLinks = body.ids.map((id, index) => ({
        ...byId.get(id)!,
        displayOrder: index,
      }))
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      })
      return
    }

    if (
      request.method() === "GET" &&
      pathname === "/api/admin/homepage-links"
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sections: {
            navigation: orderedLinks,
            friend: [],
            support: [],
          },
        }),
      })
      return
    }

    await route.abort()
  })

  await page.goto("/admin/homepage")

  const panel = page.getByRole("region", { name: "站点导航" })
  await expect(panel.getByRole("article")).toHaveCount(2)

  const firstHandle = panel.getByRole("button", {
    name: "拖动排序：活动中心",
  })
  await firstHandle.focus()
  await page.keyboard.press("Space")
  await page.waitForTimeout(100)
  await page.keyboard.press("ArrowDown")
  await page.waitForTimeout(100)
  await page.keyboard.press("Space")

  await expect
    .poll(() => submittedOrder)
    .toEqual(["navigation-recommendations", "navigation-events"])
  await expect(panel.locator("article h3")).toHaveText(["内容推荐", "活动中心"])

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)
})

import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("imsweb.language", "zh-CN")
  })
})

test("anonymous header stays compact and does not probe Platform auth", async ({
  page,
}) => {
  const platformRequests: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/platform/auth/")) {
      platformRequests.push(request.url())
    }
  })

  await page.goto("/")

  const trigger = page.getByRole("button", { name: "帐号：未登录" })
  await expect(trigger).toBeVisible()
  const triggerBox = await trigger.boundingBox()
  expect(triggerBox).not.toBeNull()
  expect(triggerBox!.width).toBe(36)
  expect(triggerBox!.height).toBe(36)

  await trigger.focus()
  await expect(trigger).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByText("未登录", { exact: true })).toBeVisible()
  await expect(page.getByRole("link", { name: "登录" })).toHaveAttribute(
    "href",
    "/account/login"
  )
  await expect(page.getByRole("link", { name: "注册" })).toHaveAttribute(
    "href",
    "/account/register"
  )
  const accessibility = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
  expect(accessibility.violations).toEqual([])

  expect(platformRequests).toEqual([])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
})

test("authenticated header logs out only the Platform realm", async ({
  context,
  page,
}) => {
  await context.addCookies([
    {
      name: "ims_platform_csrf",
      value: "platform-browser-csrf",
      domain: "127.0.0.1",
      path: "/",
    },
    {
      name: "ims_admin_csrf",
      value: "backoffice-must-survive",
      domain: "127.0.0.1",
      path: "/",
    },
  ])
  let sessionRequests = 0
  let logoutRequests = 0
  let logoutCsrf: string | null = null
  await page.route("**/api/admin/auth/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: {
          id: 7,
          username: "backoffice-browser",
          producername: "Backoffice Browser",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
  await page.route("**/api/platform/auth/session", async (route) => {
    sessionRequests += 1
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        account: { id: "platform-browser", status: "active" },
        profile: {
          displayName: "浏览器制作人",
          avatarUrl: null,
          homeCity: null,
          bio: "",
        },
      }),
    })
  })
  await page.route("**/api/platform/auth/logout", async (route) => {
    logoutRequests += 1
    logoutCsrf = route.request().headers()["x-csrftoken"] ?? null
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    })
  })

  await page.goto("/")

  const trigger = page.getByRole("button", { name: "帐号：浏览器制作人" })
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByText("浏览器制作人", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "退出帐号" }).click()
  await expect(page.getByRole("button", { name: "帐号：未登录" })).toBeVisible()

  expect(sessionRequests).toBe(1)
  expect(logoutRequests).toBe(1)
  expect(logoutCsrf).toBe("platform-browser-csrf")
  expect(
    (await context.cookies()).find((cookie) => cookie.name === "ims_admin_csrf")
      ?.value
  ).toBe("backoffice-must-survive")
})

test("two tabs coordinate one Platform refresh wave", async ({
  context,
  page,
}) => {
  await context.addCookies([
    {
      name: "ims_platform_csrf",
      value: "platform-cross-tab-old",
      domain: "127.0.0.1",
      path: "/",
    },
  ])
  let initialSessionRequests = 0
  let refreshRequests = 0
  let releaseInitialRequests!: () => void
  const initialRequestsReady = new Promise<void>((resolve) => {
    releaseInitialRequests = resolve
  })
  await context.route("**/api/platform/auth/session", async (route) => {
    const cookies = route.request().headers().cookie ?? ""
    if (cookies.includes("ims_platform_csrf=platform-cross-tab-next")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          account: { id: "platform-cross-tab", status: "active" },
          profile: {
            displayName: "多页签制作人",
            avatarUrl: null,
            homeCity: null,
            bio: "",
          },
        }),
      })
      return
    }

    initialSessionRequests += 1
    if (initialSessionRequests === 2) releaseInitialRequests()
    await initialRequestsReady
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        success: false,
        code: "PLATFORM_SESSION_INVALID",
      }),
    })
  })
  await context.route("**/api/platform/auth/refresh", async (route) => {
    refreshRequests += 1
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "set-cookie":
          "ims_platform_csrf=platform-cross-tab-next; Path=/; SameSite=Lax",
      },
      body: JSON.stringify({ success: true }),
    })
  })

  const secondPage = await context.newPage()
  await Promise.all([page.goto("/"), secondPage.goto("/")])

  await expect(
    page.getByRole("button", { name: "帐号：多页签制作人" })
  ).toBeVisible()
  await expect(
    secondPage.getByRole("button", { name: "帐号：多页签制作人" })
  ).toBeVisible()
  expect(initialSessionRequests).toBe(2)
  expect(refreshRequests).toBe(1)
  await secondPage.close()
})

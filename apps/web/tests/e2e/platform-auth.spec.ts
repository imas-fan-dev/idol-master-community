import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

const session = {
  success: true,
  account: { id: "platform-browser", status: "active" },
  profile: {
    displayName: "浏览器制作人",
    avatarUrl: null,
    homeCity: null,
    bio: "",
  },
}

async function mockOwnerWorkspace(page: Page) {
  await page.route("**/api/platform/me", async (route) => {
    await route.fulfill({
      json: {
        ...session,
        capabilities: { fudabaWrite: true },
        profile: { ...session.profile, updatedAt: 1 },
      },
    })
  })
  await page.route("**/api/community/exchange/me/series", async (route) => {
    await route.fulfill({ json: { items: [] } })
  })
  await page.route("**/api/community/exchange/me/cards", async (route) => {
    await route.fulfill({ json: { items: [] } })
  })
}

async function expectAccessibleAuthPage(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  const accessibility = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
  expect(accessibility.violations).toEqual([])
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("imsweb.language", "zh-CN")
  })
  await mockOwnerWorkspace(page)
})

test("logs in and adopts the returned Platform session", async ({ page }) => {
  let loginBody: unknown
  let sessionRequests = 0
  await page.route("**/api/platform/auth/login", async (route) => {
    loginBody = route.request().postDataJSON()
    await route.fulfill({ status: 200, json: session })
  })
  await page.route("**/api/platform/auth/session", async (route) => {
    sessionRequests += 1
    await route.fulfill({ status: 401, json: { success: false } })
  })

  await page.goto("/account/login")
  await expect(page).toHaveTitle(/帐号登录.*IMSWeb/i)
  await expect(
    page.getByRole("heading", { name: "登录站点帐号" })
  ).toBeVisible()
  await expectAccessibleAuthPage(page)

  await page.getByLabel("邮箱").fill("  Producer@Example.COM ")
  await page.getByLabel("密码", { exact: true }).fill("correct-horse-battery")
  await page.getByRole("button", { name: "登录", exact: true }).click()

  await expect(page).toHaveURL(/\/community\/exchange\/me$/)
  await expect(
    page.getByRole("heading", { name: "我的交换名片", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "帐号：浏览器制作人" })
  ).toBeVisible()
  expect(loginBody).toEqual({
    email: "producer@example.com",
    password: "correct-horse-battery",
  })
  expect(sessionRequests).toBe(0)
})

test("registers after a conflict is corrected and keeps errors user-safe", async ({
  page,
}) => {
  let attempts = 0
  let registrationBody: unknown
  let verificationBody: unknown
  await page.route(
    "**/api/platform/auth/register/verification-code",
    async (route) => {
      verificationBody = route.request().postDataJSON()
      await route.fulfill({
        status: 202,
        json: { success: true, retryAfterSeconds: 60 },
      })
    }
  )
  await page.route("**/api/platform/auth/register", async (route) => {
    attempts += 1
    registrationBody = route.request().postDataJSON()
    if (attempts === 1) {
      await route.fulfill({
        status: 409,
        json: {
          success: false,
          message: "internal unique constraint platform_accounts_email_key",
        },
      })
      return
    }
    await route.fulfill({ status: 201, json: session })
  })

  await page.goto("/account/register")
  await expect(page).toHaveTitle(/帐号注册.*IMSWeb/i)
  await expect(
    page.getByRole("heading", { name: "注册站点帐号" })
  ).toBeVisible()
  await expectAccessibleAuthPage(page)

  await page.getByLabel("显示名称").fill("  浏览器制作人  ")
  await page.getByLabel("邮箱", { exact: true }).fill("  New@Example.COM ")
  await page.getByRole("button", { name: "发送验证码" }).click()
  await expect(page.getByText("验证码已发送至 new@example.com。")).toBeVisible()
  await expect(page.getByRole("button", { name: "60 秒后重发" })).toBeDisabled()
  await page.getByLabel("邮箱验证码").fill("012345")
  await page.getByLabel("密码", { exact: true }).fill("correct-horse-battery")
  await page.getByLabel("确认密码").fill("correct-horse-battery")
  await page.getByRole("button", { name: "注册" }).click()

  await expect(page.getByText("该邮箱已经注册，请直接登录。")).toBeVisible()
  await expect(page.getByText(/unique constraint/)).toHaveCount(0)
  await page.getByRole("button", { name: "注册" }).click()

  await expect(page).toHaveURL(/\/community\/exchange\/me$/)
  await expect(
    page.getByRole("heading", { name: "我的交换名片", exact: true })
  ).toBeVisible()
  expect(registrationBody).toEqual({
    email: "new@example.com",
    password: "correct-horse-battery",
    displayName: "浏览器制作人",
    code: "012345",
  })
  expect(verificationBody).toEqual({ email: "new@example.com" })
})

import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.route("**/api/admin/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: {
          id: 1,
          username: "super-operator",
          producername: "Super Operator",
          dept: "op",
          adminRole: "super_admin",
        },
      }),
    })
  })
  await page.route("**/api/admin/accounts", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        accounts: [
          {
            id: 1,
            username: "super-operator",
            producername: "Super Operator",
            adminRole: "super_admin",
          },
          {
            id: 2,
            username: "regular-operator",
            producername: "Regular Operator",
            adminRole: "admin",
          },
        ],
      }),
    })
  })
})

test("super administrator manages accounts without viewport overflow", async ({
  page,
}, testInfo) => {
  await page.goto("/admin/accounts")

  await expect(
    page.getByRole("heading", { name: "管理员账号", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("link", { name: /管理员账号/ })).toBeVisible()

  const accountList = page.getByRole("region", { name: "账号列表" })
  await expect(accountList.getByText("Super Operator")).toBeVisible()
  await expect(accountList.getByText("Regular Operator")).toBeVisible()
  await expect(
    accountList.getByRole("button", {
      name: "删除管理员 regular-operator",
    })
  ).toBeVisible()
  await expect(
    accountList.getByRole("button", { name: "删除管理员 super-operator" })
  ).toHaveCount(0)

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)

  await page.getByRole("button", { name: "新增管理员" }).click()
  const dialog = page.getByRole("dialog", { name: "新增管理员" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel("用户名")).toBeVisible()
  await expect(dialog.getByLabel("制作人名称")).toBeVisible()
  await expect(dialog.getByLabel("密码", { exact: true })).toBeVisible()

  if (process.env.CAPTURE_ADMIN_ACCOUNTS_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-admin-accounts-${testInfo.project.name}.png`,
      fullPage: true,
    })
  }

  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
  expect(results.violations).toEqual([])
})

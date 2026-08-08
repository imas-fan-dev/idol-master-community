import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("imsweb.language", "zh-CN")
  })

  await page.route("**/api/admin/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        user: {
          id: 1,
          username: "upload-qa",
          producername: "上传样式检查",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
  await page.route("**/api/admin/site-packages", async (route) => {
    if (route.request().method() !== "GET") {
      await route.abort()
      return
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    })
  })
})

test("admin file upload uses the shared responsive interaction", async ({
  page,
}, testInfo) => {
  await page.goto("/admin/site-packages")

  await expect(page.getByRole("heading", { name: "页面包管理" })).toBeVisible()
  const uploadZone = page.getByLabel("页面包文件选择")
  await expect(uploadZone).toContainText("选择页面包归档")
  await expect(uploadZone).toContainText("ZIP 归档 · 最大 25 MiB")

  await page.locator('input[type="file"]').setInputFiles({
    name: "global-upload-style.zip",
    mimeType: "application/zip",
    buffer: Buffer.alloc(1024),
  })

  await expect(uploadZone).toContainText("global-upload-style.zip")
  await expect(uploadZone).toContainText("ZIP 归档 · 1.0 KiB")
  await expect(uploadZone.getByText("已选择", { exact: true })).toBeVisible()
  await expect(uploadZone.getByRole("button", { name: "更换" })).toBeVisible()
  await expect(
    uploadZone.getByRole("button", {
      name: "移除 global-upload-style.zip",
    })
  ).toBeVisible()

  await uploadZone.scrollIntoViewIfNeeded()
  if (process.env.CAPTURE_UPLOAD_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-upload-${testInfo.project.name}.png`,
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

  await uploadZone
    .getByRole("button", { name: "移除 global-upload-style.zip" })
    .click()
  await expect(uploadZone).toContainText("选择页面包归档")
  await expect(uploadZone).not.toContainText("global-upload-style.zip")
})

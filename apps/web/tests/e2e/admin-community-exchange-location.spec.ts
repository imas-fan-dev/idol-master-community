import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const pendingReview = {
  officeId: "office-e2e",
  officeName: "上海周末交换事务所",
  city: "上海",
  ownerAccountId: "platform-owner-e2e",
  location: {
    latitude: 31.2,
    longitude: 121.5,
    precision: "regional",
  },
  reviewState: "pending",
  revision: 2,
  submittedAt: "2026-08-03T01:00:00.000Z",
  reviewedAt: null,
  reviewedBy: null,
  reviewNote: "",
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    {
      name: "ims_admin_csrf",
      value: "location-review-e2e",
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
          username: "location-operator",
          producername: "位置审核员",
          dept: "op",
          adminRole: "admin",
        },
      }),
    })
  })
})

test("administrator reviews a regional office location without viewport overflow", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  let reviewed = false
  let submitted:
    | {
        headers: Record<string, string>
        body: Record<string, unknown>
      }
    | undefined

  await page.route(
    "**/api/admin/community/exchange/office-locations**",
    async (route) => {
      const request = route.request()
      if (request.method() === "PUT") {
        submitted = {
          headers: request.headers(),
          body: request.postDataJSON() as Record<string, unknown>,
        }
        reviewed = true
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            officeLocation: {
              officeId: pendingReview.officeId,
              location: pendingReview.location,
              reviewState: "rejected",
              revision: 3,
              submittedAt: pendingReview.submittedAt,
              reviewedAt: "2026-08-03T02:00:00.000Z",
              reviewNote: "需要缩小公开区域",
            },
          }),
        })
        return
      }

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: reviewed ? [] : [pendingReview] }),
      })
    }
  )

  await page.goto("/admin/community/exchange")

  await expect(
    page.getByRole("heading", { name: "事务所位置审核" })
  ).toBeVisible()
  await expect(page.getByRole("link", { name: /事务所位置/ })).toBeVisible()
  await expect(page.getByText("31.2°, 121.5°")).toBeVisible()
  await expect(page.getByText("0.1° 区域精度")).toBeVisible()

  const hasHorizontalOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)

  const accessibility = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
  expect(accessibility.violations).toEqual([])

  await page.getByLabel("审核备注").fill("需要缩小公开区域")
  await page.getByRole("button", { name: "拒绝" }).click()
  await expect(page.getByText("待审核队列为空")).toBeVisible()

  expect(submitted?.headers["x-csrftoken"]).toBe("location-review-e2e")
  expect(submitted?.body).toEqual({
    decision: "reject",
    expectedRevision: 2,
    note: "需要缩小公开区域",
  })
  expect(consoleErrors).toEqual([])

  if (process.env.CAPTURE_FUDABA_LOCATION_QA === "1") {
    await page.screenshot({
      path: `/tmp/imsweb-location-review-${testInfo.project.name}.png`,
      fullPage: true,
    })
  }
})

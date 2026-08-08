import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

const profile = {
  displayName: "浏览器制作人",
  avatarUrl: null,
  homeCity: "上海",
  bio: "周末参加线下交换",
  updatedAt: 10,
}

const card = {
  id: "card-1",
  producerName: "浏览器制作人",
  displayName: "浏览器交换名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  frontImageUrl: "/brand/series/wall/765pro.webp",
  backImageUrl: "/brand/series/wall/cinderella-girls.webp",
  accent: "#f34e6c",
  bio: "上海地区制作人",
  tradeNote: "周末现场交换",
  available: true,
  mediaRightsStatus: "approved",
  publicationStatus: "draft",
  revision: 3,
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
}

const office = {
  id: "office-1",
  slug: "browser-office-1",
  name: "浏览器交换事务所",
  intro: "周末线下交换",
  city: "上海",
  address: "西岸艺术中心入口",
  location: { latitude: 31.18452, longitude: 121.45678, precision: "exact" },
  accent: "#2581c7",
  coverUrl: null,
  pendingCoverUrl: null,
  pendingCoverSubmittedAt: null,
  isOpen: true,
  visitorCount: 12,
  status: "active",
  revision: 3,
  seriesCodes: ["765"],
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
  archivedAt: null,
}

type LocationFixture = {
  officeId: string
  location: { latitude: number; longitude: number; precision: "regional" }
  reviewState: "pending" | "published" | "rejected"
  revision: number
  submittedAt: string
  reviewedAt: string | null
  reviewNote: string
}

const publishedLocation: LocationFixture = {
  officeId: office.id,
  location: { latitude: 31.2, longitude: 121.5, precision: "regional" },
  reviewState: "published",
  revision: 2,
  submittedAt: "2026-08-02T09:00:00.000Z",
  reviewedAt: "2026-08-02T10:00:00.000Z",
  reviewNote: "区域范围合适",
}

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    {
      name: "ims_platform_csrf",
      value: "exchange-me-csrf",
      domain: "127.0.0.1",
      path: "/",
    },
  ])
  await page.addInitScript(() => {
    window.localStorage.setItem("imsweb.language", "zh-CN")
  })
  await page.route("**/api/platform/auth/session", async (route) => {
    await route.fulfill({
      json: {
        success: true,
        account: { id: "platform-browser", status: "active" },
        profile: {
          displayName: profile.displayName,
          avatarUrl: null,
          homeCity: profile.homeCity,
          bio: profile.bio,
        },
      },
    })
  })
  await page.route("**/api/platform/me", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          success: true,
          account: { id: "platform-browser", status: "active" },
          capabilities: { fudabaWrite: true },
          profile,
        },
      })
      return
    }
    const submission = route.request().postDataJSON()
    await route.fulfill({
      json: {
        success: true,
        profile: {
          ...profile,
          displayName: submission.displayName,
          updatedAt: 11,
        },
      },
    })
  })
  await page.route("**/api/community/exchange/me/series", async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            id: 1,
            code: "765",
            displayName: "765PRO",
            color: "#f34f6d",
            iconUrl: "/brand/series/765pro.png",
            imageTransform: {
              fit: "contain",
              focalX: 0.5,
              focalY: 0.5,
              zoom: 1,
              rotation: 0,
            },
            displayOrder: 0,
            activeOfficeCount: 1,
          },
        ],
      },
    })
  })
  await page.route("**/api/community/exchange/me/cards", async (route) => {
    await route.fulfill({ json: { items: [card] } })
  })
  await page.route(
    "**/api/community/exchange/me/cards/card-1",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { card } })
        return
      }
      const submission = route.request().postDataJSON()
      await route.fulfill({
        json: {
          success: true,
          card: {
            ...card,
            displayName: submission.displayName,
            revision: 4,
            updatedAt: "2026-08-02T10:00:00.000Z",
          },
        },
      })
    }
  )
  await page.route("**/api/community/exchange/me/offices", async (route) => {
    await route.fulfill({ json: { items: [office] } })
  })
  await page.route(
    "**/api/community/exchange/me/offices/office-1",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { office } })
        return
      }
      const submission = route.request().postDataJSON()
      await route.fulfill({
        json: {
          success: true,
          office: {
            ...office,
            name: submission.name,
            revision: 4,
            updatedAt: "2026-08-02T11:00:00.000Z",
          },
        },
      })
    }
  )
  let ownerLocation: LocationFixture | null = publishedLocation
  await page.route(
    "**/api/community/exchange/me/offices/office-1/location",
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { location: ownerLocation } })
        return
      }
      if (route.request().method() === "DELETE") {
        ownerLocation = null
        await route.fulfill({ json: { success: true } })
        return
      }
      const submission = route.request().postDataJSON()
      ownerLocation = {
        ...publishedLocation,
        location: {
          latitude: submission.latitude,
          longitude: submission.longitude,
          precision: "regional",
        },
        reviewState: "pending",
        revision: 3,
        reviewedAt: null,
        reviewNote: "",
      }
      await route.fulfill({
        json: { success: true, officeLocation: ownerLocation },
      })
    }
  )
})

test("edits the authenticated profile and card without viewport overflow", async ({
  page,
  isMobile,
}) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  await page.goto("/community/exchange/me")

  await expect(
    page.getByRole("heading", { name: "我的交换名片", exact: true })
  ).toBeVisible()
  await expect(page.getByText("浏览器交换名片")).toBeVisible()
  await expect(page.getByText("素材已核准")).toBeVisible()
  await expect(
    page.getByLabel("编辑名片").getByText("草稿", { exact: true })
  ).toBeVisible()

  const accountTrigger = page.getByRole("button", {
    name: "帐号：浏览器制作人",
  })
  await accountTrigger.click()
  await expect(
    page.getByRole("link", { name: "我的交换名片" })
  ).toHaveAttribute("href", "/community/exchange/me")
  await page.keyboard.press("Escape")

  const profileName = page.getByRole("textbox", { name: "显示名称" })
  await profileName.fill("更新后的浏览器制作人")
  await page.getByRole("button", { name: "保存资料" }).click()
  await expect(page.getByText("制作人资料已保存。")).toBeVisible()

  const cardName = page.getByRole("textbox", { name: "名片标题" })
  await cardName.fill("更新后的浏览器名片")
  await page.getByRole("button", { name: "保存名片资料" }).click()
  await expect(page.getByText("名片资料已保存。")).toBeVisible()

  await page.getByRole("tab", { name: "背面预览" }).click()
  await expect(
    page.getByRole("button", { name: "查看更新后的浏览器名片背面" })
  ).toBeVisible()

  await expect(
    page.getByRole("heading", { name: "我的事务所与地图位置" })
  ).toBeVisible()
  await expect(page.getByRole("textbox", { name: "事务所名称" })).toHaveValue(
    "浏览器交换事务所"
  )
  await expect(page.getByText("已公开", { exact: true })).toBeVisible()
  await expect(page.getByText("区域范围合适")).toBeVisible()
  await expect(page.getByRole("spinbutton", { name: "精确纬度" })).toHaveValue(
    "31.18452"
  )
  await expect(page.getByRole("spinbutton", { name: "区域纬度" })).toHaveValue(
    "31.2"
  )

  const officeName = page.getByRole("textbox", { name: "事务所名称" })
  await officeName.fill("更新后的浏览器事务所")
  await page.getByRole("button", { name: "保存事务所" }).click()
  await expect(page.getByText("事务所资料已保存。")).toBeVisible()

  const publicLongitude = page.getByRole("spinbutton", { name: "区域经度" })
  await publicLongitude.fill("121.6")
  await page.getByRole("button", { name: "重新提交审核" }).click()
  await expect(
    page.getByText("区域位置已提交审核，审核通过前不会出现在公开地图。")
  ).toBeVisible()
  await expect(page.getByText("审核中", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "撤回公开位置" }).click()
  await page.getByRole("button", { name: "确认撤回" }).click()
  await expect(
    page.getByText("公开位置已撤回，事务所已从区域地图下线。")
  ).toBeVisible()
  await expect(page.getByText("当前位置不在地图上")).toBeVisible()

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    `${isMobile ? "mobile" : "desktop"} exchange-me overflow`
  ).toBe(true)

  const accessibility = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze()
  expect(accessibility.violations).toEqual([])
  expect(consoleErrors).toEqual([])
})

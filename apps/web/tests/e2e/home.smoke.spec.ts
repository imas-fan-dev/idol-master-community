import { expect, test } from "@playwright/test"

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("imsweb.language", "zh-CN")
  })
})

const publicRoutes = [
  { path: "/", title: /IMSWeb/i },
  { path: "/about", title: /关于我们.*IMSWeb/i },
  { path: "/events", title: /活动.*IMSWeb/i },
  { path: "/recommendations", title: /向您推荐.*IMSWeb/i },
  { path: "/live", title: /Live.*IMSWeb/i },
  { path: "/community", title: /制作人社区.*IMSWeb/i },
  { path: "/account/login", title: /帐号登录.*IMSWeb/i },
  { path: "/account/register", title: /帐号注册.*IMSWeb/i },
  { path: "/community/exchange", title: /名片交换事务所.*IMSWeb/i },
  { path: "/community/cards", title: /制作人名片墙.*IMSWeb/i },
  { path: "/works", title: /系列作品.*IMSWeb/i },
  { path: "/wiki", title: /剧情档案.*IMSWeb/i },
  { path: "/wiki/modern", title: /剧情档案.*IMSWeb/i },
  { path: "/wiki/classic", title: /经典剧情导航.*IMSWeb/i },
  { path: "/story", title: /剧情详情.*IMSWeb/i },
  { path: "/story/modern", title: /剧情详情.*IMSWeb/i },
  { path: "/story/classic", title: /经典剧情详情.*IMSWeb/i },
  { path: "/works/sc", title: /SHINY COLORS.*IMSWeb/i },
  { path: "/chronicle", title: /活动编年史.*IMSWeb/i },
]

for (const route of publicRoutes) {
  test(`${route.path} renders a healthy IMSWeb document`, async ({ page }) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text())
      }
    })
    page.on("pageerror", (error) => {
      pageErrors.push(error.message)
    })

    const response = await page.goto(route.path, {
      waitUntil: "domcontentloaded",
    })

    expect(
      response,
      "the document request should return a response"
    ).not.toBeNull()
    expect(
      response!.status(),
      `${route.path} should be reachable`
    ).toBeLessThan(400)
    await expect(page).toHaveTitle(route.title)
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
    await expect(page.locator("main#main-content")).toBeVisible()
    await expect(page.locator("main#main-content")).not.toBeEmpty()
    if (
      route.path === "/wiki/classic" ||
      route.path === "/story/classic" ||
      route.path === "/community/exchange"
    ) {
      await expect(page.getByTestId("series-icon-background")).toHaveCount(0)
    } else {
      await expect(
        page.getByRole("link", { name: "跳到主要内容" })
      ).toHaveAttribute("href", "#main-content")
      const background = page.getByTestId("series-icon-background")
      await expect(background).toBeVisible()
      await expect(background).toHaveCount(1)
      await expect(background.locator(".series-icon-motif")).toHaveCount(12)
    }

    expect(consoleErrors, "the page should not log console errors").toEqual([])
    expect(pageErrors, "the page should not raise uncaught errors").toEqual([])
  })
}

test("the interface stays Chinese when an English preference is stored", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("imsweb.language", "en")
  })
  await page.goto("/")

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN")
  await expect(
    page.locator(
      'button[aria-label*="切换至"], button[aria-label^="Switch to"]'
    )
  ).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("imsweb.language")))
    .toBe("zh-CN")
})

test("work detail content stays below the sticky site header", async ({
  page,
  isMobile,
}) => {
  if (!isMobile) {
    await page.setViewportSize({ width: 1600, height: 900 })
  }
  await page.goto("/works/sc")

  const header = page.getByRole("banner")
  const title = page.getByRole("heading", {
    name: "THE IDOLM@STER",
    exact: true,
  })
  await expect(header).toBeVisible()
  await expect(title).toBeVisible()

  const headerBox = await header.boundingBox()
  const titleBox = await title.boundingBox()
  expect(headerBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  expect(titleBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height)

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  )
  expect(hasHorizontalOverflow).toBe(false)

  if (!isMobile) {
    const copyBox = await page.getByTestId("work-detail-copy").boundingBox()
    const navBox = await page.getByTestId("work-nav-card").boundingBox()
    const character = page.getByRole("img", {
      name: "SHINY COLORS 角色立绘",
    })
    expect(copyBox).not.toBeNull()
    expect(navBox).not.toBeNull()
    expect(copyBox!.x + copyBox!.width).toBeLessThanOrEqual(navBox!.x)
    await expect(character).toHaveCSS("opacity", "1")
    await expect(character.locator("..")).toHaveCSS("position", "relative")
  }
})

test("work detail keeps narrow-screen artwork behind the copy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await page.goto("/works/sc")

  const headerBox = await page.getByRole("banner").boundingBox()
  const titleBox = await page
    .getByRole("heading", { name: "THE IDOLM@STER", exact: true })
    .boundingBox()
  const copyBox = await page.getByTestId("work-detail-copy").boundingBox()
  const character = page.getByRole("img", {
    name: "SHINY COLORS 角色立绘",
  })

  expect(headerBox).not.toBeNull()
  expect(titleBox).not.toBeNull()
  expect(copyBox).not.toBeNull()
  expect(titleBox!.y).toBeLessThan(headerBox!.y + headerBox!.height + 160)
  expect(copyBox!.x).toBeGreaterThanOrEqual(0)
  expect(copyBox!.x + copyBox!.width).toBeLessThanOrEqual(768)
  await expect(character).toHaveCSS("opacity", "0.2")
  await expect(character.locator("..")).toHaveCSS("position", "absolute")
})

test("work detail loads its character and font directly from R2", async ({
  page,
}) => {
  const assetResponses = new Map<string, number>()
  const legacyAssetRequests: string[] = []
  page.on("request", (request) => {
    const url = request.url()
    if (
      url.includes("/assets/images/Production/") ||
      url.includes("/assets/font/IrisIdol.ttf")
    ) {
      legacyAssetRequests.push(url)
    }
  })
  page.on("response", (response) => {
    const url = response.url()
    if (url.startsWith("https://imas-assets.texasoct.tech/brand/")) {
      assetResponses.set(url, response.status())
    }
  })

  await page.goto("/works/sc")

  const character = page.getByRole("img", {
    name: "SHINY COLORS 角色立绘",
  })
  await expect(character).toBeVisible()
  await expect(character).toHaveAttribute(
    "src",
    /^https:\/\/imas-assets\.texasoct\.tech\/brand\/works\/sc\//
  )
  await expect
    .poll(() =>
      character.evaluate((image: HTMLImageElement) => image.naturalWidth)
    )
    .toBeGreaterThan(0)
  await expect
    .poll(() => page.evaluate(() => document.fonts.check("16px idolFont")))
    .toBe(true)

  expect(assetResponses.size).toBeGreaterThanOrEqual(2)
  expect([...assetResponses.values()].every((status) => status === 200)).toBe(
    true
  )
  expect(legacyAssetRequests).toEqual([])
})

test("work detail carries the lightweight global series background", async ({
  page,
  isMobile,
}) => {
  await page.goto("/works/sc")

  const background = page.getByTestId("series-icon-background")
  const motifs = background.locator(".series-icon-motif")
  await expect(background).toBeVisible()
  await expect(motifs).toHaveCount(12)
  await expect(motifs.filter({ visible: true })).toHaveCount(isMobile ? 8 : 12)

  const visibleWidths = await motifs.evaluateAll((elements) =>
    elements
      .filter((element) => !(element as HTMLElement).hidden)
      .map((element) => Number.parseFloat(getComputedStyle(element).width))
  )
  const [minimumWidth, maximumWidth] = isMobile ? [50, 98] : [68, 136]
  expect(
    visibleWidths.every(
      (width) => width >= minimumWidth && width <= maximumWidth
    )
  ).toBe(true)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)

  const firstMotif = motifs.first()
  await expect(firstMotif).toHaveCSS("filter", "none")
  await expect(firstMotif).toHaveCSS("will-change", "transform")
  const initialTransform = await firstMotif.evaluate(
    (element) => element.style.transform
  )
  await expect
    .poll(() => firstMotif.evaluate((element) => element.style.transform))
    .not.toBe(initialTransform)
})

test("mobile navigation keeps link semantics and closes after routing", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile navigation is hidden on desktop")

  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })

  await page.goto("/")
  const trigger = page.getByRole("button", {
    name: /打开导航|Open navigation/,
  })
  await expect(trigger).toBeEnabled()
  await trigger.click()

  const dialog = page.getByRole("dialog", {
    name: /站点导航|Site navigation/,
  })
  await expect(dialog).toBeVisible()
  const navigation = dialog.getByRole("navigation", {
    name: /移动端主导航|Mobile navigation/,
  })
  const eventsLink = navigation.getByRole("link", {
    name: /活动|Events/,
    exact: true,
  })

  await expect(eventsLink).toHaveAttribute("href", "/events")
  await eventsLink.click()
  await expect(page).toHaveURL(/\/events$/)
  await expect(
    page.getByRole("dialog", { name: /站点导航|Site navigation/ })
  ).toBeHidden()
  expect(consoleErrors).toEqual([])
})

test("homepage navigation keeps secondary destinations in the directory", async ({
  page,
  isMobile,
}) => {
  if (process.env.CAPTURE_HEADER_QA === "1") {
    await page.addInitScript(() => {
      localStorage.setItem("imsweb.language", "zh-CN")
    })
  }
  await page.goto("/")

  if (isMobile) {
    const trigger = page.getByRole("button", {
      name: /打开导航|Open navigation/,
    })
    await expect(trigger).toBeEnabled()
    await trigger.click()
  }

  const navigation = isMobile
    ? page
        .getByRole("dialog", { name: /站点导航|Site navigation/ })
        .getByRole("navigation", {
          name: /移动端主导航|Mobile navigation/,
        })
    : page.getByRole("navigation", { name: /主导航|Main navigation/ })
  await expect(navigation.locator("a")).toHaveCount(isMobile ? 7 : 6)

  for (const primaryHref of [
    "/",
    "/events",
    "/recommendations",
    "/live",
    "/community",
    "/about",
  ]) {
    await expect(navigation.locator(`a[href="${primaryHref}"]`)).toBeVisible()
  }
  for (const secondaryHref of [
    "/community/exchange",
    "/community/cards",
    "/producer-map",
    "/works",
    "/chronicle",
  ]) {
    await expect(navigation.locator(`a[href="${secondaryHref}"]`)).toHaveCount(
      0
    )
  }
  await expect(page.locator('a[href="/runninggame/"]')).toHaveCount(0)
  await expect(
    (isMobile ? navigation : page.getByRole("banner")).getByRole("link", {
      name: /剧情站|Story Archive/,
    })
  ).toHaveAttribute("href", "/wiki")
  if (isMobile) {
    await page.keyboard.press("Escape")
    await expect(navigation).toBeHidden()
  }

  const directory = page.getByRole("region", { name: "站点导航" })
  await expect
    .poll(() => directory.getByRole("link").count())
    .toBeGreaterThanOrEqual(10)
  await expect(directory.getByRole("link", { name: /剧情站/ })).toHaveAttribute(
    "href",
    "/wiki"
  )

  await expect(
    page.getByRole("contentinfo").getByRole("link", {
      name: /剧情站|Story Archive/,
    })
  ).toHaveAttribute("href", "/wiki/")
  if (process.env.CAPTURE_HEADER_QA === "1") {
    await page.getByRole("contentinfo").scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `/tmp/imsweb-footer-story-site-${isMobile ? "mobile" : "desktop"}.png`,
    })
  }
  await expect(directory.locator('a[href="/community/cards"]')).toBeVisible()
  await expect(directory.locator('a[href="/producer-map"]')).toBeVisible()

  const friendLinksBox = await page
    .getByRole("region", { name: "友情链接" })
    .boundingBox()
  const siteSupportBox = await page
    .getByRole("region", { name: "网站支持" })
    .boundingBox()
  expect(friendLinksBox).not.toBeNull()
  expect(siteSupportBox).not.toBeNull()
  expect(friendLinksBox!.y).toBeLessThan(siteSupportBox!.y)
})

test("homepage directory uses compact responsive columns", async ({ page }) => {
  await page.goto("/")

  const directory = page.getByRole("region", { name: "站点导航" })
  const grid = directory.getByTestId("portal-directory-grid")
  const description = directory.getByText("浏览近期活动与公开信息", {
    exact: true,
  })

  await expect
    .poll(() => grid.getByRole("link").count())
    .toBeGreaterThanOrEqual(11)
  await expect(grid.locator('a[href="/community/exchange"]')).toBeVisible()

  for (const viewport of [
    { width: 320, expectedColumns: 2, descriptionVisible: false },
    { width: 375, expectedColumns: 2, descriptionVisible: false },
    { width: 430, expectedColumns: 2, descriptionVisible: false },
    { width: 640, expectedColumns: 2, descriptionVisible: true },
    { width: 1024, expectedColumns: 3, descriptionVisible: true },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: 900 })

    const layout = await grid.evaluate((element) => {
      const columns = getComputedStyle(element)
        .gridTemplateColumns.split(" ")
        .filter(Boolean).length
      const descriptionElement = element.querySelector(
        'a[href="/events"] [data-testid="portal-link-description"]'
      )
      const descriptionBox = descriptionElement?.getBoundingClientRect()

      return {
        columns,
        descriptionVisible: Boolean(
          descriptionBox &&
          descriptionBox.width > 1 &&
          descriptionBox.height > 1
        ),
        overflowing: element.scrollWidth > element.clientWidth,
        pageOverflowing:
          document.documentElement.scrollWidth > window.innerWidth,
      }
    })

    expect(layout, `${viewport.width}px directory layout`).toEqual({
      columns: viewport.expectedColumns,
      descriptionVisible: viewport.descriptionVisible,
      overflowing: false,
      pageOverflowing: false,
    })
  }

  await expect(description).toHaveText("浏览近期活动与公开信息")
})

test("theme toggle persists the selected color scheme", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(() => localStorage.setItem("theme", "light"))
  await page.reload()

  const root = page.locator("html")
  const toggle = page.getByRole("button", {
    name: /切换亮色或暗色模式|Toggle light or dark mode/,
  })

  await expect(root).not.toHaveClass(/dark/)
  await page.evaluate(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => {
      if (root.dataset.themeTransition !== "circle") return

      root.dataset.themeTransitionObserved = "circle"
      observer.disconnect()

      const captureReveal = () => {
        const animation = document.getAnimations().find((candidate) => {
          const effect = candidate.effect
          return (
            effect instanceof KeyframeEffect &&
            effect.pseudoElement === "::view-transition-new(root)"
          )
        })
        const effect = animation?.effect

        if (!(effect instanceof KeyframeEffect)) {
          requestAnimationFrame(captureReveal)
          return
        }

        const keyframes = effect.getKeyframes()
        root.dataset.themeTransitionDuration = String(
          effect.getTiming().duration
        )
        root.dataset.themeTransitionStart = String(keyframes[0]?.clipPath)
        root.dataset.themeTransitionEnd = String(keyframes.at(-1)?.clipPath)
      }
      requestAnimationFrame(captureReveal)
    })
    observer.observe(root, { attributes: true })
  })
  await toggle.click()
  await expect(root).toHaveClass(/dark/)
  await expect(root).toHaveAttribute("data-theme-transition-observed", "circle")
  await expect(root).toHaveAttribute("data-theme-transition-duration", "500")
  await expect(root).toHaveAttribute(
    "data-theme-transition-start",
    /circle\(0px at [\d.]+px [\d.]+px\)/
  )
  await expect(root).toHaveAttribute(
    "data-theme-transition-end",
    /circle\([\d.]+px at [\d.]+px [\d.]+px\)/
  )
  await expect(root).not.toHaveAttribute("data-theme-transition")
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("theme")))
    .toBe("dark")

  await page.reload()
  await expect(root).toHaveClass(/dark/)
})

test("default wiki hero gives story artwork an expanded frame", async ({
  page,
  isMobile,
}) => {
  await page.goto("/wiki")

  const hero = page.getByRole("region", { name: "剧情档案视觉" })
  await expect(hero).toBeVisible()
  const heroBox = await hero.boundingBox()
  expect(heroBox).not.toBeNull()
  expect(heroBox!.height).toBeGreaterThanOrEqual(isMobile ? 448 : 480)

  const artwork = hero.getByRole("img")
  if ((await artwork.count()) > 0) {
    await expect(artwork).toHaveCSS("opacity", "1")
    await expect(artwork).toHaveCSS("object-fit", "cover")
    await expect(artwork).toHaveCSS("object-position", "50% 25%")
  }
  await expect(
    hero
      .getByRole("link", { name: "经典视图" })
      .locator('img[src="/brand/wiki-view-switch.png"]')
  ).toHaveCount(1)

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  )
  expect(hasHorizontalOverflow).toBe(false)
})

test("home exposes current discovery and birthday interactions", async ({
  page,
  isMobile,
}) => {
  await page.route("**/api/information", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cards: [] }),
    })
  })

  await page.goto("/")

  const brandBackground = page.getByTestId("series-icon-background")
  await expect(brandBackground).toBeVisible()
  await expect(brandBackground.locator(".series-icon-motif")).toHaveCount(12)
  const firstMotif = brandBackground.locator(".series-icon-motif").first()
  await expect(firstMotif).toHaveCSS("filter", "none")
  const initialTransform = await firstMotif.evaluate(
    (element) => element.style.transform
  )
  await expect
    .poll(() => firstMotif.evaluate((element) => element.style.transform))
    .not.toBe(initialTransform)

  const seriesWall = page.getByRole("region", {
    name: "THE iDOLM@STER",
  })
  await expect(seriesWall.getByRole("link")).toHaveCount(6)
  await expect(seriesWall.getByTestId("series-band")).toHaveCount(6)
  await expect(seriesWall.locator("img")).toHaveCount(6)
  await expect(seriesWall.locator("img").first()).toHaveAttribute(
    "src",
    "/brand/series/wall/765pro.webp"
  )
  if (!isMobile) {
    const viewportWidth = page.viewportSize()?.width ?? 0
    const lastSeriesBand = await seriesWall
      .getByTestId("series-band")
      .last()
      .boundingBox()
    expect(lastSeriesBand).not.toBeNull()
    expect(lastSeriesBand!.x + lastSeriesBand!.width).toBeGreaterThan(
      viewportWidth * 0.95
    )
  }

  const directory = page.getByRole("region", { name: "站点导航" })
  await expect
    .poll(() => directory.getByRole("link").count())
    .toBeGreaterThanOrEqual(10)
  await expect(
    directory.getByRole("link", { name: /活动中心/ })
  ).toHaveAttribute("href", "/events")
  await expect(directory.locator('a[href="/community/cards"]')).toBeVisible()
  await expect(directory.locator('a[href="/producer-map"]')).toBeVisible()
  await expect(
    directory.getByRole("link", { name: /关于 IMSWeb/ })
  ).toHaveAttribute("href", "/about")

  const calendar = page.getByRole("region", { name: "偶像生日日历" })
  const visibleMonth = calendar.getByTestId("calendar-month")
  const initialMonth = await visibleMonth.innerText()
  await calendar.getByRole("button", { name: "下个月" }).click()
  await expect(visibleMonth).not.toHaveText(initialMonth)
  await calendar.getByRole("button", { name: "今日" }).click()
  await expect(visibleMonth).toHaveText(initialMonth)

  const friendLinks = page.getByRole("region", { name: "友情链接" })
  await expect(friendLinks.getByRole("link")).toHaveCount(6)
  await expect(
    friendLinks.getByRole("link", { name: /偶像大师 SP 汉化/ })
  ).toHaveAttribute("href", "https://sp.idolmaster.top/")

  const highlights = page.getByRole("region", {
    name: "活动资讯与同人活动",
  })
  await expect(
    highlights.getByRole("status", { name: "正在加载活动资讯" })
  ).toHaveCount(0)
  await expect(highlights.getByRole("link")).toHaveCount(0)
  await expect(highlights.getByText("当前没有已发布的活动资讯。")).toBeVisible()

  const randomIdol = page.getByRole("region", { name: "随机担当" })
  await randomIdol.getByRole("button", { name: "随机选择" }).click()
  await expect(randomIdol.getByRole("link")).toHaveCount(1)
  await expect(randomIdol.getByTestId("random-idol-avatar")).toBeVisible()
  await expect(
    randomIdol.getByRole("link", { name: "查看剧情档案" })
  ).toHaveAttribute("href", /^\/story\?agency=.+&idol=.+/)
  await expect(randomIdol.getByText(/剧情站收录/)).toHaveCount(0)

  const siteSupport = page.getByRole("region", { name: "网站支持" })
  await expect(siteSupport.getByRole("link")).toHaveCount(3)

  const friendLinksBox = await friendLinks.boundingBox()
  const siteSupportBox = await siteSupport.boundingBox()
  expect(friendLinksBox).not.toBeNull()
  expect(siteSupportBox).not.toBeNull()
  expect(friendLinksBox!.y).toBeLessThan(siteSupportBox!.y)
})

test("home random idol uses a square portrait and agency marker", async ({
  page,
}) => {
  await page.goto("/")

  const randomIdol = page.getByRole("region", { name: "随机担当" })
  const avatar = randomIdol.getByTestId("random-idol-avatar")
  const agencyMarker = randomIdol.getByTestId("random-idol-agency-marker")
  const archiveLink = randomIdol.getByRole("link", { name: "查看剧情档案" })

  await expect(avatar).toBeVisible()
  await expect(agencyMarker).toBeVisible()
  await expect(archiveLink).toBeVisible()
  await expect(randomIdol.getByText(/剧情站收录/)).toHaveCount(0)
  await expect
    .poll(async () => {
      const box = await avatar.boundingBox()
      return box ? Math.abs(box.width - box.height) : Number.POSITIVE_INFINITY
    })
    .toBeLessThanOrEqual(1)
  await expect
    .poll(async () => {
      const [avatarBox, linkBox] = await Promise.all([
        avatar.boundingBox(),
        archiveLink.boundingBox(),
      ])
      return avatarBox && linkBox
        ? linkBox.y - (avatarBox.y + avatarBox.height)
        : Number.POSITIVE_INFINITY
    })
    .toBeLessThanOrEqual(24)
})

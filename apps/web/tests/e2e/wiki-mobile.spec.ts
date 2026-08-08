import { expect, test } from "@playwright/test"

test("mobile Wiki agency switching preserves both scroll positions", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile-only Wiki interaction")

  await page.goto("/wiki")

  const firstIdolCard = page.locator('a[aria-label][href^="/story?"]').first()
  await expect(firstIdolCard).toBeVisible()
  const firstIdolAvatar = firstIdolCard.getByTestId("wiki-idol-avatar")
  await expect
    .poll(async () => {
      const box = await firstIdolAvatar.boundingBox()
      return box ? Math.abs(box.width - box.height) : Number.POSITIVE_INFINITY
    })
    .toBeLessThanOrEqual(1)
  await expect(firstIdolCard.locator('[data-slot="badge"]')).toHaveCount(0)

  const agencyRail = page.getByTestId("wiki-agency-tabs")
  const targetAgency = agencyRail.getByRole("tab", { name: /百万现场/ })
  await agencyRail.scrollIntoViewIfNeeded()
  const horizontalScrollBefore = await targetAgency.evaluate((element) => {
    const rail = element.parentElement!
    const targetLeft =
      element.getBoundingClientRect().left -
      rail.getBoundingClientRect().left +
      rail.scrollLeft
    rail.scrollLeft = targetLeft - 16
    return rail.scrollLeft
  })
  await expect(targetAgency).toBeVisible()
  const verticalScrollBefore = await page.evaluate(() => {
    window.scrollBy({ top: 80, behavior: "instant" })
    return window.scrollY
  })

  await targetAgency.click()

  await expect(targetAgency).toHaveAttribute("aria-selected", "true")
  await expect
    .poll(() => new URL(page.url()).searchParams.get("agency"))
    .toBe("百万现场")
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThanOrEqual(verticalScrollBefore - 2)
  await expect
    .poll(async () =>
      Math.abs(
        (await agencyRail.evaluate((element) => element.scrollLeft)) -
          horizontalScrollBefore
      )
    )
    .toBeLessThanOrEqual(20)
})

test("modern Wiki windowed dial loops and switches agencies", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile-only Wiki interaction")
  test.slow()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/wiki?agency=765PRO")

  const trigger = page.getByRole("button", { name: "打开企划拨盘" })
  const searchButton = page.getByRole("button", { name: "打开全屏搜索" })
  await expect(trigger).toBeVisible()
  await expect(searchButton).toBeVisible()
  await expect(trigger).toHaveCSS("position", "fixed")

  const [triggerBox, searchBox] = await Promise.all([
    trigger.boundingBox(),
    searchButton.boundingBox(),
  ])
  expect(triggerBox).not.toBeNull()
  expect(searchBox).not.toBeNull()
  expect(triggerBox!.x).toBeLessThanOrEqual(17)
  expect(triggerBox!.width).toBe(56)
  expect(triggerBox!.x + triggerBox!.width).toBeLessThan(searchBox!.x)

  await trigger.click()

  const dialog = page.getByRole("dialog")
  const dial = dialog.getByRole("group", { name: "企划拨盘" })
  const carouselWindow = dialog.getByTestId("wiki-agency-carousel-window")
  const selectedOption = carouselWindow.locator(
    'button[aria-label^="预览企划 "][aria-pressed="true"]'
  )
  const previewOption = carouselWindow.locator(
    'button[data-wiki-agency-preview="true"]'
  )
  await expect(dialog).toBeVisible()
  await expect(dial).toBeFocused()
  await expect(selectedOption).toHaveCount(1)
  await expect(previewOption).toHaveCount(1)
  await expect(dialog.locator(".lucide-chevron-down")).toHaveCount(0)
  const directionIndicator = dialog.locator("[data-wiki-agency-dial-direction]")
  await expect(directionIndicator).toBeVisible()
  await expect(directionIndicator).toHaveAttribute("viewBox", "0 0 120 120")
  await expect(directionIndicator.locator("path")).toHaveCount(3)
  await expect(
    directionIndicator.locator(".wiki-agency-dial-direction-arc")
  ).toHaveAttribute("d", "M 60 16 A 44 44 0 0 1 104 60")
  await expect(
    directionIndicator.locator(".wiki-agency-dial-direction-head").first()
  ).toHaveAttribute("d", "M 66 11 L 60 16 L 66 21")
  const directionStyles = await directionIndicator.evaluate((element) => {
    const arc = getComputedStyle(
      element.querySelector<SVGPathElement>(".wiki-agency-dial-direction-arc")!
    )
    const head = getComputedStyle(
      element.querySelector<SVGPathElement>(".wiki-agency-dial-direction-head")!
    )
    return {
      arcStroke: arc.stroke,
      headStroke: head.stroke,
      lineCap: head.strokeLinecap,
      lineJoin: head.strokeLinejoin,
      strokeWidth: head.strokeWidth,
    }
  })
  expect(directionStyles.arcStroke).toBe(directionStyles.headStroke)
  expect(directionStyles.lineCap).toBe("round")
  expect(directionStyles.lineJoin).toBe("round")
  expect(directionStyles.strokeWidth).toBe("2.5px")
  const highlightColors = await dialog.evaluate((element) => ({
    center: getComputedStyle(
      element.querySelector<HTMLElement>("[data-wiki-agency-dial-center]")!
    ).borderTopColor,
    selected: getComputedStyle(
      element.querySelector<HTMLElement>(
        '[aria-label^="预览企划 "][aria-pressed="true"]'
      )!
    ).borderTopColor,
  }))
  expect(highlightColors.center).not.toBe(highlightColors.selected)
  await expect(
    carouselWindow.locator('button[aria-label^="预览企划 "]')
  ).toHaveCount(5)
  await expect
    .poll(async () => (await dial.boundingBox())?.x ?? Number.POSITIVE_INFINITY)
    .toBeLessThanOrEqual(13)
  await expect
    .poll(() =>
      dialog.evaluate((element) =>
        element
          .getAnimations({ subtree: false })
          .every((animation) => animation.playState === "finished")
      )
    )
    .toBe(true)

  const dialBox = await dial.boundingBox()
  const expandedCenterBox = await dialog
    .locator("[data-wiki-agency-dial-center]")
    .boundingBox()
  const directionBox = await dialog
    .locator("[data-wiki-agency-dial-direction]")
    .boundingBox()
  const orbitBox = await dialog
    .locator("[data-wiki-agency-dial-orbit]")
    .boundingBox()
  const previewOrbitOptionBox = await previewOption.boundingBox()
  expect(dialBox).not.toBeNull()
  expect(expandedCenterBox).not.toBeNull()
  expect(directionBox).not.toBeNull()
  expect(orbitBox).not.toBeNull()
  expect(previewOrbitOptionBox).not.toBeNull()
  expect(Math.abs(dialBox!.width - dialBox!.height)).toBeLessThanOrEqual(1)
  expect(directionBox!.width / dialBox!.width).toBeGreaterThan(0.44)
  expect(directionBox!.width / dialBox!.width).toBeLessThan(0.47)
  expect(expandedCenterBox!.width).toBe(48)
  expect(expandedCenterBox!.height).toBe(48)
  expect(
    Math.abs(
      expandedCenterBox!.x +
        expandedCenterBox!.width / 2 -
        (triggerBox!.x + triggerBox!.width / 2)
    )
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      expandedCenterBox!.y +
        expandedCenterBox!.height / 2 -
        (triggerBox!.y + triggerBox!.height / 2)
    )
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      directionBox!.x +
        directionBox!.width / 2 -
        (dialBox!.x + dialBox!.width / 2)
    )
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      directionBox!.y +
        directionBox!.height / 2 -
        (dialBox!.y + dialBox!.height / 2)
    )
  ).toBeLessThanOrEqual(1)
  const dialCenter = {
    x: dialBox!.x + dialBox!.width / 2,
    y: dialBox!.y + dialBox!.height / 2,
  }
  const orbitCenter = {
    x: orbitBox!.x + orbitBox!.width / 2,
    y: orbitBox!.y + orbitBox!.height / 2,
  }
  const previewOrbitOptionCenter = {
    x: previewOrbitOptionBox!.x + previewOrbitOptionBox!.width / 2,
    y: previewOrbitOptionBox!.y + previewOrbitOptionBox!.height / 2,
  }
  expect(Math.abs(orbitCenter.x - dialCenter.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(orbitCenter.y - dialCenter.y)).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      Math.hypot(
        previewOrbitOptionCenter.x - dialCenter.x,
        previewOrbitOptionCenter.y - dialCenter.y
      ) -
        orbitBox!.width / 2
    )
  ).toBeLessThanOrEqual(1)
  const popupMotion = await dialog.evaluate((element) => {
    const style = getComputedStyle(element)
    const origin = style.transformOrigin
      .split(" ")
      .slice(0, 2)
      .map(Number.parseFloat)
    const item = element.querySelector<HTMLElement>(
      "[data-wiki-agency-dial-item]"
    )
    return {
      animationName: style.animationName,
      itemAnimationName: item ? getComputedStyle(item).animationName : "",
      origin,
    }
  })
  expect(popupMotion.animationName).toContain("wiki-agency-dial-popup-in")
  expect(popupMotion.itemAnimationName).toContain("wiki-agency-dial-item-in")
  expect(
    Math.abs(
      dialBox!.x +
        popupMotion.origin[0]! -
        (triggerBox!.x + triggerBox!.width / 2)
    )
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(
      dialBox!.y +
        popupMotion.origin[1]! -
        (triggerBox!.y + triggerBox!.height / 2)
    )
  ).toBeLessThanOrEqual(1)
  await expect(
    carouselWindow.locator('[data-wiki-agency-carousel-slot="0"]')
  ).toHaveCSS("transition-duration", "0s")

  const beforeSelection = await selectedOption.getAttribute("aria-label")
  const selectedOptionBox = await previewOption.boundingBox()
  const outgoingEdgeOption = carouselWindow.locator(
    '[data-wiki-agency-carousel-virtual-slot="-2"] button'
  )
  await expect(outgoingEdgeOption).toHaveCount(1)
  expect(selectedOptionBox).not.toBeNull()
  const optionCenterX = selectedOptionBox!.x + selectedOptionBox!.width / 2
  const optionCenterY = selectedOptionBox!.y + selectedOptionBox!.height / 2
  await page.mouse.move(optionCenterX, optionCenterY)
  await page.mouse.down()
  await page.mouse.move(optionCenterX - 8, optionCenterY, { steps: 2 })
  await expect
    .poll(async () =>
      Number(await dial.getAttribute("data-wiki-agency-dial-position"))
    )
    .toBeGreaterThan(0.07)
  await expect(outgoingEdgeOption).toHaveCount(1)
  const outgoingEdgeBox = await outgoingEdgeOption.boundingBox()
  expect(outgoingEdgeBox).not.toBeNull()
  expect(outgoingEdgeBox!.x + outgoingEdgeBox!.width).toBeLessThanOrEqual(0)
  await page.mouse.move(optionCenterX - 24, optionCenterY, { steps: 4 })
  await expect(outgoingEdgeOption).toHaveCount(0)
  const firstContinuousPosition = Number(
    await dial.getAttribute("data-wiki-agency-dial-position")
  )
  await page.mouse.move(optionCenterX - 58, optionCenterY, { steps: 6 })
  const secondContinuousPosition = Number(
    await dial.getAttribute("data-wiki-agency-dial-position")
  )
  expect(firstContinuousPosition).toBeGreaterThan(0.3)
  expect(firstContinuousPosition).toBeLessThan(0.4)
  expect(secondContinuousPosition).toBeGreaterThan(
    firstContinuousPosition + 0.45
  )
  expect(Math.abs(secondContinuousPosition % 1)).toBeGreaterThan(0.1)
  await page.waitForTimeout(100)
  await page.mouse.up()

  await expect
    .poll(() => previewOption.getAttribute("aria-label"))
    .not.toBe(beforeSelection)
  await expect(previewOption).toHaveAttribute("aria-pressed", "false")
  await expect(selectedOption).toHaveAttribute("aria-label", beforeSelection!)
  await expect(dial).toHaveAttribute("data-wiki-agency-dial-interacted")
  await expect(dial).not.toHaveAttribute("data-wiki-agency-dial-inertia")
  const restingPosition = Number(
    await dial.getAttribute("data-wiki-agency-dial-position")
  )
  expect(Math.abs(restingPosition - secondContinuousPosition)).toBeLessThan(
    0.03
  )
  expect(
    Math.abs(restingPosition - Math.round(restingPosition))
  ).toBeGreaterThan(0.1)
  await expect
    .poll(() =>
      carouselWindow
        .locator('[data-wiki-agency-carousel-slot="1"]')
        .evaluate((element) => getComputedStyle(element).animationName)
    )
    .toBe("none")

  const continuousDialBox = await dial.boundingBox()
  expect(continuousDialBox).not.toBeNull()
  const flingStartX = continuousDialBox!.x + continuousDialBox!.width * 0.72
  const flingStartY = continuousDialBox!.y + continuousDialBox!.height * 0.58
  await page.mouse.move(flingStartX, flingStartY)
  await page.mouse.down()
  await page.mouse.move(flingStartX - 84, flingStartY, { steps: 2 })
  await page.mouse.up()
  await expect(dial).toHaveAttribute("data-wiki-agency-dial-inertia", "true")
  const flingReleasePosition = Number(
    await dial.getAttribute("data-wiki-agency-dial-position")
  )
  await expect
    .poll(async () =>
      Number(await dial.getAttribute("data-wiki-agency-dial-position"))
    )
    .toBeGreaterThan(flingReleasePosition + 0.05)
  await expect(dial).not.toHaveAttribute("data-wiki-agency-dial-inertia", {
    timeout: 2000,
  })

  const previewLabel = await previewOption.getAttribute("aria-label")
  const previewAgency = previewLabel!.replace("预览企划 ", "")

  expect(new URL(page.url()).searchParams.get("agency")).toBe(
    beforeSelection!.replace("预览企划 ", "")
  )
  await dialog.getByRole("button", { name: `切换到${previewAgency}` }).click()
  await expect
    .poll(() => new URL(page.url()).searchParams.get("agency"))
    .toBe(previewAgency)
  await expect(dialog).not.toBeVisible()

  await page.getByRole("button", { name: "打开企划拨盘" }).click()
  const directOption = page
    .getByRole("dialog")
    .locator('button[aria-label^="预览企划 "][aria-pressed="false"]')
    .first()
  await expect(directOption).toBeVisible()
  const directAgency = (await directOption.getAttribute("aria-label"))!.replace(
    "预览企划 ",
    ""
  )
  await directOption.click()

  await expect
    .poll(() => new URL(page.url()).searchParams.get("agency"))
    .toBe(directAgency)
  await expect(page.getByRole("dialog")).not.toBeVisible()
})

test("classic Wiki follows the mobile content order without narrow title wraps", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile-only classic Wiki layout")

  await page.setViewportSize({ width: 320, height: 844 })
  await page.goto("/wiki/classic")

  const homeLink = page
    .locator(".wiki-classic-mobile-bar")
    .getByRole("link", { name: "返回首页" })
  const sidebar = page.locator(".wiki-classic-sidebar")
  const banner = page.locator(".wiki-classic-banner")
  const groupNavigation = page.getByRole("region", {
    name: "组合与分类导航",
  })
  const firstGroup = page.locator(".wiki-classic-group").first()
  const searchButton = page.getByRole("button", { name: "打开全屏搜索" })
  const agencyDialTrigger = page.getByRole("button", {
    name: "打开企划拨盘",
  })
  await expect(homeLink).toHaveAttribute("href", "/")
  await expect(homeLink.locator(".lucide-house")).toHaveCount(1)
  await expect(sidebar).not.toHaveClass(/is-open/)
  await expect(banner).toBeVisible()
  await expect(groupNavigation).toBeVisible()
  await expect(firstGroup).toBeVisible()
  await expect(searchButton).toBeVisible()
  await expect(agencyDialTrigger).toBeVisible()
  await expect(page.getByRole("button", { name: "切换壁纸" })).not.toBeVisible()
  await expect(page.getByRole("button", { name: "返回顶部" })).toHaveCount(0)
  await expect(page.locator(".wiki-classic-idol-kind")).toHaveCount(0)

  const [bannerBox, navigationBox, groupBox] = await Promise.all([
    banner.boundingBox(),
    groupNavigation.boundingBox(),
    firstGroup.boundingBox(),
  ])
  expect(bannerBox).not.toBeNull()
  expect(navigationBox).not.toBeNull()
  expect(groupBox).not.toBeNull()
  expect(bannerBox!.y).toBeLessThan(navigationBox!.y)
  expect(navigationBox!.y).toBeLessThan(groupBox!.y)
  expect(bannerBox!.x).toBeGreaterThanOrEqual(13)
  expect(bannerBox!.x).toBeLessThanOrEqual(15)
  expect(groupBox!.x).toBeGreaterThanOrEqual(13)
  expect(groupBox!.x).toBeLessThanOrEqual(15)
  expect(320 - bannerBox!.x - bannerBox!.width).toBeGreaterThanOrEqual(13)
  expect(320 - bannerBox!.x - bannerBox!.width).toBeLessThanOrEqual(15)
  expect(320 - groupBox!.x - groupBox!.width).toBeGreaterThanOrEqual(13)
  expect(320 - groupBox!.x - groupBox!.width).toBeLessThanOrEqual(15)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)

  await agencyDialTrigger.click()
  const agencyDialDialog = page.getByRole("dialog")
  await expect(agencyDialDialog).toBeVisible()
  await expect(
    agencyDialDialog.locator("[data-wiki-agency-dial-direction]")
  ).toBeVisible()
  await expect(
    agencyDialDialog.locator('button[aria-label^="预览企划 "]')
  ).toHaveCount(5)
  await agencyDialDialog.getByRole("button", { name: "关闭企划拨盘" }).click()
  await expect(agencyDialDialog).not.toBeVisible()

  await searchButton.click()
  const searchDialog = page.getByRole("dialog")
  const mobileSearch = page.getByRole("textbox", {
    name: "移动端全局搜索内容页",
  })
  const searchOverlay = page.locator('[data-slot="dialog-overlay"]')
  const searchSurface = page.locator(
    '[data-wiki-mobile-search-surface="classic"]'
  )
  const searchPanel = page.locator('[data-wiki-mobile-search-panel="classic"]')
  await expect(searchDialog).toBeVisible()
  await expect(searchDialog).toHaveAttribute(
    "data-wiki-mobile-search-dialog",
    "classic"
  )
  await expect(searchDialog).toHaveCSS("position", "fixed")
  await expect(searchDialog).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(searchSurface).toBeVisible()
  await expect
    .poll(async () => (await searchPanel.boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(23)
  expect(
    await searchOverlay.evaluate(
      (element) => getComputedStyle(element).backdropFilter
    )
  ).toContain("blur")
  await expect(mobileSearch).toBeFocused()
  await expect
    .poll(async () => {
      const box = await searchDialog.boundingBox()
      return box
        ? {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          }
        : null
    })
    .toEqual({ x: 0, y: 0, width: 320, height: 844 })
  await mobileSearch.fill("天海春香")
  await expect(
    searchPanel.getByRole("navigation", { name: "全局搜索结果" })
  ).toBeVisible()
  await page.locator('[data-wiki-mobile-search-dismiss="classic"]').click()
  await expect(searchDialog).not.toBeVisible()

  const groupOption = groupNavigation
    .locator('a[href^="#classic-group-"]')
    .first()
  await expect(groupOption).toBeVisible()
  const groupHref = await groupOption.getAttribute("href")
  await groupOption.click()
  await expect.poll(() => new URL(page.url()).hash).toBe(groupHref)
  await expect
    .poll(async () => (await groupNavigation.boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(72)
  await expect
    .poll(async () => (await groupNavigation.boundingBox())?.y ?? 999)
    .toBeLessThanOrEqual(76)
  await expect(page.getByRole("button", { name: "返回顶部" })).not.toBeVisible()

  const columnCount = await page
    .locator(".wiki-classic-idol-grid")
    .first()
    .evaluate(
      (element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").length
    )
  expect(columnCount).toBe(3)

  await expect(banner).toHaveCSS("padding-left", "18px")
  const title = banner.locator("h1")
  await expect(title).toHaveCSS("word-break", "keep-all")
  const titleLineCount = await title.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    return new Set(
      Array.from(range.getClientRects(), (rect) => Math.round(rect.top))
    ).size
  })
  expect(titleLineCount).toBeLessThanOrEqual(2)
})

test("modern Wiki keeps group navigation and mobile search fixed", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile-only modern Wiki interaction")

  await page.route("**/api/check", (route) =>
    route.fulfill({
      json: {
        success: true,
        user: {
          id: 3,
          username: "operator",
          producername: "Operator",
          dept: "op",
          adminRole: "admin",
        },
      },
    })
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/wiki?agency=闪耀色彩")

  const groupNavigation = page.getByRole("region", {
    name: "组合与分类导航",
  })
  const groupOption = groupNavigation.locator('a[href^="#wiki-group-"]').first()
  const searchButton = page.getByRole("button", { name: "打开全屏搜索" })
  const adminShortcut = page.getByRole("link", { name: "返回管理工作台" })
  await expect(groupNavigation).toBeVisible()
  await expect(searchButton).toBeVisible()
  await expect(adminShortcut).toBeVisible()

  await expect
    .poll(async () => {
      const [searchBox, adminBox] = await Promise.all([
        searchButton.boundingBox(),
        adminShortcut.boundingBox(),
      ])
      return searchBox && adminBox
        ? adminBox.y - searchBox.y - searchBox.height
        : -1
    })
    .toBeGreaterThanOrEqual(7.5)

  const groupHref = await groupOption.getAttribute("href")
  await groupOption.click()
  await expect.poll(() => new URL(page.url()).hash).toBe(groupHref)
  await expect
    .poll(async () => (await groupNavigation.boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(62)
  await expect
    .poll(async () => (await groupNavigation.boundingBox())?.y ?? 999)
    .toBeLessThanOrEqual(66)
  await expect(page.getByRole("button", { name: "返回顶部" })).not.toBeVisible()

  await searchButton.click()
  const searchDialog = page.getByRole("dialog")
  const mobileSearch = page.getByRole("textbox", {
    name: "移动端全局搜索内容页",
  })
  const searchOverlay = page.locator('[data-slot="dialog-overlay"]')
  const searchSurface = page.locator(
    '[data-wiki-mobile-search-surface="modern"]'
  )
  const searchPanel = page.locator('[data-wiki-mobile-search-panel="modern"]')
  await expect(searchDialog).toBeVisible()
  await expect(searchDialog).toHaveAttribute(
    "data-wiki-mobile-search-dialog",
    "modern"
  )
  await expect(searchDialog).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(searchSurface).toBeVisible()
  await expect
    .poll(async () => (await searchPanel.boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(23)
  expect(
    await searchOverlay.evaluate(
      (element) => getComputedStyle(element).backdropFilter
    )
  ).toContain("blur")
  await expect(mobileSearch).toBeFocused()
  await mobileSearch.fill("樱木真乃")
  await expect(
    searchPanel.getByRole("navigation", { name: "全局搜索结果" })
  ).toBeVisible()
  await page.locator('[data-wiki-mobile-search-dismiss="modern"]').click()
  await expect(searchDialog).not.toBeVisible()
})

test("classic story portrait cards use two readable mobile columns", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile-only classic story layout")

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(
    "/story/classic?agency=%E7%99%BE%E4%B8%87%E7%8E%B0%E5%9C%BA&idol=%E6%98%A5%E6%97%A5%E6%9C%AA%E6%9D%A5"
  )

  const portraitSection = page.getByRole("region", { name: /竖卡/ })
  const portraitGrid = portraitSection.locator(".wiki-classic-story-grid")
  await expect(portraitSection).toBeVisible()
  await portraitSection.scrollIntoViewIfNeeded()

  const columns = await portraitGrid.evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(" ")
  )
  expect(columns).toHaveLength(2)
  expect(Number.parseFloat(columns[0])).toBeGreaterThan(120)
})

test("story source labels stay visible in both mobile views", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile-only story source labels")

  const storyTarget =
    "agency=%E9%97%AA%E8%80%80%E8%89%B2%E5%BD%A9&idol=%E6%A8%B1%E6%9C%A8%E7%9C%9F%E4%B9%83"

  for (const route of [
    `/story?${storyTarget}`,
    `/story/classic?${storyTarget}`,
  ]) {
    await page.goto(route)

    const sourcedCard = page.locator('[data-story-state="available"]').first()
    await expect(sourcedCard).toBeVisible()
    await sourcedCard.click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("剧情", { exact: true })).toBeVisible()
    await expect(dialog.getByText("Bilibili", { exact: true })).toBeVisible()
    await expect(dialog.getByText(/^来源：/).first()).toBeVisible()
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth
      )
    ).toBe(true)
  }
})

test("modern story navigation stays clickable over the mobile footer", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile-only floating navigation")

  await page.goto(
    "/story?agency=876PRO&idol=%E4%B8%8A%E6%B0%B4%E6%B5%81%E5%AE%87%E5%AE%99"
  )

  const trigger = page.getByRole("button", {
    name: "打开上水流宇宙剧情导航",
  })
  const footer = page.getByRole("contentinfo")
  await expect(trigger).toBeVisible()
  await footer.scrollIntoViewIfNeeded()

  const footerBox = await footer.boundingBox()
  const triggerBox = await trigger.boundingBox()
  expect(footerBox).not.toBeNull()
  expect(triggerBox).not.toBeNull()
  expect(triggerBox!.y + triggerBox!.height).toBeGreaterThan(footerBox!.y)

  const triggerOwnsCenterPoint = await trigger.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const hitTarget = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2
    )
    return hitTarget === element || element.contains(hitTarget)
  })
  expect(triggerOwnsCenterPoint).toBe(true)

  await trigger.click()
  await expect(page.getByRole("dialog")).toBeVisible()
})

test("classic text-only story cards do not render nested frames", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop-only classic story framing")

  await page.goto(
    "/story/classic?agency=%E5%AD%A6%E5%9B%AD%E5%81%B6%E5%83%8F%E5%A4%A7%E5%B8%88&idol=%E8%91%9B%E5%9F%8E%E8%8E%89%E8%8E%89%E5%A8%85"
  )

  const textOnlyBody = page
    .locator(
      ".wiki-classic-story-card.is-text-only .wiki-classic-story-card-body"
    )
    .first()
  await expect(textOnlyBody).toBeVisible()

  const textOnlyStyles = await textOnlyBody.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderWidth: style.borderWidth,
      margin: style.margin,
    }
  })

  expect(textOnlyStyles).toEqual({
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderWidth: "0px",
    margin: "0px",
  })

  await page.goto(
    "/story/classic?agency=%E7%99%BE%E4%B8%87%E7%8E%B0%E5%9C%BA&idol=%E6%98%A5%E6%97%A5%E6%9C%AA%E6%9D%A5"
  )

  const imageBody = page
    .locator(
      ".wiki-classic-story-card:not(.is-text-only) .wiki-classic-story-card-body"
    )
    .first()
  await expect(imageBody).toBeVisible()

  const imageStyles = await imageBody.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      backgroundColor: style.backgroundColor,
      borderWidth: style.borderWidth,
      margin: style.margin,
    }
  })

  expect(imageStyles).toEqual({
    backgroundColor: "rgb(250, 249, 251)",
    borderWidth: "1px",
    margin: "8px",
  })
})

test("new story cards without story sources render in gray", async ({
  page,
}) => {
  await page.goto(
    "/story?agency=876PRO&idol=%E4%B8%8A%E6%B0%B4%E6%B5%81%E5%AE%87%E5%AE%99"
  )

  const imageCard = page.locator('[id^="story-card-"]:has(img)').first()
  const textOnlyCard = page
    .locator('[id^="story-card-"]:not(:has(img))')
    .first()
  await expect(imageCard).toBeVisible()
  await expect(textOnlyCard).toBeVisible()
  await expect(imageCard).toHaveCSS("opacity", "0.6")
  await expect(imageCard).toHaveCSS("filter", "grayscale(1)")
  await expect(textOnlyCard).toHaveCSS("opacity", "0.6")
  await expect(textOnlyCard).toHaveCSS("filter", "grayscale(1)")

  await expect(imageCard).toHaveAttribute("data-story-state", "unavailable")
  await expect(textOnlyCard).toHaveAttribute("data-story-state", "unavailable")

  await textOnlyCard.click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByText("暂无可用剧情来源")).toBeVisible()
})

test("classic desktop idol groups align incomplete rows to the left", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop-only classic Wiki alignment")

  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto("/wiki/classic?agency=%E9%97%AA%E8%80%80%E8%89%B2%E5%BD%A9")

  const group = page.locator(".wiki-classic-group").filter({
    has: page.getByRole("heading", {
      name: "illumination STARS",
      exact: true,
    }),
  })
  const cards = group.locator(".wiki-classic-idol-card")
  await expect(group).toBeVisible()
  await expect(cards).toHaveCount(3)

  const [groupBox, firstCardBox, secondCardBox, lastCardBox] =
    await Promise.all([
      group.boundingBox(),
      cards.first().boundingBox(),
      cards.nth(1).boundingBox(),
      cards.last().boundingBox(),
    ])
  expect(groupBox).not.toBeNull()
  expect(firstCardBox).not.toBeNull()
  expect(secondCardBox).not.toBeNull()
  expect(lastCardBox).not.toBeNull()

  await expect(group.locator(".wiki-classic-idol-grid")).toHaveCSS(
    "justify-content",
    "start"
  )

  const leftGap = firstCardBox!.x - groupBox!.x
  const firstCardGap =
    secondCardBox!.x - (firstCardBox!.x + firstCardBox!.width)
  const secondCardGap =
    lastCardBox!.x - (secondCardBox!.x + secondCardBox!.width)
  const rightGap =
    groupBox!.x + groupBox!.width - (lastCardBox!.x + lastCardBox!.width)
  expect(leftGap).toBeLessThanOrEqual(48)
  expect(firstCardGap).toBeLessThanOrEqual(32)
  expect(secondCardGap).toBeLessThanOrEqual(32)
  expect(rightGap).toBeGreaterThan(lastCardBox!.width)
})

test("classic Wiki styles survive returning from a story", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "desktop-only classic Wiki return regression")

  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(
    "/wiki/classic?agency=%E5%AD%A6%E5%9B%AD%E5%81%B6%E5%83%8F%E5%A4%A7%E5%B8%88"
  )
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "初星学园",
      exact: true,
    })
  ).toBeVisible()

  const readLayoutStyles = () =>
    page.evaluate(() => {
      const pattern = getComputedStyle(
        document.querySelector(".wiki-classic-pattern")!
      )
      const window = getComputedStyle(
        document.querySelector(".wiki-classic-window")!
      )
      const sidebar = getComputedStyle(
        document.querySelector(".wiki-classic-sidebar")!
      )
      const activeAgency = getComputedStyle(
        document.querySelector(".wiki-classic-agency-button.is-active")!
      )
      const secondaryAgency = getComputedStyle(
        document.querySelector(".wiki-classic-agency-button.is-secondary")!
      )

      return {
        pattern: {
          backgroundColor: pattern.backgroundColor,
          backgroundImage: pattern.backgroundImage,
        },
        window: {
          gridTemplateColumns: window.gridTemplateColumns,
          padding: window.padding,
          width: window.width,
        },
        sidebar: {
          padding: sidebar.padding,
          position: sidebar.position,
          width: sidebar.width,
        },
        activeAgency: {
          backgroundColor: activeAgency.backgroundColor,
          borderRightWidth: activeAgency.borderRightWidth,
          gridTemplateColumns: activeAgency.gridTemplateColumns,
          padding: activeAgency.padding,
        },
        secondaryAgency: {
          borderRadius: secondaryAgency.borderRadius,
          borderRightWidth: secondaryAgency.borderRightWidth,
        },
      }
    })

  const directStyles = await readLayoutStyles()
  await page.locator(".wiki-classic-idol-card").first().click()
  await expect(page).toHaveURL(/\/story\/classic\?/)
  await page.getByRole("link", { name: "返回上一页", exact: true }).click()
  await expect(page).toHaveURL(/\/wiki\/classic\?/)
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "初星学园",
      exact: true,
    })
  ).toBeVisible()

  expect(await readLayoutStyles()).toEqual(directStyles)
  expect(directStyles.pattern).toEqual({
    backgroundColor: "rgba(255, 248, 251, 0.38)",
    backgroundImage: "none",
  })
  expect(directStyles.sidebar.position).toBe("fixed")
  expect(directStyles.activeAgency.backgroundColor).toBe("rgb(243, 152, 0)")
  expect(directStyles.activeAgency.borderRightWidth).toBe("0px")
  expect(directStyles.secondaryAgency).toEqual({
    borderRadius: "14px 0px 0px 14px",
    borderRightWidth: "0px",
  })
})

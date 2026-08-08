import { render, screen } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import { MemoryRouter, Route, Routes } from "react-router"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

import { i18n } from "~/i18n/config"
import PublicLayout from "~/layouts/public-layout"

vi.mock("~/components/shared/admin-return-shortcut", () => ({
  AdminReturnShortcut: () => null,
}))

vi.mock("~/components/shared/back-to-top", () => ({
  BackToTop: ({ className }: { className?: string }) => (
    <button type="button" className={className}>
      返回顶部
    </button>
  ),
}))

vi.mock("~/components/shared/series-icon-background", () => ({
  SeriesIconBackground: () => <div data-testid="series-icon-background" />,
}))

vi.mock("~/components/shared/site-footer", () => ({
  SiteFooter: () => <footer>站点页脚</footer>,
}))

vi.mock("~/components/shared/site-header", () => ({
  SiteHeader: () => <header>站点导航</header>,
}))

vi.mock("~/components/platform/platform-session-provider", () => ({
  PlatformSessionProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="platform-session-boundary">{children}</div>
  ),
}))

describe("PublicLayout", () => {
  it("shares one animated series background across public routes", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/events"]}>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route path="events" element={<main>活动中心内容</main>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    )

    expect(screen.getAllByTestId("series-icon-background")).toHaveLength(1)
    expect(screen.getByTestId("platform-session-boundary")).toContainElement(
      screen.getByText("活动中心内容")
    )
    expect(screen.getByText("活动中心内容")).toBeVisible()
    expect(screen.getByText("站点导航")).toBeVisible()
    expect(screen.getByText("站点页脚")).toBeVisible()
    expect(screen.getByRole("button", { name: "返回顶部" })).toBeVisible()
    expect(screen.getByRole("main").parentElement).toHaveClass("z-10")
  })

  it("keeps modern story floating controls above the site footer", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/story"]}>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route path="story" element={<main>剧情详情</main>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    )

    expect(screen.getByRole("main").parentElement).toHaveClass("z-20")
  })

  it("hides back to top on mobile Wiki catalogs", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/wiki"]}>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route path="wiki" element={<main>Wiki 内容</main>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    )

    expect(screen.getByRole("button", { name: "返回顶部" })).toHaveClass(
      "max-md:hidden"
    )
  })

  it.each(["/community/exchange", "/community/exchange/"])(
    "uses the full-screen map shell for %s",
    (initialEntry) => {
      render(
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={[initialEntry]}>
            <Routes>
              <Route element={<PublicLayout />}>
                <Route
                  path="community/exchange/*"
                  element={<main>交换地图内容</main>}
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </I18nextProvider>
      )

      const shell = screen.getByTestId(
        "platform-session-boundary"
      ).firstElementChild
      expect(shell).toHaveClass("h-dvh", "min-h-0", "overflow-hidden")
      expect(
        screen.queryByTestId("series-icon-background")
      ).not.toBeInTheDocument()
      expect(screen.queryByText("站点页脚")).not.toBeInTheDocument()
      expect(screen.getByText("交换地图内容")).toBeVisible()
    }
  )

  it("keeps nested exchange pages in the normal public layout", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/community/exchange/me"]}>
          <Routes>
            <Route element={<PublicLayout />}>
              <Route
                path="community/exchange/*"
                element={<main>交换帐号内容</main>}
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    )

    const shell = screen.getByTestId(
      "platform-session-boundary"
    ).firstElementChild
    expect(shell).not.toHaveClass("h-dvh", "overflow-hidden")
    expect(screen.getByTestId("series-icon-background")).toBeVisible()
    expect(screen.getByText("站点页脚")).toBeVisible()
    expect(screen.getByText("交换帐号内容")).toBeVisible()
  })
})

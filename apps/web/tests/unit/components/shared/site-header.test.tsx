import { act, render, screen, within } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"
import { MemoryRouter } from "react-router"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SiteHeader } from "~/components/shared/site-header"
import { PlatformSessionProvider } from "~/components/platform/platform-session-provider"
import { i18n } from "~/i18n/config"
import { defaultLanguage, defaultNamespace } from "~/i18n/resources"

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}))

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n} defaultNS={defaultNamespace}>
      <MemoryRouter>
        <PlatformSessionProvider>{children}</PlatformSessionProvider>
      </MemoryRouter>
    </I18nextProvider>
  )
}

describe("SiteHeader", () => {
  beforeEach(async () => {
    await i18n.changeLanguage(defaultLanguage)
  })

  it("keeps the story archive in Chinese and hides language switching", async () => {
    render(<SiteHeader />, { wrapper: TestProviders })

    const storySiteLink = screen.getByRole("link", { name: "剧情站" })
    expect(storySiteLink).toHaveAttribute("href", "/wiki")
    expect(storySiteLink.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true"
    )
    expect(
      screen.queryByRole("link", { name: "板板大暴走" })
    ).not.toBeInTheDocument()

    await act(() => i18n.changeLanguage("en"))

    expect(screen.getByRole("link", { name: "剧情站" })).toBe(storySiteLink)
    expect(
      screen.queryByRole("button", { name: /切换至|Switch to/ })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("link", { name: "Running Idol" })
    ).not.toBeInTheDocument()
  })

  it("keeps only primary destinations in the global navigation", () => {
    render(<SiteHeader />, { wrapper: TestProviders })

    const navigation = screen.getByRole("navigation", { name: "主导航" })
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["首页", "活动", "推荐", "Live", "社区", "关于"])

    for (const secondaryLabel of ["名片墙", "地图", "作品", "编年史"]) {
      expect(
        within(navigation).queryByRole("link", { name: secondaryLabel })
      ).not.toBeInTheDocument()
    }
  })
})

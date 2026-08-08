import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "~/lib/api"
import Community from "~/pages/community/community-page"

const apiMocks = vi.hoisted(() => ({
  getFudabaSeries: vi.fn(),
  sendSeries: vi.fn(),
}))

vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>()
  return {
    ...actual,
    getFudabaSeries: apiMocks.getFudabaSeries,
  }
})

function renderPage() {
  return render(
    <MemoryRouter>
      <Community />
    </MemoryRouter>
  )
}

describe("Community", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.getFudabaSeries.mockReturnValue({ send: apiMocks.sendSeries })
    apiMocks.sendSeries.mockResolvedValue({ items: [] })
  })

  it("shows the exchange entry when the public read route is available", async () => {
    renderPage()

    expect(
      await screen.findByRole("link", { name: /名片交换事务所/ })
    ).toHaveAttribute("href", "/community/exchange")
  })

  it("hides the exchange entry only for the explicit feature-off response", async () => {
    apiMocks.sendSeries.mockRejectedValue(
      new ApiError("Not Found", {
        kind: "http",
        status: 404,
        payload: "Not Found",
      })
    )
    renderPage()

    await waitFor(() => {
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    })
    expect(
      screen.queryByRole("link", { name: /名片交换事务所/ })
    ).not.toBeInTheDocument()
  })

  it("keeps a navigable entry when the availability probe fails", async () => {
    apiMocks.sendSeries.mockRejectedValue(
      new ApiError("Service unavailable", {
        kind: "http",
        status: 503,
        payload: { error: "Service unavailable" },
      })
    )
    renderPage()

    expect(
      await screen.findByRole("link", { name: /名片交换事务所/ })
    ).toHaveTextContent("交换区状态暂时无法确认，可直接进入重试。")
  })

  it("does not treat an unrelated JSON 404 as the feature-off response", async () => {
    apiMocks.sendSeries.mockRejectedValue(
      new ApiError("Route response changed", {
        kind: "http",
        status: 404,
        payload: { error: "Route response changed" },
      })
    )
    renderPage()

    expect(
      await screen.findByRole("link", { name: /名片交换事务所/ })
    ).toHaveAttribute("href", "/community/exchange")
  })
})

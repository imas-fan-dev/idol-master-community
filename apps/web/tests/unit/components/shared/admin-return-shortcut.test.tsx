import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AdminReturnShortcut } from "~/components/shared/admin-return-shortcut"

const mocks = vi.hoisted(() => ({
  getAdminSession: vi.fn(() => ({ id: "admin-session-method" })),
  hasBackofficeSessionHint: vi.fn(),
  onError: vi.fn(),
  useRequest: vi.fn(),
}))

vi.mock("alova/client", () => ({
  useRequest: mocks.useRequest,
}))

vi.mock("~/lib/api", () => ({
  getAdminSession: mocks.getAdminSession,
  hasBackofficeSessionHint: mocks.hasBackofficeSessionHint,
}))

function renderShortcut() {
  render(
    <MemoryRouter>
      <AdminReturnShortcut />
    </MemoryRouter>
  )
}

describe("AdminReturnShortcut", () => {
  beforeEach(() => {
    mocks.hasBackofficeSessionHint.mockReturnValue(true)
    mocks.onError.mockReturnValue(undefined)
  })

  it("shows the management shortcut for an authenticated operator", () => {
    mocks.useRequest.mockReturnValue({
      data: {
        success: true,
        user: {
          id: 3,
          username: "operator",
          producername: "Operator",
          dept: "op",
          adminRole: "admin",
        },
      },
      error: undefined,
      onError: mocks.onError,
    })

    renderShortcut()

    expect(
      screen.getByRole("link", { name: "返回管理工作台" })
    ).toHaveAttribute("href", "/admin")
  })

  it("stays hidden for authenticated non-operators", () => {
    mocks.useRequest.mockReturnValue({
      data: {
        success: true,
        user: {
          id: 8,
          username: "reader",
          producername: "Reader",
          dept: "user",
          adminRole: null,
        },
      },
      error: undefined,
      onError: mocks.onError,
    })

    renderShortcut()

    expect(
      screen.queryByRole("link", { name: "返回管理工作台" })
    ).not.toBeInTheDocument()
  })

  it("stays hidden when the session cannot be validated", () => {
    mocks.useRequest.mockReturnValue({
      data: undefined,
      error: new Error("session unavailable"),
      onError: mocks.onError,
    })

    renderShortcut()

    expect(
      screen.queryByRole("link", { name: "返回管理工作台" })
    ).not.toBeInTheDocument()
  })

  it("does not send a session request without a CSRF cookie hint", () => {
    mocks.hasBackofficeSessionHint.mockReturnValue(false)
    mocks.useRequest.mockReturnValue({
      data: undefined,
      error: undefined,
      onError: mocks.onError,
    })

    renderShortcut()

    expect(mocks.useRequest).toHaveBeenCalledWith(
      { id: "admin-session-method" },
      { immediate: false }
    )
    expect(
      screen.queryByRole("link", { name: "返回管理工作台" })
    ).not.toBeInTheDocument()
  })
})

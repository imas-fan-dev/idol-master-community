import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Outlet, Route, Routes } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import AdminAccountsPage from "~/pages/admin/accounts/admin-accounts-page"
import type { AdminSession } from "~/lib/api"

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: mocks,
}))

const superSession: AdminSession = {
  id: 1,
  username: "super-operator",
  producername: "Super Operator",
  dept: "op",
  adminRole: "super_admin",
}

function renderPage(session: AdminSession = superSession) {
  render(
    <MemoryRouter initialEntries={["/admin/accounts"]}>
      <Routes>
        <Route element={<Outlet context={{ adminSession: session }} />}>
          <Route path="/admin/accounts" element={<AdminAccountsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}

function requestFrom(input: RequestInfo | URL, init?: RequestInit) {
  return input instanceof Request
    ? input
    : new Request(new URL(String(input), "http://ims.test"), init)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  document.cookie = "ims_admin_csrf=; Max-Age=0; path=/"
})

describe("AdminAccountsPage", () => {
  it("blocks a regular administrator before requesting account data", () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    renderPage({
      ...superSession,
      id: 2,
      username: "regular-operator",
      adminRole: "admin",
    })

    expect(screen.getByText("仅最高管理员可访问")).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("lists roles and creates a regular administrator", async () => {
    document.cookie = "ims_admin_csrf=account-csrf; path=/"
    const requests: Request[] = []
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFrom(input, init)
        requests.push(request.clone())

        if (request.method === "GET") {
          return Response.json({
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
          })
        }

        if (request.method === "POST") {
          return Response.json(
            {
              success: true,
              account: {
                id: 3,
                username: "new-operator",
                producername: "New Operator",
                adminRole: "admin",
              },
            },
            { status: 201 }
          )
        }

        throw new Error(`Unexpected request: ${request.method} ${request.url}`)
      }
    )
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()

    renderPage()

    expect(await screen.findByText("Super Operator")).toBeVisible()
    expect(screen.getByText("最高管理员")).toBeVisible()
    expect(screen.getByText("一般管理员")).toBeVisible()
    expect(
      screen.queryByRole("button", {
        name: "删除管理员 super-operator",
      })
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "新增管理员" }))
    await user.type(screen.getByLabelText("用户名"), "new-operator")
    await user.type(screen.getByLabelText("制作人名称"), "New Operator")
    await user.type(
      screen.getByLabelText("密码", { exact: true }),
      "secure-password-123"
    )
    await user.click(screen.getByRole("button", { name: "创建账号" }))

    await waitFor(() => {
      expect(requests.some((request) => request.method === "POST")).toBe(true)
    })
    const createRequest = requests.find((request) => request.method === "POST")
    expect(createRequest?.headers.get("X-CSRFToken")).toBe("account-csrf")
    await expect(createRequest?.json()).resolves.toEqual({
      username: "new-operator",
      producername: "New Operator",
      password: "secure-password-123",
    })
    expect(mocks.success).toHaveBeenCalledWith("管理员账号已创建")
  })

  it("confirms deletion of a regular administrator", async () => {
    document.cookie = "ims_admin_csrf=delete-csrf; path=/"
    const requests: Request[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = requestFrom(input, init)
        requests.push(request.clone())

        if (request.method === "DELETE") {
          return Response.json({ success: true })
        }

        return Response.json({
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
        })
      })
    )
    const user = userEvent.setup()

    renderPage()
    await user.click(
      await screen.findByRole("button", {
        name: "删除管理员 regular-operator",
      })
    )
    expect(screen.getByText(/将被删除，且无法再次登录管理工作台/)).toBeVisible()
    await user.click(screen.getByRole("button", { name: "确认删除" }))

    await waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.method === "DELETE" &&
            new URL(request.url).pathname === "/api/admin/accounts/2"
        )
      ).toBe(true)
    })
    const deleteRequest = requests.find(
      (request) => request.method === "DELETE"
    )
    expect(deleteRequest?.headers.get("X-CSRFToken")).toBe("delete-csrf")
    expect(mocks.success).toHaveBeenCalledWith("管理员账号已删除")
  })
})

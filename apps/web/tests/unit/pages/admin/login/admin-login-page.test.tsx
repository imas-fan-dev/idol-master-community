import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import AdminLogin from "~/pages/admin/login/admin-login-page"

function renderLogin() {
  render(
    <MemoryRouter initialEntries={["/admin/login"]}>
      <Routes>
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<h1>管理工作台首页</h1>} />
      </Routes>
    </MemoryRouter>
  )
}

function jsonResponse(payload: unknown, status = 200) {
  return Response.json(payload, { status })
}

describe("AdminLogin", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("submits to the role-gated endpoint and shows permission denial", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = input instanceof Request ? input.url : String(input)
      expect(new URL(requestUrl, "http://ims.test").pathname).toBe(
        "/api/admin/auth/login"
      )
      return jsonResponse(
        {
          success: false,
          message: "当前账号没有管理工作台权限",
        },
        403
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText("用户名"), "reader")
    await user.type(screen.getByLabelText("密码", { exact: true }), "password")
    await user.click(screen.getByRole("button", { name: "登录工作台" }))

    expect(await screen.findByText("当前账号没有管理工作台权限")).toBeVisible()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("navigates to the workspace after an op login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          username: "operator",
          producername: "Operator",
          dept: "op",
          adminRole: "admin",
        })
      )
    )
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText("用户名"), "operator")
    await user.type(screen.getByLabelText("密码", { exact: true }), "password")
    await user.click(screen.getByRole("button", { name: "登录工作台" }))

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "管理工作台首页" })
      ).toBeVisible()
    })
  })
})

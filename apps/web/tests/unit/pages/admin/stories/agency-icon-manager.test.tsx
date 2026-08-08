import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AgencyIconManager } from "~/pages/admin/stories/agency-icon-manager"

function requestDetails(call: unknown[]) {
  const [input, init] = call as [RequestInfo | URL, RequestInit | undefined]
  if (input instanceof Request) {
    return {
      body: input.body,
      headers: input.headers,
      method: input.method,
      url: input.url,
    }
  }
  return {
    body: init?.body ?? null,
    headers: new Headers(init?.headers),
    method: init?.method ?? "GET",
    url: String(input),
  }
}

function catalogPayload(iconUrl: string | null) {
  return {
    status: "success",
    agencies: [
      {
        id: 6,
        code: "sc",
        name: "闪耀色彩",
        color: "#8dbbff",
        wikiEnabled: true,
        bannerTitle: "283 Production",
        displayOrder: 0,
        layoutRevision: 0,
        iconUrl,
        groups: [],
      },
      {
        id: 7,
        code: "gk",
        name: "学园偶像大师",
        color: "#f39800",
        wikiEnabled: true,
        bannerTitle: "初星学园",
        displayOrder: 1,
        layoutRevision: 0,
        iconUrl: null,
        groups: [],
      },
    ],
  }
}

describe("AgencyIconManager", () => {
  beforeEach(() => {
    document.cookie = "ims_admin_csrf=wiki-agency-icon-test; path=/"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("uploads, previews, and removes the selected series icon", async () => {
    let iconUrl: string | null = "/icon/agencies/6.webp"
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((...args) => {
      const request = requestDetails(args)
      const url = new URL(request.url, window.location.origin)
      if (
        url.pathname === "/api/admin/wiki/catalog" &&
        request.method === "GET"
      ) {
        return Promise.resolve(Response.json(catalogPayload(iconUrl)))
      }
      if (
        url.pathname === "/api/wiki/agency-icon" &&
        request.method === "POST"
      ) {
        iconUrl = "/icon/agencies/6.webp"
        return Promise.resolve(
          Response.json({ status: "success", url: iconUrl })
        )
      }
      if (
        url.pathname === "/api/wiki/agency-icon" &&
        request.method === "DELETE"
      ) {
        iconUrl = null
        return Promise.resolve(Response.json({ status: "success" }))
      }
      return Promise.reject(
        new Error(`Unexpected request: ${request.method} ${url.pathname}`)
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    const objectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:series-icon-preview")
    const revokeObjectUrl = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined)
    const user = userEvent.setup()

    render(<AgencyIconManager />)

    expect(
      await screen.findByRole("img", { name: "闪耀色彩系列图标" })
    ).toHaveAttribute("src", "/icon/agencies/6.webp")

    const file = new File(["series-icon"], "shiny-colors.png", {
      type: "image/png",
    })
    await user.upload(screen.getByLabelText("系列图标"), file)
    expect(objectUrl).toHaveBeenCalledWith(file)
    expect(
      screen.getByRole("img", { name: "闪耀色彩系列图标" })
    ).toHaveAttribute("src", "blob:series-icon-preview")

    await user.click(screen.getByRole("button", { name: "保存系列图标" }))
    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: "闪耀色彩系列图标" })
      ).toHaveAttribute("src", "/icon/agencies/6.webp")
    })

    const uploadRequest = fetchMock.mock.calls
      .map((call) => requestDetails(call))
      .find(({ method }) => method === "POST")
    expect(uploadRequest?.headers.get("X-CSRFToken")).toBe(
      "wiki-agency-icon-test"
    )
    expect(uploadRequest?.body).toBeInstanceOf(FormData)
    const form = uploadRequest?.body as FormData
    expect(form.get("agency")).toBe("闪耀色彩")
    expect(form.get("image")).toBe(file)

    await user.click(screen.getByRole("button", { name: "移除图标" }))
    expect(
      screen.getByRole("heading", { name: "移除自定义系列图标？" })
    ).toBeInTheDocument()
    expect(
      screen.getByText("“闪耀色彩”将不再显示系列图标。")
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "确认移除" }))
    await waitFor(() => {
      expect(screen.queryByRole("img")).not.toBeInTheDocument()
    })
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:series-icon-preview")
  })
})

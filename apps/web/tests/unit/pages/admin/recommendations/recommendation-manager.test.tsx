import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RecommendationManager } from "~/pages/admin/recommendations/recommendation-manager"

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  })
}

describe("RecommendationManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.cookie = "ims_admin_csrf=; Max-Age=0; path=/"
  })

  it("reuses Bilibili parsing to fill and submit the recommendation cover", async () => {
    document.cookie = "ims_admin_csrf=recommendation-test; path=/"
    let submittedForm: FormData | null = null
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const request =
          input instanceof Request
            ? input
            : new Request(new URL(String(input), window.location.origin), init)
        const pathname = new URL(request.url).pathname
        if (pathname === "/api/wiki/parse_bilibili") {
          expect(await request.clone().json()).toEqual({
            url: "https://www.bilibili.com/video/BV1xx411c7mD",
          })
          return jsonResponse({
            status: "success",
            title: "B站解析标题",
            up: "测试UP",
            std_url: "https://www.bilibili.com/video/BV1xx411c7mD",
            cover_url: "https://i0.hdslb.com/bfs/archive/cover.jpg",
          })
        }
        if (pathname === "/api/admin/news" && request.method === "POST") {
          submittedForm = await request.clone().formData()
          return jsonResponse({ success: true })
        }
        return jsonResponse({ success: true, data: [] })
      })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()

    render(<RecommendationManager />)

    await user.type(
      screen.getByLabelText("跳转链接"),
      "https://www.bilibili.com/video/BV1xx411c7mD"
    )
    await user.click(screen.getByRole("button", { name: "解析 B站" }))

    expect(await screen.findByDisplayValue("B站解析标题")).toBeVisible()
    expect(screen.getByAltText("B站封面预览")).toHaveAttribute(
      "src",
      "https://i0.hdslb.com/bfs/archive/cover.jpg"
    )

    await user.click(screen.getByRole("button", { name: "发布推荐" }))

    await waitFor(() => expect(submittedForm).not.toBeNull())
    expect(submittedForm!.get("title")).toBe("B站解析标题")
    expect(submittedForm!.get("content")).toBe(
      "https://www.bilibili.com/video/BV1xx411c7mD"
    )
    expect(submittedForm!.get("cover_url")).toBe(
      "https://i0.hdslb.com/bfs/archive/cover.jpg"
    )
  })
})

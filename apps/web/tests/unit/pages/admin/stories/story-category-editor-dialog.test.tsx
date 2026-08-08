import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { StoryCategoryEditorDialog } from "~/pages/admin/stories/story-category-editor-dialog"

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

describe("StoryCategoryEditorDialog", () => {
  beforeEach(() => {
    document.cookie = "ims_admin_csrf=story-category-editor-test; path=/"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("prefills the shared category name and closes after a successful patch", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "success" }))
    vi.stubGlobal("fetch", fetchMock)
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <StoryCategoryEditorDialog
        open
        agencyId={6}
        idolId={10}
        agencyName="闪耀色彩"
        idolName="樱木真乃"
        category={{
          id: 8,
          name: "主线剧情",
          storageSlug: "main_story",
          displayOrder: 0,
          showWhenEmpty: true,
          backgroundEligible: false,
        }}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    )

    expect(screen.getByLabelText("分类名称")).toHaveValue("主线剧情")
    expect(
      screen.getByText(/分类名称属于企划级定义，将同步到本企划所有引用位置/)
    ).toBeVisible()
    expect(screen.getByText(/闪耀色彩 · 樱木真乃/)).toBeVisible()

    await user.clear(screen.getByLabelText("分类名称"))
    await user.type(screen.getByLabelText("分类名称"), "主线剧情 改")
    await user.click(screen.getByRole("button", { name: "保存分类" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("PATCH")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/categories/8"
    )
    expect(request.headers.get("X-CSRFToken")).toBe(
      "story-category-editor-test"
    )
    expect(JSON.parse(String(request.body))).toEqual({
      agencyId: 6,
      idolId: 10,
      name: "主线剧情 改",
      expectedName: "主线剧情",
    })
  })

  it("adds an explicit category for the selected idol", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "success" }, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <StoryCategoryEditorDialog
        open
        agencyId={6}
        idolId={10}
        agencyName="闪耀色彩"
        idolName="樱木真乃"
        category={null}
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    )

    expect(screen.getByRole("heading", { name: "新增剧情分类" })).toBeVisible()
    await user.type(screen.getByLabelText("分类名称"), "活动剧情")
    await user.click(screen.getByRole("button", { name: "新增分类" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("POST")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/agencies/6/idols/10/categories"
    )
    expect(JSON.parse(String(request.body))).toEqual({ name: "活动剧情" })
  })
})

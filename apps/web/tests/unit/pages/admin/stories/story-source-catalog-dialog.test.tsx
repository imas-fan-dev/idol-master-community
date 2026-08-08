import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { StorySourceCatalogDialog } from "~/pages/admin/stories/story-source-catalog-dialog"

const contentTypes = [
  {
    id: 1,
    name: "剧情",
    iconName: "book-open-text",
    description: "剧情内容",
    displayOrder: 0,
    isActive: true,
    revision: 0,
  },
]

const sourcePlatforms = [
  {
    id: 2,
    name: "其他来源",
    homepageUrl: "",
    description: "未分类来源",
    displayOrder: 0,
    isActive: true,
    revision: 0,
  },
]

describe("StorySourceCatalogDialog", () => {
  beforeEach(() => {
    document.cookie = "ims_admin_csrf=source-catalog-test; path=/"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("creates a dynamic content type used by source editors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        option: {
          id: 3,
          name: "电话",
          iconName: "phone",
          description: "游戏内电话",
          displayOrder: 1,
          isActive: true,
          revision: 0,
        },
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <StorySourceCatalogDialog
        open
        contentTypes={contentTypes}
        sourcePlatforms={sourcePlatforms}
        onOpenChange={vi.fn()}
        onSaved={onSaved}
      />
    )

    await user.type(screen.getByLabelText("名称"), "电话")
    await user.click(screen.getByRole("button", { name: "图标：link-2" }))
    await user.type(
      screen.getByRole("textbox", { name: "搜索 Lucide 图标" }),
      "phone"
    )
    await user.click(screen.getByRole("button", { name: "选择 phone 图标" }))
    await user.type(screen.getByLabelText("说明"), "游戏内电话")
    await user.click(screen.getByRole("button", { name: "新增目录项" }))

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1)
      expect(screen.getByText("电话")).toBeVisible()
    })
    const [request, init] = fetchMock.mock.calls[0] ?? []
    expect(init?.method).toBe("POST")
    expect(new URL(String(request), window.location.origin).pathname).toBe(
      "/api/admin/wiki/story-content-types"
    )
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "电话",
      iconName: "phone",
      description: "游戏内电话",
      isActive: true,
    })
    expect(new Headers(init?.headers).get("X-CSRFToken")).toBe(
      "source-catalog-test"
    )
  })
})

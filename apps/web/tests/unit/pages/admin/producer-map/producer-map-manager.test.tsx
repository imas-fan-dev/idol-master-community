import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ProducerMapManager } from "~/pages/admin/producer-map/producer-map-manager"
import type { ProducerMapContent } from "~/lib/api"

function content(): ProducerMapContent {
  return {
    version: 1,
    title: "全国偶像大师社群一览",
    subtitle: "THE IDOLM@STER COMMUNITY MAP",
    introduction: "连接各地制作人社群。",
    directoryTitle: "制作人社群名录",
    mapSourceLabel: "地图数据源",
    mapSourceUrl: "https://example.com/map-source",
    regions: [],
    communities: [
      {
        id: "site-owner-lounge",
        name: "站长小窝",
        platform: "QQ",
        region: null,
        description: "",
        contact: "",
        linkUrl: null,
        imageUrl: null,
        series: "all",
        enabled: true,
      },
    ],
    updatedAt: null,
  }
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  })
}

describe("ProducerMapManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.cookie = "ims_admin_csrf=; Max-Age=0; path=/"
  })

  it("loads the current revision and saves page and region edits", async () => {
    document.cookie = "ims_admin_csrf=producer-map-manager-test; path=/"
    let savedBody: unknown
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const request =
          input instanceof Request
            ? input
            : new Request(new URL(String(input), "http://localhost"), init)
        if (request.method === "PUT") {
          savedBody = await request.clone().json()
          const submitted = savedBody as {
            content: ProducerMapContent
            revision: string | null
          }
          return jsonResponse({
            success: true,
            content: {
              ...submitted.content,
              updatedAt: "2026-07-26T01:00:00.000Z",
            },
            revision: '"revision-2"',
          })
        }
        return jsonResponse({ content: content(), revision: '"revision-1"' })
      })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()

    render(<ProducerMapManager />)

    const title = await screen.findByLabelText("页面标题")
    await user.clear(title)
    await user.type(title, "更新后的制作人地图")
    await user.click(screen.getByRole("button", { name: "添加地区" }))
    expect(screen.getByLabelText("地区名称")).toHaveValue("北京市")
    await user.click(screen.getByRole("button", { name: "保存更改" }))

    await waitFor(() => expect(savedBody).toBeDefined())
    expect(savedBody).toMatchObject({
      revision: '"revision-1"',
      content: {
        title: "更新后的制作人地图",
        regions: [{ province: "北京市", name: "北京市" }],
      },
    })
    await waitFor(() => expect(screen.getByText(/最近保存/)).toBeVisible())
  })

  it("previews and updates configured region images", async () => {
    document.cookie = "ims_admin_csrf=producer-map-image-test; path=/"
    let savedBody: unknown
    const current = content()
    current.regions = [
      {
        id: "guangdong",
        province: "广东省",
        name: "广东制作人社群",
        summary: "",
        contact: "",
        linkUrl: null,
        imageUrl: "/uploads/producer-map/guangdong.webp",
        series: "all",
        enabled: true,
      },
    ]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const request =
          input instanceof Request
            ? input
            : new Request(new URL(String(input), "http://localhost"), init)
        if (request.method === "PUT") {
          savedBody = await request.clone().json()
          const submitted = savedBody as {
            content: ProducerMapContent
          }
          return jsonResponse({
            success: true,
            content: submitted.content,
            revision: '"revision-2"',
          })
        }
        return jsonResponse({ content: current, revision: '"revision-1"' })
      })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()

    render(<ProducerMapManager />)

    expect(
      await screen.findByAltText("广东制作人社群地区资料图片")
    ).toHaveAttribute("src", "/uploads/producer-map/guangdong.webp")

    const imageUrl = screen.getByLabelText("地区资料图片 URL")
    await user.clear(imageUrl)
    await user.type(imageUrl, "https://example.com/guangdong-new.webp")
    expect(screen.getByAltText("广东制作人社群地区资料图片")).toHaveAttribute(
      "src",
      "https://example.com/guangdong-new.webp"
    )

    await user.click(screen.getByRole("button", { name: "保存更改" }))
    await waitFor(() => expect(savedBody).toBeDefined())
    expect(savedBody).toMatchObject({
      content: {
        regions: [{ imageUrl: "https://example.com/guangdong-new.webp" }],
      },
    })
  })
})

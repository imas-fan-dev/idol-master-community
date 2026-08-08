import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { StoryManager } from "~/pages/admin/stories/story-manager"

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

function catalogPayload() {
  return {
    status: "success",
    agencies: [
      {
        id: 1,
        code: "765pro",
        name: "765PRO",
        color: null,
        wikiEnabled: true,
        bannerTitle: "765PRO ALLSTARS",
        displayOrder: 0,
        layoutRevision: 0,
        iconUrl: null,
        groups: [
          {
            id: 1,
            code: "765pro",
            name: "765PRO",
            color: "#f34f6d",
            iconUrl: null,
            displayOrder: 0,
            isFallback: true,
            idols: [
              {
                id: 10,
                name: "天海春香",
                folderName: "amami_haruka",
                color: "#e22b30",
                textColor: "#ffffff",
                displayOrder: 0,
                imageUrl: "",
                imageFit: "cover",
              },
            ],
          },
        ],
      },
    ],
  }
}

function storiesPayload(upName = "投稿者") {
  return {
    status: "success",
    agency: {
      id: 1,
      code: "765pro",
      name: "765PRO",
      color: "#f34f6d",
    },
    idol: {
      id: 10,
      name: "天海春香",
      folderName: "amami_haruka",
      color: "#e22b30",
      textColor: "#ffffff",
      displayOrder: 0,
      imageUrl: "",
      imageFit: "cover",
    },
    categories: [
      {
        id: 1,
        name: "主线",
        storageSlug: "main",
        displayOrder: 0,
        showWhenEmpty: true,
        backgroundEligible: false,
      },
      {
        id: 2,
        name: "活动剧情",
        storageSlug: "event",
        displayOrder: 1,
        showWhenEmpty: true,
        backgroundEligible: false,
      },
    ],
    contentTypes: [
      {
        id: 1,
        name: "剧情",
        description: "",
        displayOrder: 0,
        isActive: true,
        revision: 0,
      },
    ],
    sourcePlatforms: [
      {
        id: 1,
        name: "Bilibili",
        homepageUrl: "https://www.bilibili.com",
        description: "",
        displayOrder: 0,
        isActive: true,
        revision: 0,
      },
    ],
    stories: [
      {
        id: 21,
        category: "主线",
        cardName: "【第一话】",
        upName,
        videoTitle: "第一话 开场",
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        contentTypeId: 1,
        contentTypeName: "剧情",
        sourcePlatformId: 1,
        sourcePlatformName: "Bilibili",
        subtitle: "开场",
        imageFile: null,
        imageUrl: "",
      },
    ],
  }
}

describe("StoryManager", () => {
  beforeEach(() => {
    document.cookie = "ims_admin_csrf=wiki-manager-test; path=/"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("loads dynamic Wiki data and edits the selected story id", async () => {
    let currentUpName = "投稿者"
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((...args) => {
      const request = requestDetails(args)
      const url = new URL(request.url, window.location.origin)
      if (url.pathname === "/api/admin/wiki/catalog") {
        return Promise.resolve(Response.json(catalogPayload()))
      }
      if (
        url.pathname === "/api/admin/wiki/stories" &&
        request.method === "GET"
      ) {
        return Promise.resolve(Response.json(storiesPayload(currentUpName)))
      }
      if (
        url.pathname === "/api/wiki/edit_story" &&
        request.method === "POST"
      ) {
        const form = request.body as FormData
        currentUpName = String(form.get("up_name"))
        return Promise.resolve(Response.json({ status: "success" }))
      }
      return Promise.reject(
        new Error(`Unexpected request: ${request.method} ${url.pathname}`)
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()

    render(<StoryManager />)

    expect(await screen.findByText("【第一话】")).toBeVisible()
    expect(screen.getAllByText("投稿者")[0]).toBeVisible()
    expect(screen.getByRole("link", { name: "打开公开页" })).toHaveAttribute(
      "href",
      "/story?agency=765PRO&idol=%E5%A4%A9%E6%B5%B7%E6%98%A5%E9%A6%99"
    )

    await user.click(screen.getByRole("button", { name: "编辑" }))
    const upInput = screen.getByLabelText("发布者或署名")
    await user.clear(upInput)
    await user.type(upInput, "新投稿者")
    await user.click(screen.getByRole("button", { name: "保存修改" }))

    await waitFor(() => {
      expect(screen.getAllByText("新投稿者")[0]).toBeVisible()
    })

    const editRequest = fetchMock.mock.calls
      .map((call) => requestDetails(call))
      .find(
        ({ url }) =>
          new URL(url, window.location.origin).pathname ===
          "/api/wiki/edit_story"
      )
    expect(editRequest?.headers.get("X-CSRFToken")).toBe("wiki-manager-test")
    expect(editRequest?.body).toBeInstanceOf(FormData)
    const form = editRequest?.body as FormData
    expect(form.get("story_id")).toBe("21")
    expect(form.get("old_category_name")).toBe("主线")
    expect(form.get("old_card_name")).toBe("【第一话】")
    expect(form.get("up_name")).toBe("新投稿者")
  })
})

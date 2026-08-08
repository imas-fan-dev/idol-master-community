import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { StoryEditorDialog } from "~/pages/admin/stories/story-editor-dialog"
import { defaultWikiImageTransform, type WikiAdminStory } from "~/lib/api"

const category = {
  id: 1,
  name: "enzaP卡",
  storageSlug: "enza_pcard",
  displayOrder: 0,
  showWhenEmpty: true,
  backgroundEligible: false,
}

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
    description: "其他来源",
    displayOrder: 0,
    isActive: true,
    revision: 0,
  },
]

function requestDetails(call: unknown[]) {
  const [input, init] = call as [RequestInfo | URL, RequestInit | undefined]
  if (input instanceof Request) {
    return { body: input.body, method: input.method, url: input.url }
  }
  return {
    body: init?.body ?? null,
    method: init?.method ?? "GET",
    url: String(input),
  }
}

describe("StoryEditorDialog", () => {
  beforeEach(() => {
    document.cookie = "ims_admin_csrf=story-editor-test; path=/"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("creates one card and multiple source entries in a single request", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "success", sourceCount: 2 }))
    vi.stubGlobal("fetch", fetchMock)
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <StoryEditorDialog
        open
        story={null}
        agency="闪耀色彩"
        idol="樱木真乃"
        categories={[category]}
        contentTypes={contentTypes}
        sourcePlatforms={sourcePlatforms}
        defaultCategory="enzaP卡"
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    )

    expect(screen.getByRole("heading", { name: "新增剧情卡片" })).toBeVisible()
    expect(screen.getByLabelText("内容类型")).toHaveTextContent("剧情")
    expect(screen.getByLabelText("来源平台")).toHaveTextContent("其他来源")
    await user.type(screen.getByLabelText("卡片名"), "W.I.N.G.篇")
    await user.type(screen.getByLabelText("剧情备注"), "全话")
    await user.click(screen.getByRole("button", { name: "添加来源" }))

    const urls = screen.getAllByLabelText("内容链接")
    const uploaders = screen.getAllByLabelText("发布者或署名")
    const titles = screen.getAllByLabelText("内容标题")
    expect(urls).toHaveLength(2)
    await user.type(urls[0]!, "https://example.test/source-one")
    await user.type(uploaders[0]!, "来源一")
    await user.type(titles[0]!, "第一视角")
    await user.type(urls[1]!, "https://example.test/source-two")
    await user.type(uploaders[1]!, "来源二")
    await user.type(titles[1]!, "第二视角")
    await user.click(
      screen.getByRole("button", { name: "保存卡片与 2 个来源" })
    )

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("POST")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/wiki/add_story"
    )
    const form = request.body as FormData
    expect(form.get("category_name")).toBe("enzaP卡")
    expect(form.get("card_name")).toBe("【W.I.N.G.篇】")
    expect(form.get("subtitle")).toBe("全话")
    expect(JSON.parse(String(form.get("sources_json")))).toEqual([
      {
        upName: "来源一",
        videoTitle: "第一视角",
        url: "https://example.test/source-one",
        contentTypeId: 1,
        sourcePlatformId: 2,
      },
      {
        upName: "来源二",
        videoTitle: "第二视角",
        url: "https://example.test/source-two",
        contentTypeId: 1,
        sourcePlatformId: 2,
      },
    ])
  })

  it("creates a card without source entries", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "success", sourceCount: 0 }))
    vi.stubGlobal("fetch", fetchMock)
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <StoryEditorDialog
        open
        story={null}
        agency="闪耀色彩"
        idol="樱木真乃"
        categories={[category]}
        contentTypes={contentTypes}
        sourcePlatforms={sourcePlatforms}
        defaultCategory="enzaP卡"
        onOpenChange={() => undefined}
        onSaved={onSaved}
      />
    )

    await user.type(screen.getByLabelText("卡片名"), "待补来源")
    await user.click(screen.getByRole("button", { name: "删除来源 1" }))
    expect(screen.queryByLabelText("内容链接")).toBeNull()
    await user.click(screen.getByRole("button", { name: "仅保存卡片" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const form = requestDetails(fetchMock.mock.calls[0] ?? []).body as FormData
    expect(form.get("card_name")).toBe("【待补来源】")
    expect(JSON.parse(String(form.get("sources_json")))).toEqual([])
  })

  it("adds multiple sources to the selected card identity and revision", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "success", sourceCount: 2, mediaRevision: 4 })
      )
    vi.stubGlobal("fetch", fetchMock)
    const story: WikiAdminStory = {
      id: 21,
      cardId: 11,
      category: "enzaP卡",
      cardName: "【W.I.N.G.篇】",
      upName: "已有投稿者",
      videoTitle: "已有来源",
      url: "https://example.test/existing",
      contentTypeId: 1,
      contentTypeName: "剧情",
      sourcePlatformId: 2,
      sourcePlatformName: "其他来源",
      subtitle: "全话",
      imageFile: null,
      imageUrl: "",
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 4,
    }
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <StoryEditorDialog
        open
        mode="add-sources"
        story={story}
        agency="闪耀色彩"
        idol="樱木真乃"
        categories={[category]}
        contentTypes={contentTypes}
        sourcePlatforms={sourcePlatforms}
        defaultCategory="enzaP卡"
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    )

    expect(screen.getByRole("heading", { name: "新增剧情来源" })).toBeVisible()
    expect(screen.queryByLabelText("卡片名")).toBeNull()
    expect(screen.getByLabelText("内容链接")).toHaveValue("")
    await user.click(screen.getByRole("button", { name: "添加来源" }))

    const urls = screen.getAllByLabelText("内容链接")
    const uploaders = screen.getAllByLabelText("发布者或署名")
    const titles = screen.getAllByLabelText("内容标题")
    await user.type(urls[0]!, "https://example.test/source-one")
    await user.type(uploaders[0]!, "来源一")
    await user.type(titles[0]!, "第一视角")
    await user.type(urls[1]!, "https://example.test/source-two")
    await user.type(uploaders[1]!, "来源二")
    await user.type(titles[1]!, "第二视角")
    await user.click(screen.getByRole("button", { name: "添加 2 个来源" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("POST")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/cards/11/sources"
    )
    expect(JSON.parse(String(request.body))).toEqual({
      agency: "闪耀色彩",
      idol: "樱木真乃",
      expectedRevision: 4,
      sources: [
        {
          upName: "来源一",
          videoTitle: "第一视角",
          url: "https://example.test/source-one",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
        {
          upName: "来源二",
          videoTitle: "第二视角",
          url: "https://example.test/source-two",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
      ],
    })
  })

  it("edits card metadata without sending source fields", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "success" }))
    vi.stubGlobal("fetch", fetchMock)
    const story: WikiAdminStory = {
      id: 21,
      cardId: 11,
      category: "enzaP卡",
      cardName: "【W.I.N.G.篇】",
      upName: "原投稿者",
      videoTitle: "原标题",
      url: "https://example.test/source",
      contentTypeId: 1,
      contentTypeName: "剧情",
      sourcePlatformId: 2,
      sourcePlatformName: "其他来源",
      subtitle: "旧备注",
      imageFile: null,
      imageUrl: "",
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 4,
    }
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <StoryEditorDialog
        open
        mode="edit-card"
        story={story}
        agency="闪耀色彩"
        idol="樱木真乃"
        categories={[category]}
        contentTypes={contentTypes}
        sourcePlatforms={sourcePlatforms}
        defaultCategory="enzaP卡"
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />
    )

    expect(screen.getByRole("heading", { name: "编辑剧情卡片" })).toBeVisible()
    expect(screen.queryByLabelText("内容链接")).toBeNull()
    await user.clear(screen.getByLabelText("卡片名"))
    await user.type(screen.getByLabelText("卡片名"), "W.I.N.G.篇 改")
    await user.clear(screen.getByLabelText("剧情备注"))
    await user.type(screen.getByLabelText("剧情备注"), "新备注")
    await user.click(screen.getByRole("button", { name: "保存修改" }))

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("PATCH")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/cards/11"
    )
    const form = request.body as FormData
    expect(form.get("category_id")).toBe("1")
    expect(form.get("card_name")).toBe("【W.I.N.G.篇 改】")
    expect(form.get("subtitle")).toBe("新备注")
    expect(form.get("expected_revision")).toBe("4")
    expect(form.get("cover_asset_id")).toBe("")
    expect(form.get("remove_image")).toBe("true")
    expect(form.get("up_name")).toBeNull()
    expect(form.get("video_title")).toBeNull()
    expect(form.get("url")).toBeNull()
  })

  it("binds a reusable agency cover without uploading duplicate bytes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "success" }))
    vi.stubGlobal("fetch", fetchMock)
    const story: WikiAdminStory = {
      id: 21,
      cardId: 11,
      category: "enzaP卡",
      cardName: "【W.I.N.G.篇】",
      upName: "原投稿者",
      videoTitle: "原标题",
      url: "https://example.test/source",
      contentTypeId: 1,
      contentTypeName: "剧情",
      sourcePlatformId: 2,
      sourcePlatformName: "其他来源",
      subtitle: "",
      imageFile: null,
      imageUrl: "",
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 4,
    }
    const user = userEvent.setup()

    render(
      <StoryEditorDialog
        open
        mode="edit-card"
        story={story}
        agency="闪耀色彩"
        idol="樱木真乃"
        categories={[category]}
        contentTypes={contentTypes}
        sourcePlatforms={sourcePlatforms}
        coverAssets={[
          {
            id: 12,
            agencyId: 6,
            name: "共用主线封面",
            imageUrl: "/api/wiki/story-cover-assets/12.webp?v=0",
            presentationPolicy: "contain",
            displayOrder: 0,
            isActive: true,
            revision: 0,
            usageCount: 0,
          },
        ]}
        defaultCategory="enzaP卡"
        onOpenChange={() => undefined}
        onSaved={() => undefined}
      />
    )

    await user.click(screen.getByRole("button", { name: "共享素材" }))
    expect(screen.getByRole("combobox", { name: "共享素材" })).toBeVisible()
    expect(
      screen.getByText("该共享素材始终完整显示，卡片不会单独裁切。")
    ).toBeVisible()
    expect(screen.queryByLabelText("图片适配方式")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "保存修改" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const form = requestDetails(fetchMock.mock.calls[0] ?? []).body as FormData
    expect(form.get("cover_asset_id")).toBe("12")
    expect(form.get("remove_image")).toBeNull()
    expect(form.get("image")).toBeNull()
  })
})

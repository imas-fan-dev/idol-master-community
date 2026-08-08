import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { I18nextProvider } from "react-i18next"
import type { ReactNode } from "react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { i18n } from "~/i18n/config"
import { defaultLanguage, defaultNamespace } from "~/i18n/resources"
import { WikiEntityEditorDialog } from "~/pages/admin/stories/wiki-entity-editor-sheet"
import {
  defaultWikiImageTransform,
  type WikiAdminAgency,
  type WikiAdminGroup,
  type WikiAdminIdol,
} from "~/lib/api"

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

function TestI18nProvider({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18n} defaultNS={defaultNamespace}>
      {children}
    </I18nextProvider>
  )
}

describe("WikiEntityEditorDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage(defaultLanguage)
    document.cookie = "ims_admin_csrf=wiki-entity-editor-test; path=/"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("closes and refreshes after entity save succeeds but media save fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((...args) => {
      const request = requestDetails(args)
      const path = new URL(request.url, window.location.origin).pathname
      if (path === "/api/admin/wiki/agencies" && request.method === "POST") {
        return Promise.resolve(
          Response.json(
            { status: "success", agency: { id: 9 } },
            { status: 201 }
          )
        )
      }
      if (
        path === "/api/admin/wiki/agencies/9/icon" &&
        request.method === "PUT"
      ) {
        return Promise.resolve(
          Response.json(
            {
              status: "error",
              msg: "媒体已被其他编辑更新，请刷新后重试",
              mediaRevision: 1,
            },
            { status: 409 }
          )
        )
      }
      return Promise.reject(
        new Error(`Unexpected request: ${request.method} ${path}`)
      )
    })
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:agency-icon")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    const errorToast = vi.spyOn(toast, "error").mockImplementation(() => "")
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <WikiEntityEditorDialog
        target={{ kind: "agency", entity: null }}
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
      { wrapper: TestI18nProvider }
    )

    expect(screen.getByRole("dialog", { name: "新增企划" })).toHaveAttribute(
      "data-slot",
      "dialog-content"
    )

    await user.type(screen.getByLabelText("标识"), "vproject")
    await user.type(screen.getByLabelText("名称"), "Virtual Project")
    await user.upload(
      screen.getByLabelText("上传图片"),
      new File(["icon"], "icon.png", { type: "image/png" })
    )
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    expect(errorToast).toHaveBeenCalledWith(
      "企划资料已保存，但图片未保存：媒体已被其他编辑更新，请刷新后重试"
    )

    const requests = fetchMock.mock.calls.map(requestDetails)
    expect(
      requests.filter(
        ({ method, url }) =>
          method === "POST" &&
          new URL(url, window.location.origin).pathname ===
            "/api/admin/wiki/agencies"
      )
    ).toHaveLength(1)
    expect(
      requests.filter(
        ({ method, url }) =>
          method === "PUT" &&
          new URL(url, window.location.origin).pathname ===
            "/api/admin/wiki/agencies/9/icon"
      )
    ).toHaveLength(1)
  })

  it("submits a story content page with its story subtype", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ status: "success", idol: { id: 42 } }, { status: 201 })
      )
    vi.stubGlobal("fetch", fetchMock)
    const agency: WikiAdminAgency = {
      id: 6,
      code: "sc",
      name: "闪耀色彩",
      color: "#8dbbff",
      wikiEnabled: true,
      bannerTitle: "283 Production",
      displayOrder: 0,
      layoutRevision: 0,
      iconUrl: null,
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 0,
      idols: [],
      groups: [],
    }
    const user = userEvent.setup()

    render(
      <WikiEntityEditorDialog
        target={{ kind: "idol", agency, entity: null }}
        open
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
      />,
      { wrapper: TestI18nProvider }
    )

    await user.type(screen.getByLabelText("名称"), "周年活动")
    await user.type(screen.getByLabelText("素材目录"), "anniversary_event")
    await user.type(
      screen.getByLabelText("Wiki 链接（可选）"),
      "https://wiki.example.test/events/anniversary"
    )
    await user.click(screen.getByRole("button", { name: "剧情专题" }))
    await user.click(screen.getByRole("button", { name: "活动" }))
    await user.click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("POST")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/agencies/6/idols"
    )
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: "周年活动",
      folderName: "anniversary_event",
      wikiUrl: "https://wiki.example.test/events/anniversary",
      entryKind: "story",
      entrySubtype: "event",
    })
  })

  it("deletes a group after confirming that content pages and stories are preserved", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "success" }))
    vi.stubGlobal("fetch", fetchMock)
    const group: WikiAdminGroup = {
      id: 31,
      code: "illumination-stars",
      name: "illumination STARS",
      color: "#ffd700",
      iconUrl: null,
      displayOrder: 0,
      isFallback: false,
      idolIds: [],
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 0,
      idols: [],
    }
    const agency: WikiAdminAgency = {
      id: 6,
      code: "sc",
      name: "闪耀色彩",
      color: "#8dbbff",
      wikiEnabled: true,
      bannerTitle: "283 Production",
      displayOrder: 0,
      layoutRevision: 0,
      iconUrl: null,
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 0,
      idols: [],
      groups: [group],
    }
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <WikiEntityEditorDialog
        target={{ kind: "group", agency, entity: group }}
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
      { wrapper: TestI18nProvider }
    )

    await user.click(screen.getByRole("button", { name: "删除栏目" }))
    expect(screen.getByText(/内容页和剧情会保留/)).toBeVisible()
    await user.click(screen.getByRole("button", { name: "确认删除" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("DELETE")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/groups/31"
    )
    expect(JSON.parse(String(request.body))).toEqual({ expectedRevision: 0 })
  })

  it("soft deletes an idol and reports affected cards and sources", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        softDeleted: { cards: 2, stories: 5 },
      })
    )
    vi.stubGlobal("fetch", fetchMock)
    const idol: WikiAdminIdol = {
      id: 10,
      name: "樱木真乃",
      folderName: "sakuragi_mano",
      color: "#f1b0c9",
      textColor: "#ffffff",
      wikiUrl: null,
      displayOrder: 0,
      imageUrl: "",
      imageFit: "cover",
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 4,
      wikiEnabled: true,
      groupIds: [],
      entryKind: "idol",
      entrySubtype: null,
    }
    const agency: WikiAdminAgency = {
      id: 6,
      code: "sc",
      name: "闪耀色彩",
      color: "#8dbbff",
      wikiEnabled: true,
      bannerTitle: "283 Production",
      displayOrder: 0,
      layoutRevision: 0,
      iconUrl: null,
      imageTransform: defaultWikiImageTransform,
      mediaRevision: 0,
      idols: [idol],
      groups: [],
    }
    const onOpenChange = vi.fn()
    const onSaved = vi.fn()
    const user = userEvent.setup()

    render(
      <WikiEntityEditorDialog
        target={{ kind: "idol", agency, entity: idol }}
        open
        onOpenChange={onOpenChange}
        onSaved={onSaved}
      />,
      { wrapper: TestI18nProvider }
    )

    await user.click(screen.getByRole("button", { name: "删除内容页" }))
    expect(screen.getByText(/关联卡片与剧情来源会被软删除/)).toBeVisible()
    expect(
      screen.getByText(/页面图片、剧情图片和数据库记录都会保留/)
    ).toBeVisible()
    await user.click(screen.getByRole("button", { name: "确认删除" }))

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(onSaved).toHaveBeenCalledTimes(1)
    })
    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("DELETE")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/idols/10"
    )
    expect(JSON.parse(String(request.body))).toEqual({ expectedRevision: 4 })
  })
})

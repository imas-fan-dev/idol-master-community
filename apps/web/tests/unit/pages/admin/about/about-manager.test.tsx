import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AboutManager } from "~/pages/admin/about/about-manager"
import type { AboutPageContent } from "~/lib/api"

function aboutContent(): AboutPageContent {
  return {
    version: 1,
    siteName: "偶像大师交流站",
    siteNameEn: "A website for producers to communicate.",
    tagline: "由制作人共同维护的社区站点。",
    heroImageUrl: "/brand/about/gakuen-arisa.png",
    heroImageAlt: "亚里沙老师全身立绘",
    heroImageScale: 100,
    heroImageOffsetX: 0,
    heroImageOffsetY: 0,
    accentColorStart: "#B4E04B",
    accentColorEnd: "#E6F9E5",
    welcome: "欢迎制作人！",
    manifesto: ["为了 Top Idol 之名"],
    sinceYear: 2026,
    overviewTitle: "本站概要",
    overview: ["站点介绍。"],
    groups: [
      {
        id: "creators",
        title: "创始人",
        subtitle: "Creator",
        people: [
          {
            id: "producer-a",
            name: "制作人A",
            role: "站长",
            description: "维护站点。",
            since: "Since 2026",
            profileUrl: "https://example.com/producer-a",
            avatarUrl: "/brand/about/staff/producer-a.webp",
          },
        ],
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

describe("AboutManager", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.cookie = "ims_admin_csrf=; Max-Age=0; path=/"
  })

  it("loads the current revision and saves edited content", async () => {
    const original = aboutContent()
    document.cookie = "ims_admin_csrf=about-manager-test; path=/"
    let savedBody: unknown
    let uploadedHeroFileName: string | null = null
    let heroUploadCsrf: string | null = null
    let uploadedAvatarFileName: string | null = null
    let avatarUploadCsrf: string | null = null
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const request =
          input instanceof Request
            ? input
            : new Request(new URL(String(input), "http://localhost"), init)
        if (request.method === "POST") {
          const form = init?.body
          if (!(form instanceof FormData))
            throw new Error("missing upload form")
          const image = form.get("image")
          if (new URL(request.url).pathname.endsWith("/member-avatar")) {
            uploadedAvatarFileName = image instanceof File ? image.name : null
            avatarUploadCsrf = request.headers.get("x-csrftoken")
            return jsonResponse({
              success: true,
              url: "/uploads/about/member-avatars/producer-a.webp",
            })
          }
          uploadedHeroFileName = image instanceof File ? image.name : null
          heroUploadCsrf = request.headers.get("x-csrftoken")
          return jsonResponse({
            success: true,
            url: "/uploads/about/hero/new-hero.webp",
          })
        }
        if (request.method === "PUT") {
          savedBody = await request.clone().json()
          const submitted = savedBody as {
            content: AboutPageContent
            revision: string | null
          }
          return jsonResponse({
            success: true,
            content: {
              ...submitted.content,
              updatedAt: "2026-07-25T01:00:00.000Z",
            },
            revision: '"revision-8"',
          })
        }
        return jsonResponse({ content: original, revision: '"revision-7"' })
      })
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()

    render(<AboutManager />)

    const welcome = await screen.findByLabelText("欢迎语")
    expect(welcome).toHaveValue("欢迎制作人！")
    expect(screen.getByLabelText("角色主视觉图链接")).toHaveValue(
      "/brand/about/gakuen-arisa.png"
    )
    expect(screen.getByLabelText("角色图片替代文本")).toHaveValue(
      "亚里沙老师全身立绘"
    )
    const desktopPreviewButton = screen.getByRole("button", {
      name: "桌面端",
    })
    const mobilePreviewButton = screen.getByRole("button", {
      name: "移动端",
    })
    const previewCanvas = screen.getByTestId("about-hero-preview-canvas")
    expect(desktopPreviewButton).toHaveAttribute("aria-pressed", "true")
    expect(mobilePreviewButton).toHaveAttribute("aria-pressed", "false")
    expect(previewCanvas).toHaveAttribute("data-preview-mode", "desktop")
    await user.click(mobilePreviewButton)
    expect(desktopPreviewButton).toHaveAttribute("aria-pressed", "false")
    expect(mobilePreviewButton).toHaveAttribute("aria-pressed", "true")
    expect(previewCanvas).toHaveAttribute("data-preview-mode", "mobile")
    const precisePositionButton = screen.getByRole("button", {
      name: /精细位置/,
    })
    expect(precisePositionButton).toHaveAttribute("aria-expanded", "false")
    await user.click(precisePositionButton)
    expect(precisePositionButton).toHaveAttribute("aria-expanded", "true")
    const heroScale = screen.getByLabelText("角色缩放")
    const compositionPreview = screen.getByTestId(
      "about-hero-composition-preview"
    )
    const heroPreview = screen.getByAltText("亚里沙老师全身立绘构图预览")
    expect(heroScale).toHaveValue("100")
    expect(screen.getByLabelText("水平偏移")).toHaveValue("0")
    expect(screen.getByLabelText("垂直偏移")).toHaveValue("0")
    expect(screen.getByLabelText("渐变起始色十六进制值")).toHaveValue("#B4E04B")
    expect(screen.queryByLabelText("头像链接")).not.toBeInTheDocument()
    expect(screen.getByAltText("制作人A头像预览")).toHaveAttribute(
      "src",
      "/brand/about/staff/producer-a.webp"
    )
    const heroUpload = screen.getByLabelText("上传角色主视觉图")
    await user.upload(
      heroUpload,
      new File([Uint8Array.of(1, 2, 3)], "new-hero.png", {
        type: "image/png",
      })
    )
    await waitFor(() => expect(uploadedHeroFileName).toBe("new-hero.png"))
    expect(heroUploadCsrf).toBe("about-manager-test")
    await waitFor(() => {
      expect(screen.getByLabelText("角色主视觉图链接")).toHaveValue(
        "/uploads/about/hero/new-hero.webp"
      )
    })
    expect(heroPreview).toHaveAttribute(
      "src",
      "/uploads/about/hero/new-hero.webp"
    )
    const avatarUpload = screen.getByLabelText("上传头像")
    await user.upload(
      avatarUpload,
      new File([Uint8Array.of(4, 5, 6)], "member-avatar.png", {
        type: "image/png",
      })
    )
    await waitFor(() =>
      expect(uploadedAvatarFileName).toBe("member-avatar.png")
    )
    expect(avatarUploadCsrf).toBe("about-manager-test")
    await waitFor(() => {
      expect(screen.getByAltText("制作人A头像预览")).toHaveAttribute(
        "src",
        "/uploads/about/member-avatars/producer-a.webp"
      )
    })
    vi.spyOn(compositionPreview, "getBoundingClientRect").mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 400,
      top: 0,
      width: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(compositionPreview, {
      button: 0,
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    })
    fireEvent.pointerMove(compositionPreview, {
      clientX: 140,
      clientY: 160,
      pointerId: 1,
    })
    fireEvent.pointerUp(compositionPreview, { pointerId: 1 })
    expect(screen.getByLabelText("水平偏移")).toHaveValue("10")
    expect(screen.getByLabelText("垂直偏移")).toHaveValue("10")
    fireEvent.change(heroScale, { target: { value: "120" } })
    expect(heroPreview).toHaveStyle({
      transform: "translate(10%, 10%) scale(1.2)",
    })
    await user.clear(welcome)
    await user.type(welcome, "欢迎来到更新后的交流站！")
    const saveButton = screen.getByRole("button", { name: "保存更改" })
    const form = saveButton.closest("form")!
    expect(
      [...form.querySelectorAll(":invalid")].map((element) => element.id)
    ).toEqual([])
    await user.click(saveButton)

    await waitFor(() => expect(savedBody).toBeDefined())
    expect(savedBody).toMatchObject({
      revision: '"revision-7"',
      content: {
        heroImageUrl: "/uploads/about/hero/new-hero.webp",
        heroImageOffsetX: 10,
        heroImageOffsetY: 10,
        heroImageScale: 120,
        welcome: "欢迎来到更新后的交流站！",
        groups: [
          {
            people: [
              {
                avatarUrl: "/uploads/about/member-avatars/producer-a.webp",
              },
            ],
          },
        ],
      },
    })
    await waitFor(() => expect(screen.getByText(/最近保存/)).toBeVisible())
  })
})

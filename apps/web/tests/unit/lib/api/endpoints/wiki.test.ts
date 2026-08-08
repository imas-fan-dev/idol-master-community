import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createWikiAgency,
  createWikiCategory,
  createWikiGroup,
  createWikiIdol,
  createWikiStoryBatch,
  createWikiStoryCoverAsset,
  createWikiStorySources,
  defaultWikiImageTransform,
  deleteWikiAgencyIcon,
  deleteWikiCategory,
  deleteWikiGroup,
  deleteWikiIdol,
  deleteWikiStoryGroup,
  deleteWikiStoryLink,
  deleteWikiStoryCoverAsset,
  getAdminWikiCatalog,
  getAdminWikiStories,
  getAdminWikiStoryCoverAssets,
  getWikiCatalog,
  getWikiRandomBackground,
  getWikiRandomIdol,
  getWikiStories,
  saveWikiEntityImage,
  uploadWikiAgencyIcon,
  updateWikiAgency,
  updateWikiCategory,
  updateWikiGroup,
  updateWikiIdol,
  updateWikiStoryCard,
  updateWikiStoryCoverAsset,
  updateWikiStory,
} from "~/lib/api/endpoints/wiki"

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

function successResponse(payload: unknown = { status: "success" }) {
  return Response.json(payload)
}

describe("Wiki admin API", () => {
  beforeEach(() => {
    document.cookie = "ims_admin_csrf=wiki-api-test; path=/"
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("validates the dynamic catalog and selected idol story view", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
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
        })
      )
      .mockResolvedValueOnce(
        successResponse({
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
            wikiUrl: "https://wiki.example.test/idols/amami-haruka",
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
          ],
          contentTypes: [
            {
              id: 1,
              name: "剧情",
              description: "剧情内容",
              displayOrder: 0,
              isActive: true,
              revision: 0,
            },
          ],
          sourcePlatforms: [
            {
              id: 2,
              name: "其他来源",
              homepageUrl: "",
              description: "其他来源",
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
              upName: "投稿者",
              videoTitle: "第一话",
              url: "https://www.bilibili.com/video/BV1xx411c7mD",
              contentTypeId: 1,
              contentTypeName: "剧情",
              sourcePlatformId: 2,
              sourcePlatformName: "其他来源",
              subtitle: "开场",
              imageFile: null,
              imageUrl: "",
            },
          ],
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    const catalog = await getAdminWikiCatalog().send()
    const stories = await getAdminWikiStories("765PRO", "天海春香").send()

    expect(catalog.agencies[0]?.groups[0]?.idols[0]?.name).toBe("天海春香")
    expect(stories.stories[0]?.id).toBe(21)
    expect(catalog.agencies[0]?.imageTransform).toEqual(
      defaultWikiImageTransform
    )
    expect(catalog.agencies[0]?.groups[0]?.imageTransform).toEqual(
      defaultWikiImageTransform
    )
    expect(catalog.agencies[0]?.groups[0]?.idols[0]?.imageTransform).toEqual(
      defaultWikiImageTransform
    )
    expect(stories.idol.imageTransform).toEqual(defaultWikiImageTransform)
    expect(stories.idol.wikiUrl).toBe(
      "https://wiki.example.test/idols/amami-haruka"
    )
    expect(stories.stories[0]?.imageTransform).toEqual(
      defaultWikiImageTransform
    )
    const storyRequest = requestDetails(fetchMock.mock.calls[1] ?? [])
    const storyUrl = new URL(storyRequest.url, window.location.origin)
    expect(storyUrl.pathname).toBe("/api/admin/wiki/stories")
    expect(storyUrl.searchParams.get("agency")).toBe("765PRO")
    expect(storyUrl.searchParams.get("idol")).toBe("天海春香")
  })

  it("validates public catalog, grouped stories, and random artwork", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          status: "success",
          agencies: [
            {
              id: 6,
              code: "sc",
              name: "闪耀色彩",
              color: "#8dbbff",
              bannerTitle: "283 Production",
              iconUrl: "/icon/agencies/6.webp",
              idolCount: 1,
              imageTransform: {
                fit: "contain",
                focalX: "0.25",
                focalY: "0.75",
                zoom: "1.5",
                rotation: 90,
              },
            },
          ],
          selection: {
            agency: {
              id: 6,
              code: "sc",
              name: "闪耀色彩",
              color: "#8dbbff",
              bannerTitle: "283 Production",
              iconUrl: "/icon/agencies/6.webp",
              idolCount: 1,
            },
            layoutRevision: 3,
            groups: [
              {
                id: 31,
                code: "illumination-stars",
                name: "illumination STARS",
                color: "#ffd700",
                iconUrl: null,
                imageTransform: {
                  fit: "contain",
                  focalX: "0.4",
                  focalY: "0.6",
                  zoom: "2",
                  rotation: 180,
                },
                idols: [
                  {
                    id: 10,
                    name: "樱木真乃",
                    folderName: "sakuragi_mano",
                    color: "#f1b0c9",
                    imageUrl: "/image/mano.webp",
                    imageFit: "cover",
                    textColor: "#ffffff",
                    imageTransform: {
                      fit: "cover",
                      focalX: "0.3",
                      focalY: "0.7",
                      zoom: "1.25",
                      rotation: 270,
                    },
                  },
                ],
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        successResponse({
          status: "success",
          agency: {
            id: 6,
            code: "sc",
            name: "闪耀色彩",
            color: "#8dbbff",
          },
          idol: {
            id: 10,
            name: "樱木真乃",
            folderName: "sakuragi_mano",
            color: "#f1b0c9",
            wikiUrl: "https://wiki.example.test/idols/sakuragi-mano",
            imageUrl: "/image/mano.webp",
            imageFit: "cover",
            textColor: "#ffffff",
          },
          categories: [
            {
              name: "enzaP卡",
              cards: [
                {
                  id: 401,
                  name: "【花风Smiley】",
                  img: "/image/story.webp",
                  subtitle: "全话",
                  imageTransform: {
                    fit: "contain",
                    focalX: "0.1",
                    focalY: "0.9",
                    zoom: "3",
                    rotation: 0,
                  },
                  links: [
                    {
                      id: 21,
                      up: "投稿者",
                      title: "卡片剧情",
                      url: "https://www.bilibili.com/video/BV1xx411c7mD",
                      contentType: "剧情",
                      sourcePlatform: "Bilibili",
                    },
                  ],
                },
              ],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        successResponse({
          url: "/image/background.webp",
          card_id: 401,
          card_name: "【花风Smiley】",
          idol_name: "樱木真乃",
          agency_name: "闪耀色彩",
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    const catalog = await getWikiCatalog("闪耀色彩").send()
    const stories = await getWikiStories("闪耀色彩", "樱木真乃").send()
    const background = await getWikiRandomBackground().send()

    expect(catalog.selection?.groups[0]?.idols[0]?.imageFit).toBe("cover")
    expect(catalog.agencies[0]?.imageTransform).toEqual({
      fit: "contain",
      focalX: 0.25,
      focalY: 0.75,
      zoom: 1.5,
      rotation: 90,
    })
    expect(catalog.selection?.groups[0]?.imageTransform).toEqual({
      fit: "contain",
      focalX: 0.4,
      focalY: 0.6,
      zoom: 2,
      rotation: 180,
    })
    expect(catalog.selection?.groups[0]?.idols[0]?.imageTransform).toEqual({
      fit: "cover",
      focalX: 0.3,
      focalY: 0.7,
      zoom: 1.25,
      rotation: 270,
    })
    expect(stories.idol.imageTransform).toEqual(defaultWikiImageTransform)
    expect(stories.idol.wikiUrl).toBe(
      "https://wiki.example.test/idols/sakuragi-mano"
    )
    expect(stories.categories[0]?.cards[0]?.imageTransform).toEqual({
      fit: "contain",
      focalX: 0.1,
      focalY: 0.9,
      zoom: 3,
      rotation: 0,
    })
    expect(stories.categories[0]?.cards[0]?.links[0]?.id).toBe(21)
    expect(stories.categories[0]?.cards[0]?.id).toBe(401)
    expect(background.card_id).toBe(401)
    expect(background.card_name).toBe("【花风Smiley】")
    const requests = fetchMock.mock.calls.map(
      (call) => new URL(requestDetails(call).url, window.location.origin)
    )
    expect(requests.map((url) => url.pathname)).toEqual([
      "/api/wiki/catalog",
      "/api/wiki/stories",
      "/api/wiki/random_bg",
    ])
    expect(requests[0]?.searchParams.get("agency")).toBe("闪耀色彩")
    expect(requests[1]?.searchParams.get("idol")).toBe("樱木真乃")
  })

  it("validates the Wiki-backed random idol contract", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successResponse({
        status: "success",
        eligibleCount: 345,
        idol: {
          id: 6,
          name: "樱木真乃",
          color: "#8dbbff",
          textColor: "#ffffff",
          imageUrl: "/image/闪耀色彩/樱木真乃/icon.webp",
          imageTransform: {
            fit: "cover",
            focalX: 0.35,
            focalY: 0.4,
            zoom: 1.25,
            rotation: 0,
          },
          agency: {
            id: 6,
            code: "sc",
            name: "闪耀色彩",
            color: "#8dbbff",
            iconUrl: "/icon/agencies/6.webp",
            imageTransform: {
              fit: "contain",
              focalX: 0.5,
              focalY: 0.5,
              zoom: 1,
              rotation: 0,
            },
          },
        },
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await getWikiRandomIdol().send()

    expect(result.eligibleCount).toBe(345)
    expect(result.idol?.name).toBe("樱木真乃")
    expect(result.idol?.imageTransform.zoom).toBe(1.25)
    expect(result.idol?.agency.iconUrl).toBe("/icon/agencies/6.webp")
    expect(result.idol?.agency.imageTransform.fit).toBe("contain")
    const request = new URL(
      requestDetails(fetchMock.mock.calls[0] ?? []).url,
      window.location.origin
    )
    expect(request.pathname).toBe("/api/wiki/random_idol")
  })

  it("sends exact story edits and destructive group operations with CSRF", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse())
    vi.stubGlobal("fetch", fetchMock)

    await updateWikiStory(
      21,
      { category: "旧分类", cardName: "【旧卡片】" },
      {
        agency: "765PRO",
        idol: "天海春香",
        category: "新分类",
        cardName: "新卡片|特典",
        upName: "投稿者",
        videoTitle: "第二话",
        url: "https://www.bilibili.com/video/BV1xx411c7mD|ignored",
        contentTypeId: 1,
        sourcePlatformId: 2,
        subtitle: "备注|补充",
        imageTransform: {
          fit: "contain",
          focalX: 0.2,
          focalY: 0.8,
          zoom: 1.75,
          rotation: 90,
        },
        mediaRevision: 4,
      }
    ).send()
    await deleteWikiStoryGroup({
      agency: "765PRO",
      idol: "天海春香",
      category: "新分类",
      cardName: "【新卡片｜特典】",
    }).send()
    await deleteWikiCategory({
      agency: "765PRO",
      idol: "天海春香",
      category: "新分类",
    }).send()

    const requests = fetchMock.mock.calls.map((call) => requestDetails(call))
    expect(requests.map(({ method }) => method)).toEqual([
      "POST",
      "POST",
      "POST",
    ])
    for (const request of requests) {
      expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
      expect(request.body).toBeInstanceOf(FormData)
    }

    const edit = requests[0]?.body as FormData
    expect(edit.get("story_id")).toBe("21")
    expect(edit.get("old_category_name")).toBe("旧分类")
    expect(edit.get("old_card_name")).toBe("【旧卡片】")
    expect(edit.get("category_name")).toBe("新分类")
    expect(edit.get("card_name")).toBe("【新卡片｜特典】")
    expect(edit.get("url")).toBe(
      "https://www.bilibili.com/video/BV1xx411c7mDignored | 备注｜补充"
    )
    expect(edit.get("image_fit")).toBe("contain")
    expect(edit.get("image_focal_x")).toBe("0.2")
    expect(edit.get("image_focal_y")).toBe("0.8")
    expect(edit.get("image_zoom")).toBe("1.75")
    expect(edit.get("image_rotation")).toBe("90")
    expect(edit.get("expected_revision")).toBe("4")

    const cardDelete = requests[1]?.body as FormData
    expect(cardDelete.get("card_name")).toBe("【新卡片｜特典】")
    const categoryDelete = requests[2]?.body as FormData
    expect(categoryDelete.get("category_name")).toBe("新分类")
  })

  it("creates a card with multiple sources and deletes groups or individual sources", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({ status: "success", sourceCount: 2 })
      )
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(
        successResponse({ status: "success", cardDeleted: false })
      )
    vi.stubGlobal("fetch", fetchMock)
    const image = new File(["card"], "card.png", { type: "image/png" })

    await createWikiStoryBatch({
      agency: "闪耀色彩",
      idol: "樱木真乃",
      category: "enzaP卡",
      cardName: "批量卡片",
      subtitle: "备注|补充",
      sources: [
        {
          upName: " 来源一 ",
          videoTitle: " 第一视角 ",
          url: "https://example.test/one|drop",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
        {
          upName: "来源二",
          videoTitle: "第二视角",
          url: "https://example.test/two",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
      ],
      image,
      imageTransform: {
        fit: "contain",
        focalX: 0.2,
        focalY: 0.8,
        zoom: 1.5,
        rotation: 90,
      },
    }).send()
    await deleteWikiGroup(31, 2).send()
    await deleteWikiStoryLink({
      agency: "闪耀色彩",
      idol: "樱木真乃",
      storyId: 21,
      expectedRevision: 4,
    }).send()

    const requests = fetchMock.mock.calls.map(requestDetails)
    expect(requests.map(({ method }) => method)).toEqual([
      "POST",
      "DELETE",
      "DELETE",
    ])
    expect(
      requests.map(({ url }) => new URL(url, window.location.origin).pathname)
    ).toEqual([
      "/api/wiki/add_story",
      "/api/admin/wiki/groups/31",
      "/api/admin/wiki/stories/21",
    ])
    const storyUrl = new URL(requests[2]!.url, window.location.origin)
    expect(storyUrl.searchParams.get("agency")).toBe("闪耀色彩")
    expect(storyUrl.searchParams.get("idol")).toBe("樱木真乃")
    expect(storyUrl.searchParams.get("expectedRevision")).toBe("4")
    expect(JSON.parse(String(requests[1]!.body))).toEqual({
      expectedRevision: 2,
    })
    const form = requests[0]!.body as FormData
    expect(form.get("card_name")).toBe("【批量卡片】")
    expect(form.get("subtitle")).toBe("备注｜补充")
    expect(form.get("image")).toBe(image)
    expect(form.get("image_fit")).toBe("contain")
    expect(JSON.parse(String(form.get("sources_json")))).toEqual([
      {
        upName: "来源一",
        videoTitle: "第一视角",
        url: "https://example.test/onedrop",
        contentTypeId: 1,
        sourcePlatformId: 2,
      },
      {
        upName: "来源二",
        videoTitle: "第二视角",
        url: "https://example.test/two",
        contentTypeId: 1,
        sourcePlatformId: 2,
      },
    ])
    for (const request of requests) {
      expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
    }
  })

  it("sends category and card metadata patches with exact contracts and CSRF", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse())
    vi.stubGlobal("fetch", fetchMock)
    const image = new File(["card"], "card.png", { type: "image/png" })

    await updateWikiCategory({
      categoryId: 8,
      agencyId: 6,
      idolId: 10,
      name: "  主线剧情 改  ",
      expectedName: "主线剧情",
    }).send()
    await updateWikiStoryCard(21, {
      agency: "闪耀色彩",
      idol: "樱木真乃",
      categoryId: 8,
      cardName: " 主线卡片|改 ",
      subtitle: " 备注|补充 ",
      image,
      imageTransform: {
        fit: "contain",
        focalX: 0.2,
        focalY: 0.8,
        zoom: 1.75,
        rotation: 90,
      },
      mediaRevision: 4,
    }).send()

    const requests = fetchMock.mock.calls.map(requestDetails)
    expect(requests.map(({ method }) => method)).toEqual(["PATCH", "PATCH"])
    expect(
      requests.map(({ url }) => new URL(url, window.location.origin).pathname)
    ).toEqual(["/api/admin/wiki/categories/8", "/api/admin/wiki/cards/21"])
    for (const request of requests) {
      expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
    }

    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      agencyId: 6,
      idolId: 10,
      name: "主线剧情 改",
      expectedName: "主线剧情",
    })
    expect(requests[0]?.headers.get("Content-Type")).toContain(
      "application/json"
    )

    expect(requests[1]?.body).toBeInstanceOf(FormData)
    const form = requests[1]?.body as FormData
    expect(form.get("agency")).toBe("闪耀色彩")
    expect(form.get("idol")).toBe("樱木真乃")
    expect(form.get("category_id")).toBe("8")
    expect(form.get("card_name")).toBe("【主线卡片｜改】")
    expect(form.get("subtitle")).toBe("备注｜补充")
    expect(form.get("expected_revision")).toBe("4")
    expect(form.get("cover_asset_id")).toBe("")
    expect(form.get("image_fit")).toBe("contain")
    expect(form.get("image_focal_x")).toBe("0.2")
    expect(form.get("image_focal_y")).toBe("0.8")
    expect(form.get("image_zoom")).toBe("1.75")
    expect(form.get("image_rotation")).toBe("90")
    expect(form.get("image")).toBe(image)
    expect(form.get("up_name")).toBeNull()
    expect(form.get("video_title")).toBeNull()
    expect(form.get("url")).toBeNull()
  })

  it("creates an idol category and soft deletes an idol with exact contracts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(
        successResponse({
          status: "success",
          softDeleted: { cards: 2, stories: 5 },
        })
      )
    vi.stubGlobal("fetch", fetchMock)

    await createWikiCategory({
      agencyId: 6,
      idolId: 10,
      name: " 活动剧情 ",
    }).send()
    const deleted = await deleteWikiIdol(10, 4).send()

    expect(deleted.softDeleted).toEqual({ cards: 2, stories: 5 })
    const requests = fetchMock.mock.calls.map(requestDetails)
    expect(requests.map(({ method }) => method)).toEqual(["POST", "DELETE"])
    expect(
      requests.map(({ url }) => new URL(url, window.location.origin).pathname)
    ).toEqual([
      "/api/admin/wiki/agencies/6/idols/10/categories",
      "/api/admin/wiki/idols/10",
    ])
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      name: "活动剧情",
    })
    expect(JSON.parse(String(requests[1]?.body))).toEqual({
      expectedRevision: 4,
    })
    for (const request of requests) {
      expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
    }
  })

  it("lists and mutates agency story cover assets with multipart contracts", async () => {
    const asset = {
      id: 12,
      agencyId: 6,
      name: "共用主线封面",
      imageUrl: "/api/wiki/story-cover-assets/12.webp?v=0",
      presentationPolicy: "contain" as const,
      displayOrder: 0,
      isActive: true,
      revision: 0,
      usageCount: 0,
    }
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          status: "success",
          agency: { id: 6, code: "sc", name: "闪耀色彩" },
          assets: [asset],
        })
      )
      .mockResolvedValueOnce(successResponse({ status: "success", asset }))
      .mockResolvedValueOnce(
        successResponse({
          status: "success",
          asset: { ...asset, name: "共用封面改", revision: 1 },
        })
      )
      .mockResolvedValueOnce(successResponse())
    vi.stubGlobal("fetch", fetchMock)
    const image = new File(["cover"], "cover.png", { type: "image/png" })

    await getAdminWikiStoryCoverAssets(6).send()
    await createWikiStoryCoverAsset({
      agencyId: 6,
      name: " 共用主线封面 ",
      image,
      presentationPolicy: "contain",
    }).send()
    await updateWikiStoryCoverAsset({
      assetId: 12,
      name: " 共用封面改 ",
      isActive: false,
      presentationPolicy: "inherit",
      expectedRevision: 0,
    }).send()
    await deleteWikiStoryCoverAsset(12).send()

    const requests = fetchMock.mock.calls.map(requestDetails)
    expect(requests.map(({ method }) => method)).toEqual([
      "GET",
      "POST",
      "PATCH",
      "DELETE",
    ])
    expect(
      requests.map(({ url }) => new URL(url, window.location.origin).pathname)
    ).toEqual([
      "/api/admin/wiki/agencies/6/story-cover-assets",
      "/api/admin/wiki/agencies/6/story-cover-assets",
      "/api/admin/wiki/story-cover-assets/12",
      "/api/admin/wiki/story-cover-assets/12",
    ])
    const createForm = requests[1]?.body as FormData
    expect(createForm.get("name")).toBe("共用主线封面")
    expect(createForm.get("presentation_policy")).toBe("contain")
    expect(createForm.get("image")).toBe(image)
    const updateForm = requests[2]?.body as FormData
    expect(updateForm.get("name")).toBe("共用封面改")
    expect(updateForm.get("is_active")).toBe("false")
    expect(updateForm.get("presentation_policy")).toBe("inherit")
    expect(updateForm.get("expected_revision")).toBe("0")
    expect(updateForm.get("image")).toBeNull()
    for (const request of requests.slice(1)) {
      expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
    }
  })

  it("appends multiple sources to one versioned card without card metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      successResponse({
        status: "success",
        sourceCount: 2,
        mediaRevision: 4,
      })
    )
    vi.stubGlobal("fetch", fetchMock)

    await createWikiStorySources(21, {
      agency: "闪耀色彩",
      idol: "樱木真乃",
      expectedRevision: 4,
      sources: [
        {
          upName: " 来源一 ",
          videoTitle: " 第一视角 ",
          url: "https://example.test/one|drop",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
        {
          upName: "来源二",
          videoTitle: "第二视角",
          url: "https://example.test/two",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
      ],
    }).send()

    const request = requestDetails(fetchMock.mock.calls[0] ?? [])
    expect(request.method).toBe("POST")
    expect(new URL(request.url, window.location.origin).pathname).toBe(
      "/api/admin/wiki/cards/21/sources"
    )
    expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
    expect(JSON.parse(String(request.body))).toEqual({
      agency: "闪耀色彩",
      idol: "樱木真乃",
      expectedRevision: 4,
      sources: [
        {
          upName: "来源一",
          videoTitle: "第一视角",
          url: "https://example.test/onedrop",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
        {
          upName: "来源二",
          videoTitle: "第二视角",
          url: "https://example.test/two",
          contentTypeId: 1,
          sourcePlatformId: 2,
        },
      ],
    })
  })

  it("uploads and deletes agency icons through the Wiki CSRF boundary", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        successResponse({
          status: "success",
          url: "/icon/agencies/sc.webp?v=test",
        })
      )
      .mockResolvedValueOnce(successResponse())
    vi.stubGlobal("fetch", fetchMock)
    const file = new File(["icon"], "series.png", { type: "image/png" })

    const uploaded = await uploadWikiAgencyIcon("闪耀色彩", file).send()
    await deleteWikiAgencyIcon("闪耀色彩").send()

    expect(uploaded.url).toBe("/icon/agencies/sc.webp?v=test")
    const requests = fetchMock.mock.calls.map((call) => requestDetails(call))
    expect(requests.map(({ method }) => method)).toEqual(["POST", "DELETE"])
    expect(
      requests.map(({ url }) => new URL(url, window.location.origin).pathname)
    ).toEqual(["/api/wiki/agency-icon", "/api/wiki/agency-icon"])
    expect(requests[0]?.headers.get("X-CSRFToken")).toBe("wiki-api-test")
    expect(requests[1]?.headers.get("X-CSRFToken")).toBe("wiki-api-test")
    expect(requests[0]?.body).toBeInstanceOf(FormData)
    const form = requests[0]?.body as FormData
    expect(form.get("agency")).toBe("闪耀色彩")
    expect(form.get("image")).toBe(file)
  })

  it("sends catalog creates and updates with exact JSON contracts and CSRF", async () => {
    const mutationResults = [
      { status: "success", agency: { id: "6" } },
      { status: "success", agency: { id: 6 } },
      { status: "success", group: { id: "31" } },
      { status: "success", group: { id: 31 } },
      { status: "success", idol: { id: "10" } },
      { status: "success", idol: { id: 10 } },
    ]
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(successResponse(mutationResults.shift()))
      )
    vi.stubGlobal("fetch", fetchMock)
    const createAgencyPayload = {
      code: "future",
      name: "未来企划",
      color: "#123456",
      bannerTitle: "Future Production",
      wikiEnabled: true,
    }
    const updateAgencyPayload = {
      name: "未来企划 改",
      color: "#654321",
      bannerTitle: "Future Production 2",
      wikiEnabled: false,
    }
    const createGroupPayload = {
      code: "unit-a",
      name: "组合 A",
      color: "#abcdef",
    }
    const updateGroupPayload = { name: "组合 A 改", color: "#fedcba" }
    const createIdolPayload = {
      name: "未来偶像",
      folderName: "future_idol",
      color: "#112233",
      textColor: "#ffffff",
      wikiUrl: "https://wiki.example.test/idols/future",
      wikiEnabled: true,
      groupIds: [31, 32],
    }
    const updateIdolPayload = {
      name: "未来偶像 改",
      color: null,
      textColor: "#111111",
      wikiUrl: null,
      wikiEnabled: false,
      groupIds: [32],
    }

    await createWikiAgency(createAgencyPayload).send()
    await updateWikiAgency(6, updateAgencyPayload).send()
    await createWikiGroup(6, createGroupPayload).send()
    await updateWikiGroup(31, updateGroupPayload).send()
    await createWikiIdol(6, createIdolPayload).send()
    await updateWikiIdol(10, updateIdolPayload).send()

    const requests = fetchMock.mock.calls.map((call) => requestDetails(call))
    expect(requests.map(({ method }) => method)).toEqual([
      "POST",
      "PATCH",
      "POST",
      "PATCH",
      "POST",
      "PATCH",
    ])
    expect(
      requests.map(({ url }) => new URL(url, window.location.origin).pathname)
    ).toEqual([
      "/api/admin/wiki/agencies",
      "/api/admin/wiki/agencies/6",
      "/api/admin/wiki/agencies/6/groups",
      "/api/admin/wiki/groups/31",
      "/api/admin/wiki/agencies/6/idols",
      "/api/admin/wiki/idols/10",
    ])
    expect(requests.map(({ body }) => JSON.parse(String(body)))).toEqual([
      createAgencyPayload,
      updateAgencyPayload,
      createGroupPayload,
      updateGroupPayload,
      createIdolPayload,
      updateIdolPayload,
    ])
    for (const request of requests) {
      expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
      expect(request.headers.get("Content-Type")).toContain("application/json")
    }
  })

  it("saves every Wiki entity image with transforms, revision, and CSRF", async () => {
    const resultTransform = {
      fit: "contain" as const,
      focalX: 0.15,
      focalY: 0.85,
      zoom: 2.25,
      rotation: 270 as const,
    }
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        successResponse({
          status: "success",
          url: "/media/wiki.webp",
          mediaRevision: 8,
          imageTransform: resultTransform,
        })
      )
    )
    vi.stubGlobal("fetch", fetchMock)
    const file = new File(["image"], "entity.png", { type: "image/png" })

    await saveWikiEntityImage({
      kind: "agency",
      id: 6,
      file,
      transform: resultTransform,
      expectedRevision: 5,
    }).send()
    await saveWikiEntityImage({
      kind: "group",
      id: 31,
      transform: resultTransform,
      expectedRevision: 6,
    }).send()
    await saveWikiEntityImage({
      kind: "idol",
      id: 10,
      transform: resultTransform,
      expectedRevision: 7,
    }).send()

    const requests = fetchMock.mock.calls.map((call) => requestDetails(call))
    expect(requests.map(({ method }) => method)).toEqual(["PUT", "PUT", "PUT"])
    expect(
      requests.map(({ url }) => new URL(url, window.location.origin).pathname)
    ).toEqual([
      "/api/admin/wiki/agencies/6/icon",
      "/api/admin/wiki/groups/31/icon",
      "/api/admin/wiki/idols/10/avatar",
    ])
    for (const [index, request] of requests.entries()) {
      expect(request.headers.get("X-CSRFToken")).toBe("wiki-api-test")
      expect(request.body).toBeInstanceOf(FormData)
      const form = request.body as FormData
      expect(form.get("image_fit")).toBe("contain")
      expect(form.get("image_focal_x")).toBe("0.15")
      expect(form.get("image_focal_y")).toBe("0.85")
      expect(form.get("image_zoom")).toBe("2.25")
      expect(form.get("image_rotation")).toBe("270")
      expect(form.get("expected_revision")).toBe(String(index + 5))
      expect(form.get("image")).toBe(index === 0 ? file : null)
    }
  })
})

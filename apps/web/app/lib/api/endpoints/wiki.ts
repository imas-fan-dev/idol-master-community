import { z } from "zod"

import { adminApiClient } from "../admin-client"
import {
  NO_CLIENT_CACHE,
  PUBLIC_CACHE_INVALIDATION_SOURCE,
  WIKI_PUBLIC_CACHE,
} from "../cache-policy"
import { apiClient } from "../client"
import { withBackofficeAuth, withBackofficeCsrf } from "../types"

export const wikiImageTransformSchema = z.object({
  fit: z.enum(["contain", "cover"]),
  focalX: z.coerce.number().min(0).max(1),
  focalY: z.coerce.number().min(0).max(1),
  zoom: z.coerce.number().min(1).max(3),
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
  ]),
})

export const defaultWikiImageTransform: WikiImageTransform = {
  fit: "cover",
  focalX: 0.5,
  focalY: 0.5,
  zoom: 1,
  rotation: 0,
}

export const wikiStoryCoverPresentationPolicySchema = z.enum([
  "inherit",
  "contain",
])

export const wikiEntryKindSchema = z.enum(["idol", "unit", "story", "other"])
export const wikiStoryEntrySubtypeSchema = z.enum([
  "main",
  "event",
  "special",
  "other",
])

const wikiAdminIdolSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string(),
  folderName: z.string(),
  color: z.string().nullable(),
  wikiUrl: z.string().nullable().default(null),
  textColor: z.string(),
  displayOrder: z.coerce.number().int().nonnegative(),
  imageUrl: z.string(),
  imageFit: z.enum(["contain", "cover"]),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
  mediaRevision: z.coerce.number().int().nonnegative().default(0),
  wikiEnabled: z.boolean().default(true),
  groupIds: z.array(z.coerce.number().int().positive()).default([]),
  entryKind: wikiEntryKindSchema.default("idol"),
  entrySubtype: wikiStoryEntrySubtypeSchema.nullable().default(null),
})

const wikiAdminGroupSchema = z.object({
  id: z.coerce.number().int().positive(),
  code: z.string(),
  name: z.string(),
  color: z.string(),
  iconUrl: z.string().nullable(),
  displayOrder: z.coerce.number().int().nonnegative(),
  isFallback: z.boolean(),
  idolIds: z.array(z.coerce.number().int().positive()).default([]),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
  mediaRevision: z.coerce.number().int().nonnegative().default(0),
  idols: z.array(wikiAdminIdolSchema),
})

const wikiAdminAgencySchema = z.object({
  id: z.coerce.number().int().positive(),
  code: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  wikiEnabled: z.boolean(),
  bannerTitle: z.string(),
  displayOrder: z.coerce.number().int().nonnegative(),
  layoutRevision: z.coerce.number().int().nonnegative(),
  iconUrl: z.string().nullable(),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
  mediaRevision: z.coerce.number().int().nonnegative().default(0),
  idols: z.array(wikiAdminIdolSchema).default([]),
  groups: z.array(wikiAdminGroupSchema),
})

const wikiAdminCatalogSchema = z.object({
  status: z.literal("success"),
  agencies: z.array(wikiAdminAgencySchema),
})

export const wikiAdminStoryCardSchema = z.object({
  category: z.string(),
  cardName: z.string(),
  subtitle: z.string(),
  imageFile: z.string().nullable(),
  coverAssetId: z.coerce.number().int().positive().nullable().optional(),
  coverAssetName: z.string().nullable().optional(),
  imageUrl: z.string(),
  cardId: z.coerce.number().int().positive().optional(),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
  mediaRevision: z.coerce.number().int().nonnegative().default(0),
})

export const wikiAdminStorySchema = wikiAdminStoryCardSchema.extend({
  id: z.coerce.number().int().positive(),
  upName: z.string(),
  videoTitle: z.string(),
  url: z.string(),
  contentTypeId: z.coerce.number().int().positive(),
  contentTypeName: z.string(),
  sourcePlatformId: z.coerce.number().int().positive(),
  sourcePlatformName: z.string(),
})

const wikiStoryCatalogOptionSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string(),
  description: z.string(),
  displayOrder: z.coerce.number().int().nonnegative(),
  isActive: z.boolean(),
  revision: z.coerce.number().int().nonnegative(),
})

const wikiStoryContentTypeSchema = wikiStoryCatalogOptionSchema.extend({
  iconName: z.string().default("link-2"),
})

const wikiStorySourcePlatformSchema = wikiStoryCatalogOptionSchema.extend({
  homepageUrl: z.string(),
})

const wikiStorySourceCatalogSchema = z.object({
  status: z.literal("success"),
  contentTypes: z.array(wikiStoryContentTypeSchema),
  sourcePlatforms: z.array(wikiStorySourcePlatformSchema),
})

const wikiAdminStoriesSchema = z.object({
  status: z.literal("success"),
  agency: z.object({
    id: z.coerce.number().int().positive(),
    code: z.string(),
    name: z.string(),
    color: z.string(),
  }),
  idol: wikiAdminIdolSchema,
  categories: z.array(
    z.object({
      id: z.coerce.number().int().positive(),
      name: z.string(),
      storageSlug: z.string(),
      displayOrder: z.coerce.number().int().nonnegative(),
      showWhenEmpty: z.boolean(),
      backgroundEligible: z.boolean(),
    })
  ),
  contentTypes: z.array(wikiStoryContentTypeSchema),
  sourcePlatforms: z.array(wikiStorySourcePlatformSchema),
  cards: z.array(wikiAdminStoryCardSchema).optional(),
  stories: z.array(wikiAdminStorySchema),
})

const wikiStoryCoverAssetSchema = z.object({
  id: z.coerce.number().int().positive(),
  agencyId: z.coerce.number().int().positive(),
  name: z.string(),
  imageUrl: z.string(),
  presentationPolicy: wikiStoryCoverPresentationPolicySchema.default("inherit"),
  displayOrder: z.coerce.number().int().nonnegative(),
  isActive: z.boolean(),
  revision: z.coerce.number().int().nonnegative(),
  usageCount: z.coerce.number().int().nonnegative(),
})

const wikiStoryCoverAssetsSchema = z.object({
  status: z.literal("success"),
  agency: z.object({
    id: z.coerce.number().int().positive(),
    code: z.string(),
    name: z.string(),
  }),
  assets: z.array(wikiStoryCoverAssetSchema),
})

const wikiMutationResultSchema = z.object({
  status: z.literal("success"),
})

const wikiStoryCoverAssetMutationSchema = wikiMutationResultSchema.extend({
  asset: wikiStoryCoverAssetSchema,
})

const wikiAgencyMutationResultSchema = wikiMutationResultSchema.extend({
  agency: z.object({ id: z.coerce.number().int().positive() }),
})

const wikiGroupMutationResultSchema = wikiMutationResultSchema.extend({
  group: z.object({ id: z.coerce.number().int().positive() }),
})

const wikiIdolMutationResultSchema = wikiMutationResultSchema.extend({
  idol: z.object({ id: z.coerce.number().int().positive() }),
})

const wikiIdolDeleteResultSchema = wikiMutationResultSchema.extend({
  softDeleted: z.object({
    cards: z.coerce.number().int().nonnegative(),
    stories: z.coerce.number().int().nonnegative(),
  }),
})

const wikiAgencyIconResultSchema = wikiMutationResultSchema.extend({
  url: z.string(),
})

const wikiLayoutResultSchema = z.object({
  status: z.literal("success"),
  layoutRevision: z.coerce.number().int().nonnegative(),
})

const bilibiliResultSchema = z.object({
  status: z.literal("success"),
  title: z.string(),
  up: z.string(),
  std_url: z.string(),
  cover_url: z.string().default(""),
})

const wikiPublicAgencySchema = z.object({
  id: z.coerce.number().int().positive(),
  code: z.string(),
  name: z.string(),
  color: z.string(),
  bannerTitle: z.string(),
  iconUrl: z.string().nullable(),
  idolCount: z.coerce.number().int().nonnegative(),
  entryCount: z.coerce.number().int().nonnegative().optional(),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
})

const wikiPublicIdolSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string(),
  folderName: z.string(),
  color: z.string().nullable(),
  wikiUrl: z.string().nullable().default(null),
  imageUrl: z.string(),
  imageFit: z.enum(["contain", "cover"]),
  textColor: z.string(),
  entryKind: wikiEntryKindSchema.default("idol"),
  entrySubtype: wikiStoryEntrySubtypeSchema.nullable().default(null),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
})

const wikiPublicSearchEntrySchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string(),
  agencyId: z.coerce.number().int().positive(),
  agencyCode: z.string(),
  agencyName: z.string(),
  agencyColor: z.string(),
  entryKind: wikiEntryKindSchema.default("idol"),
  entrySubtype: wikiStoryEntrySubtypeSchema.nullable().default(null),
})

const wikiPublicGroupSchema = z.object({
  id: z.coerce.number().int().positive(),
  code: z.string(),
  name: z.string(),
  color: z.string(),
  iconUrl: z.string().nullable(),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
  idols: z.array(wikiPublicIdolSchema),
})

const wikiPublicCatalogSchema = z.object({
  status: z.literal("success"),
  agencies: z.array(wikiPublicAgencySchema),
  searchEntries: z.array(wikiPublicSearchEntrySchema).default([]),
  selection: z
    .object({
      agency: wikiPublicAgencySchema,
      layoutRevision: z.coerce.number().int().nonnegative(),
      groups: z.array(wikiPublicGroupSchema),
      ungroupedIdols: z.array(wikiPublicIdolSchema).default([]),
    })
    .nullable(),
})

const wikiPublicStoryLinkSchema = z.object({
  id: z.coerce.number().int().positive(),
  up: z.string(),
  title: z.string(),
  url: z.string(),
  contentType: z.string(),
  contentTypeIcon: z.string().default("link-2"),
  sourcePlatform: z.string(),
})

const wikiPublicStoryCardSchema = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string(),
  img: z.string(),
  subtitle: z.string(),
  imageTransform: wikiImageTransformSchema.default(defaultWikiImageTransform),
  links: z.array(wikiPublicStoryLinkSchema),
})

const wikiPublicStoriesSchema = z.object({
  status: z.literal("success"),
  agency: z.object({
    id: z.coerce.number().int().positive(),
    code: z.string(),
    name: z.string(),
    color: z.string(),
  }),
  idol: wikiPublicIdolSchema,
  categories: z.array(
    z.object({
      name: z.string(),
      cards: z.array(wikiPublicStoryCardSchema),
    })
  ),
})

const wikiRandomBackgroundSchema = z.object({
  url: z.string(),
  card_id: z.coerce.number().int().positive().optional(),
  card_name: z.string().optional(),
  idol_name: z.string().optional(),
  agency_name: z.string().optional(),
})

const wikiRandomIdolSchema = z.object({
  status: z.literal("success"),
  eligibleCount: z.coerce.number().int().nonnegative(),
  idol: z
    .object({
      id: z.coerce.number().int().positive(),
      name: z.string(),
      color: z.string().nullable(),
      textColor: z.string(),
      imageUrl: z.string(),
      imageTransform: wikiImageTransformSchema.default(
        defaultWikiImageTransform
      ),
      agency: z.object({
        id: z.coerce.number().int().positive(),
        code: z.string(),
        name: z.string(),
        color: z.string(),
        iconUrl: z.string().nullable().default(null),
        imageTransform: wikiImageTransformSchema.default(
          defaultWikiImageTransform
        ),
      }),
    })
    .nullable(),
})

export type WikiAdminCatalog = z.infer<typeof wikiAdminCatalogSchema>
export type WikiAdminAgency = z.infer<typeof wikiAdminAgencySchema>
export type WikiAdminGroup = z.infer<typeof wikiAdminGroupSchema>
export type WikiAdminIdol = z.infer<typeof wikiAdminIdolSchema>
export type WikiAdminStories = z.infer<typeof wikiAdminStoriesSchema>
export type WikiAdminStoryCard = z.infer<typeof wikiAdminStoryCardSchema>
export type WikiAdminStory = z.infer<typeof wikiAdminStorySchema>
export type WikiStoryCoverAsset = z.infer<typeof wikiStoryCoverAssetSchema>
export type WikiStoryCoverPresentationPolicy = z.infer<
  typeof wikiStoryCoverPresentationPolicySchema
>
export type WikiStoryCoverAssets = z.infer<typeof wikiStoryCoverAssetsSchema>
export type WikiStoryContentType = z.infer<typeof wikiStoryContentTypeSchema>
export type WikiStorySourcePlatform = z.infer<
  typeof wikiStorySourcePlatformSchema
>
export type WikiStorySourceCatalog = z.infer<
  typeof wikiStorySourceCatalogSchema
>
export type WikiImageTransform = z.infer<typeof wikiImageTransformSchema>
export type WikiEntryKind = z.infer<typeof wikiEntryKindSchema>
export type WikiStoryEntrySubtype = z.infer<typeof wikiStoryEntrySubtypeSchema>
export type BilibiliParseResult = z.infer<typeof bilibiliResultSchema>
export type WikiPublicAgency = z.infer<typeof wikiPublicAgencySchema>
export type WikiPublicIdol = z.infer<typeof wikiPublicIdolSchema>
export type WikiPublicSearchEntry = z.infer<typeof wikiPublicSearchEntrySchema>
export type WikiPublicCatalog = z.infer<typeof wikiPublicCatalogSchema>
export type WikiPublicStories = z.infer<typeof wikiPublicStoriesSchema>
export type WikiPublicStoryCategory = WikiPublicStories["categories"][number]
export type WikiPublicStoryCard = WikiPublicStoryCategory["cards"][number]
export type WikiRandomBackground = z.infer<typeof wikiRandomBackgroundSchema>
export type WikiRandomIdol = z.infer<typeof wikiRandomIdolSchema>

export type WikiStorySubmission = {
  agency: string
  idol: string
  category: string
  cardName: string
  upName: string
  videoTitle: string
  url: string
  contentTypeId: number
  sourcePlatformId: number
  subtitle: string
  image?: File | null
  imageTransform?: WikiImageTransform
  mediaRevision?: number
}

export type WikiStorySourceSubmission = {
  upName: string
  videoTitle: string
  url: string
  contentTypeId: number
  sourcePlatformId: number
}

export type WikiStoryCatalogOptionSubmission = {
  name: string
  iconName: string
  description: string
  isActive: boolean
}

export type WikiStorySourcePlatformSubmission = Omit<
  WikiStoryCatalogOptionSubmission,
  "iconName"
> & {
  homepageUrl: string
}

export type WikiStoryBatchSubmission = {
  agency: string
  idol: string
  category: string
  cardName: string
  subtitle: string
  sources: WikiStorySourceSubmission[]
  image?: File | null
  coverAssetId?: number | null
  imageTransform?: WikiImageTransform
}

export type WikiStorySourcesSubmission = {
  agency: string
  idol: string
  expectedRevision: number
  sources: WikiStorySourceSubmission[]
}

export type WikiStoryCardSubmission = {
  agency: string
  idol: string
  categoryId: number
  cardName: string
  subtitle: string
  image?: File | null
  coverAssetId?: number | null
  removeImage?: boolean
  imageTransform: WikiImageTransform
  mediaRevision: number
}

export type WikiAgencySubmission = {
  code: string
  name: string
  color: string
  bannerTitle: string
  wikiEnabled: boolean
}

export type WikiGroupSubmission = {
  code: string
  name: string
  color: string
}

export type WikiIdolSubmission = {
  name: string
  folderName: string
  color: string | null
  textColor: string
  wikiUrl: string | null
  wikiEnabled: boolean
  groupIds: number[]
  entryKind?: WikiEntryKind
  entrySubtype?: WikiStoryEntrySubtype | null
}

export type WikiStoryGroup = {
  agency: string
  idol: string
  category: string
  cardName: string
}

function wikiMutationConfig() {
  return {
    name: PUBLIC_CACHE_INVALIDATION_SOURCE.wiki,
    meta: withBackofficeCsrf(),
  } as const
}

export function getWikiCatalog(agency?: string) {
  return apiClient.Get<WikiPublicCatalog, unknown>("/api/wiki/catalog", {
    cacheFor: WIKI_PUBLIC_CACHE,
    hitSource: PUBLIC_CACHE_INVALIDATION_SOURCE.wiki,
    params: agency ? { agency } : undefined,
    transform: (payload) => wikiPublicCatalogSchema.parse(payload),
  })
}

export function getWikiStories(agency: string, idol: string) {
  return apiClient.Get<WikiPublicStories, unknown>("/api/wiki/stories", {
    cacheFor: WIKI_PUBLIC_CACHE,
    hitSource: PUBLIC_CACHE_INVALIDATION_SOURCE.wiki,
    params: { agency, idol },
    transform: (payload) => wikiPublicStoriesSchema.parse(payload),
  })
}

export function getWikiRandomBackground() {
  return apiClient.Get<WikiRandomBackground, unknown>("/api/wiki/random_bg", {
    cacheFor: NO_CLIENT_CACHE,
    transform: (payload) => wikiRandomBackgroundSchema.parse(payload),
  })
}

export function getWikiRandomIdol() {
  return apiClient.Get<WikiRandomIdol, unknown>("/api/wiki/random_idol", {
    cacheFor: NO_CLIENT_CACHE,
    transform: (payload) => wikiRandomIdolSchema.parse(payload),
  })
}

function normalizedCardName(value: string) {
  let cardName = value.trim().replaceAll("|", "｜")
  if (!cardName.startsWith("【")) cardName = `【${cardName}`
  if (!cardName.endsWith("】")) cardName = `${cardName}】`
  return cardName
}

function appendStoryFields(form: FormData, submission: WikiStorySubmission) {
  const subtitle = submission.subtitle.trim().replaceAll("|", "｜")
  const url = submission.url.trim().replaceAll("|", "")

  form.append("agency", submission.agency)
  form.append("idol", submission.idol)
  form.append("category_name", submission.category.trim())
  form.append("card_name", normalizedCardName(submission.cardName))
  form.append("up_name", submission.upName.trim())
  form.append("video_title", submission.videoTitle.trim())
  form.append("url", `${url}${subtitle ? ` | ${subtitle}` : ""}`)
  form.append("content_type_id", String(submission.contentTypeId))
  form.append("source_platform_id", String(submission.sourcePlatformId))
  if (submission.image) form.append("image", submission.image)
  if (submission.imageTransform) {
    appendImageTransform(form, submission.imageTransform)
  }
  if (submission.mediaRevision !== undefined) {
    form.append("expected_revision", String(submission.mediaRevision))
  }
}

function appendImageTransform(form: FormData, transform: WikiImageTransform) {
  form.append("image_fit", transform.fit)
  form.append("image_focal_x", String(transform.focalX))
  form.append("image_focal_y", String(transform.focalY))
  form.append("image_zoom", String(transform.zoom))
  form.append("image_rotation", String(transform.rotation))
}

function appendStoryGroup(form: FormData, group: WikiStoryGroup) {
  form.append("agency", group.agency)
  form.append("idol", group.idol)
  form.append("category_name", group.category)
  form.append("card_name", group.cardName)
}

export function getAdminWikiCatalog() {
  return adminApiClient.Get<WikiAdminCatalog, unknown>(
    "/api/admin/wiki/catalog",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => wikiAdminCatalogSchema.parse(payload),
    }
  )
}

export function getAdminWikiStories(agency: string, idol: string) {
  return adminApiClient.Get<WikiAdminStories, unknown>(
    "/api/admin/wiki/stories",
    {
      meta: withBackofficeAuth(),
      params: { agency, idol },
      transform: (payload) => wikiAdminStoriesSchema.parse(payload),
    }
  )
}

export function getAdminWikiStoryCoverAssets(agencyId: number) {
  return adminApiClient.Get<WikiStoryCoverAssets, unknown>(
    `/api/admin/wiki/agencies/${agencyId}/story-cover-assets`,
    {
      meta: withBackofficeAuth(),
      transform: (payload) => wikiStoryCoverAssetsSchema.parse(payload),
    }
  )
}

export function createWikiStoryCoverAsset(input: {
  agencyId: number
  name: string
  image: File
  presentationPolicy: WikiStoryCoverPresentationPolicy
}) {
  const form = new FormData()
  form.append("name", input.name.trim())
  form.append("presentation_policy", input.presentationPolicy)
  form.append("image", input.image)
  return adminApiClient.Post<
    z.infer<typeof wikiStoryCoverAssetMutationSchema>,
    unknown
  >(`/api/admin/wiki/agencies/${input.agencyId}/story-cover-assets`, form, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiStoryCoverAssetMutationSchema.parse(payload),
  })
}

export function updateWikiStoryCoverAsset(input: {
  assetId: number
  name: string
  isActive: boolean
  presentationPolicy: WikiStoryCoverPresentationPolicy
  expectedRevision: number
  image?: File | null
}) {
  const form = new FormData()
  form.append("name", input.name.trim())
  form.append("is_active", String(input.isActive))
  form.append("presentation_policy", input.presentationPolicy)
  form.append("expected_revision", String(input.expectedRevision))
  if (input.image) form.append("image", input.image)
  return adminApiClient.Patch<
    z.infer<typeof wikiStoryCoverAssetMutationSchema>,
    unknown
  >(`/api/admin/wiki/story-cover-assets/${input.assetId}`, form, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiStoryCoverAssetMutationSchema.parse(payload),
  })
}

export function deleteWikiStoryCoverAsset(assetId: number) {
  return adminApiClient.Delete<
    z.infer<typeof wikiMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/story-cover-assets/${assetId}`, undefined, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiMutationResultSchema.parse(payload),
  })
}

export function getWikiStorySourceCatalog() {
  return adminApiClient.Get<WikiStorySourceCatalog, unknown>(
    "/api/admin/wiki/story-source-catalog",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => wikiStorySourceCatalogSchema.parse(payload),
    }
  )
}

const contentTypeMutationSchema = wikiMutationResultSchema.extend({
  option: wikiStoryContentTypeSchema,
})
const sourcePlatformMutationSchema = wikiMutationResultSchema.extend({
  option: wikiStorySourcePlatformSchema,
})

export function createWikiStoryContentType(
  submission: WikiStoryCatalogOptionSubmission
) {
  return adminApiClient.Post<
    z.infer<typeof contentTypeMutationSchema>,
    unknown
  >("/api/admin/wiki/story-content-types", submission, {
    ...wikiMutationConfig(),
    transform: (payload) => contentTypeMutationSchema.parse(payload),
  })
}

export function updateWikiStoryContentType(
  optionId: number,
  expectedRevision: number,
  submission: WikiStoryCatalogOptionSubmission
) {
  return adminApiClient.Patch<
    z.infer<typeof contentTypeMutationSchema>,
    unknown
  >(
    `/api/admin/wiki/story-content-types/${optionId}`,
    { ...submission, expectedRevision },
    {
      ...wikiMutationConfig(),
      transform: (payload) => contentTypeMutationSchema.parse(payload),
    }
  )
}

export function deleteWikiStoryContentType(optionId: number) {
  return adminApiClient.Delete<
    z.infer<typeof wikiMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/story-content-types/${optionId}`, undefined, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiMutationResultSchema.parse(payload),
  })
}

export function createWikiStorySourcePlatform(
  submission: WikiStorySourcePlatformSubmission
) {
  return adminApiClient.Post<
    z.infer<typeof sourcePlatformMutationSchema>,
    unknown
  >("/api/admin/wiki/story-source-platforms", submission, {
    ...wikiMutationConfig(),
    transform: (payload) => sourcePlatformMutationSchema.parse(payload),
  })
}

export function updateWikiStorySourcePlatform(
  optionId: number,
  expectedRevision: number,
  submission: WikiStorySourcePlatformSubmission
) {
  return adminApiClient.Patch<
    z.infer<typeof sourcePlatformMutationSchema>,
    unknown
  >(
    `/api/admin/wiki/story-source-platforms/${optionId}`,
    { ...submission, expectedRevision },
    {
      ...wikiMutationConfig(),
      transform: (payload) => sourcePlatformMutationSchema.parse(payload),
    }
  )
}

export function deleteWikiStorySourcePlatform(optionId: number) {
  return adminApiClient.Delete<
    z.infer<typeof wikiMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/story-source-platforms/${optionId}`, undefined, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiMutationResultSchema.parse(payload),
  })
}

export function createWikiAgency(submission: WikiAgencySubmission) {
  return adminApiClient.Post<
    z.infer<typeof wikiAgencyMutationResultSchema>,
    unknown
  >("/api/admin/wiki/agencies", submission, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiAgencyMutationResultSchema.parse(payload),
  })
}

export function updateWikiAgency(
  agencyId: number,
  submission: Omit<WikiAgencySubmission, "code">
) {
  return adminApiClient.Patch<
    z.infer<typeof wikiAgencyMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/agencies/${agencyId}`, submission, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiAgencyMutationResultSchema.parse(payload),
  })
}

export function createWikiGroup(
  agencyId: number,
  submission: WikiGroupSubmission
) {
  return adminApiClient.Post<
    z.infer<typeof wikiGroupMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/agencies/${agencyId}/groups`, submission, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiGroupMutationResultSchema.parse(payload),
  })
}

export function updateWikiGroup(
  groupId: number,
  submission: Omit<WikiGroupSubmission, "code">
) {
  return adminApiClient.Patch<
    z.infer<typeof wikiGroupMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/groups/${groupId}`, submission, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiGroupMutationResultSchema.parse(payload),
  })
}

export function deleteWikiGroup(groupId: number, expectedRevision: number) {
  return adminApiClient.Delete<
    z.infer<typeof wikiMutationResultSchema>,
    unknown
  >(
    `/api/admin/wiki/groups/${groupId}`,
    { expectedRevision },
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function createWikiIdol(
  agencyId: number,
  submission: WikiIdolSubmission
) {
  return adminApiClient.Post<
    z.infer<typeof wikiIdolMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/agencies/${agencyId}/idols`, submission, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiIdolMutationResultSchema.parse(payload),
  })
}

export function updateWikiIdol(
  idolId: number,
  submission: Omit<WikiIdolSubmission, "folderName">
) {
  return adminApiClient.Patch<
    z.infer<typeof wikiIdolMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/idols/${idolId}`, submission, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiIdolMutationResultSchema.parse(payload),
  })
}

type WikiEntityImageKind = "agency" | "group" | "idol"

const wikiEntityImagePath = {
  agency: (id: number) => `/api/admin/wiki/agencies/${id}/icon`,
  group: (id: number) => `/api/admin/wiki/groups/${id}/icon`,
  idol: (id: number) => `/api/admin/wiki/idols/${id}/avatar`,
} satisfies Record<WikiEntityImageKind, (id: number) => string>

const wikiEntityImageResultSchema = wikiMutationResultSchema.extend({
  url: z.string(),
  mediaRevision: z.coerce.number().int().nonnegative(),
  imageTransform: wikiImageTransformSchema,
})

export function saveWikiEntityImage(input: {
  kind: WikiEntityImageKind
  id: number
  file?: File | null
  transform: WikiImageTransform
  expectedRevision: number
}) {
  const form = new FormData()
  if (input.file) form.append("image", input.file)
  appendImageTransform(form, input.transform)
  form.append("expected_revision", String(input.expectedRevision))
  return adminApiClient.Put<
    z.infer<typeof wikiEntityImageResultSchema>,
    unknown
  >(wikiEntityImagePath[input.kind](input.id), form, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiEntityImageResultSchema.parse(payload),
  })
}

export function uploadWikiAgencyIcon(agency: string, file: File) {
  const form = new FormData()
  form.append("agency", agency)
  form.append("image", file)
  return adminApiClient.Post<
    z.infer<typeof wikiAgencyIconResultSchema>,
    unknown
  >("/api/wiki/agency-icon", form, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiAgencyIconResultSchema.parse(payload),
  })
}

export function deleteWikiAgencyIcon(agency: string) {
  return adminApiClient.Delete<
    z.infer<typeof wikiMutationResultSchema>,
    unknown
  >(
    "/api/wiki/agency-icon",
    { agency },
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function saveWikiLayout(
  agencyId: number,
  expectedRevision: number,
  groups: Array<{ id: number; idolIds: number[] }>
) {
  return adminApiClient.Put<z.infer<typeof wikiLayoutResultSchema>, unknown>(
    `/api/admin/wiki/agencies/${agencyId}/layout`,
    { expectedRevision, groups },
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiLayoutResultSchema.parse(payload),
    }
  )
}

export function createWikiStory(submission: WikiStorySubmission) {
  const form = new FormData()
  appendStoryFields(form, submission)
  return adminApiClient.Post<z.infer<typeof wikiMutationResultSchema>, unknown>(
    "/api/wiki/add_story",
    form,
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function createWikiStoryBatch(submission: WikiStoryBatchSubmission) {
  const form = new FormData()
  form.append("agency", submission.agency)
  form.append("idol", submission.idol)
  form.append("category_name", submission.category.trim())
  form.append("card_name", normalizedCardName(submission.cardName))
  form.append("subtitle", submission.subtitle.trim().replaceAll("|", "｜"))
  form.append(
    "sources_json",
    JSON.stringify(
      submission.sources.map((source) => ({
        upName: source.upName.trim(),
        videoTitle: source.videoTitle.trim(),
        url: source.url.trim().replaceAll("|", ""),
        contentTypeId: source.contentTypeId,
        sourcePlatformId: source.sourcePlatformId,
      }))
    )
  )
  if (submission.image) form.append("image", submission.image)
  if (submission.coverAssetId) {
    form.append("cover_asset_id", String(submission.coverAssetId))
  }
  if (submission.imageTransform) {
    appendImageTransform(form, submission.imageTransform)
  }
  return adminApiClient.Post<z.infer<typeof wikiMutationResultSchema>, unknown>(
    "/api/wiki/add_story",
    form,
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function createWikiStorySources(
  cardId: number,
  submission: WikiStorySourcesSubmission
) {
  return adminApiClient.Post<z.infer<typeof wikiMutationResultSchema>, unknown>(
    `/api/admin/wiki/cards/${cardId}/sources`,
    {
      agency: submission.agency,
      idol: submission.idol,
      expectedRevision: submission.expectedRevision,
      sources: submission.sources.map((source) => ({
        upName: source.upName.trim(),
        videoTitle: source.videoTitle.trim(),
        url: source.url.trim().replaceAll("|", ""),
        contentTypeId: source.contentTypeId,
        sourcePlatformId: source.sourcePlatformId,
      })),
    },
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

const wikiStoryLinkDeleteResultSchema = wikiMutationResultSchema.extend({
  cardDeleted: z.boolean(),
})

export function deleteWikiStoryLink(input: {
  agency: string
  idol: string
  storyId: number
  expectedRevision: number
}) {
  return adminApiClient.Delete<
    z.infer<typeof wikiStoryLinkDeleteResultSchema>,
    unknown
  >(`/api/admin/wiki/stories/${input.storyId}`, undefined, {
    params: {
      agency: input.agency,
      idol: input.idol,
      expectedRevision: input.expectedRevision,
    },
    ...wikiMutationConfig(),
    transform: (payload) => wikiStoryLinkDeleteResultSchema.parse(payload),
  })
}

export function deleteWikiIdol(idolId: number, expectedRevision: number) {
  return adminApiClient.Delete<
    z.infer<typeof wikiIdolDeleteResultSchema>,
    unknown
  >(
    `/api/admin/wiki/idols/${idolId}`,
    { expectedRevision },
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiIdolDeleteResultSchema.parse(payload),
    }
  )
}

export function updateWikiCategory(input: {
  categoryId: number
  agencyId: number
  idolId: number
  name: string
  expectedName: string
}) {
  return adminApiClient.Patch<
    z.infer<typeof wikiMutationResultSchema>,
    unknown
  >(
    `/api/admin/wiki/categories/${input.categoryId}`,
    {
      agencyId: input.agencyId,
      idolId: input.idolId,
      name: input.name.trim(),
      expectedName: input.expectedName,
    },
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function createWikiCategory(input: {
  agencyId: number
  idolId: number
  name: string
}) {
  return adminApiClient.Post<z.infer<typeof wikiMutationResultSchema>, unknown>(
    `/api/admin/wiki/agencies/${input.agencyId}/idols/${input.idolId}/categories`,
    { name: input.name.trim() },
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function updateWikiStoryCard(
  cardId: number,
  submission: WikiStoryCardSubmission
) {
  const form = new FormData()
  form.append("agency", submission.agency)
  form.append("idol", submission.idol)
  form.append("category_id", String(submission.categoryId))
  form.append("card_name", normalizedCardName(submission.cardName))
  form.append("subtitle", submission.subtitle.trim().replaceAll("|", "｜"))
  form.append("expected_revision", String(submission.mediaRevision))
  form.append(
    "cover_asset_id",
    submission.coverAssetId == null ? "" : String(submission.coverAssetId)
  )
  if (submission.removeImage) form.append("remove_image", "true")
  appendImageTransform(form, submission.imageTransform)
  if (submission.image) form.append("image", submission.image)
  return adminApiClient.Patch<
    z.infer<typeof wikiMutationResultSchema>,
    unknown
  >(`/api/admin/wiki/cards/${cardId}`, form, {
    ...wikiMutationConfig(),
    transform: (payload) => wikiMutationResultSchema.parse(payload),
  })
}

export function updateWikiStory(
  storyId: number,
  original: Pick<WikiAdminStory, "category" | "cardName">,
  submission: WikiStorySubmission
) {
  const form = new FormData()
  appendStoryFields(form, submission)
  form.append("story_id", String(storyId))
  form.append("old_category_name", original.category)
  form.append("old_card_name", original.cardName)
  return adminApiClient.Post<z.infer<typeof wikiMutationResultSchema>, unknown>(
    "/api/wiki/edit_story",
    form,
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function deleteWikiStoryGroup(group: WikiStoryGroup) {
  const form = new FormData()
  appendStoryGroup(form, group)
  return adminApiClient.Post<z.infer<typeof wikiMutationResultSchema>, unknown>(
    "/api/wiki/delete_story",
    form,
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function deleteWikiCategory(group: Omit<WikiStoryGroup, "cardName">) {
  const form = new FormData()
  form.append("agency", group.agency)
  form.append("idol", group.idol)
  form.append("category_name", group.category)
  return adminApiClient.Post<z.infer<typeof wikiMutationResultSchema>, unknown>(
    "/api/wiki/delete_category",
    form,
    {
      ...wikiMutationConfig(),
      transform: (payload) => wikiMutationResultSchema.parse(payload),
    }
  )
}

export function parseBilibiliStoryUrl(url: string) {
  return adminApiClient.Post<BilibiliParseResult, unknown>(
    "/api/wiki/parse_bilibili",
    { url },
    {
      meta: withBackofficeCsrf(),
      transform: (payload) => bilibiliResultSchema.parse(payload),
    }
  )
}

import { z } from "zod"

import { adminApiClient } from "../admin-client"
import { PUBLIC_CACHE_INVALIDATION_SOURCE } from "../cache-policy"
import { readCookie } from "../cookies"
import {
  BACKOFFICE_CSRF_COOKIE_NAME,
  LEGACY_BACKOFFICE_CSRF_COOKIE_NAME,
} from "../request"
import { withBackofficeAuth, withBackofficeCsrf } from "../types"

const adminRoleSchema = z.enum(["admin", "super_admin"])

const adminSessionSchema = z.object({
  success: z.literal(true),
  user: z.object({
    id: z.coerce.number().int().positive(),
    username: z.string(),
    producername: z.string().optional().default(""),
    dept: z.string(),
    adminRole: adminRoleSchema.nullable(),
  }),
})

const loginSchema = z.object({
  success: z.literal(true),
  username: z.string(),
  producername: z.string().nullable().optional(),
  dept: z.literal("op"),
  adminRole: adminRoleSchema,
})

const adminAccountSchema = z.object({
  id: z.coerce.number().int().positive(),
  username: z.string(),
  producername: z.string(),
  adminRole: adminRoleSchema,
})

const adminAccountListSchema = z.object({
  success: z.literal(true),
  accounts: z.array(adminAccountSchema),
})

const adminAccountMutationSchema = z.object({
  success: z.literal(true),
  account: adminAccountSchema,
})

const informationCategorySchema = z.enum(["activity", "fan"])
const informationContentTypeSchema = z.enum(["external", "html"])

export const adminInformationCardSchema = z.object({
  id: z.string(),
  category: informationCategorySchema,
  contentType: informationContentTypeSchema,
  image: z.string(),
  link: z.string(),
  title: z.string(),
  html: z.string().optional(),
  updatedAt: z.string(),
})

const adminInformationIndexSchema = z.object({
  version: z.literal(1),
  cards: z.array(adminInformationCardSchema),
  assets: z.array(z.string()),
})

const recommendationSchema = z.object({
  id: z.coerce.number().int().positive(),
  title: z.string(),
  image: z.string().nullable().optional(),
  thumbnail: z.string().nullable().optional(),
  content: z.string(),
  date: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
})

const recommendationListSchema = z.object({
  success: z.literal(true),
  data: z.array(recommendationSchema),
})

const informationAssetSchema = z.object({
  success: z.literal(true),
  url: z.string(),
})

const idolMediaSourceSchema = z.enum(["object-storage", "none"])

const idolMediaCatalogSchema = z.object({
  status: z.literal("success"),
  agencies: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      idols: z.array(
        z.object({
          name: z.string(),
          imageUrl: z.string(),
          imageFit: z.enum(["contain", "cover"]),
          source: idolMediaSourceSchema,
        })
      ),
    })
  ),
})

const pendingChronicleMediaSchema = z.record(
  z.string(),
  z.array(
    z.object({
      filename: z.string().min(1),
      url: z.string().min(1),
      uploader: z.string().optional(),
      time: z.string().optional(),
    })
  )
)

const usedChronicleMediaSchema = z.record(
  z.string(),
  z.array(
    z.object({
      filename: z.string().min(1),
      url: z.string().min(1),
    })
  )
)

const adminNamecardSchema = z.object({
  id: z.coerce.number().int().positive(),
  image1_url: z.string().min(1),
  image2_url: z.string().min(1),
  status: z.string(),
})

const adminNamecardListSchema = z.object({
  success: z.literal(true),
  data: z.array(adminNamecardSchema),
})

export type AdminSession = z.infer<typeof adminSessionSchema>["user"]
export type AdminRole = z.infer<typeof adminRoleSchema>
export type AdminAccount = z.infer<typeof adminAccountSchema>
export type AdminInformationCard = z.infer<typeof adminInformationCardSchema>
export type AdminInformationIndex = z.infer<typeof adminInformationIndexSchema>
export type AdminRecommendation = z.infer<typeof recommendationSchema>
export type InformationCategory = z.infer<typeof informationCategorySchema>
export type InformationContentType = z.infer<
  typeof informationContentTypeSchema
>
export type IdolMediaCatalog = z.infer<typeof idolMediaCatalogSchema>
export type IdolMediaAgency = IdolMediaCatalog["agencies"][number]
export type IdolMediaItem = IdolMediaAgency["idols"][number]
export type PendingChronicleMedia = z.infer<typeof pendingChronicleMediaSchema>
export type UsedChronicleMedia = z.infer<typeof usedChronicleMediaSchema>
export type AdminNamecard = z.infer<typeof adminNamecardSchema>

export type InformationSubmission = {
  title: string
  category: InformationCategory
  contentType: InformationContentType
  externalUrl: string
  html: string
  image: string
}

export function hasBackofficeSessionHint() {
  return Boolean(
    readCookie(BACKOFFICE_CSRF_COOKIE_NAME) ||
    readCookie(LEGACY_BACKOFFICE_CSRF_COOKIE_NAME)
  )
}

export function getAdminSession() {
  return adminApiClient.Get<z.infer<typeof adminSessionSchema>, unknown>(
    "/api/admin/auth/session",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => adminSessionSchema.parse(payload),
    }
  )
}

export function loginAdmin(username: string, password: string) {
  return adminApiClient.Post<z.infer<typeof loginSchema>, unknown>(
    "/api/admin/auth/login",
    { username, password },
    {
      meta: withBackofficeAuth({ authRole: "login" }),
      transform: (payload) => loginSchema.parse(payload),
    }
  )
}

export function logoutAdmin() {
  return adminApiClient.Post<{ success: true }, unknown>(
    "/api/admin/auth/logout",
    undefined,
    {
      meta: withBackofficeCsrf({ authRole: "logout" }),
    }
  )
}

export function getAdminAccounts() {
  return adminApiClient.Get<z.infer<typeof adminAccountListSchema>, unknown>(
    "/api/admin/accounts",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => adminAccountListSchema.parse(payload),
    }
  )
}

export function createAdminAccount(input: {
  username: string
  producername: string
  password: string
}) {
  return adminApiClient.Post<
    z.infer<typeof adminAccountMutationSchema>,
    unknown
  >("/api/admin/accounts", input, {
    meta: withBackofficeCsrf(),
    transform: (payload) => adminAccountMutationSchema.parse(payload),
  })
}

export function deleteAdminAccount(id: number) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    `/api/admin/accounts/${id}`,
    undefined,
    { meta: withBackofficeCsrf() }
  )
}

export function getAdminInformation() {
  return adminApiClient.Get<AdminInformationIndex, unknown>(
    "/api/admin/information",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => adminInformationIndexSchema.parse(payload),
    }
  )
}

export function uploadInformationAsset(file: File) {
  const form = new FormData()
  form.append("image", file)
  return adminApiClient.Post<z.infer<typeof informationAssetSchema>, unknown>(
    "/api/admin/information/assets",
    form,
    {
      meta: withBackofficeCsrf(),
      transform: (payload) => informationAssetSchema.parse(payload),
    }
  )
}

export function createInformation(submission: InformationSubmission) {
  return adminApiClient.Post<
    { success: true; card: AdminInformationCard },
    unknown
  >("/api/admin/information", submission, {
    meta: withBackofficeCsrf(),
    name: PUBLIC_CACHE_INVALIDATION_SOURCE.information,
  })
}

export function updateInformation(
  id: string,
  submission: InformationSubmission
) {
  return adminApiClient.Put<
    { success: true; card: AdminInformationCard },
    unknown
  >(`/api/admin/information/${encodeURIComponent(id)}`, submission, {
    meta: withBackofficeCsrf(),
    name: PUBLIC_CACHE_INVALIDATION_SOURCE.information,
  })
}

export function deleteInformation(id: string) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    `/api/admin/information/${encodeURIComponent(id)}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.information,
    }
  )
}

export function reorderInformation(ids: string[]) {
  return adminApiClient.Put<{ success: true }, unknown>(
    "/api/admin/information/order",
    { ids },
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.information,
    }
  )
}

export function deleteInformationAsset(url: string) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    "/api/admin/information/assets",
    { url },
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.information,
    }
  )
}

export function getRecommendations() {
  return adminApiClient.Get<z.infer<typeof recommendationListSchema>, unknown>(
    "/api/admin/news",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => recommendationListSchema.parse(payload),
    }
  )
}

export function createRecommendation(form: FormData) {
  return adminApiClient.Post<{ success: true }, unknown>(
    "/api/admin/news",
    form,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.recommendations,
    }
  )
}

export function deleteRecommendation(id: number) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    `/api/admin/news/${id}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.recommendations,
    }
  )
}

export function getIdolMediaCatalog() {
  return adminApiClient.Get<IdolMediaCatalog, unknown>("/api/wiki/idol-media", {
    meta: withBackofficeAuth(),
    transform: (payload) => idolMediaCatalogSchema.parse(payload),
  })
}

export function uploadIdolMedia(agency: string, idol: string, file: File) {
  const form = new FormData()
  form.append("agency", agency)
  form.append("idol", idol)
  form.append("image", file)
  return adminApiClient.Post<{ status: "success"; url: string }, unknown>(
    "/api/wiki/idol-media",
    form,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.wiki,
    }
  )
}

export function deleteIdolMedia(agency: string, idol: string) {
  return adminApiClient.Delete<{ status: "success" }, unknown>(
    "/api/wiki/idol-media",
    { agency, idol },
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.wiki,
    }
  )
}

export function getPendingChronicleMedia() {
  return adminApiClient.Get<PendingChronicleMedia, unknown>(
    "/eventchronicle/admin/pending",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => pendingChronicleMediaSchema.parse(payload),
    }
  )
}

export function getUsedChronicleMedia() {
  return adminApiClient.Get<UsedChronicleMedia, unknown>(
    "/eventchronicle/admin/used",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => usedChronicleMediaSchema.parse(payload),
    }
  )
}

export function approveChronicleMedia(activityId: string, filename: string) {
  return adminApiClient.Post<{ success: true }, unknown>(
    `/eventchronicle/admin/approve/${encodeURIComponent(activityId)}/${encodeURIComponent(filename)}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.chronicle,
    }
  )
}

export function rejectChronicleMedia(activityId: string, filename: string) {
  return adminApiClient.Post<{ success: true }, unknown>(
    `/eventchronicle/admin/reject/${encodeURIComponent(activityId)}/${encodeURIComponent(filename)}`,
    undefined,
    { meta: withBackofficeCsrf() }
  )
}

export function deleteUsedChronicleMedia(activityId: string, filename: string) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    `/eventchronicle/admin/delete-used/${encodeURIComponent(activityId)}/${encodeURIComponent(filename)}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.chronicle,
    }
  )
}

export function getAdminNamecards(page = 1) {
  return adminApiClient.Get<z.infer<typeof adminNamecardListSchema>, unknown>(
    "/api/admin/cards",
    {
      meta: withBackofficeAuth(),
      params: { page },
      transform: (payload) => adminNamecardListSchema.parse(payload),
    }
  )
}

export function approveAdminNamecard(id: number) {
  return adminApiClient.Post<{ success: true }, unknown>(
    `/api/admin/cards/approve/${id}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.community,
    }
  )
}

export function deleteAdminNamecard(id: number) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    `/api/admin/cards/${id}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.community,
    }
  )
}

export function createAdminEvent(form: FormData) {
  return adminApiClient.Post<{ success: true; id: number }, unknown>(
    "/api/events",
    form,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.events,
    }
  )
}

export function deleteAdminEvent(id: string) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    `/api/events/${encodeURIComponent(id)}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.events,
    }
  )
}

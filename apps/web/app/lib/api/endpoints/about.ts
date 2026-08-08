import { z } from "zod"

import { adminApiClient } from "../admin-client"
import {
  PUBLIC_CACHE_INVALIDATION_SOURCE,
  STABLE_CONTENT_CACHE_FOR,
} from "../cache-policy"
import { apiClient } from "../client"
import { withBackofficeAuth, withBackofficeCsrf } from "../types"

const aboutPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  description: z.string(),
  since: z.string(),
  profileUrl: z.string().url().nullable(),
  avatarUrl: z.string().nullable(),
})

const aboutGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  people: z.array(aboutPersonSchema),
})

export const aboutPageContentSchema = z.object({
  version: z.literal(1),
  siteName: z.string(),
  siteNameEn: z.string(),
  tagline: z.string(),
  heroImageUrl: z.string().nullable(),
  heroImageAlt: z.string(),
  heroImageScale: z.number().int().min(60).max(160),
  heroImageOffsetX: z.number().int().min(-40).max(40),
  heroImageOffsetY: z.number().int().min(-40).max(40),
  accentColorStart: z.string().regex(/^#[0-9a-f]{6}$/i),
  accentColorEnd: z.string().regex(/^#[0-9a-f]{6}$/i),
  welcome: z.string(),
  manifesto: z.array(z.string()),
  sinceYear: z.coerce.number().int(),
  overviewTitle: z.string(),
  overview: z.array(z.string()),
  groups: z.array(aboutGroupSchema),
  updatedAt: z.string().datetime().nullable(),
})

const aboutAdminSnapshotSchema = z.object({
  content: aboutPageContentSchema,
  revision: z.string().nullable(),
})

const aboutAdminUpdateSchema = aboutAdminSnapshotSchema.extend({
  success: z.literal(true),
})

const aboutImageUploadSchema = z.object({
  success: z.literal(true),
  url: z.string().min(1),
})

export type AboutPerson = z.infer<typeof aboutPersonSchema>
export type AboutGroup = z.infer<typeof aboutGroupSchema>
export type AboutPageContent = z.infer<typeof aboutPageContentSchema>
export type AboutAdminSnapshot = z.infer<typeof aboutAdminSnapshotSchema>

export function getAboutPageContent() {
  return apiClient.Get<AboutPageContent, unknown>("/api/about", {
    cacheFor: STABLE_CONTENT_CACHE_FOR,
    hitSource: PUBLIC_CACHE_INVALIDATION_SOURCE.about,
    transform: (payload) => aboutPageContentSchema.parse(payload),
  })
}

export function getAdminAboutPageContent() {
  return adminApiClient.Get<AboutAdminSnapshot, unknown>("/api/admin/about", {
    meta: withBackofficeAuth(),
    transform: (payload) => aboutAdminSnapshotSchema.parse(payload),
  })
}

export function updateAdminAboutPageContent(
  content: AboutPageContent,
  revision: string | null
) {
  return adminApiClient.Put<z.infer<typeof aboutAdminUpdateSchema>, unknown>(
    "/api/admin/about",
    { content, revision },
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.about,
      transform: (payload) => aboutAdminUpdateSchema.parse(payload),
    }
  )
}

export function uploadAboutHeroImage(file: File) {
  const form = new FormData()
  form.append("image", file)
  return adminApiClient.Post<
    z.infer<typeof aboutImageUploadSchema>,
    unknown
  >("/api/admin/about/hero-image", form, {
    meta: withBackofficeCsrf(),
    name: PUBLIC_CACHE_INVALIDATION_SOURCE.about,
    transform: (payload) => aboutImageUploadSchema.parse(payload),
  })
}

export function uploadAboutMemberAvatar(file: File) {
  const form = new FormData()
  form.append("image", file)
  return adminApiClient.Post<z.infer<typeof aboutImageUploadSchema>, unknown>(
    "/api/admin/about/member-avatar",
    form,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.about,
      transform: (payload) => aboutImageUploadSchema.parse(payload),
    }
  )
}

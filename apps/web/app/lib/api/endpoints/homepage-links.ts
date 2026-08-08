import { z } from "zod"

import { adminApiClient } from "../admin-client"
import {
  PUBLIC_CACHE_INVALIDATION_SOURCE,
  STABLE_CONTENT_CACHE_FOR,
} from "../cache-policy"
import { apiClient } from "../client"
import { withBackofficeAuth, withBackofficeCsrf } from "../types"

export const homepageLinkSectionSchema = z.enum([
  "navigation",
  "friend",
  "support",
])
export const homepageLinkIconSchema = z.enum([
  "calendar",
  "book-open",
  "radio-tower",
  "contact",
  "library",
  "id-card",
  "map",
  "gamepad",
  "history",
  "info",
  "external-link",
])
export const homepageLinkAccentSchema = z.enum([
  "franchise-765",
  "franchise-cg",
  "franchise-ml",
  "franchise-sidem",
  "franchise-sc",
  "franchise-gk",
  "primary",
  "info",
  "success",
  "warning",
])

export const homepageLinkSchema = z.object({
  id: z.string().min(1),
  section: homepageLinkSectionSchema,
  title: z.string().min(1).max(80),
  description: z.string().max(200),
  href: z.string().min(1).max(2048),
  icon: homepageLinkIconSchema,
  accent: homepageLinkAccentSchema,
  displayOrder: z.number().int().nonnegative(),
})

export const homepageLinksSchema = z.object({
  sections: z.object({
    navigation: z.array(homepageLinkSchema),
    friend: z.array(homepageLinkSchema),
    support: z.array(homepageLinkSchema),
  }),
})

export type HomepageLink = z.infer<typeof homepageLinkSchema>
export type HomepageLinks = z.infer<typeof homepageLinksSchema>
export type HomepageLinkSection = z.infer<typeof homepageLinkSectionSchema>
export type HomepageLinkIcon = z.infer<typeof homepageLinkIconSchema>
export type HomepageLinkAccent = z.infer<typeof homepageLinkAccentSchema>
export type HomepageLinkSubmission = Omit<HomepageLink, "id" | "displayOrder">

export const emptyHomepageLinks: HomepageLinks = {
  sections: { navigation: [], friend: [], support: [] },
}

export function getHomepageLinks() {
  return apiClient.Get<HomepageLinks, unknown>("/api/homepage-links", {
    cacheFor: STABLE_CONTENT_CACHE_FOR,
    hitSource: PUBLIC_CACHE_INVALIDATION_SOURCE.homepageLinks,
    transform: (payload) => homepageLinksSchema.parse(payload),
  })
}

export function getAdminHomepageLinks() {
  return adminApiClient.Get<HomepageLinks, unknown>(
    "/api/admin/homepage-links",
    {
      meta: withBackofficeAuth(),
      transform: (payload) => homepageLinksSchema.parse(payload),
    }
  )
}

export function createHomepageLink(submission: HomepageLinkSubmission) {
  return adminApiClient.Post<{ success: true; link: HomepageLink }, unknown>(
    "/api/admin/homepage-links",
    submission,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.homepageLinks,
    }
  )
}

export function updateHomepageLink(
  id: string,
  submission: Omit<HomepageLinkSubmission, "section">
) {
  return adminApiClient.Put<{ success: true; link: HomepageLink }, unknown>(
    `/api/admin/homepage-links/${encodeURIComponent(id)}`,
    submission,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.homepageLinks,
    }
  )
}

export function deleteHomepageLink(id: string) {
  return adminApiClient.Delete<{ success: true }, unknown>(
    `/api/admin/homepage-links/${encodeURIComponent(id)}`,
    undefined,
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.homepageLinks,
    }
  )
}

export function reorderHomepageLinks(
  section: HomepageLinkSection,
  ids: string[]
) {
  return adminApiClient.Put<{ success: true }, unknown>(
    `/api/admin/homepage-links/${section}/order`,
    { ids },
    {
      meta: withBackofficeCsrf(),
      name: PUBLIC_CACHE_INVALIDATION_SOURCE.homepageLinks,
    }
  )
}

import { z } from "zod"

import { adminApiClient } from "../admin-client"
import { withBackofficeAuth, withBackofficeCsrf } from "../types"

const timestampSchema = z.string().datetime({ offset: true })
const reviewStateSchema = z.enum(["pending", "published", "rejected"])
const revisionSchema = z.number().int().safe().nonnegative()
const regionalCoordinateSchema = (minimum: number, maximum: number) =>
  z
    .number()
    .finite()
    .min(minimum)
    .max(maximum)
    .refine(
      (value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-8,
      "regional coordinates must use the 0.1 degree grid"
    )

const regionalLocationSchema = z
  .object({
    latitude: regionalCoordinateSchema(-60, 60),
    longitude: regionalCoordinateSchema(-180, 180),
    precision: z.literal("regional"),
  })
  .strict()

export const fudabaLocationReviewSchema = z
  .object({
    officeId: z.string().min(1).max(128),
    officeName: z.string().trim().min(1),
    city: z.string().trim().min(1),
    ownerAccountId: z.string().min(1),
    location: regionalLocationSchema,
    reviewState: reviewStateSchema,
    revision: revisionSchema,
    submittedAt: timestampSchema,
    reviewedAt: timestampSchema.nullable(),
    reviewedBy: z.number().int().positive().nullable(),
    reviewNote: z.string().max(1000),
  })
  .strict()

export const fudabaLocationReviewListSchema = z
  .object({
    items: z.array(fudabaLocationReviewSchema),
  })
  .strict()

const fudabaReviewedLocationSchema = z
  .object({
    officeId: z.string().min(1).max(128),
    location: regionalLocationSchema,
    reviewState: reviewStateSchema,
    revision: revisionSchema,
    submittedAt: timestampSchema,
    reviewedAt: timestampSchema.nullable(),
    reviewNote: z.string().max(1000),
  })
  .strict()

export const fudabaLocationReviewMutationSchema = z
  .object({
    success: z.literal(true),
    officeLocation: fudabaReviewedLocationSchema,
  })
  .strict()

export type FudabaLocationReviewState = z.infer<typeof reviewStateSchema>
export type FudabaLocationReview = z.infer<typeof fudabaLocationReviewSchema>
export type FudabaLocationReviewDecision = "publish" | "reject"

export function getFudabaLocationReviews(
  state: FudabaLocationReviewState,
  limit = 50
) {
  const query = new URLSearchParams({
    state,
    limit: String(limit),
  })
  return adminApiClient.Get<
    z.infer<typeof fudabaLocationReviewListSchema>,
    unknown
  >(`/api/admin/community/exchange/office-locations?${query}`, {
    meta: withBackofficeAuth(),
    transform: (payload) => fudabaLocationReviewListSchema.parse(payload),
  })
}

export function reviewFudabaLocation(
  officeId: string,
  input: {
    decision: FudabaLocationReviewDecision
    expectedRevision: number
    note: string
  }
) {
  return adminApiClient.Put<
    z.infer<typeof fudabaLocationReviewMutationSchema>,
    unknown
  >(
    `/api/admin/community/exchange/office-locations/${encodeURIComponent(officeId)}`,
    input,
    {
      meta: withBackofficeCsrf(),
      transform: (payload) => fudabaLocationReviewMutationSchema.parse(payload),
    }
  )
}

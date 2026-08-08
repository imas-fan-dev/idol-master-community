import {
  fudabaOfficeFieldsSchema,
  fudabaOwnerLocationSubmissionSchema,
  isApiError,
  type FudabaOfficeFields,
  type FudabaOwnerLocation,
  type FudabaOwnerOffice,
  type FudabaSeries,
} from "~/lib/api"

export type OfficeDraft = {
  name: string
  intro: string
  city: string
  address: string
  latitude: string
  longitude: string
  accent: string
  isOpen: boolean
  seriesCodes: string[]
}

export type PublicLocationDraft = {
  latitude: string
  longitude: string
}

export type WorkspaceFeedback = {
  kind: "success" | "error" | "conflict"
  message: string
}

export const officeStatusLabels: Record<FudabaOwnerOffice["status"], string> = {
  active: "正常开放",
  hidden: "已隐藏",
  archived: "已归档",
}

export const locationReviewLabels: Record<
  FudabaOwnerLocation["reviewState"],
  string
> = {
  pending: "审核中",
  published: "已公开",
  rejected: "已驳回",
}

function numericInput(value: string) {
  return value.trim() ? Number(value) : Number.NaN
}

export function emptyOfficeDraft(
  homeCity: string | null,
  series: FudabaSeries[]
): OfficeDraft {
  return {
    name: "",
    intro: "",
    city: homeCity ?? "",
    address: "",
    latitude: "",
    longitude: "",
    accent: "#2581c7",
    isOpen: true,
    seriesCodes: series[0] ? [series[0].code] : [],
  }
}

export function officeDraft(office: FudabaOwnerOffice): OfficeDraft {
  return {
    name: office.name,
    intro: office.intro,
    city: office.city,
    address: office.address,
    latitude: String(office.location.latitude),
    longitude: String(office.location.longitude),
    accent: office.accent,
    isOpen: office.isOpen,
    seriesCodes: office.seriesCodes,
  }
}

export function parseOfficeDraft(draft: OfficeDraft) {
  return fudabaOfficeFieldsSchema.safeParse({
    name: draft.name,
    intro: draft.intro,
    city: draft.city,
    address: draft.address,
    latitude: numericInput(draft.latitude),
    longitude: numericInput(draft.longitude),
    accent: draft.accent,
    isOpen: draft.isOpen,
    seriesCodes: draft.seriesCodes,
  } satisfies FudabaOfficeFields)
}

export function publicLocationDraft(
  location: FudabaOwnerLocation | null
): PublicLocationDraft {
  return location
    ? {
        latitude: location.location.latitude.toFixed(1),
        longitude: location.location.longitude.toFixed(1),
      }
    : { latitude: "", longitude: "" }
}

export function parsePublicLocationDraft(
  draft: PublicLocationDraft,
  expectedRevision: number | null
) {
  return fudabaOwnerLocationSubmissionSchema.safeParse({
    latitude: numericInput(draft.latitude),
    longitude: numericInput(draft.longitude),
    expectedRevision,
  })
}

export function isOfficeConflict(error: unknown) {
  return (
    isApiError(error) &&
    error.status === 409 &&
    (error.code === "FUDABA_OFFICE_CONFLICT" ||
      error.code === "FUDABA_OFFICE_STATE_CONFLICT")
  )
}

export function isLocationConflict(error: unknown) {
  return (
    isApiError(error) &&
    error.status === 409 &&
    error.code === "FUDABA_OFFICE_LOCATION_CONFLICT"
  )
}

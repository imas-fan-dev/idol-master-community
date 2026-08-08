import {
  isApiError,
  type FudabaCardFields,
  type FudabaOwnerCard,
  type FudabaSeries,
  type PlatformProfile,
} from "~/lib/api"

export type EditorFeedback = {
  kind: "success" | "error" | "conflict"
  message: string
}

export const mediaRightsLabels: Record<
  FudabaOwnerCard["mediaRightsStatus"],
  string
> = {
  unknown: "素材授权待确认",
  approved: "素材已核准",
  denied: "素材未授权",
}

export const publicationLabels: Record<
  FudabaOwnerCard["publicationStatus"],
  string
> = {
  draft: "草稿",
  pending: "审核中",
  published: "已公开",
  hidden: "已隐藏",
  rejected: "已驳回",
}

export function profileFields(profile: PlatformProfile) {
  return {
    displayName: profile.displayName,
    homeCity: profile.homeCity ?? "",
    bio: profile.bio,
  }
}

export function cardFields(card: FudabaOwnerCard): FudabaCardFields {
  return {
    producerName: card.producerName,
    displayName: card.displayName,
    seriesCode: card.seriesCode,
    favoriteIdol: card.favoriteIdol,
    accent: card.accent,
    bio: card.bio,
    tradeNote: card.tradeNote,
    available: card.available,
  }
}

export function emptyCardFields(
  profile: PlatformProfile,
  series: FudabaSeries[]
): FudabaCardFields {
  return {
    producerName: profile.displayName,
    displayName: "",
    seriesCode: series[0]?.code ?? "",
    favoriteIdol: "",
    accent: "#f34e6c",
    bio: profile.bio,
    tradeNote: "",
    available: true,
  }
}

export function apiMessage(error: unknown, fallback: string) {
  return isApiError(error) && error.message ? error.message : fallback
}

export function isFeatureClosed(error: unknown) {
  return (
    isApiError(error) && error.status === 404 && error.payload === "Not Found"
  )
}

export function isProfileConflict(error: unknown) {
  return (
    isApiError(error) &&
    error.status === 409 &&
    error.code === "PLATFORM_PROFILE_CONFLICT"
  )
}

export function isCardConflict(error: unknown) {
  return (
    isApiError(error) &&
    error.status === 409 &&
    error.code === "FUDABA_CARD_CONFLICT"
  )
}

export function validateImage(file: File, maximumBytes: number) {
  if (!file.type.startsWith("image/")) return "请选择图片文件。"
  if (file.size > maximumBytes) {
    return `图片不能超过 ${Math.floor(maximumBytes / 1024 / 1024)} MiB。`
  }
  return null
}

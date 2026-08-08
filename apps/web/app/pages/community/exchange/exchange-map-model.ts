import type { FudabaMapBounds, FudabaMapOffice, FudabaSeries } from "~/lib/api"

export interface MapViewportBounds {
  west: number
  south: number
  east: number
  north: number
}

export interface FudabaMapOfficeGroup {
  key: string
  latitude: number
  longitude: number
  offices: FudabaMapOffice[]
  colors: string[]
}

const openFreeMapOrigin = "https://tiles.openfreemap.org"

export function resolveAllowedMapResourceUrl(
  value: string,
  siteOrigin: string
) {
  const currentSite = new URL(siteOrigin)
  const resource = new URL(value, currentSite)
  const isHttp = ["http:", "https:"].includes(resource.protocol)
  const isCurrentOrigin = isHttp && resource.origin === currentSite.origin
  const isOpenFreeMap =
    resource.protocol === "https:" &&
    resource.hostname === "tiles.openfreemap.org" &&
    resource.port === "" &&
    resource.origin === openFreeMapOrigin

  if (
    (!isCurrentOrigin && !isOpenFreeMap) ||
    resource.username ||
    resource.password
  ) {
    throw new Error("地图资源仅允许当前站点或 OpenFreeMap 官方 HTTPS 地址")
  }
  return resource.href
}

function normalizeLongitude(longitude: number) {
  const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180
  return Object.is(normalized, -0) ? 0 : normalized
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

function stableCoordinate(value: number) {
  return Number(value.toFixed(6))
}

export function splitViewportBounds({
  west,
  south,
  east,
  north,
}: MapViewportBounds): FudabaMapBounds[] {
  if (![west, south, east, north].every(Number.isFinite)) return []

  const boundedSouth = stableCoordinate(clamp(south, -90, 90))
  const boundedNorth = stableCoordinate(clamp(north, -90, 90))
  if (boundedSouth >= boundedNorth) return []

  const span = east >= west ? east - west : east - west + 360
  if (span >= 360) {
    return [[-180, boundedSouth, 180, boundedNorth]]
  }

  const boundedWest = stableCoordinate(normalizeLongitude(west))
  let boundedEast = stableCoordinate(normalizeLongitude(east))
  if (boundedEast === -180 && east > west) boundedEast = 180

  if (boundedWest < boundedEast) {
    return [[boundedWest, boundedSouth, boundedEast, boundedNorth]]
  }
  if (boundedWest === boundedEast) return []

  const splitBounds: FudabaMapBounds[] = [
    [boundedWest, boundedSouth, 180, boundedNorth],
    [-180, boundedSouth, boundedEast, boundedNorth],
  ]
  return splitBounds.filter(
    ([requestWest, , requestEast]) => requestWest < requestEast
  )
}

export function mergeMapOfficeResponses(
  responses: ReadonlyArray<{
    items: FudabaMapOffice[]
    truncated: boolean
  }>
) {
  const offices = new Map<string, FudabaMapOffice>()
  let truncated = false

  for (const response of responses) {
    truncated ||= response.truncated
    for (const office of response.items) offices.set(office.id, office)
  }

  return { items: [...offices.values()], truncated }
}

export function groupMapOffices(
  offices: readonly FudabaMapOffice[],
  series: readonly FudabaSeries[] = []
): FudabaMapOfficeGroup[] {
  const groups = new Map<string, FudabaMapOfficeGroup>()
  const seriesColors = new Map(series.map((item) => [item.code, item.color]))

  for (const office of offices) {
    const { latitude, longitude } = office.location
    const key = `${latitude.toFixed(1)},${longitude.toFixed(1)}`
    const group = groups.get(key) ?? {
      key,
      latitude,
      longitude,
      offices: [],
      colors: [],
    }
    group.offices.push(office)

    for (const seriesCode of office.seriesCodes) {
      const color = seriesColors.get(seriesCode)
      if (color && !group.colors.includes(color)) group.colors.push(color)
    }
    if (!group.colors.length && !group.colors.includes(office.accent)) {
      group.colors.push(office.accent)
    }
    groups.set(key, group)
  }

  return [...groups.values()]
}

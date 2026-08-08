import "maplibre-gl/dist/maplibre-gl.css"

import {
  AttributionControl,
  GeoJSONSource,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl"
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url"
import { useEffect, useRef } from "react"

import type { FudabaMapOfficeGroup } from "./exchange-map-model"
import {
  resolveAllowedMapResourceUrl,
  splitViewportBounds,
  type MapViewportBounds,
} from "./exchange-map-model"

const officeSourceId = "fudaba-regional-offices"
const officeSourceLayerId = "fudaba-regional-offices-hit-area"
type PaintPropertyName = Parameters<MapLibreMap["setPaintProperty"]>[1]
type PaintPropertyValue = Parameters<MapLibreMap["setPaintProperty"]>[2]

const portalMapLayerPaint: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  background: { "background-color": "#edf3f8" },
  "landcover-glacier": { "fill-color": "#f9fbfd" },
  "landuse-residential": { "fill-color": "#f5f8fb" },
  "landuse-suburb": { "fill-color": "#f3f7fa" },
  "landuse-commercial": { "fill-color": "#f6f2f7" },
  "landuse-industrial": { "fill-color": "#f0f2f7" },
  "landuse-cemetery": { "fill-color": "#e2efe9" },
  "landuse-hospital": { "fill-color": "#f8eef3" },
  "landuse-school": { "fill-color": "#f7f4e8" },
  "landuse-railway": { "fill-color": "#edf1f5" },
  park: { "fill-color": "#e0f0e7", "fill-opacity": 0.86 },
  "landcover-wood": { "fill-color": "#d9ece3", "fill-opacity": 0.78 },
  "landcover-grass": { "fill-color": "#e4f2e9", "fill-opacity": 0.9 },
  "landcover-grass-park": {
    "fill-color": "#deeee5",
    "fill-opacity": 0.9,
  },
  "landcover-sand": { "fill-color": "#f5efd9" },
  water: { "fill-color": "#d9ecf8" },
  "water-intermittent": { "fill-color": "#e5f3fb" },
  building: {
    "fill-color": "#e9eef4",
    "fill-outline-color": "#dbe4ed",
  },
  "building-top": {
    "fill-color": "#eef2f6",
    "fill-outline-color": "#dde6ef",
  },
  boundary_2: { "line-color": "#afbed0", "line-opacity": 0.68 },
  boundary_3: { "line-color": "#c5d1df", "line-opacity": 0.58 },
  boundary_disputed: {
    "line-color": "#b7c3d1",
    "line-opacity": 0.54,
  },
}

const waterwayLayerIds = [
  "waterway_tunnel",
  "waterway-other",
  "waterway-other-intermittent",
  "waterway-stream-canal",
  "waterway-stream-canal-intermittent",
  "waterway-river",
  "waterway-river-intermittent",
  "ferry",
]

const minorRoadLayerIds = [
  "tunnel-service-track",
  "tunnel-link",
  "tunnel-minor",
  "highway-path",
  "highway-link",
  "highway-minor",
  "bridge-path",
  "bridge-link",
  "bridge-minor",
]

const collectorRoadLayerIds = [
  "tunnel-secondary-tertiary",
  "highway-secondary-tertiary",
  "bridge-secondary-tertiary",
]

const arterialRoadLayerIds = [
  "tunnel-trunk-primary",
  "highway-primary",
  "highway-trunk",
  "bridge-trunk-primary",
]

const motorwayLayerIds = [
  "tunnel-motorway-link",
  "tunnel-motorway",
  "highway-motorway-link",
  "highway-motorway",
  "bridge-motorway-link",
  "bridge-motorway",
]

const roadCasingLayerIds = [
  "tunnel-service-track-casing",
  "tunnel-motorway-link-casing",
  "tunnel-minor-casing",
  "tunnel-link-casing",
  "tunnel-secondary-tertiary-casing",
  "tunnel-trunk-primary-casing",
  "tunnel-motorway-casing",
  "highway-motorway-link-casing",
  "highway-link-casing",
  "highway-minor-casing",
  "highway-secondary-tertiary-casing",
  "highway-primary-casing",
  "highway-trunk-casing",
  "highway-motorway-casing",
  "bridge-motorway-link-casing",
  "bridge-link-casing",
  "bridge-secondary-tertiary-casing",
  "bridge-trunk-primary-casing",
  "bridge-motorway-casing",
  "bridge-minor-casing",
  "bridge-path-casing",
]

const labelLayerIds = [
  "waterway_line_label",
  "water_name_point_label",
  "water_name_line_label",
  "poi_r20",
  "poi_r7",
  "poi_r1",
  "poi_transit",
  "highway-name-path",
  "highway-name-minor",
  "highway-name-major",
  "airport",
  "label_other",
  "label_village",
  "label_town",
  "label_state",
  "label_city",
  "label_city_capital",
  "label_country_3",
  "label_country_2",
  "label_country_1",
]

setWorkerUrl(maplibreWorkerUrl)

interface RenderedMarker {
  marker: Marker
  signature: string
}

export interface ExchangeOfficeMapProps {
  styleUrl: string
  groups: FudabaMapOfficeGroup[]
  selectedGroupKey: string | null
  onSelectGroup: (groupKey: string) => void
  onViewportChange: (bounds: ReturnType<typeof splitViewportBounds>) => void
  onFatalError: (error: Error) => void
}

function mapError(error: unknown) {
  return error instanceof Error ? error : new Error("地图渲染失败")
}

function featureCollection(groups: readonly FudabaMapOfficeGroup[]) {
  return {
    type: "FeatureCollection" as const,
    features: groups.map((group) => ({
      type: "Feature" as const,
      id: group.key,
      geometry: {
        type: "Point" as const,
        coordinates: [group.longitude, group.latitude],
      },
      properties: {
        groupKey: group.key,
        officeCount: group.offices.length,
        accent: group.offices[0]?.accent ?? "#f34e6c",
      },
    })),
  }
}

function createClusterMarker(count: number) {
  const marker = document.createElement("button")
  marker.type = "button"
  marker.className =
    "z-1 flex size-11 items-center justify-center rounded-full border-2 border-background bg-primary text-sm font-semibold text-primary-foreground shadow-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
  marker.setAttribute("aria-label", `${count} 个区域点，放大查看`)
  marker.textContent = String(count)
  return marker
}

function createOfficeGroupMarker(
  group: FudabaMapOfficeGroup,
  selected: boolean
) {
  const marker = document.createElement("button")
  marker.type = "button"
  marker.className =
    "z-1 flex h-11 min-w-11 items-center justify-center overflow-hidden rounded-lg border-2 border-background bg-background px-2 text-sm font-semibold text-foreground shadow-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
  marker.dataset.mapOfficeGroup = group.key
  marker.setAttribute("aria-pressed", String(selected))
  marker.setAttribute(
    "aria-label",
    `${group.offices.map((office) => office.name).join("、")}，${group.offices.length} 个事务所`
  )
  if (selected) marker.classList.add("ring-3", "ring-primary/60")

  const count = document.createElement("span")
  count.textContent = String(group.offices.length)
  marker.append(count)

  const strip = document.createElement("span")
  strip.className = "absolute inset-x-0 bottom-0 flex h-1"
  strip.setAttribute("aria-hidden", "true")
  for (const color of group.colors.slice(0, 6)) {
    const segment = document.createElement("span")
    segment.className = "h-full flex-1"
    segment.style.backgroundColor = color
    strip.append(segment)
  }
  marker.append(strip)
  return marker
}

function currentViewport(map: MapLibreMap): MapViewportBounds {
  const bounds = map.getBounds()
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  }
}

function setPaintProperties(
  map: MapLibreMap,
  layerId: string,
  paint: Readonly<Record<string, unknown>>
) {
  if (!map.getLayer(layerId)) return
  for (const [property, value] of Object.entries(paint)) {
    map.setPaintProperty(
      layerId,
      property as PaintPropertyName,
      value as PaintPropertyValue
    )
  }
}

function applyPortalMapPalette(map: MapLibreMap) {
  for (const [layerId, paint] of Object.entries(portalMapLayerPaint)) {
    setPaintProperties(map, layerId, paint)
  }

  for (const layerId of waterwayLayerIds) {
    setPaintProperties(map, layerId, {
      "line-color": "#a8d6ed",
      "line-opacity": 0.84,
    })
  }
  for (const layerId of roadCasingLayerIds) {
    setPaintProperties(map, layerId, {
      "line-color": "#c7d4e2",
      "line-opacity": 0.58,
    })
  }
  for (const layerId of minorRoadLayerIds) {
    setPaintProperties(map, layerId, {
      "line-color": "#ffffff",
      "line-opacity": 0.88,
    })
  }
  for (const layerId of collectorRoadLayerIds) {
    setPaintProperties(map, layerId, {
      "line-color": "#edf3f9",
      "line-opacity": 0.94,
    })
  }
  for (const layerId of arterialRoadLayerIds) {
    setPaintProperties(map, layerId, {
      "line-color": "#d6dff0",
      "line-opacity": 0.96,
    })
  }
  for (const layerId of motorwayLayerIds) {
    setPaintProperties(map, layerId, {
      "line-color": "#adcbea",
      "line-opacity": 0.96,
    })
  }
  for (const layerId of [
    "railway-transit",
    "railway-service",
    "railway",
    "bridge-railway",
    "tunnel-railway",
  ]) {
    setPaintProperties(map, layerId, {
      "line-color": "#bdc8d5",
      "line-opacity": 0.5,
    })
  }
  for (const layerId of labelLayerIds) {
    setPaintProperties(map, layerId, {
      "text-color": "#687489",
      "text-halo-color": "#f7faff",
      "text-halo-width": 1.35,
      "text-opacity": 0.86,
    })
  }
  for (const layerId of ["poi_r20", "poi_r7", "poi_r1", "poi_transit"]) {
    setPaintProperties(map, layerId, { "text-opacity": 0.56 })
  }
  for (const layerId of [
    "highway-name-path",
    "highway-name-minor",
    "highway-name-major",
  ]) {
    setPaintProperties(map, layerId, { "text-opacity": 0.66 })
  }
  for (const layerId of [
    "label_city",
    "label_city_capital",
    "label_country_1",
    "label_country_2",
    "label_country_3",
  ]) {
    setPaintProperties(map, layerId, {
      "text-color": "#3d485b",
      "text-halo-color": "#f7faff",
      "text-halo-width": 1.6,
      "text-opacity": 0.94,
    })
  }
  for (const layerId of [
    "water_name_point_label",
    "water_name_line_label",
    "waterway_line_label",
  ]) {
    setPaintProperties(map, layerId, {
      "text-color": "#5b89a5",
      "text-halo-color": "#e8f5fb",
      "text-halo-width": 1.2,
      "text-opacity": 0.88,
    })
  }
}

export function ExchangeOfficeMap({
  styleUrl,
  groups,
  selectedGroupKey,
  onSelectGroup,
  onViewportChange,
  onFatalError,
}: ExchangeOfficeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markersRef = useRef(new Map<string, RenderedMarker>())
  const groupsRef = useRef(groups)
  const selectedGroupKeyRef = useRef(selectedGroupKey)
  const onSelectGroupRef = useRef(onSelectGroup)
  const onViewportChangeRef = useRef(onViewportChange)
  const onFatalErrorRef = useRef(onFatalError)
  const refreshMarkersRef = useRef<() => void>(() => undefined)
  const fatalErrorSentRef = useRef(false)

  useEffect(() => {
    groupsRef.current = groups
    selectedGroupKeyRef.current = selectedGroupKey
    onSelectGroupRef.current = onSelectGroup
    onViewportChangeRef.current = onViewportChange
    onFatalErrorRef.current = onFatalError
  }, [groups, onFatalError, onSelectGroup, onViewportChange, selectedGroupKey])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const webglProbe = document.createElement("canvas")
    if (!webglProbe.getContext("webgl2")) {
      onFatalErrorRef.current(new Error("当前浏览器不支持 WebGL 2 地图"))
      return
    }

    let map: MapLibreMap
    const reportFatalError = (error: unknown) => {
      if (fatalErrorSentRef.current) return
      fatalErrorSentRef.current = true
      onFatalErrorRef.current(mapError(error))
    }

    try {
      map = new MapLibreMap({
        container,
        style: styleUrl,
        center: [127.1, 31.2],
        zoom: 4.05,
        minZoom: 2.3,
        maxZoom: 17,
        bearing: 0,
        pitch: 0,
        roll: 0,
        minPitch: 0,
        maxPitch: 0,
        dragRotate: false,
        touchPitch: false,
        pitchWithRotate: false,
        rollEnabled: false,
        attributionControl: false,
        cooperativeGestures: true,
        transformRequest: (url) => ({
          url: resolveAllowedMapResourceUrl(url, window.location.origin),
        }),
      })
    } catch (error) {
      reportFatalError(error)
      return
    }

    mapRef.current = map
    map.touchZoomRotate.disableRotation()
    map.keyboard.disableRotation()
    map.addControl(new AttributionControl({ compact: false }), "bottom-left")
    map.addControl(
      new NavigationControl({ showCompass: false, showZoom: true }),
      "bottom-right"
    )

    const clearMarkers = () => {
      for (const { marker } of markersRef.current.values()) marker.remove()
      markersRef.current.clear()
    }

    const refreshMarkers = () => {
      const source = map.getSource(officeSourceId)
      if (!(source instanceof GeoJSONSource)) return

      const groupsByKey = new Map(
        groupsRef.current.map((group) => [group.key, group])
      )
      const seen = new Set<string>()

      for (const feature of map.querySourceFeatures(officeSourceId)) {
        if (feature.geometry.type !== "Point") continue
        const [longitude, latitude] = feature.geometry.coordinates
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue

        const isCluster = Boolean(feature.properties?.cluster)
        if (isCluster) {
          const clusterId = Number(feature.properties?.cluster_id)
          const count = Number(
            feature.properties?.officeCount ?? feature.properties?.point_count
          )
          const key = `cluster:${clusterId}`
          if (!Number.isInteger(clusterId) || seen.has(key)) continue
          seen.add(key)

          const signature = `cluster:${count}`
          let rendered = markersRef.current.get(key)
          if (!rendered || rendered.signature !== signature) {
            rendered?.marker.remove()
            const element = createClusterMarker(count)
            element.addEventListener("click", () => {
              void source.getClusterExpansionZoom(clusterId).then((zoom) => {
                map.easeTo({ center: [longitude, latitude], zoom })
              })
            })
            rendered = {
              marker: new Marker({ element, anchor: "bottom" })
                .setLngLat([longitude, latitude])
                .addTo(map),
              signature,
            }
            markersRef.current.set(key, rendered)
          }
          rendered.marker.setLngLat([longitude, latitude])
          continue
        }

        const groupKey = String(feature.properties?.groupKey ?? "")
        const group = groupsByKey.get(groupKey)
        if (!group || seen.has(groupKey)) continue
        seen.add(groupKey)
        const signature = JSON.stringify({
          offices: group.offices.map(({ id, name }) => [id, name]),
          colors: group.colors,
        })
        let rendered = markersRef.current.get(groupKey)
        if (!rendered || rendered.signature !== signature) {
          rendered?.marker.remove()
          const element = createOfficeGroupMarker(
            group,
            selectedGroupKeyRef.current === groupKey
          )
          element.addEventListener("click", () =>
            onSelectGroupRef.current(groupKey)
          )
          rendered = {
            marker: new Marker({ element, anchor: "bottom" })
              .setLngLat([group.longitude, group.latitude])
              .addTo(map),
            signature,
          }
          markersRef.current.set(groupKey, rendered)
        }
        rendered.marker.setLngLat([group.longitude, group.latitude])
      }

      for (const [key, { marker }] of markersRef.current) {
        if (seen.has(key)) continue
        marker.remove()
        markersRef.current.delete(key)
      }
    }
    refreshMarkersRef.current = refreshMarkers

    const queryViewport = () => {
      const bounds = splitViewportBounds(currentViewport(map))
      if (bounds.length) onViewportChangeRef.current(bounds)
    }

    const handleLoad = () => {
      const canvas = map.getCanvas()
      canvas.setAttribute(
        "aria-label",
        "区域事务所地图。使用方向键移动地图，使用加减按钮缩放。"
      )
      applyPortalMapPalette(map)
      map.addSource(officeSourceId, {
        type: "geojson",
        data: featureCollection(groupsRef.current),
        cluster: true,
        clusterRadius: 56,
        clusterMaxZoom: 10,
        clusterProperties: {
          officeCount: ["+", ["get", "officeCount"]],
        },
      })
      map.addLayer({
        id: officeSourceLayerId,
        type: "circle",
        source: officeSourceId,
        paint: {
          "circle-color": ["coalesce", ["get", "accent"], "#f34e6c"],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 2, 8, 10, 12],
          "circle-opacity": 0.24,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": 0.9,
          "circle-stroke-width": 2,
        },
      })
      queryViewport()
      map.once("idle", refreshMarkers)
    }

    const handleMoveEnd = () => {
      queryViewport()
      map.once("idle", refreshMarkers)
    }
    const handleError = (event: { error: Error }) =>
      reportFatalError(event.error)

    map.on("load", handleLoad)
    map.on("moveend", handleMoveEnd)
    map.on("error", handleError)

    let resizeFrame: number | null = null
    const resizeMap = () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null
        map.resize()
      })
    }
    const resizeObserver = new ResizeObserver(resizeMap)
    resizeObserver.observe(container)
    window.addEventListener("resize", resizeMap, { passive: true })
    window.visualViewport?.addEventListener("resize", resizeMap, {
      passive: true,
    })
    resizeMap()

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener("resize", resizeMap)
      window.visualViewport?.removeEventListener("resize", resizeMap)
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      clearMarkers()
      map.off("load", handleLoad)
      map.off("moveend", handleMoveEnd)
      map.off("error", handleError)
      map.remove()
      mapRef.current = null
      refreshMarkersRef.current = () => undefined
    }
  }, [styleUrl])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource(officeSourceId)
    if (!map || !(source instanceof GeoJSONSource)) return
    source.setData(featureCollection(groups))
    map.once("idle", () => refreshMarkersRef.current())
  }, [groups])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    for (const { marker } of markersRef.current.values()) {
      const element = marker.getElement()
      const groupKey = element.dataset.mapOfficeGroup
      if (!groupKey) continue
      const selected = groupKey === selectedGroupKey
      element.setAttribute("aria-pressed", String(selected))
      element.classList.toggle("ring-3", selected)
      element.classList.toggle("ring-primary/60", selected)
    }
  }, [selectedGroupKey])

  return (
    <div
      ref={containerRef}
      className="size-full min-h-0 bg-[#e8f2f4]"
      aria-label="区域事务所地图工作面"
    />
  )
}

import {
  Building2Icon,
  LoaderCircleIcon,
  MapIcon,
  MapPinOffIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react"
import { Link } from "react-router"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button, buttonVariants } from "~/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet"
import {
  getFudabaMapConfig,
  getFudabaMapOffices,
  type FudabaMapBounds,
  type FudabaMapOffice,
  type FudabaSeries,
} from "~/lib/api"
import { cn } from "~/lib/utils"
import {
  groupMapOffices,
  mergeMapOfficeResponses,
  type FudabaMapOfficeGroup,
} from "./exchange-map-model"
import type { ExchangeOfficeMapProps } from "./exchange-office-map"

type MapComponent = ComponentType<ExchangeOfficeMapProps>
type ConfigState =
  | { phase: "loading"; styleUrl: null; error: null }
  | { phase: "ready"; styleUrl: string; error: null }
  | { phase: "error"; styleUrl: null; error: string }

interface MapDataState {
  phase: "idle" | "loading" | "ready" | "error"
  items: FudabaMapOffice[]
  truncated: boolean
  error: string | null
}

const initialConfigState: ConfigState = {
  phase: "loading",
  styleUrl: null,
  error: null,
}

const initialDataState: MapDataState = {
  phase: "idle",
  items: [],
  truncated: false,
  error: null,
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function useNarrowMapLayout() {
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    if (!window.matchMedia) return
    const media = window.matchMedia("(max-width: 1023px)")
    const update = () => setIsNarrow(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  return isNarrow
}

function OfficeStatus({ open }: { open: boolean }) {
  return (
    <Badge variant={open ? "secondary" : "outline"}>
      {open ? "开放交换" : "暂未开放"}
    </Badge>
  )
}

function OfficeGroupDetails({ group }: { group: FudabaMapOfficeGroup }) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">
          约 0.1° 区域位置
        </p>
        <h3 className="mt-1 text-base font-semibold">
          {group.offices.length} 个交换事务所
        </h3>
      </div>
      <div className="divide-y border-y">
        {group.offices.map((office) => (
          <article
            key={office.id}
            className="border-l-2 py-4 pl-3 first:pt-3 last:pb-3"
            style={{ borderLeftColor: office.accent }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="font-medium wrap-break-word">{office.name}</h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  {office.city}
                </p>
              </div>
              <OfficeStatus open={office.isOpen} />
            </div>
            <Link
              to={`/community/exchange/offices/${encodeURIComponent(office.slug)}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "mt-3"
              )}
            >
              查看事务所
            </Link>
          </article>
        ))}
      </div>
    </div>
  )
}

function MapUnavailable({
  message,
  onRetry,
  onSwitchDirectory,
}: {
  message: string
  onRetry: () => void
  onSwitchDirectory: () => void
}) {
  return (
    <Empty className="absolute inset-0 bg-[#e8f2f4] px-5">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MapPinOffIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>地图暂时不可用</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" onClick={onRetry}>
          <RefreshCwIcon aria-hidden="true" />
          重试地图
        </Button>
        <Button type="button" onClick={onSwitchDirectory}>
          <Building2Icon aria-hidden="true" />
          查看事务所名录
        </Button>
      </div>
    </Empty>
  )
}

export function CommunityExchangeMapSection({
  city,
  series,
  seriesCatalog = [],
  open,
  onSwitchDirectory,
}: {
  city?: string
  series?: string
  seriesCatalog?: readonly FudabaSeries[]
  open?: boolean
  onSwitchDirectory: () => void
}) {
  const [config, setConfig] = useState<ConfigState>(initialConfigState)
  const [MapComponent, setMapComponent] = useState<MapComponent | null>(null)
  const [moduleError, setModuleError] = useState<string | null>(null)
  const [moduleAttempt, setModuleAttempt] = useState(0)
  const [data, setData] = useState<MapDataState>(initialDataState)
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const configGeneration = useRef(0)
  const dataGeneration = useRef(0)
  const lastBoundsRef = useRef<FudabaMapBounds[] | null>(null)
  const isNarrow = useNarrowMapLayout()

  const loadConfig = useCallback(async () => {
    const generation = ++configGeneration.current
    setConfig(initialConfigState)
    setModuleError(null)
    setMapComponent(null)
    try {
      const result = await getFudabaMapConfig().send()
      if (configGeneration.current !== generation) return
      setConfig({ phase: "ready", styleUrl: result.styleUrl, error: null })
    } catch (error) {
      if (configGeneration.current !== generation) return
      setConfig({
        phase: "error",
        styleUrl: null,
        error: errorMessage(error, "地图配置无法加载"),
      })
    }
  }, [])

  useEffect(() => {
    void loadConfig()
    return () => {
      configGeneration.current += 1
    }
  }, [loadConfig])

  useEffect(() => {
    if (config.phase !== "ready") return
    let active = true
    setModuleError(null)
    void import("./exchange-office-map")
      .then((module) => {
        if (active) setMapComponent(() => module.ExchangeOfficeMap)
      })
      .catch((error) => {
        if (active) setModuleError(errorMessage(error, "地图模块无法加载"))
      })
    return () => {
      active = false
    }
  }, [config.phase, moduleAttempt])

  const loadBounds = useCallback(
    async (bounds: FudabaMapBounds[]) => {
      const generation = ++dataGeneration.current
      lastBoundsRef.current = bounds
      setData((current) => ({
        ...current,
        phase: "loading",
        error: null,
      }))
      try {
        const responses = await Promise.all(
          bounds.map((bbox) =>
            getFudabaMapOffices({
              bbox,
              city,
              series,
              open,
              limit: 200,
            }).send()
          )
        )
        if (dataGeneration.current !== generation) return
        const merged = mergeMapOfficeResponses(responses)
        setData({
          phase: "ready",
          items: merged.items,
          truncated: merged.truncated,
          error: null,
        })
      } catch (error) {
        if (dataGeneration.current !== generation) return
        setData((current) => ({
          ...current,
          phase: "error",
          error: errorMessage(error, "地图范围内的事务所无法加载"),
        }))
      }
    },
    [city, open, series]
  )

  useEffect(() => {
    const bounds = lastBoundsRef.current
    if (bounds) void loadBounds(bounds)
    return () => {
      dataGeneration.current += 1
    }
  }, [loadBounds])

  const groups = useMemo(
    () => groupMapOffices(data.items, seriesCatalog),
    [data.items, seriesCatalog]
  )
  const selectedGroup =
    groups.find((group) => group.key === selectedGroupKey) ?? null

  useEffect(() => {
    if (selectedGroupKey && !selectedGroup) {
      setSelectedGroupKey(null)
      setMobileSheetOpen(false)
    }
  }, [selectedGroup, selectedGroupKey])

  useEffect(() => {
    if (!isNarrow) {
      setMobileSheetOpen(false)
      return
    }
    if (selectedGroupKey) setMobileSheetOpen(true)
  }, [isNarrow, selectedGroupKey])

  const selectGroup = useCallback(
    (groupKey: string) => {
      setSelectedGroupKey(groupKey)
      if (isNarrow) setMobileSheetOpen(true)
    },
    [isNarrow]
  )

  const mapFailure =
    config.phase === "error" ? config.error : (moduleError ?? null)

  function retryMap() {
    if (config.phase === "error") void loadConfig()
    else setModuleAttempt((attempt) => attempt + 1)
  }

  function handleFatalError(error: Error) {
    setModuleError(error.message)
    setMapComponent(null)
  }

  return (
    <section
      className="relative size-full min-h-0 overflow-hidden bg-[#e8f2f4]"
      aria-label="区域地图"
    >
      {config.phase === "loading" ||
      (config.phase === "ready" && !MapComponent && !moduleError) ? (
        <div
          className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <LoaderCircleIcon
            className="animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          正在准备区域地图
        </div>
      ) : null}

      {config.phase === "ready" && MapComponent ? (
        <MapComponent
          styleUrl={config.styleUrl}
          groups={groups}
          selectedGroupKey={selectedGroupKey}
          onSelectGroup={selectGroup}
          onViewportChange={(bounds) => void loadBounds(bounds)}
          onFatalError={handleFatalError}
        />
      ) : null}

      {mapFailure ? (
        <MapUnavailable
          message={mapFailure}
          onRetry={retryMap}
          onSwitchDirectory={onSwitchDirectory}
        />
      ) : null}

      {!mapFailure && data.phase !== "error" ? (
        <div
          className="pointer-events-none absolute bottom-[max(2.75rem,calc(env(safe-area-inset-bottom)+2.25rem))] left-3 z-10 max-w-[calc(100%-5.5rem)] rounded-lg border bg-background/95 px-2.5 py-2 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
          aria-live="polite"
        >
          <span className="inline-flex items-center gap-1.5">
            {data.phase === "loading" ? (
              <LoaderCircleIcon
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <MapIcon className="size-3.5 text-primary" aria-hidden="true" />
            )}
            {data.phase === "idle"
              ? "等待地图范围"
              : data.phase === "loading"
                ? "正在更新地图结果"
                : groups.length
                  ? `${groups.length} 个区域点`
                  : "当前范围内没有公开事务所"}
          </span>
          {data.truncated ? (
            <span className="mt-1 block text-warning-foreground">
              当前范围结果较多，请放大地图或收窄筛选。
            </span>
          ) : null}
        </div>
      ) : null}

      {data.phase === "error" && !mapFailure ? (
        <Alert className="absolute inset-x-3 bottom-[max(2.75rem,calc(env(safe-area-inset-bottom)+2.25rem))] z-10 bg-background/95 shadow-sm sm:left-auto sm:w-96">
          <RefreshCwIcon aria-hidden="true" />
          <AlertTitle>地图数据更新失败</AlertTitle>
          <AlertDescription>
            {data.error}。已保留上次成功结果。
          </AlertDescription>
          <div className="col-start-2 mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                const bounds = lastBoundsRef.current
                if (bounds) void loadBounds(bounds)
              }}
            >
              重试
            </Button>
            <Button type="button" size="sm" onClick={onSwitchDirectory}>
              查看名录
            </Button>
          </div>
        </Alert>
      ) : null}

      {selectedGroup ? (
        <aside className="absolute top-3 right-3 z-10 hidden max-h-[calc(100%-1.5rem)] w-80 overflow-y-auto rounded-lg border bg-background/97 p-4 shadow-md backdrop-blur-sm lg:block">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-2 right-2"
            aria-label="关闭区域详情"
            onClick={() => setSelectedGroupKey(null)}
          >
            <XIcon aria-hidden="true" />
          </Button>
          <div className="pr-8">
            <OfficeGroupDetails group={selectedGroup} />
          </div>
        </aside>
      ) : null}

      <Sheet
        open={isNarrow && mobileSheetOpen && Boolean(selectedGroup)}
        onOpenChange={setMobileSheetOpen}
      >
        <SheetContent
          side="bottom"
          className="max-h-[78dvh] overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          <SheetHeader className="border-b pr-14">
            <SheetTitle>区域交换事务所</SheetTitle>
            <SheetDescription>地图仅展示约 0.1° 的区域位置。</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-2">
            {selectedGroup ? (
              <OfficeGroupDetails group={selectedGroup} />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  )
}

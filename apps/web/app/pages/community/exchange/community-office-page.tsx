import {
  ArrowLeftIcon,
  Building2Icon,
  CheckIcon,
  EyeIcon,
  LayoutGridIcon,
  ListIcon,
  LoaderCircleIcon,
  LogInIcon,
  MapPinIcon,
  PencilRulerIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"

import { usePlatformSession } from "~/components/platform/platform-session-provider"
import { SeriesAccentStrip } from "~/components/shared/series-accent-strip"
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import { Skeleton } from "~/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs"
import {
  deleteFudabaCardPlacement,
  getFudabaOffice,
  getFudabaOwnerCards,
  getFudabaSeries,
  getPlatformProfile,
  isApiError,
  saveFudabaCardPlacement,
  type FudabaCardPlacement,
  type FudabaOfficeDetail,
  type FudabaOwnerCard,
  type FudabaPlacedCard,
  type FudabaSeries,
} from "~/lib/api"
import { cn } from "~/lib/utils"
import {
  ExchangeCard,
  PlacedCardWall,
  SeriesBadge,
} from "./exchange-components"
import type { WallPlacement } from "./exchange-card-wall"

type DetailPhase = "loading" | "ready" | "closed" | "missing" | "error"

type DetailState = {
  phase: DetailPhase
  office: FudabaOfficeDetail | null
  series: FudabaSeries[]
  error: string | null
}

type WallEditorState = {
  phase: "idle" | "loading" | "ready" | "error"
  cards: FudabaOwnerCard[]
  writeEnabled: boolean
}

const initialState: DetailState = {
  phase: "loading",
  office: null,
  series: [],
  error: null,
}

const initialWallEditorState: WallEditorState = {
  phase: "idle",
  cards: [],
  writeEnabled: false,
}

function detailFailure(error: unknown): Pick<DetailState, "phase" | "error"> {
  if (isApiError(error) && error.status === 404) {
    return error.payload === "Not Found"
      ? { phase: "closed", error: null }
      : { phase: "missing", error: null }
  }
  if (isApiError(error) && (error.status === 401 || error.status === 403)) {
    return {
      phase: "error",
      error: "平台帐号会话无法验证，请刷新登录状态后重试。",
    }
  }
  return {
    phase: "error",
    error: error instanceof Error ? error.message : "事务所暂时无法加载",
  }
}

export function meta() {
  return [
    { title: "交换事务所 | IMSWeb" },
    {
      name: "description",
      content: "浏览制作人名片交换事务所与公开名片墙。",
    },
  ]
}

export default function CommunityOfficePage() {
  const { officeSlug } = useParams()
  const platform = usePlatformSession()
  const [state, setState] = useState<DetailState>(initialState)
  const [wallEditor, setWallEditor] = useState<WallEditorState>(
    initialWallEditorState
  )
  const [wallEditing, setWallEditing] = useState(false)
  const [selectedOwnerCardId, setSelectedOwnerCardId] = useState<string | null>(
    null
  )
  const [pendingCardIds, setPendingCardIds] = useState(() => new Set<string>())
  const [confirmedPlacements, setConfirmedPlacements] = useState(
    () => new Map<string, FudabaCardPlacement>()
  )
  const requestGeneration = useRef(0)
  const editorGeneration = useRef(0)
  const pendingCardIdsRef = useRef(new Set<string>())

  const loadOffice = useCallback(async () => {
    if (!officeSlug) {
      setState({ ...initialState, phase: "missing" })
      return
    }
    const generation = ++requestGeneration.current
    setState((current) => ({ ...current, phase: "loading", error: null }))
    try {
      const [officeResult, seriesResult] = await Promise.allSettled([
        getFudabaOffice(officeSlug).send(),
        getFudabaSeries().send(),
      ])
      if (requestGeneration.current !== generation) return
      if (officeResult.status === "rejected") throw officeResult.reason
      setState({
        phase: "ready",
        office: officeResult.value,
        series:
          seriesResult.status === "fulfilled" ? seriesResult.value.items : [],
        error: null,
      })
    } catch (error) {
      if (requestGeneration.current !== generation) return
      setState((current) => ({ ...current, ...detailFailure(error) }))
    }
  }, [officeSlug])

  useEffect(() => {
    void loadOffice()
    return () => {
      requestGeneration.current += 1
    }
  }, [loadOffice])

  useEffect(() => {
    if (platform.status !== "authenticated") {
      editorGeneration.current += 1
      setWallEditor(initialWallEditorState)
      setWallEditing(false)
      return
    }

    const generation = ++editorGeneration.current
    setWallEditor((current) => ({ ...current, phase: "loading" }))
    void Promise.all([
      getFudabaOwnerCards().send(),
      getPlatformProfile().send(),
    ])
      .then(([cardResult, profileResult]) => {
        if (editorGeneration.current !== generation) return
        setWallEditor({
          phase: "ready",
          cards: cardResult.items,
          writeEnabled:
            profileResult.account.status === "active" &&
            profileResult.capabilities.fudabaWrite,
        })
      })
      .catch(() => {
        if (editorGeneration.current !== generation) return
        setWallEditor({ phase: "error", cards: [], writeEnabled: false })
        setWallEditing(false)
      })

    return () => {
      editorGeneration.current += 1
    }
  }, [platform.session?.account.id, platform.status])

  const seriesMap = useMemo(
    () => new Map(state.series.map((item) => [item.code, item])),
    [state.series]
  )

  const eligibleOwnerCards = useMemo(
    () =>
      wallEditor.cards.filter(
        (card) =>
          card.publicationStatus === "published" &&
          card.mediaRightsStatus === "approved"
      ),
    [wallEditor.cards]
  )
  const placedCardIds = useMemo(() => {
    const cardIds = new Set(state.office?.cards.map((card) => card.id) ?? [])
    for (const cardId of confirmedPlacements.keys()) cardIds.add(cardId)
    return cardIds
  }, [confirmedPlacements, state.office?.cards])
  const unplacedOwnerCards = useMemo(
    () => eligibleOwnerCards.filter((card) => !placedCardIds.has(card.id)),
    [eligibleOwnerCards, placedCardIds]
  )
  const canEditWall =
    platform.status === "authenticated" &&
    wallEditor.phase === "ready" &&
    wallEditor.writeEnabled &&
    Boolean(state.office?.isOpen)
  const hasOwnedPlacedCard = Boolean(
    state.office?.cards.some((card) => card.viewerOwned)
  )

  useEffect(() => {
    setSelectedOwnerCardId((current) => {
      if (current && unplacedOwnerCards.some((card) => card.id === current)) {
        return current
      }
      return unplacedOwnerCards[0]?.id ?? null
    })
  }, [unplacedOwnerCards])

  useEffect(() => {
    if (!canEditWall) setWallEditing(false)
  }, [canEditWall])

  useEffect(() => {
    setConfirmedPlacements(new Map())
  }, [officeSlug, platform.session?.account.id])

  function markCardPending(cardId: string, pending: boolean) {
    const next = new Set(pendingCardIdsRef.current)
    if (pending) next.add(cardId)
    else next.delete(cardId)
    pendingCardIdsRef.current = next
    setPendingCardIds(next)
  }

  function replacePlacement(cardId: string, placement: FudabaCardPlacement) {
    setState((current) => {
      if (!current.office) return current
      return {
        ...current,
        office: {
          ...current.office,
          cards: current.office.cards.map((card) =>
            card.id === cardId ? { ...card, placement } : card
          ),
        },
      }
    })
  }

  function rememberConfirmedPlacement(
    cardId: string,
    placement: FudabaCardPlacement
  ) {
    setConfirmedPlacements((current) => {
      const next = new Map(current)
      next.set(cardId, placement)
      return next
    })
  }

  function forgetConfirmedPlacement(cardId: string) {
    setConfirmedPlacements((current) => {
      if (!current.has(cardId)) return current
      const next = new Map(current)
      next.delete(cardId)
      return next
    })
  }

  function previewPlacement(cardId: string, placement: WallPlacement) {
    setState((current) => {
      if (!current.office) return current
      return {
        ...current,
        office: {
          ...current.office,
          cards: current.office.cards.map((card) =>
            card.id === cardId
              ? {
                  ...card,
                  placement: { ...card.placement, ...placement },
                }
              : card
          ),
        },
      }
    })
  }

  const refreshOfficeDetail = useCallback(async () => {
    if (!officeSlug) return null
    const office = await getFudabaOffice(officeSlug).send()
    setState((current) => ({
      ...current,
      phase: "ready",
      office,
      error: null,
    }))
    return office
  }, [officeSlug])

  async function handlePlacementFailure(error: unknown, fallback: string) {
    if (
      isApiError(error) &&
      error.status === 409 &&
      error.code === "FUDABA_CARD_PLACEMENT_IN_USE"
    ) {
      toast.error("这张名片已有交换记录，暂时不能从事务所移除。")
      return
    }
    if (isApiError(error) && error.status === 409) {
      try {
        await refreshOfficeDetail()
        toast.error("名片墙已在其他页面更新，当前布局已重新载入。")
      } catch {
        toast.error(
          "名片墙已在其他页面更新，但最新布局暂时无法载入，请重新加载页面。"
        )
      }
      return
    }
    if (isApiError(error) && error.status === 404) {
      setWallEditor((current) => ({ ...current, writeEnabled: false }))
      setWallEditing(false)
    }
    toast.error(error instanceof Error ? error.message : fallback)
  }

  async function savePlacement(
    cardId: string,
    previous: FudabaCardPlacement,
    placement: WallPlacement
  ) {
    const office = state.office
    if (!office || pendingCardIdsRef.current.has(cardId)) return
    markCardPending(cardId, true)
    try {
      const result = await saveFudabaCardPlacement(office.id, cardId, {
        ...placement,
        expectedRevision: previous.revision,
      }).send()
      replacePlacement(cardId, result.placement)
    } catch (error) {
      replacePlacement(cardId, previous)
      await handlePlacementFailure(error, "名片位置暂时无法保存。")
    } finally {
      markCardPending(cardId, false)
    }
  }

  async function addSelectedCard() {
    const office = state.office
    const card = unplacedOwnerCards.find(
      (item) => item.id === selectedOwnerCardId
    )
    if (!office || !card || pendingCardIdsRef.current.has(card.id)) return
    const maximumZIndex = Math.max(
      0,
      ...office.cards.map((item) => item.placement.zIndex),
      ...Array.from(
        confirmedPlacements.values(),
        (placement) => placement.zIndex
      )
    )
    markCardPending(card.id, true)
    try {
      const result = await saveFudabaCardPlacement(office.id, card.id, {
        x: 50,
        y: 50,
        rotation: 0,
        zIndex: Math.min(999, maximumZIndex + 1),
        expectedRevision: null,
      }).send()
      rememberConfirmedPlacement(card.id, result.placement)
      try {
        const refreshedOffice = await refreshOfficeDetail()
        if (!refreshedOffice?.cards.some((item) => item.id === card.id)) {
          toast.warning("名片已放到墙上，但最新墙面暂时无法重新载入。")
          return
        }
        forgetConfirmedPlacement(card.id)
      } catch {
        toast.warning("名片已放到墙上，但最新墙面暂时无法重新载入。")
        return
      }
      toast.success("名片已放到墙上。")
    } catch (error) {
      await handlePlacementFailure(error, "名片暂时无法放到墙上。")
    } finally {
      markCardPending(card.id, false)
    }
  }

  async function removeCard(card: FudabaPlacedCard) {
    const office = state.office
    if (!office || pendingCardIdsRef.current.has(card.id)) return
    markCardPending(card.id, true)
    try {
      await deleteFudabaCardPlacement(
        office.id,
        card.id,
        card.placement.revision
      ).send()
      setState((current) => {
        if (!current.office) return current
        return {
          ...current,
          office: {
            ...current.office,
            cards: current.office.cards.filter((item) => item.id !== card.id),
          },
        }
      })
      toast.success("名片已从墙上移除。")
    } catch (error) {
      await handlePlacementFailure(error, "名片暂时无法移除。")
    } finally {
      markCardPending(card.id, false)
    }
  }

  if (state.phase === "loading") {
    return (
      <main
        id="main-content"
        className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
      >
        <Skeleton className="h-6 w-28" />
        <Skeleton className="mt-6 aspect-16/5 w-full" />
        <Skeleton className="mt-8 h-12 w-2/3" />
        <Skeleton className="mt-8 min-h-96 w-full" />
      </main>
    )
  }

  if (state.phase !== "ready" || !state.office) {
    let title = "事务所暂时无法加载"
    let description = state.error || "请稍后重新加载。"
    if (state.phase === "closed") {
      title = "社区交换区尚未开放"
      description = "事务所完成公开审核后会在这里显示。"
    } else if (state.phase === "missing") {
      title = "未找到这个事务所"
      description = "链接可能已失效，或者事务所已停止公开。"
    }

    return (
      <main
        id="main-content"
        className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8"
      >
        <Empty className="min-h-96 border-y">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Building2Icon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{title}</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
          <div className="flex flex-wrap justify-center gap-2">
            {state.phase === "error" ? (
              <Button type="button" onClick={() => void loadOffice()}>
                <RefreshCwIcon aria-hidden="true" />
                重新加载
              </Button>
            ) : null}
            <Link
              to="/community/exchange"
              className={buttonVariants({ variant: "outline" })}
            >
              返回事务所列表
            </Link>
          </div>
        </Empty>
      </main>
    )
  }

  const office = state.office
  const wallMutationPending = pendingCardIds.size > 0

  return (
    <main id="main-content">
      <div className="mx-auto w-full max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
        <Link
          to="/community/exchange"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ArrowLeftIcon aria-hidden="true" />
          返回事务所列表
        </Link>
      </div>

      <section className="mt-4 border-y bg-background">
        <div className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8">
          {office.coverUrl ? (
            <div className="aspect-16/5 max-h-96 min-h-48 w-full overflow-hidden border-x bg-muted">
              <img
                src={office.coverUrl}
                alt={`${office.name}封面`}
                className="size-full object-cover"
              />
            </div>
          ) : (
            <div className="relative flex aspect-16/5 max-h-96 min-h-48 w-full items-center justify-center overflow-hidden border-x bg-muted/50">
              <SeriesAccentStrip className="absolute inset-x-0 top-0 h-1" />
              <Building2Icon
                className="size-12 text-muted-foreground/60"
                aria-hidden="true"
              />
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="border-b pb-8">
          <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
            <div className="max-w-3xl min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="secondary"
                  className={cn(
                    office.isOpen
                      ? "bg-success/20 text-success-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  {office.isOpen ? "开放交换" : "暂未开放"}
                </Badge>
                {office.seriesCodes.map((code) => (
                  <SeriesBadge key={code} code={code} series={seriesMap} />
                ))}
              </div>
              <h1 className="mt-4 text-3xl font-semibold text-balance">
                {office.name}
              </h1>
              <p className="mt-4 max-w-2xl leading-7 text-muted-foreground">
                {office.intro || "事务所暂未填写介绍。"}
              </p>
            </div>
            <dl className="grid min-w-64 grid-cols-2 gap-x-6 gap-y-3 border-y py-4 text-sm lg:border-y-0 lg:border-l lg:py-1 lg:pl-6">
              <div>
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <MapPinIcon className="size-3.5" aria-hidden="true" />
                  城市
                </dt>
                <dd className="mt-1 font-medium">{office.city}</dd>
              </div>
              <div>
                <dt className="flex items-center gap-1.5 text-muted-foreground">
                  <EyeIcon className="size-3.5" aria-hidden="true" />
                  访问
                </dt>
                <dd className="mt-1 font-medium">
                  {office.visitorCount.toLocaleString("zh-CN")}
                </dd>
              </div>
            </dl>
          </div>
        </header>

        <section className="pt-8" aria-labelledby="office-card-wall-title">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 id="office-card-wall-title" className="text-xl font-semibold">
                事务所名片墙
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {office.cards.length} 张公开名片
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {platform.status === "anonymous" ? (
                <Link
                  to="/account/login"
                  className={buttonVariants({ variant: "outline" })}
                >
                  <LogInIcon aria-hidden="true" />
                  登录后布置
                </Link>
              ) : null}
              {platform.status === "restricted" ? (
                <Badge variant="secondary">帐号受限，仅可浏览</Badge>
              ) : null}
              {platform.status === "authenticated" &&
              wallEditor.phase === "loading" ? (
                <Button type="button" variant="outline" disabled>
                  <LoaderCircleIcon
                    className="animate-spin"
                    aria-hidden="true"
                  />
                  载入我的名片
                </Button>
              ) : null}
              {platform.status === "authenticated" &&
              wallEditor.phase === "error" ? (
                <Link
                  to="/community/exchange/me"
                  className={buttonVariants({ variant: "outline" })}
                >
                  管理我的名片
                </Link>
              ) : null}
              {canEditWall &&
              (eligibleOwnerCards.length > 0 || hasOwnedPlacedCard) ? (
                <Button
                  type="button"
                  variant={wallEditing ? "secondary" : "default"}
                  disabled={wallMutationPending}
                  onClick={() => setWallEditing((current) => !current)}
                >
                  {wallEditing ? (
                    <CheckIcon aria-hidden="true" />
                  ) : (
                    <PencilRulerIcon aria-hidden="true" />
                  )}
                  {wallEditing ? "完成布置" : "布置名片墙"}
                </Button>
              ) : null}
              {canEditWall &&
              eligibleOwnerCards.length === 0 &&
              !hasOwnedPlacedCard ? (
                <Link
                  to="/community/exchange/me"
                  className={buttonVariants({ variant: "outline" })}
                >
                  创建可公开名片
                </Link>
              ) : null}
              {platform.status === "authenticated" &&
              wallEditor.phase === "ready" &&
              (!wallEditor.writeEnabled || !office.isOpen) ? (
                <Badge variant="secondary">当前仅可浏览</Badge>
              ) : null}
            </div>
          </div>

          {wallEditing ? (
            <div className="mt-5 flex flex-col gap-3 border-y bg-muted/30 py-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0 flex-1 sm:max-w-md">
                <span
                  id="fudaba-wall-card-select-label"
                  className="mb-1.5 block text-xs font-medium"
                >
                  放置名片
                </span>
                <Select
                  value={selectedOwnerCardId ?? ""}
                  disabled={
                    unplacedOwnerCards.length === 0 || wallMutationPending
                  }
                  onValueChange={(value) =>
                    setSelectedOwnerCardId(String(value ?? "") || null)
                  }
                >
                  <SelectTrigger
                    className="w-full bg-background"
                    aria-labelledby="fudaba-wall-card-select-label"
                  >
                    <SelectValue placeholder="没有可放置的名片">
                      {unplacedOwnerCards.find(
                        (card) => card.id === selectedOwnerCardId
                      )?.displayName ?? "没有可放置的名片"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectGroup>
                      {unplacedOwnerCards.map((card) => (
                        <SelectItem key={card.id} value={card.id}>
                          {card.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Link
                  to="/community/exchange/me"
                  className={buttonVariants({ variant: "outline" })}
                >
                  管理名片
                </Link>
                <Button
                  type="button"
                  disabled={!selectedOwnerCardId || wallMutationPending}
                  onClick={() => void addSelectedCard()}
                >
                  <PlusIcon aria-hidden="true" />
                  放到墙上
                </Button>
              </div>
            </div>
          ) : null}

          {office.cards.length || wallEditing ? (
            <Tabs defaultValue="wall" className="mt-5">
              <TabsList aria-label="名片墙视图">
                <TabsTrigger value="wall">
                  <LayoutGridIcon aria-hidden="true" />
                  墙面
                </TabsTrigger>
                <TabsTrigger value="list">
                  <ListIcon aria-hidden="true" />
                  列表
                </TabsTrigger>
              </TabsList>
              <TabsContent value="wall" className="mt-3">
                <PlacedCardWall
                  cards={office.cards}
                  editing={wallEditing}
                  pendingCardIds={pendingCardIds}
                  onPlacementPreview={previewPlacement}
                  onPlacementCommit={(cardId, previous, placement) =>
                    void savePlacement(cardId, previous, placement)
                  }
                  onRemove={(card) => void removeCard(card)}
                />
              </TabsContent>
              <TabsContent value="list" className="mt-3">
                {office.cards.length ? (
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {office.cards.map((card) => (
                      <ExchangeCard
                        key={card.id}
                        card={card}
                        series={seriesMap}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="border-y py-12 text-center text-sm text-muted-foreground">
                    名片墙还是空的
                  </p>
                )}
              </TabsContent>
            </Tabs>
          ) : (
            <Empty className="mt-5 min-h-64 border-y">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LayoutGridIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>名片墙还是空的</EmptyTitle>
                <EmptyDescription>
                  已审核并放置到事务所的名片会显示在这里。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </section>
      </div>
    </main>
  )
}

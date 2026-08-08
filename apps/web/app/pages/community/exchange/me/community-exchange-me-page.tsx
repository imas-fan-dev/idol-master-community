import {
  CircleAlertIcon,
  LockKeyholeIcon,
  RefreshCwIcon,
  UserRoundIcon,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router"

import { usePlatformSession } from "~/components/platform/platform-session-provider"
import { SeriesAccentStrip } from "~/components/shared/series-accent-strip"
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button, buttonVariants } from "~/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import { Skeleton } from "~/components/ui/skeleton"
import {
  getFudabaOwnerCard,
  getFudabaOwnerCards,
  getFudabaOwnerSeries,
  getPlatformProfile,
  hasPlatformSessionHint,
  type FudabaOwnerCard,
  type FudabaSeries,
  type PlatformProfile,
} from "~/lib/api"
import { CardWorkspace } from "./card-workspace"
import { apiMessage, isFeatureClosed } from "./exchange-me-model"
import { OfficeLocationWorkspace } from "./office-location-workspace"
import { ProfileEditor } from "./profile-editor"

type WorkspacePhase = "idle" | "loading" | "ready" | "closed" | "error"

type WorkspaceState = {
  phase: WorkspacePhase
  profile: PlatformProfile | null
  accountStatus: "active" | "restricted" | null
  writeEnabled: boolean
  series: FudabaSeries[]
  cards: FudabaOwnerCard[]
  error: string | null
}

const initialState: WorkspaceState = {
  phase: "idle",
  profile: null,
  accountStatus: null,
  writeEnabled: false,
  series: [],
  cards: [],
  error: null,
}

export function meta() {
  return [
    { title: "我的交换名片 | IMSWeb" },
    {
      name: "description",
      content: "维护制作人资料、双面交换名片与公开状态。",
    },
  ]
}

export default function CommunityExchangeMePage() {
  const platform = usePlatformSession()
  const [state, setState] = useState<WorkspaceState>(initialState)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const workspaceGeneration = useRef(0)
  const detailGeneration = useRef(0)

  const loadWorkspace = useCallback(async () => {
    const generation = ++workspaceGeneration.current
    setState((current) => ({
      ...current,
      phase: "loading",
      error: null,
    }))
    try {
      const [profileResult, seriesResult, cardResult] = await Promise.all([
        getPlatformProfile().send(),
        getFudabaOwnerSeries().send(),
        getFudabaOwnerCards().send(),
      ])
      if (workspaceGeneration.current !== generation) return
      const canCreate =
        profileResult.account.status === "active" &&
        profileResult.capabilities.fudabaWrite
      setState({
        phase: "ready",
        profile: profileResult.profile,
        accountStatus: profileResult.account.status,
        writeEnabled: profileResult.capabilities.fudabaWrite,
        series: seriesResult.items,
        cards: cardResult.items,
        error: null,
      })
      setSelectedCardId(cardResult.items[0]?.id ?? null)
      setCreating(cardResult.items.length === 0 && canCreate)
    } catch (error) {
      if (workspaceGeneration.current !== generation) return
      setState((current) => ({
        ...current,
        phase: isFeatureClosed(error) ? "closed" : "error",
        error: isFeatureClosed(error)
          ? null
          : apiMessage(error, "制作人名片工作区暂时无法加载。"),
      }))
    }
  }, [])

  useEffect(() => {
    if (
      platform.status !== "authenticated" &&
      platform.status !== "restricted"
    ) {
      return
    }
    void loadWorkspace()
    return () => {
      workspaceGeneration.current += 1
      detailGeneration.current += 1
    }
  }, [loadWorkspace, platform.session?.account.id, platform.status])

  function saveProfile(profile: PlatformProfile) {
    setState((current) => ({ ...current, profile }))
  }

  async function reloadProfile() {
    const result = await getPlatformProfile().send()
    setState((current) => ({
      ...current,
      profile: result.profile,
      accountStatus: result.account.status,
      writeEnabled: result.capabilities.fudabaWrite,
    }))
    return result.profile
  }

  function replaceCard(card: FudabaOwnerCard) {
    setState((current) => ({
      ...current,
      cards: current.cards.map((item) => (item.id === card.id ? card : item)),
    }))
  }

  async function loadCard(cardId: string) {
    const generation = ++detailGeneration.current
    setSelectedCardId(cardId)
    setCreating(false)
    setLoadingDetail(true)
    try {
      const result = await getFudabaOwnerCard(cardId).send()
      if (detailGeneration.current !== generation) return result.card
      replaceCard(result.card)
      return result.card
    } finally {
      if (detailGeneration.current === generation) setLoadingDetail(false)
    }
  }

  function createCard(card: FudabaOwnerCard) {
    setState((current) => ({
      ...current,
      cards: [card, ...current.cards.filter((item) => item.id !== card.id)],
    }))
    setSelectedCardId(card.id)
    setCreating(false)
  }

  function deleteCard(cardId: string) {
    const cards = state.cards.filter((item) => item.id !== cardId)
    setState((current) => ({ ...current, cards }))
    setSelectedCardId(cards[0]?.id ?? null)
    setCreating(cards.length === 0 && state.writeEnabled)
  }

  function closeWrites() {
    setState((current) => ({ ...current, writeEnabled: false }))
    setCreating(false)
  }

  const hasSessionHint = hasPlatformSessionHint()
  const waitingForSession =
    platform.status === "loading" ||
    (platform.status === "anonymous" && hasSessionHint)

  if (waitingForSession || state.phase === "loading") {
    return (
      <main
        id="main-content"
        className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8"
        aria-label="正在载入我的交换名片"
      >
        <Skeleton className="h-7 w-44" />
        <Skeleton className="mt-5 h-20 w-full" />
        <div className="mt-8 grid gap-8 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <Skeleton className="h-144 w-full" />
          <Skeleton className="h-176 w-full" />
        </div>
      </main>
    )
  }

  if (platform.status === "anonymous") {
    return (
      <main
        id="main-content"
        className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8"
      >
        <Empty className="min-h-96 border-y">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <UserRoundIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>请先登录平台帐号</EmptyTitle>
            <EmptyDescription>
              登录后可以维护制作人资料、双面名片与交换状态。
            </EmptyDescription>
          </EmptyHeader>
          <Link
            to="/community/exchange"
            className={buttonVariants({ variant: "outline" })}
          >
            返回交换事务所
          </Link>
        </Empty>
      </main>
    )
  }

  if (platform.status === "error") {
    return (
      <main
        id="main-content"
        className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8"
      >
        <Empty className="min-h-96 border-y">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleAlertIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>帐号状态暂时不可用</EmptyTitle>
            <EmptyDescription>
              请重新载入帐号状态后再打开名片工作区。
            </EmptyDescription>
          </EmptyHeader>
          <Button type="button" onClick={() => void platform.reload()}>
            <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
            重新载入帐号
          </Button>
        </Empty>
      </main>
    )
  }

  if (state.phase !== "ready" || !state.profile) {
    const closed = state.phase === "closed"
    return (
      <main
        id="main-content"
        className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 lg:px-8"
      >
        <Empty className="min-h-96 border-y">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              {closed ? (
                <LockKeyholeIcon aria-hidden="true" />
              ) : (
                <CircleAlertIcon aria-hidden="true" />
              )}
            </EmptyMedia>
            <EmptyTitle>
              {closed ? "我的交换名片尚未开放" : "名片工作区暂时无法加载"}
            </EmptyTitle>
            <EmptyDescription>
              {closed
                ? "功能开放后，可以在这里维护制作人资料和双面名片。"
                : state.error || "请稍后重新载入。"}
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex flex-wrap justify-center gap-2">
            {!closed ? (
              <Button type="button" onClick={() => void loadWorkspace()}>
                <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                重新载入
              </Button>
            ) : null}
            <Link
              to="/community/exchange"
              className={buttonVariants({ variant: "outline" })}
            >
              返回交换事务所
            </Link>
          </div>
        </Empty>
      </main>
    )
  }

  const restricted =
    platform.status === "restricted" || state.accountStatus === "restricted"
  const readOnly = restricted || !state.writeEnabled
  const readOnlyReason = restricted
    ? "帐号当前受限，资料和名片保持可查看，但不能修改。"
    : !state.writeEnabled
      ? "编辑功能正在分阶段开放，当前资料和名片保持只读。"
      : null

  return (
    <main id="main-content" className="min-w-0">
      <header className="relative border-b bg-muted/25">
        <SeriesAccentStrip className="absolute inset-x-0 top-0 h-1" />
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="max-w-2xl min-w-0">
            <Link
              to="/community/exchange"
              className="text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              名片交换事务所
            </Link>
            <h1 className="mt-3 text-2xl font-semibold text-balance">
              我的交换名片
            </h1>
            <p className="mt-2 max-w-xl leading-7 text-muted-foreground">
              维护制作人资料、名片正反面和交换状态。
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{state.cards.length} 张名片</span>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="刷新我的交换名片"
              title="刷新"
              onClick={() => void loadWorkspace()}
            >
              <RefreshCwIcon aria-hidden="true" />
            </Button>
          </div>
        </div>
      </header>

      {readOnlyReason ? (
        <div className="border-b bg-background">
          <div className="mx-auto w-full max-w-7xl p-4 sm:px-6 lg:px-8">
            <Alert>
              <LockKeyholeIcon aria-hidden="true" />
              <AlertTitle>
                {restricted ? "帐号受限" : "编辑暂未开放"}
              </AlertTitle>
              <AlertDescription>{readOnlyReason}</AlertDescription>
            </Alert>
          </div>
        </div>
      ) : null}

      <div className="mx-auto grid w-full max-w-7xl min-w-0 gap-10 px-4 py-8 sm:px-6 lg:grid-cols-[20rem_minmax(0,1fr)] lg:px-8">
        <ProfileEditor
          profile={state.profile}
          readOnly={readOnly}
          readOnlyReason={readOnlyReason}
          onSaved={saveProfile}
          onReload={reloadProfile}
          onWriteClosed={closeWrites}
        />
        <section
          className="min-w-0 border-t pt-8 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-8"
          aria-label="名片库存与编辑器"
        >
          <CardWorkspace
            cards={state.cards}
            selectedCardId={selectedCardId}
            creating={creating}
            loadingDetail={loadingDetail}
            profile={state.profile}
            series={state.series}
            readOnly={readOnly}
            readOnlyReason={readOnlyReason}
            onSelect={(cardId) => void loadCard(cardId)}
            onCreate={() => {
              setCreating(true)
              setSelectedCardId(null)
              setLoadingDetail(false)
            }}
            onCreated={createCard}
            onSaved={replaceCard}
            onDeleted={deleteCard}
            onReload={loadCard}
            onWriteClosed={closeWrites}
          />
        </section>
      </div>
      <OfficeLocationWorkspace
        series={state.series}
        homeCity={state.profile.homeCity}
        readOnly={readOnly}
        onWriteClosed={closeWrites}
      />
    </main>
  )
}

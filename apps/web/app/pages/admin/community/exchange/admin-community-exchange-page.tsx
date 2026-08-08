import {
  AlertTriangleIcon,
  CheckIcon,
  RefreshCwIcon,
  UserRoundIcon,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Skeleton } from "~/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs"
import {
  getFudabaLocationReviews,
  isApiError,
  reviewFudabaLocation,
  type FudabaLocationReview,
  type FudabaLocationReviewDecision,
  type FudabaLocationReviewState,
} from "~/lib/api"
import {
  AdminEmptyState,
  AdminPageHeader,
} from "~/pages/admin/components/admin-ui"

import { LocationReviewCard } from "./location-review-card"

const reviewStates: readonly FudabaLocationReviewState[] = [
  "pending",
  "published",
  "rejected",
]

const stateLabels: Record<FudabaLocationReviewState, string> = {
  pending: "待审核",
  published: "已发布",
  rejected: "已拒绝",
}

function isReviewState(value: string): value is FudabaLocationReviewState {
  return reviewStates.some((state) => state === value)
}

function errorMessage(error: unknown) {
  return isApiError(error) ? error.message : "请求失败，请稍后重试"
}

export function meta() {
  return [{ title: "事务所位置审核 | IMSWeb" }]
}

export default function AdminCommunityExchangePage() {
  const [activeState, setActiveState] =
    useState<FudabaLocationReviewState>("pending")
  const [items, setItems] = useState<FudabaLocationReview[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set())
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [noteErrors, setNoteErrors] = useState<Record<string, string>>({})
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({})
  const [conflicts, setConflicts] = useState<Record<string, boolean>>({})
  const requestSequence = useRef(0)

  const loadQueue = useCallback(async () => {
    const sequence = ++requestSequence.current
    setLoading(true)
    setLoadError(null)
    try {
      const result = await getFudabaLocationReviews(activeState).send()
      if (sequence !== requestSequence.current) return
      setItems(result.items)
      setConflicts({})
      setActionErrors({})
    } catch (error) {
      if (sequence !== requestSequence.current) return
      setLoadError(errorMessage(error))
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [activeState])

  useEffect(() => {
    void loadQueue()
    return () => {
      requestSequence.current += 1
    }
  }, [loadQueue])

  function changeNote(officeId: string, value: string) {
    setNotes((current) => ({ ...current, [officeId]: value }))
    setNoteErrors((current) => {
      if (!current[officeId]) return current
      const next = { ...current }
      delete next[officeId]
      return next
    })
  }

  async function submitDecision(
    item: FudabaLocationReview,
    decision: FudabaLocationReviewDecision
  ) {
    const note = (notes[item.officeId] ?? "").trim()
    if (decision === "reject" && !note) {
      setNoteErrors((current) => ({
        ...current,
        [item.officeId]: "拒绝公开位置时必须填写审核理由",
      }))
      return
    }

    setBusyIds((current) => {
      if (current.has(item.officeId)) return current
      const next = new Set(current)
      next.add(item.officeId)
      return next
    })
    setActionErrors((current) => {
      const next = { ...current }
      delete next[item.officeId]
      return next
    })
    try {
      await reviewFudabaLocation(item.officeId, {
        decision,
        expectedRevision: item.revision,
        note,
      }).send()
      toast.success(
        decision === "publish"
          ? `“${item.officeName}”的位置已发布`
          : `“${item.officeName}”的位置已拒绝`
      )
      await loadQueue()
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        setConflicts((current) => ({ ...current, [item.officeId]: true }))
        toast.error("审核记录已变化，请刷新后重试")
      } else {
        setActionErrors((current) => ({
          ...current,
          [item.officeId]: errorMessage(error),
        }))
      }
    } finally {
      setBusyIds((current) => {
        if (!current.has(item.officeId)) return current
        const next = new Set(current)
        next.delete(item.officeId)
        return next
      })
    }
  }

  return (
    <div className="flex flex-col gap-7">
      <AdminPageHeader
        eyebrow="EXCHANGE LOCATION REVIEW"
        title="事务所位置审核"
        description="审核事务所提交的公开区域位置。页面只展示 0.1° 网格坐标，不包含精确地址。"
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void loadQueue()}
          >
            <RefreshCwIcon data-icon="inline-start" />
            刷新
          </Button>
        }
      />

      <Tabs
        value={activeState}
        onValueChange={(value) => {
          const state = String(value)
          if (isReviewState(state)) setActiveState(state)
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="w-full sm:w-fit" aria-label="位置审核状态">
            {reviewStates.map((state) => (
              <TabsTrigger key={state} value={state}>
                {stateLabels[state]}
              </TabsTrigger>
            ))}
          </TabsList>
          <Badge variant="outline" aria-live="polite">
            {loading ? "正在读取" : `${items.length} 条记录`}
          </Badge>
        </div>
      </Tabs>

      <section aria-label={`${stateLabels[activeState]}位置队列`}>
        {loading ? (
          <div
            className="grid gap-4 xl:grid-cols-2"
            aria-label="正在读取审核队列"
          >
            <Skeleton className="h-96 w-full" />
            <Skeleton className="hidden h-96 w-full xl:block" />
          </div>
        ) : loadError ? (
          <Alert variant="destructive">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>无法读取审核队列</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3">
              <span>{loadError}</span>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadQueue()}
              >
                <RefreshCwIcon data-icon="inline-start" />
                重试
              </Button>
            </AlertDescription>
          </Alert>
        ) : items.length === 0 ? (
          <AdminEmptyState
            icon={CheckIcon}
            title={`${stateLabels[activeState]}队列为空`}
            description="该筛选状态下暂时没有事务所位置记录。"
          />
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {items.map((item) => (
              <LocationReviewCard
                key={item.officeId}
                item={item}
                note={notes[item.officeId] ?? ""}
                noteError={noteErrors[item.officeId]}
                actionError={actionErrors[item.officeId]}
                conflict={Boolean(conflicts[item.officeId])}
                busy={busyIds.has(item.officeId)}
                onNoteChange={(value) => changeNote(item.officeId, value)}
                onDecision={(decision) => void submitDecision(item, decision)}
                onRefresh={() => void loadQueue()}
              />
            ))}
          </div>
        )}
      </section>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <UserRoundIcon className="size-4" aria-hidden="true" />
        审核结果与管理员操作记录由服务端在同一事务中保存。
      </p>
    </div>
  )
}

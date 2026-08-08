import {
  AlertTriangleIcon,
  CircleCheckIcon,
  CircleXIcon,
  Clock3Icon,
  LoaderCircleIcon,
  MapPinIcon,
  RefreshCwIcon,
  SendIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import { Field, FieldError, FieldLabel } from "~/components/ui/field"
import { Textarea } from "~/components/ui/textarea"
import type {
  FudabaLocationReview,
  FudabaLocationReviewDecision,
  FudabaLocationReviewState,
} from "~/lib/api"

const stateLabels: Record<FudabaLocationReviewState, string> = {
  pending: "待审核",
  published: "已发布",
  rejected: "已拒绝",
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium",
  timeStyle: "short",
})

function formatDate(value: string | null) {
  if (!value) return "尚未审核"
  return dateFormatter.format(new Date(value))
}

function ReviewStatusBadge({ state }: { state: FudabaLocationReviewState }) {
  const Icon =
    state === "pending"
      ? Clock3Icon
      : state === "published"
        ? CircleCheckIcon
        : CircleXIcon
  return (
    <Badge
      variant={
        state === "pending"
          ? "secondary"
          : state === "published"
            ? "default"
            : "destructive"
      }
    >
      <Icon data-icon="inline-start" aria-hidden="true" />
      {stateLabels[state]}
    </Badge>
  )
}

function ReviewDetails({ item }: { item: FudabaLocationReview }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">所属城市</dt>
        <dd className="mt-1 font-medium">{item.city}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">公开区域坐标</dt>
        <dd className="mt-1 font-mono tabular-nums">
          {item.location.latitude.toFixed(1)}°,{" "}
          {item.location.longitude.toFixed(1)}°
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">提交账号</dt>
        <dd className="mt-1 truncate font-mono text-xs">
          {item.ownerAccountId}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-muted-foreground">提交时间</dt>
        <dd className="mt-1">{formatDate(item.submittedAt)}</dd>
      </div>
      {item.reviewState !== "pending" ? (
        <>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">审核人员</dt>
            <dd className="mt-1">
              {item.reviewedBy ? `管理员 #${item.reviewedBy}` : "记录缺失"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">审核时间</dt>
            <dd className="mt-1">{formatDate(item.reviewedAt)}</dd>
          </div>
        </>
      ) : null}
    </dl>
  )
}

export function LocationReviewCard({
  item,
  note,
  noteError,
  actionError,
  conflict,
  busy,
  onNoteChange,
  onDecision,
  onRefresh,
}: {
  item: FudabaLocationReview
  note: string
  noteError?: string
  actionError?: string
  conflict: boolean
  busy: boolean
  onNoteChange: (value: string) => void
  onDecision: (decision: FudabaLocationReviewDecision) => void
  onRefresh: () => void
}) {
  const noteId = `location-review-note-${item.officeId}`

  return (
    <Card role="article" aria-label={`${item.officeName}位置审核`}>
      <CardHeader className="border-b">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ReviewStatusBadge state={item.reviewState} />
            <Badge variant="outline">
              <MapPinIcon data-icon="inline-start" aria-hidden="true" />
              0.1° 区域精度
            </Badge>
            <Badge variant="outline">修订 {item.revision}</Badge>
          </div>
          <CardTitle>
            <h2>{item.officeName}</h2>
          </CardTitle>
          <CardDescription className="truncate font-mono text-xs">
            {item.officeId}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ReviewDetails item={item} />

        {item.reviewNote ? (
          <div className="rounded-lg border bg-muted/40 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              审核备注
            </p>
            <p className="mt-1 text-sm whitespace-pre-wrap">
              {item.reviewNote}
            </p>
          </div>
        ) : null}

        {item.reviewState === "pending" ? (
          <Field data-invalid={Boolean(noteError)}>
            <FieldLabel htmlFor={noteId}>审核备注</FieldLabel>
            <Textarea
              id={noteId}
              value={note}
              maxLength={1000}
              disabled={busy}
              aria-invalid={Boolean(noteError)}
              placeholder="发布时可选；拒绝时必须说明原因"
              onChange={(event) => onNoteChange(event.target.value)}
            />
            <div className="flex items-start justify-between gap-3">
              <FieldError>{noteError}</FieldError>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {note.length}/1000
              </span>
            </div>
          </Field>
        ) : null}

        {conflict ? (
          <Alert variant="destructive">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>审核记录已变化</AlertTitle>
            <AlertDescription>
              另一位管理员已经处理或修改了这条记录。审核备注已保留，请刷新后核对最新状态。
            </AlertDescription>
          </Alert>
        ) : actionError ? (
          <Alert variant="destructive">
            <AlertTriangleIcon aria-hidden="true" />
            <AlertTitle>审核操作失败</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      {item.reviewState === "pending" ? (
        <CardFooter className="flex flex-wrap justify-end gap-2">
          {conflict ? (
            <Button type="button" variant="outline" onClick={onRefresh}>
              <RefreshCwIcon data-icon="inline-start" />
              刷新队列
            </Button>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            disabled={busy || conflict}
            onClick={() => onDecision("reject")}
          >
            {busy ? (
              <LoaderCircleIcon
                data-icon="inline-start"
                className="animate-spin"
              />
            ) : (
              <CircleXIcon data-icon="inline-start" />
            )}
            拒绝
          </Button>
          <Button
            type="button"
            disabled={busy || conflict}
            onClick={() => onDecision("publish")}
          >
            {busy ? (
              <LoaderCircleIcon
                data-icon="inline-start"
                className="animate-spin"
              />
            ) : (
              <SendIcon data-icon="inline-start" />
            )}
            发布
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}

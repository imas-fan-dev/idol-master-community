import {
  CircleAlertIcon,
  LoaderCircleIcon,
  MapPinIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react"
import type { FormEvent } from "react"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field"
import { Input } from "~/components/ui/input"
import type { FudabaOwnerLocation, FudabaOwnerOffice } from "~/lib/api"
import {
  locationReviewLabels,
  type PublicLocationDraft,
  type WorkspaceFeedback,
} from "./office-location-model"

function reviewDescription(location: FudabaOwnerLocation | null) {
  if (!location) return "尚未提交公开地图位置。"
  if (location.reviewState === "published") {
    return "这个 0.1 度区域位置当前显示在公开地图。"
  }
  if (location.reviewState === "rejected") {
    return "该位置未公开。修改区域坐标后可以重新提交审核。"
  }
  return "位置正在审核，审核通过前不会显示在公开地图。"
}

export function PublicLocationEditor({
  office,
  location,
  draft,
  disabled,
  busy,
  feedback,
  onChange,
  onSave,
  onReload,
  onWithdraw,
}: {
  office: FudabaOwnerOffice | null
  location: FudabaOwnerLocation | null
  draft: PublicLocationDraft
  disabled: boolean
  busy: boolean
  feedback: WorkspaceFeedback | null
  onChange: (draft: PublicLocationDraft) => void
  onSave: () => void
  onReload: () => void
  onWithdraw: () => void
}) {
  const formDisabled = disabled || busy || office?.status === "archived"

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSave()
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h3>地图公开位置</h3>
        </CardTitle>
        <CardDescription>{reviewDescription(location)}</CardDescription>
        {location ? (
          <CardAction className="flex items-center gap-2">
            <Badge
              variant={
                location.reviewState === "rejected"
                  ? "destructive"
                  : "secondary"
              }
            >
              {locationReviewLabels[location.reviewState]}
            </Badge>
            <Badge variant="outline">版本 {location.revision}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        {feedback ? (
          <Alert
            className="mb-5"
            variant={feedback.kind === "error" ? "destructive" : "default"}
          >
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>
              {feedback.kind === "success"
                ? "操作成功"
                : feedback.kind === "conflict"
                  ? "地图位置版本冲突"
                  : "操作未完成"}
            </AlertTitle>
            <AlertDescription>
              <p>{feedback.message}</p>
              {feedback.kind === "conflict" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={onReload}
                >
                  <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                  载入最新地图位置
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {location?.reviewNote ? (
          <Alert className="mb-5">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>审核备注</AlertTitle>
            <AlertDescription>{location.reviewNote}</AlertDescription>
          </Alert>
        ) : null}

        <Alert className="mb-5">
          <MapPinIcon aria-hidden="true" />
          <AlertTitle>只公开约 0.1 度区域</AlertTitle>
          <AlertDescription>
            请主动填写希望公开的区域中心。这里不会读取或复制左侧的精确坐标；约
            0.1 度通常代表数公里范围，不应填写家庭住址等敏感地点。
          </AlertDescription>
        </Alert>

        <form id="fudaba-public-location-form" onSubmit={submit}>
          <FieldGroup className="grid gap-5 sm:grid-cols-2">
            <Field data-disabled={formDisabled || undefined}>
              <FieldLabel htmlFor="fudaba-public-latitude">区域纬度</FieldLabel>
              <Input
                id="fudaba-public-latitude"
                type="number"
                inputMode="decimal"
                min={-60}
                max={60}
                step={0.1}
                value={draft.latitude}
                required
                disabled={formDisabled || !office}
                placeholder="31.2"
                onChange={(event) =>
                  onChange({ ...draft, latitude: event.currentTarget.value })
                }
              />
              <FieldDescription>
                范围 -60.0 至 60.0，保留 1 位小数。
              </FieldDescription>
            </Field>
            <Field data-disabled={formDisabled || undefined}>
              <FieldLabel htmlFor="fudaba-public-longitude">
                区域经度
              </FieldLabel>
              <Input
                id="fudaba-public-longitude"
                type="number"
                inputMode="decimal"
                min={-180}
                max={180}
                step={0.1}
                value={draft.longitude}
                required
                disabled={formDisabled || !office}
                placeholder="121.5"
                onChange={(event) =>
                  onChange({ ...draft, longitude: event.currentTarget.value })
                }
              />
              <FieldDescription>
                范围 -180.0 至 180.0，保留 1 位小数。
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>

        {location ? (
          <dl className="mt-5 grid gap-3 border-t pt-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">提交时间</dt>
              <dd className="mt-1 font-medium">
                {new Date(location.submittedAt).toLocaleString("zh-CN")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">审核时间</dt>
              <dd className="mt-1 font-medium">
                {location.reviewedAt
                  ? new Date(location.reviewedAt).toLocaleString("zh-CN")
                  : "尚未审核"}
              </dd>
            </div>
          </dl>
        ) : null}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2">
        {location ? (
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  variant="destructive"
                  disabled={formDisabled}
                />
              }
            >
              <Trash2Icon data-icon="inline-start" aria-hidden="true" />
              撤回公开位置
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogMedia>
                  <Trash2Icon aria-hidden="true" />
                </AlertDialogMedia>
                <AlertDialogTitle>撤回地图公开位置？</AlertDialogTitle>
                <AlertDialogDescription>
                  确认后该事务所会立即从区域地图下线。事务所资料和名片不会被删除。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={busy}
                  onClick={onWithdraw}
                >
                  确认撤回
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <span className="text-sm text-muted-foreground">
            当前位置不在地图上
          </span>
        )}
        <Button
          type="submit"
          form="fudaba-public-location-form"
          disabled={formDisabled || !office}
        >
          {busy ? (
            <LoaderCircleIcon
              data-icon="inline-start"
              className="animate-spin"
              aria-hidden="true"
            />
          ) : (
            <SaveIcon data-icon="inline-start" aria-hidden="true" />
          )}
          {busy ? "正在提交" : location ? "重新提交审核" : "提交位置审核"}
        </Button>
      </CardFooter>
    </Card>
  )
}

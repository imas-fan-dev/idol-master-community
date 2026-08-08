import {
  CircleAlertIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SaveIcon,
} from "lucide-react"
import type { FormEvent } from "react"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
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
import { Checkbox } from "~/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "~/components/ui/field"
import { Input } from "~/components/ui/input"
import { Textarea } from "~/components/ui/textarea"
import type { FudabaOwnerOffice, FudabaSeries } from "~/lib/api"
import {
  officeStatusLabels,
  type OfficeDraft,
  type WorkspaceFeedback,
} from "./office-location-model"

export function OfficeEditor({
  mode,
  office,
  draft,
  series,
  disabled,
  busy,
  feedback,
  onChange,
  onSubmit,
  onReload,
}: {
  mode: "create" | "edit"
  office: FudabaOwnerOffice | null
  draft: OfficeDraft
  series: FudabaSeries[]
  disabled: boolean
  busy: boolean
  feedback: WorkspaceFeedback | null
  onChange: (draft: OfficeDraft) => void
  onSubmit: () => void
  onReload: () => void
}) {
  const archived = office?.status === "archived"
  const formDisabled = disabled || busy || archived

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit()
  }

  function toggleSeries(code: string, checked: boolean) {
    onChange({
      ...draft,
      seriesCodes: checked
        ? [...draft.seriesCodes, code]
        : draft.seriesCodes.filter((item) => item !== code),
    })
  }

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>
          <h3>{mode === "create" ? "创建交换事务所" : "事务所资料"}</h3>
        </CardTitle>
        <CardDescription>
          {mode === "create"
            ? "填写事务所的完整资料。创建请求使用幂等键，网络重试不会重复建所。"
            : "维护事务所的精确资料和交换状态。"}
        </CardDescription>
        {office ? (
          <CardAction className="flex items-center gap-2">
            <Badge
              variant={office.status === "active" ? "secondary" : "outline"}
            >
              {officeStatusLabels[office.status]}
            </Badge>
            <Badge variant="outline">版本 {office.revision}</Badge>
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
                  ? "事务所版本冲突"
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
                  载入最新事务所
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {archived ? (
          <Alert className="mb-5">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>事务所已归档</AlertTitle>
            <AlertDescription>
              已归档事务所保留资料，但不能在此工作面继续编辑。
            </AlertDescription>
          </Alert>
        ) : null}

        <form id="fudaba-office-form" onSubmit={submit}>
          <FieldGroup>
            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <Field data-disabled={formDisabled || undefined}>
                <FieldLabel htmlFor="fudaba-office-name">事务所名称</FieldLabel>
                <Input
                  id="fudaba-office-name"
                  value={draft.name}
                  maxLength={80}
                  required
                  disabled={formDisabled}
                  placeholder="例如：浦江放课后事务所"
                  onChange={(event) =>
                    onChange({ ...draft, name: event.currentTarget.value })
                  }
                />
              </Field>
              <Field data-disabled={formDisabled || undefined}>
                <FieldLabel htmlFor="fudaba-office-city">城市</FieldLabel>
                <Input
                  id="fudaba-office-city"
                  value={draft.city}
                  maxLength={100}
                  required
                  disabled={formDisabled}
                  placeholder="上海"
                  onChange={(event) =>
                    onChange({ ...draft, city: event.currentTarget.value })
                  }
                />
              </Field>
            </FieldGroup>

            <Field data-disabled={formDisabled || undefined}>
              <FieldLabel htmlFor="fudaba-office-address">具体地点</FieldLabel>
              <Input
                id="fudaba-office-address"
                value={draft.address}
                maxLength={240}
                required
                disabled={formDisabled}
                placeholder="例如：场馆入口或集合点"
                onChange={(event) =>
                  onChange({ ...draft, address: event.currentTarget.value })
                }
              />
            </Field>

            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <Field data-disabled={formDisabled || undefined}>
                <FieldLabel htmlFor="fudaba-office-latitude">
                  精确纬度
                </FieldLabel>
                <Input
                  id="fudaba-office-latitude"
                  type="number"
                  inputMode="decimal"
                  min={-90}
                  max={90}
                  step="any"
                  value={draft.latitude}
                  required
                  disabled={formDisabled}
                  onChange={(event) =>
                    onChange({ ...draft, latitude: event.currentTarget.value })
                  }
                />
              </Field>
              <Field data-disabled={formDisabled || undefined}>
                <FieldLabel htmlFor="fudaba-office-longitude">
                  精确经度
                </FieldLabel>
                <Input
                  id="fudaba-office-longitude"
                  type="number"
                  inputMode="decimal"
                  min={-180}
                  max={180}
                  step="any"
                  value={draft.longitude}
                  required
                  disabled={formDisabled}
                  onChange={(event) =>
                    onChange({ ...draft, longitude: event.currentTarget.value })
                  }
                />
              </Field>
            </FieldGroup>

            <Alert>
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>精确位置不会直接公开</AlertTitle>
              <AlertDescription>
                这组坐标属于事务所资料，不会自动带入地图。公开地图位置必须在右侧单独输入并提交审核。
              </AlertDescription>
            </Alert>

            <FieldSet disabled={formDisabled}>
              <FieldLegend>所属企划</FieldLegend>
              <FieldDescription>
                至少选择 1 个，最多选择 8 个。
              </FieldDescription>
              <div
                data-slot="checkbox-group"
                className="grid gap-3 sm:grid-cols-2"
              >
                {series.map((item) => {
                  const checked = draft.seriesCodes.includes(item.code)
                  return (
                    <Field key={item.code} orientation="horizontal">
                      <Checkbox
                        id={`fudaba-office-series-${item.code}`}
                        checked={checked}
                        disabled={
                          formDisabled ||
                          (!checked && draft.seriesCodes.length >= 8)
                        }
                        onCheckedChange={(value) =>
                          toggleSeries(item.code, Boolean(value))
                        }
                      />
                      <FieldLabel htmlFor={`fudaba-office-series-${item.code}`}>
                        {item.displayName}
                      </FieldLabel>
                    </Field>
                  )
                })}
              </div>
            </FieldSet>

            <Field data-disabled={formDisabled || undefined}>
              <FieldLabel htmlFor="fudaba-office-intro">事务所介绍</FieldLabel>
              <Textarea
                id="fudaba-office-intro"
                value={draft.intro}
                maxLength={2000}
                disabled={formDisabled}
                className="min-h-28 resize-y"
                placeholder="这里通常有哪些制作人，适合怎样交换？"
                onChange={(event) =>
                  onChange({ ...draft, intro: event.currentTarget.value })
                }
              />
            </Field>

            <FieldGroup className="grid gap-5 sm:grid-cols-2">
              <Field data-disabled={formDisabled || undefined}>
                <FieldLabel htmlFor="fudaba-office-accent">强调色</FieldLabel>
                <div className="flex min-w-0 items-center gap-3">
                  <Input
                    id="fudaba-office-accent"
                    type="color"
                    value={draft.accent}
                    disabled={formDisabled}
                    className="size-10 shrink-0 cursor-pointer p-1"
                    onChange={(event) =>
                      onChange({ ...draft, accent: event.currentTarget.value })
                    }
                  />
                  <output className="min-w-0 font-mono text-sm text-muted-foreground">
                    {draft.accent.toUpperCase()}
                  </output>
                </div>
              </Field>
              <Field
                orientation="horizontal"
                data-disabled={formDisabled || undefined}
              >
                <Checkbox
                  id="fudaba-office-open"
                  checked={draft.isOpen}
                  disabled={formDisabled}
                  onCheckedChange={(value) =>
                    onChange({ ...draft, isOpen: Boolean(value) })
                  }
                />
                <div className="flex flex-col gap-1">
                  <FieldLabel htmlFor="fudaba-office-open">
                    接受现场交换
                  </FieldLabel>
                  <FieldDescription>
                    关闭后事务所仍可见，但会标记为暂不交换。
                  </FieldDescription>
                </div>
              </Field>
            </FieldGroup>
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button
          type="submit"
          form="fudaba-office-form"
          disabled={formDisabled || series.length === 0}
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
          {busy
            ? mode === "create"
              ? "正在创建"
              : "正在保存"
            : mode === "create"
              ? "创建事务所"
              : "保存事务所"}
        </Button>
      </CardFooter>
    </Card>
  )
}

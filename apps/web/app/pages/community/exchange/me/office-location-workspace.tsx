import {
  Building2Icon,
  CircleAlertIcon,
  MapPinnedIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert"
import { Button } from "~/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty"
import { Field, FieldLabel } from "~/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select"
import { Skeleton } from "~/components/ui/skeleton"
import {
  createFudabaOffice,
  getFudabaOwnerLocation,
  getFudabaOwnerOffice,
  getFudabaOwnerOffices,
  saveFudabaOwnerLocation,
  updateFudabaOwnerOffice,
  withdrawFudabaOwnerLocation,
  type FudabaOwnerLocation,
  type FudabaOwnerOffice,
  type FudabaSeries,
} from "~/lib/api"
import { apiMessage, isFeatureClosed } from "./exchange-me-model"
import { OfficeEditor } from "./office-editor"
import {
  emptyOfficeDraft,
  isLocationConflict,
  isOfficeConflict,
  officeDraft,
  parseOfficeDraft,
  parsePublicLocationDraft,
  publicLocationDraft,
  type OfficeDraft,
  type PublicLocationDraft,
  type WorkspaceFeedback,
} from "./office-location-model"
import { PublicLocationEditor } from "./public-location-editor"

type WorkspacePhase = "loading" | "ready" | "error"

function newIdempotencyKey() {
  return `fudaba-office-${globalThis.crypto.randomUUID()}`
}

export function OfficeLocationWorkspace({
  series,
  homeCity,
  readOnly,
  onWriteClosed,
}: {
  series: FudabaSeries[]
  homeCity: string | null
  readOnly: boolean
  onWriteClosed: () => void
}) {
  const [phase, setPhase] = useState<WorkspacePhase>("loading")
  const [offices, setOffices] = useState<FudabaOwnerOffice[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [office, setOffice] = useState<FudabaOwnerOffice | null>(null)
  const [location, setLocation] = useState<FudabaOwnerLocation | null>(null)
  const [creating, setCreating] = useState(false)
  const [loadingSelection, setLoadingSelection] = useState(false)
  const [savingOffice, setSavingOffice] = useState(false)
  const [savingLocation, setSavingLocation] = useState(false)
  const [officeDraftState, setOfficeDraftState] = useState<OfficeDraft>(() =>
    emptyOfficeDraft(homeCity, series)
  )
  const [locationDraftState, setLocationDraftState] =
    useState<PublicLocationDraft>(() => publicLocationDraft(null))
  const [officeFeedback, setOfficeFeedback] =
    useState<WorkspaceFeedback | null>(null)
  const [locationFeedback, setLocationFeedback] =
    useState<WorkspaceFeedback | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const generation = useRef(0)
  const selectedIdRef = useRef<string | null>(null)
  const selectionTargetIdRef = useRef<string | null>(null)
  const createKey = useRef<string | null>(null)
  const createFingerprint = useRef<string | null>(null)

  function mutationIsCurrent(
    requestGeneration: number,
    targetOfficeId: string | null
  ) {
    return (
      generation.current === requestGeneration &&
      selectionTargetIdRef.current === targetOfficeId
    )
  }

  const loadSelection = useCallback(async (officeId: string) => {
    const current = ++generation.current
    selectionTargetIdRef.current = officeId
    setSavingOffice(false)
    setSavingLocation(false)
    setLoadingSelection(true)
    setOfficeFeedback(null)
    setLocationFeedback(null)
    try {
      const [officeResult, locationResult] = await Promise.all([
        getFudabaOwnerOffice(officeId).send(),
        getFudabaOwnerLocation(officeId).send(),
      ])
      if (generation.current !== current) return
      selectedIdRef.current = officeId
      setSelectedId(officeId)
      setOffice(officeResult.office)
      setLocation(locationResult.location)
      setOfficeDraftState(officeDraft(officeResult.office))
      setLocationDraftState(publicLocationDraft(locationResult.location))
      setOffices((items) =>
        items.map((item) =>
          item.id === officeResult.office.id ? officeResult.office : item
        )
      )
      setCreating(false)
    } catch (error) {
      if (generation.current !== current) return
      selectionTargetIdRef.current = selectedIdRef.current
      setOfficeFeedback({
        kind: "error",
        message: apiMessage(error, "事务所详情载入失败，请重试。"),
      })
    } finally {
      if (generation.current === current) setLoadingSelection(false)
    }
  }, [])

  const loadWorkspace = useCallback(async () => {
    const current = ++generation.current
    selectionTargetIdRef.current = selectedIdRef.current
    setSavingOffice(false)
    setSavingLocation(false)
    setPhase("loading")
    setLoadError(null)
    try {
      const result = await getFudabaOwnerOffices().send()
      if (generation.current !== current) return
      setOffices(result.items)
      setPhase("ready")
      const nextId =
        result.items.find((item) => item.id === selectedIdRef.current)?.id ??
        result.items[0]?.id ??
        null
      if (!nextId) {
        selectedIdRef.current = null
        selectionTargetIdRef.current = null
        setSelectedId(null)
        setOffice(null)
        setLocation(null)
        setCreating(true)
        setOfficeDraftState(emptyOfficeDraft(homeCity, series))
        setLocationDraftState(publicLocationDraft(null))
        return
      }
      void loadSelection(nextId)
    } catch (error) {
      if (generation.current !== current) return
      setPhase("error")
      setLoadError(apiMessage(error, "事务所与地图位置暂时无法加载。"))
    }
  }, [homeCity, loadSelection, series])

  useEffect(() => {
    const timer = globalThis.setTimeout(() => void loadWorkspace(), 0)
    return () => {
      globalThis.clearTimeout(timer)
      generation.current += 1
    }
  }, [loadWorkspace])

  function beginCreate() {
    generation.current += 1
    setSavingOffice(false)
    setSavingLocation(false)
    selectedIdRef.current = null
    selectionTargetIdRef.current = null
    setCreating(true)
    setSelectedId(null)
    setOffice(null)
    setLocation(null)
    setOfficeDraftState(emptyOfficeDraft(homeCity, series))
    setLocationDraftState(publicLocationDraft(null))
    setOfficeFeedback(null)
    setLocationFeedback(null)
    setLoadingSelection(false)
    createKey.current = null
    createFingerprint.current = null
  }

  function replaceOffice(saved: FudabaOwnerOffice) {
    setOffices((items) => [
      saved,
      ...items.filter((item) => item.id !== saved.id),
    ])
    setOffice(saved)
    selectedIdRef.current = saved.id
    selectionTargetIdRef.current = saved.id
    setSelectedId(saved.id)
    setOfficeDraftState(officeDraft(saved))
  }

  function mutationClosed(error: unknown) {
    if (!isFeatureClosed(error)) return false
    onWriteClosed()
    return true
  }

  async function submitOffice() {
    const parsed = parseOfficeDraft(officeDraftState)
    if (!parsed.success) {
      setOfficeFeedback({
        kind: "error",
        message:
          "请填写完整有效的事务所名称、地点、精确坐标，并至少选择一个企划。",
      })
      return
    }
    const requestGeneration = generation.current
    const targetOfficeId = creating ? null : (office?.id ?? null)
    if (!creating && !targetOfficeId) return
    setSavingOffice(true)
    setOfficeFeedback(null)
    try {
      if (creating) {
        const fingerprint = JSON.stringify(parsed.data)
        if (!createKey.current || createFingerprint.current !== fingerprint) {
          createKey.current = newIdempotencyKey()
          createFingerprint.current = fingerprint
        }
        const result = await createFudabaOffice(
          parsed.data,
          createKey.current
        ).send()
        if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
        replaceOffice(result.office)
        setCreating(false)
        setLocation(null)
        setLocationDraftState(publicLocationDraft(null))
        createKey.current = null
        createFingerprint.current = null
        setOfficeFeedback({ kind: "success", message: "交换事务所已创建。" })
        toast.success("交换事务所已创建")
        return
      }
      if (!office || !targetOfficeId) return
      const result = await updateFudabaOwnerOffice(targetOfficeId, {
        ...parsed.data,
        expectedRevision: office.revision,
      }).send()
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      replaceOffice(result.office)
      setOfficeFeedback({ kind: "success", message: "事务所资料已保存。" })
      toast.success("事务所资料已保存")
    } catch (error) {
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      if (mutationClosed(error)) {
        setOfficeFeedback({ kind: "error", message: "事务所编辑当前未开放。" })
      } else if (isOfficeConflict(error)) {
        setOfficeFeedback({
          kind: "conflict",
          message:
            "事务所已在其他窗口更新。当前输入仍保留，请载入最新版本后再修改。",
        })
      } else {
        setOfficeFeedback({
          kind: "error",
          message: apiMessage(error, "事务所保存失败，请重试。"),
        })
      }
    } finally {
      if (generation.current === requestGeneration) setSavingOffice(false)
    }
  }

  async function reloadOffice() {
    if (!office) return
    await loadSelection(office.id)
  }

  async function submitLocation() {
    if (!office) return
    const requestGeneration = generation.current
    const targetOfficeId = office.id
    const parsed = parsePublicLocationDraft(
      locationDraftState,
      location?.revision ?? null
    )
    if (!parsed.success) {
      setLocationFeedback({
        kind: "error",
        message:
          "公开位置必须位于有效范围，并严格使用 0.1 度网格，例如 31.2、121.5。",
      })
      return
    }
    setSavingLocation(true)
    setLocationFeedback(null)
    try {
      const result = await saveFudabaOwnerLocation(
        targetOfficeId,
        parsed.data
      ).send()
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      setLocation(result.officeLocation)
      setLocationDraftState(publicLocationDraft(result.officeLocation))
      setLocationFeedback({
        kind: "success",
        message: "区域位置已提交审核，审核通过前不会出现在公开地图。",
      })
      toast.success("区域位置已提交审核")
    } catch (error) {
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      if (mutationClosed(error)) {
        setLocationFeedback({
          kind: "error",
          message: "地图位置编辑当前未开放。",
        })
      } else if (isLocationConflict(error)) {
        setLocationFeedback({
          kind: "conflict",
          message:
            "地图位置已在其他窗口更新。当前输入仍保留，请载入最新版本后再修改。",
        })
      } else {
        setLocationFeedback({
          kind: "error",
          message: apiMessage(error, "地图位置提交失败，请重试。"),
        })
      }
    } finally {
      if (generation.current === requestGeneration) setSavingLocation(false)
    }
  }

  async function reloadLocation() {
    if (!office) return
    const requestGeneration = generation.current
    const targetOfficeId = office.id
    setSavingLocation(true)
    try {
      const result = await getFudabaOwnerLocation(targetOfficeId).send()
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      setLocation(result.location)
      setLocationDraftState(publicLocationDraft(result.location))
      setLocationFeedback({ kind: "success", message: "已载入最新地图位置。" })
    } catch (error) {
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      setLocationFeedback({
        kind: "error",
        message: apiMessage(error, "最新地图位置载入失败，请重试。"),
      })
    } finally {
      if (generation.current === requestGeneration) setSavingLocation(false)
    }
  }

  async function withdrawLocation() {
    if (!office || !location) return
    const requestGeneration = generation.current
    const targetOfficeId = office.id
    const targetRevision = location.revision
    setSavingLocation(true)
    setLocationFeedback(null)
    try {
      await withdrawFudabaOwnerLocation(targetOfficeId, targetRevision).send()
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      setLocation(null)
      setLocationFeedback({
        kind: "success",
        message: "公开位置已撤回，事务所已从区域地图下线。",
      })
      toast.success("事务所已从区域地图下线")
    } catch (error) {
      if (!mutationIsCurrent(requestGeneration, targetOfficeId)) return
      if (mutationClosed(error)) {
        setLocationFeedback({
          kind: "error",
          message: "地图位置编辑当前未开放。",
        })
      } else if (isLocationConflict(error)) {
        setLocationFeedback({
          kind: "conflict",
          message:
            "地图位置已在其他窗口更新，未执行撤回。请载入最新版本后重试。",
        })
      } else {
        setLocationFeedback({
          kind: "error",
          message: apiMessage(error, "地图位置撤回失败，请重试。"),
        })
      }
    } finally {
      if (generation.current === requestGeneration) setSavingLocation(false)
    }
  }

  const mutationPending = savingOffice || savingLocation

  return (
    <section
      className="border-t bg-muted/15"
      aria-labelledby="fudaba-office-location-title"
    >
      <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-muted-foreground">
              OFFICE &amp; REGIONAL MAP
            </p>
            <h2
              id="fudaba-office-location-title"
              className="mt-2 text-xl font-semibold"
            >
              我的事务所与地图位置
            </h2>
            <p className="mt-2 leading-7 text-muted-foreground">
              事务所精确资料与公开区域位置分开维护，地图只显示审核后的 0.1
              度网格。
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
            {offices.length ? (
              <Field className="min-w-0 sm:w-72">
                <FieldLabel htmlFor="fudaba-owner-office-select">
                  当前事务所
                </FieldLabel>
                <Select
                  value={selectedId ?? ""}
                  disabled={
                    phase !== "ready" || loadingSelection || mutationPending
                  }
                  onValueChange={(value) => {
                    const nextId = String(value ?? "")
                    if (nextId) void loadSelection(nextId)
                  }}
                >
                  <SelectTrigger
                    id="fudaba-owner-office-select"
                    className="w-full"
                  >
                    <SelectValue placeholder="选择事务所">
                      {offices.find((item) => item.id === selectedId)?.name ??
                        ""}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectGroup>
                      {offices.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="刷新我的事务所"
                title="刷新"
                disabled={mutationPending}
                onClick={() => void loadWorkspace()}
              >
                <RefreshCwIcon aria-hidden="true" />
              </Button>
              <Button
                type="button"
                disabled={readOnly || mutationPending}
                onClick={beginCreate}
              >
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                新建事务所
              </Button>
            </div>
          </div>
        </div>

        {phase === "loading" ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-160 w-full" />
            <Skeleton className="h-112 w-full" />
          </div>
        ) : phase === "error" ? (
          <Alert className="mt-8" variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>事务所工作区暂时无法加载</AlertTitle>
            <AlertDescription>
              <p>{loadError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void loadWorkspace()}
              >
                <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
                重新载入
              </Button>
            </AlertDescription>
          </Alert>
        ) : loadingSelection ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-160 w-full" />
            <Skeleton className="h-112 w-full" />
          </div>
        ) : creating ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <OfficeEditor
              mode="create"
              office={null}
              draft={officeDraftState}
              series={series}
              disabled={readOnly}
              busy={savingOffice}
              feedback={officeFeedback}
              onChange={setOfficeDraftState}
              onSubmit={() => void submitOffice()}
              onReload={() => undefined}
            />
            <Empty className="min-h-80 border-y lg:border-y-0 lg:border-l">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MapPinnedIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>创建后再设置公开区域</EmptyTitle>
                <EmptyDescription>
                  地图位置不会从精确坐标自动生成。事务所创建成功后，请单独输入希望公开的
                  0.1 度区域位置。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        ) : office ? (
          <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-2 lg:items-start">
            <OfficeEditor
              mode="edit"
              office={office}
              draft={officeDraftState}
              series={series}
              disabled={readOnly}
              busy={savingOffice}
              feedback={officeFeedback}
              onChange={setOfficeDraftState}
              onSubmit={() => void submitOffice()}
              onReload={() => void reloadOffice()}
            />
            <PublicLocationEditor
              office={office}
              location={location}
              draft={locationDraftState}
              disabled={readOnly}
              busy={savingLocation}
              feedback={locationFeedback}
              onChange={setLocationDraftState}
              onSave={() => void submitLocation()}
              onReload={() => void reloadLocation()}
              onWithdraw={() => void withdrawLocation()}
            />
          </div>
        ) : (
          <Empty className="mt-8 min-h-72 border-y">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Building2Icon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>还没有交换事务所</EmptyTitle>
              <EmptyDescription>
                创建事务所后，可以继续提交区域地图位置。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  )
}

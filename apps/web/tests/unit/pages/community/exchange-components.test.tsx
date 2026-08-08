import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { FudabaPlacedCard } from "~/lib/api"
import { PlacedCardWall } from "~/pages/community/exchange/exchange-components"

const baseCard: FudabaPlacedCard = {
  id: "card-start",
  producerName: "春香P",
  displayName: "边界名片",
  seriesCode: "765",
  favoriteIdol: "天海春香",
  frontImageUrl: "/brand/series/wall/765pro.webp",
  backImageUrl: "/brand/series/wall/cinderella-girls.webp",
  accent: "#f34e6c",
  bio: "",
  tradeNote: "现场交换",
  available: true,
  source: null,
  createdAt: "2026-08-02T08:00:00.000Z",
  interactions: {
    likes: 0,
    favorites: 0,
    viewerLiked: false,
    viewerFavorited: false,
  },
  viewerOwned: true,
  placement: {
    pinnedAt: "2026-08-02T09:00:00.000Z",
    x: 0,
    y: 0,
    rotation: -12,
    zIndex: 1,
    revision: 3,
    updatedAt: "2026-08-02T09:00:00.000Z",
  },
}

describe("PlacedCardWall", () => {
  it("keeps valid boundary coordinates inside the visible wall", () => {
    render(
      <PlacedCardWall
        cards={[
          baseCard,
          {
            ...baseCard,
            id: "card-end",
            displayName: "另一侧边界名片",
            placement: {
              ...baseCard.placement,
              x: 100,
              y: 100,
              rotation: 12,
              zIndex: 2,
            },
          },
        ]}
      />
    )

    const start = screen.getByRole("button", {
      name: "查看边界名片正面",
    }).parentElement
    const end = screen.getByRole("button", {
      name: "查看另一侧边界名片正面",
    }).parentElement

    expect(start?.style.left).toBe(
      "clamp(var(--wall-x-inset), 0%, calc(100% - var(--wall-x-inset)))"
    )
    expect(start?.style.top).toBe(
      "clamp(var(--wall-y-inset), 0%, calc(100% - var(--wall-y-inset)))"
    )
    expect(end?.style.left).toBe(
      "clamp(var(--wall-x-inset), 100%, calc(100% - var(--wall-x-inset)))"
    )
    expect(end?.style.top).toBe(
      "clamp(var(--wall-y-inset), 100%, calc(100% - var(--wall-y-inset)))"
    )
  })

  it("moves an owned card with the keyboard and commits its revision", async () => {
    const user = userEvent.setup()
    const preview = vi.fn()
    const commit = vi.fn()

    render(
      <PlacedCardWall
        cards={[{ ...baseCard, placement: { ...baseCard.placement, x: 50 } }]}
        editing
        onPlacementPreview={preview}
        onPlacementCommit={commit}
      />
    )

    const handle = await screen.findByRole("button", { name: "移动边界名片" })
    handle.focus()
    await user.keyboard("{ArrowRight}")

    expect(preview).toHaveBeenCalledWith(
      "card-start",
      expect.objectContaining({ x: 51, y: 0 })
    )
    expect(commit).toHaveBeenCalledWith(
      "card-start",
      expect.objectContaining({ revision: 3, x: 50 }),
      expect.objectContaining({ x: 51, y: 0 })
    )
  })

  it("keeps other users' cards read-only while supporting card flipping", async () => {
    const user = userEvent.setup()
    render(
      <PlacedCardWall cards={[{ ...baseCard, viewerOwned: false }]} editing />
    )

    expect(
      screen.queryByRole("button", { name: "移动边界名片" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "边界名片翻到背面" }))
    expect(
      screen.getByRole("button", { name: "查看边界名片背面" })
    ).toBeVisible()
  })

  it("rotates, brings forward, and confirms removal of the selected card", async () => {
    const user = userEvent.setup()
    const preview = vi.fn()
    const commit = vi.fn()
    const remove = vi.fn()
    render(
      <PlacedCardWall
        cards={[
          {
            ...baseCard,
            placement: {
              ...baseCard.placement,
              rotation: 0,
              zIndex: 1,
            },
          },
          {
            ...baseCard,
            id: "card-front",
            displayName: "前层名片",
            viewerOwned: false,
            placement: { ...baseCard.placement, zIndex: 4 },
          },
        ]}
        editing
        onPlacementPreview={preview}
        onPlacementCommit={commit}
        onRemove={remove}
      />
    )

    await screen.findByRole("button", { name: "移动边界名片" })
    await user.click(screen.getByRole("button", { name: "向右旋转名片" }))
    expect(commit).toHaveBeenCalledWith(
      "card-start",
      expect.objectContaining({ revision: 3 }),
      expect.objectContaining({ rotation: 2 })
    )

    await user.click(screen.getByRole("button", { name: "将名片移到最前" }))
    expect(preview).toHaveBeenLastCalledWith(
      "card-start",
      expect.objectContaining({ zIndex: 5 })
    )

    await user.click(screen.getByRole("button", { name: "从名片墙移除" }))
    expect(await screen.findByText("从名片墙移除？")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "移除" }))
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "card-start" })
      )
    })
  })

  it("uses the successful write time to break ties at maximum z-index", async () => {
    const user = userEvent.setup()
    const preview = vi.fn()
    const commit = vi.fn()
    const selectedCard = {
      ...baseCard,
      placement: {
        ...baseCard.placement,
        zIndex: 999,
        updatedAt: "2026-08-02T09:00:00.000Z",
      },
    }
    const currentFrontCard = {
      ...baseCard,
      id: "card-front",
      displayName: "当前最前名片",
      viewerOwned: false,
      placement: {
        ...baseCard.placement,
        zIndex: 999,
        updatedAt: "2026-08-02T10:00:00.000Z",
      },
    }
    const { container, rerender } = render(
      <PlacedCardWall
        cards={[selectedCard, currentFrontCard]}
        editing
        onPlacementPreview={preview}
        onPlacementCommit={commit}
      />
    )

    expect(
      Array.from(container.querySelectorAll("[data-card-id]"), (element) =>
        element.getAttribute("data-card-id")
      )
    ).toEqual(["card-start", "card-front"])

    const bringToFront = screen.getByRole("button", {
      name: "将名片移到最前",
    })
    expect(bringToFront).toBeEnabled()
    await user.click(bringToFront)

    expect(preview).not.toHaveBeenCalled()
    expect(commit).toHaveBeenCalledWith(
      "card-start",
      expect.objectContaining({ revision: 3, zIndex: 999 }),
      expect.objectContaining({ zIndex: 999 })
    )

    rerender(
      <PlacedCardWall
        cards={[
          {
            ...selectedCard,
            placement: {
              ...selectedCard.placement,
              revision: 4,
              updatedAt: "2026-08-02T11:00:00.000Z",
            },
          },
          currentFrontCard,
        ]}
        editing
        onPlacementPreview={preview}
        onPlacementCommit={commit}
      />
    )

    expect(
      Array.from(container.querySelectorAll("[data-card-id]"), (element) =>
        element.getAttribute("data-card-id")
      )
    ).toEqual(["card-front", "card-start"])
    expect(bringToFront).toBeDisabled()
  })
})

import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ImageLoadingIndicator } from "~/components/shared/image-loading-indicator"

function createImage({
  complete,
  naturalWidth = 0,
}: {
  complete: boolean
  naturalWidth?: number
}) {
  const image = document.createElement("img")
  image.src = "/uploads/test.webp"
  Object.defineProperty(image, "complete", {
    configurable: true,
    value: complete,
  })
  Object.defineProperty(image, "naturalWidth", {
    configurable: true,
    value: naturalWidth,
  })
  return image
}

describe("ImageLoadingIndicator", () => {
  afterEach(() => {
    document.querySelectorAll("img").forEach((image) => image.remove())
  })

  it("marks existing images as busy until they load", () => {
    const image = createImage({ complete: false })
    document.body.append(image)

    render(<ImageLoadingIndicator />)

    expect(image).toHaveAttribute("data-image-state", "loading")
    expect(image).toHaveAttribute("aria-busy", "true")

    fireEvent.load(image)

    expect(image).toHaveAttribute("data-image-state", "loaded")
    expect(image).not.toHaveAttribute("aria-busy")
  })

  it("keeps decorative loading images out of the accessibility tree", () => {
    const image = createImage({ complete: false })
    image.alt = ""
    document.body.append(image)

    render(<ImageLoadingIndicator />)

    expect(image).toHaveAttribute("data-image-state", "loading")
    expect(image).not.toHaveAttribute("aria-busy")
  })

  it("observes dynamically inserted images and stops animation on errors", async () => {
    render(<ImageLoadingIndicator />)
    const image = createImage({ complete: false })

    document.body.append(image)

    await waitFor(() => {
      expect(image).toHaveAttribute("data-image-state", "loading")
    })

    fireEvent.error(image)

    expect(image).toHaveAttribute("data-image-state", "error")
    expect(image).not.toHaveAttribute("aria-busy")
  })

  it("does not animate images that already loaded from cache", () => {
    const image = createImage({ complete: true, naturalWidth: 640 })
    document.body.append(image)

    render(<ImageLoadingIndicator />)

    expect(image).toHaveAttribute("data-image-state", "loaded")
    expect(image).not.toHaveAttribute("aria-busy")
  })
})

import { useEffect } from "react"

type ImageLoadingState = "loading" | "loaded" | "error"

function hasImageSource(image: HTMLImageElement) {
  return Boolean(
    image.currentSrc ||
    image.getAttribute("src") ||
    image.getAttribute("srcset")
  )
}

function setImageLoadingState(
  image: HTMLImageElement,
  state: ImageLoadingState
) {
  image.dataset.imageState = state

  if (state === "loading" && image.getAttribute("alt") !== "") {
    image.setAttribute("aria-busy", "true")
    return
  }

  image.removeAttribute("aria-busy")
}

function syncImageLoadingState(image: HTMLImageElement) {
  if (!hasImageSource(image)) {
    delete image.dataset.imageState
    image.removeAttribute("aria-busy")
    return
  }

  if (!image.complete) {
    setImageLoadingState(image, "loading")
    return
  }

  setImageLoadingState(image, image.naturalWidth > 0 ? "loaded" : "error")
}

export function observeImageLoading(contentDocument: Document) {
  const contentWindow = contentDocument.defaultView
  const documentRoot = contentDocument.documentElement

  if (!contentWindow || !documentRoot) return () => undefined

  const { Element, HTMLImageElement, MutationObserver } = contentWindow

  function syncImagesInNode(node: Node) {
    if (node instanceof HTMLImageElement) {
      syncImageLoadingState(node)
      return
    }

    if (!(node instanceof Element)) return

    node.querySelectorAll("img").forEach(syncImageLoadingState)

    if (node.localName === "source") {
      const picture = node.closest("picture")
      const image = picture?.querySelector("img")
      if (image) syncImageLoadingState(image)
    }
  }

  function handleLoad(event: Event) {
    if (event.target instanceof HTMLImageElement) {
      setImageLoadingState(event.target, "loaded")
    }
  }

  function handleError(event: Event) {
    if (event.target instanceof HTMLImageElement) {
      setImageLoadingState(event.target, "error")
    }
  }

  contentDocument.querySelectorAll("img").forEach(syncImageLoadingState)
  contentDocument.addEventListener("load", handleLoad, true)
  contentDocument.addEventListener("error", handleError, true)

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "attributes") {
        syncImagesInNode(mutation.target)
        return
      }

      mutation.addedNodes.forEach(syncImagesInNode)
    })
  })

  observer.observe(documentRoot, {
    attributes: true,
    attributeFilter: ["sizes", "src", "srcset"],
    childList: true,
    subtree: true,
  })

  return () => {
    observer.disconnect()
    contentDocument.removeEventListener("load", handleLoad, true)
    contentDocument.removeEventListener("error", handleError, true)
  }
}

export function ImageLoadingIndicator() {
  useEffect(() => observeImageLoading(document), [])

  return null
}

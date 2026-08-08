import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { BrandWordmark } from "~/components/shared/brand-wordmark"

describe("BrandWordmark", () => {
  it("renders the restored IMSWeb logo with stable dimensions", () => {
    render(<BrandWordmark />)

    const logo = screen.getByRole("img", { name: "偶像大师交流站" })
    expect(logo).toHaveAttribute("src", "/brand/imsweb-logo.webp")
    expect(logo).toHaveAttribute("width", "545")
    expect(logo).toHaveAttribute("height", "188")
  })

  it("can be decorative when its parent already names the destination", () => {
    const { container } = render(<BrandWordmark alt="" />)

    expect(screen.queryByRole("img")).not.toBeInTheDocument()
    expect(container.querySelector("img")).toHaveAttribute("alt", "")
  })
})

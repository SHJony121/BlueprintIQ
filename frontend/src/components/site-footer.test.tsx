// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SiteFooter, sourceUrl } from "./site-footer";

describe("the source offer in the footer", () => {
  it("states the licence and warranty position", () => {
    render(<SiteFooter source={null} />);
    const footer = screen.getByRole("contentinfo");
    expect(footer.textContent).toMatch(/GNU Affero General Public License v3/);
    expect(footer.textContent).toMatch(/no warranty/);
    expect(footer.textContent).toMatch(/not certified/);
  });

  it("links the source and the notices when a source address is configured", () => {
    render(
      <SiteFooter source={new URL("https://github.com/example/blueprintiq")} />,
    );
    expect(
      screen.getByRole("link", { name: "Source code" }).getAttribute("href"),
    ).toBe("https://github.com/example/blueprintiq");
    expect(
      screen
        .getByRole("link", { name: "third-party notices" })
        .getAttribute("href"),
    ).toBe("https://github.com/example/blueprintiq/blob/main/NOTICE.md");
  });

  it("still points at the repository text when none is configured, with no broken link", () => {
    render(<SiteFooter source={null} />);
    expect(screen.queryByRole("link", { name: "Source code" })).toBeNull();
    expect(screen.getByTestId("source-offer").textContent).toMatch(
      /project repository/,
    );
  });

  it.each([
    ["https://github.com/example/x", "https://github.com/example/x"],
    [" http://localhost:3000/ ", "http://localhost:3000/"],
  ])("accepts %s", (raw, href) => expect(sourceUrl(raw)?.href).toBe(href));

  it.each([
    undefined,
    "",
    "   ",
    "javascript:alert(1)",
    "ftp://example.com/x",
    "not a url",
    "data:text/html,x",
  ])("ignores %j", (raw) => expect(sourceUrl(raw)).toBeNull());
});

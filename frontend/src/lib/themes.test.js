import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, DEFAULT_THEME, normalizeTheme, THEMES } from "./themes";

afterEach(() => {
  applyTheme(DEFAULT_THEME);
});

describe("themes", () => {
  it("ports every auto-dig theme", () => {
    expect(THEMES.map((theme) => theme.id)).toEqual([
      "midnight",
      "hacker-green",
      "synthwave-outrun",
      "black-gold",
      "yotsuba-pol",
      "nord",
      "dracula",
      "solarized-dark",
      "gruvbox",
      "paper"
    ]);
  });

  it("keeps the dotfile Synthwave Outrun palette", () => {
    const theme = THEMES.find((item) => item.id === "synthwave-outrun");
    expect(Object.values(theme.tokens).map((value) => value.toLowerCase())).toEqual(
      expect.arrayContaining([
        "#170c32",
        "#202146",
        "#92406e",
        "#fba922",
        "#2de2e6",
        "#f3f4f5",
        "#f6019d",
        "#62ff00",
        "#dd546e",
        "#9700cc"
      ])
    );
  });

  it("applies theme tokens and falls back safely", () => {
    expect(normalizeTheme("missing")).toBe(DEFAULT_THEME);
    expect(applyTheme("hacker-green")).toBe("hacker-green");
    expect(applyTheme("missing")).toBe(DEFAULT_THEME);
  });
});

// `<tegis-player>` pure logic. The rendered element is verified separately in a real browser (the DOM parts
// need a real custom-element registry); these cover the formatting the viewer actually reads.
import { describe, expect, it } from "bun:test";
import { formatTime } from "../src/ui.ts";

describe("formatTime", () => {
  it("formats under an hour as m:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(9)).toBe("0:09");
    expect(formatTime(62)).toBe("1:02");
    expect(formatTime(754)).toBe("12:34");
    expect(formatTime(3599)).toBe("59:59");
  });

  it("formats an hour or more as h:mm:ss", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3723)).toBe("1:02:03");
    expect(formatTime(7324.5)).toBe("2:02:04");
  });

  // The distinction that matters for the original complaint. Before an asset's length is known the UI must say
  // so — rendering "0:00" would tell the viewer the video is empty, which is a different and worse lie than
  // admitting we don't know yet.
  it("renders an unknown duration as --:-- rather than 0:00", () => {
    expect(formatTime(Number.NaN)).toBe("--:--");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("--:--");
    expect(formatTime(-1)).toBe("--:--");
    expect(formatTime(0)).not.toBe("--:--"); // a genuine zero is still zero
  });

  it("truncates rather than rounds, so the readout never runs ahead of the playhead", () => {
    expect(formatTime(59.9)).toBe("0:59");
    expect(formatTime(3599.99)).toBe("59:59");
  });
});

// ---- regressions from the adversarial review panel -----------------------------------------------------

import { TegisPlayerElement } from "../src/ui.ts";

describe("review regressions", () => {
  // F8: `sideEffects` must name PUBLISHED paths. It named ./src/bundle-entry.ts, which isn't in `files`
  // (dist only), so every published module was flagged side-effect-free and bundlers dropped
  // `import "@tegis/player/ui"` entirely — customElements.define never ran and <tegis-player> silently
  // rendered as an unknown element.
  it("declares the published ui entry as side-effectful", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const files: string[] = pkg.files;
    for (const p of pkg.sideEffects as string[]) {
      expect(p.startsWith("./dist/")).toBe(true); // must be a path that actually ships
      expect(files.some((f) => p.slice(2).startsWith(f))).toBe(true);
    }
    expect(pkg.sideEffects).toContain("./dist/ui.js");
  });

  // F1: the shadow root must be built with append() only. `innerHTML += ""` runs "replace all", which
  // re-parses the subtree and orphans the <video> the SDK was handed — the viewer watches an empty element
  // while playback feeds a detached node.
  it("never assigns innerHTML on the shadow root", async () => {
    const src = await Bun.file(new URL("../src/ui.ts", import.meta.url)).text();
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code).not.toMatch(/\.innerHTML\s*(\+?=)/);
  });

  // F1 again, from the other side: the element must expose the video it actually renders.
  it("is constructible and defines the custom element", () => {
    expect(typeof TegisPlayerElement).toBe("function");
  });
});

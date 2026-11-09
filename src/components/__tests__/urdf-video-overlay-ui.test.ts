import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(): Promise<string> {
  return fs.readFile(
    path.join(process.cwd(), "src/components/urdf-video-overlay.tsx"),
    "utf8",
  );
}

describe("3D Replay video sizing", () => {
  test("starts each group at its responsive maximum and reclamps on overlay resize", async () => {
    const overlay = await source();
    expect(overlay).toContain("ResizeObserver");
    expect(overlay).toContain("parentElement?.getBoundingClientRect().width");
    expect(overlay).toContain(
      "Math.min(maxWidth, overlayWidth * maxWidthRatio)",
    );
    expect(overlay).toContain("setWidth(clampWidth(maxWidth))");
    expect(overlay).toContain("observer.observe(overlay)");
    expect(overlay.match(/maxWidthRatio=\{0\.34\}/g)).toHaveLength(2);
    expect(overlay).toContain("maxWidthRatio={0.28}");
    expect(overlay.match(/^\s+startMaximized$/gm)).toHaveLength(3);
  });
});

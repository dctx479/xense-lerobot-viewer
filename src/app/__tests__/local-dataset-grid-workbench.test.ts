import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

async function source(): Promise<string> {
  return fs.readFile(
    path.join(process.cwd(), "src/app/local-dataset-grid.tsx"),
    "utf8",
  );
}

describe("Workbench entry locale contract", () => {
  test("exposes the language switcher and translates the entry controls", async () => {
    const content = await source();

    expect(content).toContain(
      'import LanguageSwitcher from "@/components/language-switcher";',
    );
    expect(content).toContain('<LanguageSwitcher className="mt-1.5" />');
    expect(content).toContain('t("home.subtitle")');
    expect(content).toContain('tRich("home.browsing", {');
    expect(content).toContain("<CorpusDashboard");
    expect(content).toContain("onSelectSource={focusSource}");
  });

  test("keeps organization identity data rendered as values", async () => {
    const content = await source();

    const dashboard = await fs.readFile(
      path.join(process.cwd(), "src/components/corpus-dashboard.tsx"),
      "utf8",
    );
    expect(dashboard).toContain('label: t("dash.allSources")');
    expect(dashboard).toContain("({ id: s.prefix, label: s.prefix })");
    expect(content).not.toContain('t("workbench.robotId")');
    expect(content).not.toContain('t("workbench.robotType")');
    expect(content).not.toContain("translateDataset");
  });
});

import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const filename = path.join(
      process.cwd(),
      "src",
      "utils",
      "workbench-scenario-defaults.json",
    );
    const contents = await readFile(filename, "utf8");
    const defaults: unknown = JSON.parse(contents);
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      return Response.json(
        { error: "Invalid scenario defaults" },
        { status: 500 },
      );
    }
    return Response.json(defaults, {
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch {
    return Response.json({ error: "场景默认配置读取失败" }, { status: 500 });
  }
}

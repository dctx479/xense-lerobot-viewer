import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

test("production modules use the shared calendar instead of host/UTC day logic", () => {
  const root = path.resolve(import.meta.dir, "../..");
  const violations: string[] = [];
  const patterns = [
    /\.(?:getFullYear|getMonth|getDate|getDay|getTimezoneOffset|setHours|setDate|setMonth|setFullYear|getUTCFullYear|getUTCMonth|getUTCDate|getUTCDay|setUTCHours|setUTCDate|setUTCMonth|setUTCFullYear)\s*\(/u,
    /Date\.UTC\s*\(/u,
    /\.toISOString\(\)\s*\.(?:slice|substring)\(0,\s*10\)/u,
    /\.toISOString\(\)\s*\.split\(["']T["']\)\s*\[0\]/u,
    /\.toLocale(?:Date|Time)String\s*\(/u,
    /new Date\([^;\n]*\)\.toLocaleString\s*\(/u,
    /new Intl\.DateTimeFormat\s*\(/u,
    /timeZone\s*:/u,
  ];
  function scan(directory: string) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.name === "__tests__") continue;
      const file = path.join(directory, item.name);
      if (item.isDirectory()) scan(file);
      else if (
        /\.(?:tsx?|m?js)$/u.test(item.name) &&
        !/\.test\.(?:tsx?|m?js)$/u.test(item.name) &&
        file !== path.join(root, "utils/calendarTime.ts")
      ) {
        const source = readFileSync(file, "utf8");
        const localDates = [
          ...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*new Date\b/gu),
        ];
        const usesLocalDateString = localDates.some(([, name]) =>
          new RegExp("\\b" + name + "\\.toLocaleString\\s*\\(", "u").test(
            source,
          ),
        );
        if (
          usesLocalDateString ||
          patterns.some((pattern) => pattern.test(source))
        )
          violations.push(path.relative(root, file));
      }
    }
  }
  scan(root);
  scan(path.resolve(root, "../scripts"));
  expect(violations).toEqual([]);
});

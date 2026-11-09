"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useT } from "@/context/locale-context";

export default function EpisodeRedirectNotice({
  requestedEpisode,
  targetEpisode,
}: {
  requestedEpisode: number;
  targetEpisode: number;
}) {
  const t = useT();
  const searchParams = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  if (
    dismissed ||
    searchParams.get("redirectedFromEpisode") !== String(requestedEpisode)
  ) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("redirectedFromEpisode");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  };

  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-50 max-w-xl rounded-lg border border-amber-400/40 bg-[var(--surface-0)] p-4 text-sm text-amber-100 shadow-xl max-sm:left-4"
    >
      <div className="flex items-start gap-4">
        <div>
          <p className="font-medium text-amber-300">{t("ep.redirectTitle")}</p>
          <p className="mt-1 leading-relaxed">
            {t("ep.redirectDescription", {
              requested: requestedEpisode,
              target: targetEpisode,
            })}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-slate-400">
            {t("ep.redirectHint")}
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded px-2 py-1 text-xs text-amber-200 transition-colors hover:bg-amber-400/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          {t("ep.dismissRedirect")}
        </button>
      </div>
    </aside>
  );
}

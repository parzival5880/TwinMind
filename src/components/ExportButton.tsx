"use client";

import { useState } from "react";
import { downloadFile, exportSessionAsJSON, exportSessionAsText } from "@/lib/export";
import type { SessionState } from "@/lib/types";

type ExportButtonProps = {
  className?: string;
  format?: "json" | "text";
  session: SessionState;
};

const buildExportFilename = (format: "json" | "text") => {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const extension = format === "json" ? "json" : "txt";

  return `twinmind-export-${timestamp}.${extension}`;
};

export function ExportButton({
  className,
  format = "json",
  session,
}: ExportButtonProps) {
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleExport = () => {
    const content =
      format === "json" ? exportSessionAsJSON(session) : exportSessionAsText(session);
    const filename = buildExportFilename(format);
    const mimeType = format === "json" ? "application/json" : "text/plain";

    downloadFile(content, filename, mimeType);
    setToastMessage("Session exported successfully");
    window.setTimeout(() => {
      setToastMessage(null);
    }, 2500);
  };

  return (
    <div className={`flex flex-col items-end gap-2 ${className ?? ""}`}>
      <button
        aria-label="Export session"
        className="inline-flex items-center justify-center rounded-full border border-slate-300 bg-white/90 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:-translate-y-0.5 hover:border-teal-700 hover:text-slate-950"
        type="button"
        onClick={handleExport}
      >
        📥 Export Session
      </button>
      {toastMessage ? (
        <p
          aria-live="polite"
          className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm"
        >
          {toastMessage}
        </p>
      ) : null}
    </div>
  );
}

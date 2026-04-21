"use client";

import { downloadFile, exportSessionAsJSON, exportSessionAsText } from "@/lib/export";
import type { SessionState } from "@/lib/types";

type ExportButtonProps = {
  buttonId?: string;
  className?: string;
  buttonClassName?: string;
  format?: "json" | "text";
  onExport?: () => void;
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
  buttonId,
  className,
  buttonClassName,
  format = "json",
  onExport,
  session,
}: ExportButtonProps) {
  const handleExport = () => {
    const content =
      format === "json" ? exportSessionAsJSON(session) : exportSessionAsText(session);
    const filename = buildExportFilename(format);
    const mimeType = format === "json" ? "application/json" : "text/plain";

    downloadFile(content, filename, mimeType);
    onExport?.();
  };

  return (
    <div className={`flex flex-col items-end gap-2 ${className ?? ""}`}>
      <button
        aria-label="Export session"
        data-export-button="true"
        id={buttonId}
        className={`inline-flex items-center justify-center rounded-md ${buttonClassName ?? ""}`}
        type="button"
        onClick={handleExport}
      >
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M4 20h16" />
        </svg>
        <span className="sr-only">Export</span>
      </button>
    </div>
  );
}

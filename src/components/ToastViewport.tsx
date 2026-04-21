"use client";

import type { ToastItem } from "@/hooks/useToastQueue";

type ToastViewportProps = {
  onDismiss: (id: string) => void;
  toasts: ToastItem[];
};

const toneClassNames: Record<
  ToastItem["tone"],
  {
    action: string;
    panel: string;
    pill: string;
  }
> = {
  info: {
    action:
      "border-[rgba(94,234,212,.22)] text-[var(--teal)] hover:border-[rgba(94,234,212,.36)] hover:bg-[rgba(94,234,212,.08)]",
    panel: "text-[var(--text)]",
    pill: "bg-[rgba(94,234,212,.12)] text-[var(--teal)]",
  },
  warning: {
    action:
      "border-[rgba(245,185,113,.22)] text-[var(--amber)] hover:border-[rgba(245,185,113,.36)] hover:bg-[rgba(245,185,113,.08)]",
    panel: "text-[var(--text)]",
    pill: "bg-[rgba(245,185,113,.12)] text-[var(--amber)]",
  },
  error: {
    action:
      "border-[rgba(248,113,113,.22)] text-[var(--rose)] hover:border-[rgba(248,113,113,.36)] hover:bg-[rgba(248,113,113,.08)]",
    panel: "text-[var(--text)]",
    pill: "bg-[rgba(248,113,113,.12)] text-[var(--rose)]",
  },
  success: {
    action:
      "border-[rgba(167,139,250,.22)] text-[var(--violet)] hover:border-[rgba(167,139,250,.36)] hover:bg-[rgba(167,139,250,.08)]",
    panel: "text-[var(--text)]",
    pill: "bg-[rgba(167,139,250,.12)] text-[var(--violet)]",
  },
};

export function ToastViewport({ onDismiss, toasts }: ToastViewportProps) {
  return (
    <div
      aria-atomic="false"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-4 z-[70] mx-auto flex w-full justify-end px-4 sm:px-6"
    >
      <div className="flex w-full max-w-md flex-col gap-3">
        {toasts.map((toast) => (
          <article
            key={toast.id}
            className={`toast-panel pointer-events-auto animate-toast-in p-4 ${toneClassNames[toast.tone].panel}`}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <span
                  className={`toast-tone-pill inline-flex ${toneClassNames[toast.tone].pill}`}
                >
                  {toast.tone}
                </span>
                {toast.title ? (
                  <p className="mt-3 text-sm font-semibold text-current">{toast.title}</p>
                ) : null}
                <p className="mt-2 text-sm leading-6 text-[var(--text-mid)]">{toast.message}</p>
                {toast.action ? (
                  <button
                    className={`mt-3 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${toneClassNames[toast.tone].action}`}
                    type="button"
                    onClick={() => {
                      toast.action?.onAction();
                      onDismiss(toast.id);
                    }}
                  >
                    {toast.action.label}
                  </button>
                ) : null}
              </div>
              <button
                aria-label="Dismiss toast"
                className="rounded-full border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--text-dim)] transition hover:bg-[var(--surface)] hover:text-[var(--text)]"
                type="button"
                onClick={() => onDismiss(toast.id)}
              >
                Close
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

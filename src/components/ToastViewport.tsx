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
    action: "border-sky-300/70 text-sky-700 hover:border-sky-500 hover:bg-sky-50",
    panel: "border-sky-200 bg-sky-50/95 text-sky-900",
    pill: "bg-sky-100 text-sky-700",
  },
  warning: {
    action: "border-amber-300/70 text-amber-700 hover:border-amber-500 hover:bg-amber-50",
    panel: "border-amber-200 bg-amber-50/95 text-amber-900",
    pill: "bg-amber-100 text-amber-700",
  },
  error: {
    action: "border-rose-300/70 text-rose-700 hover:border-rose-500 hover:bg-rose-50",
    panel: "border-rose-200 bg-rose-50/95 text-rose-900",
    pill: "bg-rose-100 text-rose-700",
  },
  success: {
    action: "border-emerald-300/70 text-emerald-700 hover:border-emerald-500 hover:bg-emerald-50",
    panel: "border-emerald-200 bg-emerald-50/95 text-emerald-900",
    pill: "bg-emerald-100 text-emerald-700",
  },
};

export function ToastViewport({ onDismiss, toasts }: ToastViewportProps) {
  return (
    <div
      aria-atomic="false"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-4 z-[70] mx-auto flex w-full max-w-[1920px] justify-end px-4 sm:px-6"
    >
      <div className="flex w-full max-w-md flex-col gap-3">
        {toasts.map((toast) => (
          <article
            key={toast.id}
            className={`pointer-events-auto animate-toast-in rounded-[1.5rem] border p-4 shadow-[0_18px_50px_rgba(15,23,42,0.16)] backdrop-blur ${toneClassNames[toast.tone].panel}`}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] ${toneClassNames[toast.tone].pill}`}
                >
                  {toast.tone}
                </span>
                {toast.title ? (
                  <p className="mt-3 text-sm font-semibold text-current">{toast.title}</p>
                ) : null}
                <p className="mt-2 text-sm leading-6 text-current">{toast.message}</p>
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
                className="rounded-full border border-current/15 px-2 py-1 text-xs font-semibold text-current/80 transition hover:bg-white/40 hover:text-current"
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

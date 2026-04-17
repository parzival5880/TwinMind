"use client";

import { useEffect } from "react";

type ShortcutDefinition = {
  description: string;
  keys: string;
};

type HelpModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

const shortcuts: ShortcutDefinition[] = [
  { keys: "Cmd/Ctrl + K", description: "Focus the chat input" },
  { keys: "Cmd/Ctrl + R", description: "Refresh suggestions" },
  { keys: "Cmd/Ctrl + M", description: "Start or stop the mic" },
  { keys: "Cmd/Ctrl + E", description: "Export the current session" },
  { keys: "Esc", description: "Close the active modal" },
];

export function HelpModal({ isOpen, onClose }: HelpModalProps) {
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-slate-950/55 px-4 py-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        aria-labelledby="help-modal-title"
        aria-modal="true"
        className="w-full max-w-2xl rounded-[2rem] border border-white/40 bg-[rgba(255,255,255,0.97)] p-6 shadow-[0_30px_80px_rgba(15,23,42,0.2)]"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
              Help
            </p>
            <h2
              className="mt-2 text-2xl font-semibold tracking-tight text-slate-950"
              id="help-modal-title"
            >
              Keyboard shortcuts
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Use shortcuts to keep the app feeling fast without breaking your flow.
            </p>
          </div>
          <button
            aria-label="Close help modal"
            className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="mt-6 grid gap-3">
          {shortcuts.map((shortcut) => (
            <article
              key={shortcut.keys}
              className="flex items-center justify-between gap-4 rounded-[1.25rem] border border-slate-200 bg-slate-50/90 px-4 py-4"
            >
              <div>
                <p className="text-sm font-semibold text-slate-900">{shortcut.description}</p>
              </div>
              <kbd className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-slate-700 shadow-sm">
                {shortcut.keys}
              </kbd>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

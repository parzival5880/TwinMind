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
      className="modal-scrim fixed inset-0 z-[65] flex items-center justify-center px-4 py-4"
      onClick={onClose}
    >
      <div
        aria-labelledby="help-modal-title"
        aria-modal="true"
        className="modal-shell w-full max-w-2xl rounded-[14px] p-6"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--text-dim)]">
              Help
            </p>
            <h2
              className="mt-2 text-2xl font-semibold tracking-tight text-[var(--text)]"
              id="help-modal-title"
            >
              Keyboard shortcuts
            </h2>
            <p className="mt-2 text-sm leading-6 text-[var(--text-mid)]">
              Use shortcuts to keep the app feeling fast without breaking your flow.
            </p>
          </div>
          <button
            aria-label="Close help modal"
            className="modal-close-btn rounded-full px-4 py-2 text-sm font-semibold transition"
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
              className="flex items-center justify-between gap-4 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] px-4 py-4"
            >
              <div>
                <p className="text-sm font-semibold text-[var(--text)]">{shortcut.description}</p>
              </div>
              <kbd className="rounded-full border border-[var(--border2)] bg-[var(--bg3)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-mid)] shadow-sm">
                {shortcut.keys}
              </kbd>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

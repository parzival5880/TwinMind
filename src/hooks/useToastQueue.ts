"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastTone = "error" | "info" | "success" | "warning";

export type ToastAction = {
  label: string;
  onAction: () => void;
};

export type ToastInput = {
  action?: ToastAction;
  durationMs?: number;
  message: string;
  title?: string;
  tone: ToastTone;
};

export type ToastItem = ToastInput & {
  id: string;
};

type UseToastQueueResult = {
  pushToast: (toast: ToastInput) => string;
  removeToast: (id: string) => void;
  toasts: ToastItem[];
};

const DEFAULT_TOAST_DURATION_MS = 4_500;

export function useToastQueue(): UseToastQueueResult {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timeoutMapRef = useRef<Map<string, number>>(new Map());

  const removeToast = useCallback((id: string) => {
    const timeoutId = timeoutMapRef.current.get(id);

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutMapRef.current.delete(id);
    }

    setToasts((currentToasts) => currentToasts.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: ToastInput) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const durationMs = toast.durationMs ?? DEFAULT_TOAST_DURATION_MS;

      setToasts((currentToasts) => [
        ...currentToasts,
        {
          ...toast,
          id,
        },
      ]);

      const timeoutId = window.setTimeout(() => {
        removeToast(id);
      }, durationMs);

      timeoutMapRef.current.set(id, timeoutId);

      return id;
    },
    [removeToast],
  );

  useEffect(
    () => () => {
      timeoutMapRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      timeoutMapRef.current.clear();
    },
    [],
  );

  return {
    pushToast,
    removeToast,
    toasts,
  };
}

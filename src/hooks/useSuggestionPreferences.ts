"use client";

import { useCallback, useMemo, useState } from "react";
import type { Suggestion, SuggestionType } from "@/lib/types";

export function useSuggestionPreferences() {
  const [mutedTypes, setMutedTypes] = useState<Set<SuggestionType>>(() => new Set());
  const [pinnedSuggestions, setPinnedSuggestions] = useState<Suggestion[]>([]);

  const pinnedIds = useMemo(
    () => pinnedSuggestions.map((suggestion) => suggestion.id),
    [pinnedSuggestions],
  );

  const toggleMuteType = useCallback((type: SuggestionType) => {
    setMutedTypes((currentTypes) => {
      const nextTypes = new Set(currentTypes);
      const action = nextTypes.has(type) ? "unmute_type" : "mute_type";

      if (nextTypes.has(type)) {
        nextTypes.delete(type);
      } else {
        nextTypes.add(type);
      }

      console.info("[prefs]", { action, type });
      return nextTypes;
    });
  }, []);

  const resetMutedTypes = useCallback(() => {
    setMutedTypes(new Set());
  }, []);

  const togglePin = useCallback((id: string, suggestion: Suggestion) => {
    setPinnedSuggestions((currentSuggestions) => {
      const existingIndex = currentSuggestions.findIndex((entry) => entry.id === id);

      if (existingIndex !== -1) {
        console.info("[prefs]", { action: "unpin", id });
        return currentSuggestions.filter((entry) => entry.id !== id);
      }

      const nextSuggestions =
        currentSuggestions.length >= 3
          ? [...currentSuggestions.slice(1), suggestion]
          : [...currentSuggestions, suggestion];

      console.info("[prefs]", { action: "pin", id });
      return nextSuggestions;
    });
  }, []);

  const clearPins = useCallback(() => {
    setPinnedSuggestions([]);
  }, []);

  const isMuted = useCallback((type: SuggestionType) => mutedTypes.has(type), [mutedTypes]);
  const isPinned = useCallback((id: string) => pinnedIds.includes(id), [pinnedIds]);

  return {
    mutedTypes,
    toggleMuteType,
    resetMutedTypes,
    pinnedIds,
    pinnedSuggestions,
    togglePin,
    clearPins,
    isMuted,
    isPinned,
  };
}

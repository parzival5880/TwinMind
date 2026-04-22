// ---------------------------------------------------------------------------
// Incremental array element extractor for truncation-resilient JSON parsing.
//
// Given a (possibly truncated) JSON string and a named array key, walks the
// character stream tracking brace/bracket depth, string state, and escape
// state. Every time depth returns to 1 (inside the array) after being deeper,
// the preceding range is a completed element — JSON.parse'd in isolation.
// Returns the array of successfully parsed elements.
//
// Silently drops any trailing incomplete element. Never throws on truncation.
// ---------------------------------------------------------------------------

export function extractCompletedArrayElements(
  accumulated: string,
  arrayKey: string,
): unknown[] {
  // 1. Locate the opening of `"arrayKey": [`
  const escapedKey = arrayKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openPattern = new RegExp(`"${escapedKey}"\\s*:\\s*\\[`);
  const openMatch = openPattern.exec(accumulated);

  if (!openMatch) {
    return [];
  }

  const startIndex = openMatch.index + openMatch[0].length;

  // 2. Walk characters from the opening bracket, tracking depth.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;
  const results: unknown[] = [];

  for (let i = startIndex; i < accumulated.length; i += 1) {
    const ch = accumulated[i];

    // At depth 0 we are between elements in the array.
    if (depth === 0) {
      if (ch === "{") {
        objStart = i;
        depth = 1;
      } else if (ch === "]") {
        // End of array — we're done.
        break;
      }
      continue;
    }

    // Inside a JSON string.
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    // Outside a string — track structure.
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objStart !== -1) {
        // We have a completed element: [objStart, i].
        const raw = accumulated.slice(objStart, i + 1);
        try {
          results.push(JSON.parse(raw));
        } catch {
          // Malformed element — skip it silently.
        }
        objStart = -1;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Extract the "meta" block from a (possibly truncated) JSON response.
// Returns null if the meta block is incomplete or not found.
// ---------------------------------------------------------------------------

export function extractMetaBlock(
  accumulated: string,
): { meeting_type?: string; conversation_stage?: string } | null {
  const metaPattern = /"meta"\s*:\s*\{/;
  const metaMatch = metaPattern.exec(accumulated);

  if (!metaMatch) {
    return null;
  }

  const start = metaMatch.index + metaMatch[0].length - 1; // points at {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < accumulated.length; i += 1) {
    const ch = accumulated[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = accumulated.slice(start, i + 1);
        try {
          return JSON.parse(raw) as { meeting_type?: string; conversation_stage?: string };
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

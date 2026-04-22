export const SERVER_GROQ_KEY_MISSING_MESSAGE = "Server misconfigured: GROQ_API_KEY not set";

export function getServerGroqKey(): string | null {
  const value = process.env.GROQ_API_KEY?.trim();
  return value ? value : null;
}

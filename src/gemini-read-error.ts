// The one error a Gemini quota read throws: a fixed message and an HTTP status, never a body, a path or a token.
export class GeminiReadError extends Error {
  constructor(readonly status: number, readonly email?: string, readonly retryAfterMs?: number) {
    super(`Gemini quota read failed with HTTP ${status}`);
  }
}

// Helpers every route uses, so errors leave the server in one shape.
import type { Response } from "express";
import type { z } from "zod";
import type { ApiError } from "../shared/types.ts";

export function sendError(res: Response, status: number, code: string, message: string, details?: string[]): void {
  const body: ApiError = { error: { code, message, ...(details !== undefined && details.length > 0 ? { details } : {}) } };
  res.status(status).json(body);
}

/**
 * Validates a request body. On failure it answers 400 and returns null, so a
 * route can write `const body = parseBody(...); if (body === null) return;`.
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, res: Response): T | null {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`);
  sendError(res, 400, "bad_request", "The request was missing something the server needs.", details);
  return null;
}

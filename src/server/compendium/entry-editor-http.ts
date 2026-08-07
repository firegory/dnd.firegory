import { CompendiumValidationError } from "./service.ts";
import { EntryEditorError } from "./entry-editor.ts";

export function mapEntryEditorError(error: unknown): { status: number; message: string } | null {
  if (error instanceof EntryEditorError) return { status: error.status, message: error.message };
  if (error instanceof CompendiumValidationError) {
    const conflict = /changed after this editor was opened/i.test(error.message);
    return { status: conflict ? 409 : 400, message: error.message };
  }
  if (error instanceof SyntaxError) return { status: 400, message: "Request body must be valid JSON." };
  return null;
}

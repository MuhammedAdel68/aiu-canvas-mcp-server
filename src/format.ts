import path from "node:path";

const CONTENT_FIELD_NAMES = new Set([
  "body",
  "description",
  "message",
  "syllabus_body",
  "instructions",
]);

export function htmlToText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  const withoutScripts = value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const withBreaks = withoutScripts
    .replace(/<\/(p|div|section|article|header|footer|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ");

  return decodeHtmlEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeCanvasContent(value: unknown): unknown {
  return normalizeValue(value, 0);
}

export function stringifyForTool(value: unknown, maxChars = 20_000): string {
  const normalized = normalizeCanvasContent(value);
  const text = typeof normalized === "string" ? normalized : JSON.stringify(normalized, null, 2);

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[Truncated to ${maxChars} characters. Increase max_chars to see more.]`;
}

export function textResult(value: unknown, maxChars?: number) {
  return {
    content: [
      {
        type: "text" as const,
        text: stringifyForTool(value, maxChars),
      },
    ],
  };
}

export function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: formatError(error),
      },
    ],
  };
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function cleanFileName(name: string): string {
  const parsed = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return parsed || "canvas-file";
}

function normalizeValue(value: unknown, depth: number): unknown {
  if (depth > 10) {
    return "[Max depth reached]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, depth + 1));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    output[key] = normalizeValue(entry, depth + 1);

    if (CONTENT_FIELD_NAMES.has(key)) {
      const text = htmlToText(entry);

      if (text) {
        output[`${key}_text`] = text;
      }
    }
  }

  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();

    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return named[lower] ?? match;
  });
}

import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import { cleanFileName } from "./format.js";

type Primitive = string | number | boolean;
type QueryValue = Primitive | Primitive[] | null | undefined;

export type CanvasQuery = Record<string, QueryValue>;
export type CanvasAuthMode = "token" | "chrome";

export interface CanvasConfig {
  baseUrl: string;
  accessToken?: string;
  authMode: CanvasAuthMode;
  chromeDebugUrl: string;
  downloadDir: string;
  requestTimeoutMs: number;
}

interface HttpResult {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  text: string;
}

interface BinaryResult {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  buffer: Buffer;
}

interface CanvasTransport {
  request(url: URL): Promise<HttpResult>;
  requestBinary(url: URL, maxBytes: number): Promise<BinaryResult>;
  readRenderedPageText?(url: URL, maxChars: number): Promise<string>;
}

interface JsonWithHeaders<T> {
  data: T;
  headers: Record<string, string>;
  url: string;
}

export class CanvasError extends Error {
  readonly status?: number;
  readonly details?: string;

  constructor(message: string, options: { status?: number; details?: string } = {}) {
    super(message);
    this.name = "CanvasError";
    this.status = options.status;
    this.details = options.details;
  }
}

export class CanvasClient {
  readonly baseUrl: string;
  readonly authMode: CanvasAuthMode;
  readonly downloadDir: string;

  private constructor(
    private readonly config: CanvasConfig,
    private readonly transport: CanvasTransport,
  ) {
    this.baseUrl = config.baseUrl;
    this.authMode = config.authMode;
    this.downloadDir = config.downloadDir;
  }

  static fromEnv(env = process.env): CanvasClient {
    const accessToken = env.CANVAS_ACCESS_TOKEN?.trim() || undefined;
    const requestedMode = env.CANVAS_AUTH_MODE?.trim().toLowerCase();
    const authMode: CanvasAuthMode =
      requestedMode === "chrome" || (!accessToken && requestedMode !== "token") ? "chrome" : "token";

    const config: CanvasConfig = {
      baseUrl: stripTrailingSlash(env.CANVAS_BASE_URL?.trim() || "https://aiu.instructure.com"),
      accessToken,
      authMode,
      chromeDebugUrl: env.CHROME_DEBUG_URL?.trim() || "http://127.0.0.1:9222",
      downloadDir: env.CANVAS_DOWNLOAD_DIR?.trim() || "downloads",
      requestTimeoutMs: readPositiveInteger(env.CANVAS_REQUEST_TIMEOUT_MS, 30_000),
    };

    const transport =
      config.authMode === "chrome"
        ? new ChromeSessionTransport(config.baseUrl, config.chromeDebugUrl, config.requestTimeoutMs)
        : new TokenTransport(config.accessToken, config.requestTimeoutMs);

    return new CanvasClient(config, transport);
  }

  toCanvasUrl(pathOrUrl: string, query?: CanvasQuery): URL {
    return buildCanvasUrl(this.baseUrl, pathOrUrl, query);
  }

  async getJson<T = unknown>(pathOrUrl: string, query?: CanvasQuery): Promise<T> {
    return (await this.getJsonWithHeaders<T>(pathOrUrl, query)).data;
  }

  async getAll<T = unknown>(pathOrUrl: string, query?: CanvasQuery): Promise<T[]> {
    const items: T[] = [];
    let nextUrl: string | undefined = pathOrUrl;
    let nextQuery: CanvasQuery | undefined = query;

    for (let pageCount = 0; nextUrl; pageCount += 1) {
      if (pageCount > 500) {
        throw new CanvasError("Stopped after 500 Canvas pagination pages to avoid an accidental infinite loop.");
      }

      const response = await this.getJsonWithHeaders<unknown>(nextUrl, nextQuery);

      if (!Array.isArray(response.data)) {
        throw new CanvasError(`Expected Canvas to return a list, but received ${typeof response.data}.`);
      }

      items.push(...(response.data as T[]));
      nextUrl = nextLink(response.headers);
      nextQuery = undefined;
    }

    return items;
  }

  async downloadFile(fileId: string | number, downloadDir?: string, maxBytes = 100 * 1024 * 1024) {
    const file = await this.getJson<Record<string, unknown>>(`/api/v1/files/${pathPart(fileId)}`);
    const downloadUrl = typeof file.url === "string" ? file.url : undefined;

    if (!downloadUrl) {
      throw new CanvasError("Canvas did not provide a file download URL for this file.");
    }

    const displayName =
      typeof file.display_name === "string"
        ? file.display_name
        : typeof file.filename === "string"
          ? file.filename
          : `canvas-file-${fileId}`;

    const baseDir = path.resolve(process.cwd(), downloadDir || this.downloadDir);
    const targetPath = path.resolve(baseDir, cleanFileName(displayName));

    if (!isInsidePath(baseDir, targetPath)) {
      throw new CanvasError("Resolved file path escaped the requested download directory.");
    }

    await fs.mkdir(baseDir, { recursive: true });

    const binary = await this.transport.requestBinary(this.toCanvasUrl(downloadUrl), maxBytes);
    assertOk(binary.status, binary.statusText, binary.url, binary.headers, `Downloaded ${binary.buffer.length} bytes`);

    await fs.writeFile(targetPath, binary.buffer);

    return {
      saved_path: targetPath,
      bytes: binary.buffer.length,
      source_url: binary.url,
      file,
    };
  }

  canReadRenderedPages(): boolean {
    return Boolean(this.transport.readRenderedPageText);
  }

  async readRenderedPageText(urlOrPath: string, maxChars = 20_000): Promise<string> {
    if (!this.transport.readRenderedPageText) {
      throw new CanvasError(
        "Rendered page reading is only available in Chrome mode. Set CANVAS_AUTH_MODE=chrome and run npm run chrome.",
      );
    }

    return this.transport.readRenderedPageText(this.toCanvasUrl(urlOrPath), maxChars);
  }

  private async getJsonWithHeaders<T>(pathOrUrl: string, query?: CanvasQuery): Promise<JsonWithHeaders<T>> {
    const url = this.toCanvasUrl(pathOrUrl, query);
    const response = await this.transport.request(url);

    assertOk(response.status, response.statusText, response.url, response.headers, response.text);

    if (response.text.trim() === "") {
      return { data: undefined as T, headers: response.headers, url: response.url };
    }

    try {
      return {
        data: JSON.parse(response.text) as T,
        headers: response.headers,
        url: response.url,
      };
    } catch {
      throw new CanvasError(`Canvas returned non-JSON content from ${response.url}.`, {
        status: response.status,
        details: response.text.slice(0, 1_000),
      });
    }
  }
}

export function pathPart(value: string | number): string {
  return encodeURIComponent(String(value));
}

function buildCanvasUrl(baseUrl: string, pathOrUrl: string, query?: CanvasQuery): URL {
  const base = new URL(baseUrl);
  const url = new URL(pathOrUrl, `${base.origin}/`);

  if (url.origin !== base.origin) {
    throw new CanvasError(`Refusing to request non-Canvas URL: ${url.href}`);
  }

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function nextLink(headers: Record<string, string>): string | undefined {
  const link = getHeader(headers, "link");

  if (!link) {
    return undefined;
  }

  for (const part of link.split(",")) {
    if (!/\brel="?next"?/i.test(part)) {
      continue;
    }

    const match = part.match(/<([^>]+)>/);

    if (match) {
      return match[1];
    }
  }

  return undefined;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function assertOk(
  status: number,
  statusText: string,
  url: string,
  headers: Record<string, string>,
  bodyPreview: string,
): void {
  if (status >= 200 && status < 300) {
    return;
  }

  const contentType = getHeader(headers, "content-type") || "";
  const detail = contentType.includes("application/json") ? bodyPreview : bodyPreview.slice(0, 1_000);
  let hint = "";

  if (status === 401 || status === 403) {
    hint =
      " Check that your Canvas access token is valid, or use Chrome mode after logging in with npm run chrome.";
  }

  throw new CanvasError(`Canvas request failed (${status} ${statusText}) for ${url}.${hint}`, {
    status,
    details: detail,
  });
}

function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

class TokenTransport implements CanvasTransport {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly requestTimeoutMs: number,
  ) {}

  async request(url: URL): Promise<HttpResult> {
    if (!this.accessToken) {
      throw new CanvasError(
        "CANVAS_ACCESS_TOKEN is not set. Create a Canvas access token, or set CANVAS_AUTH_MODE=chrome and run npm run chrome.",
      );
    }

    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
      },
      this.requestTimeoutMs,
    );

    return responseToTextResult(response);
  }

  async requestBinary(url: URL, maxBytes: number): Promise<BinaryResult> {
    if (!this.accessToken) {
      throw new CanvasError(
        "CANVAS_ACCESS_TOKEN is not set. Create a Canvas access token, or set CANVAS_AUTH_MODE=chrome and run npm run chrome.",
      );
    }

    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      },
      this.requestTimeoutMs,
    );

    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength > maxBytes) {
      throw new CanvasError(`Downloaded file is larger than the ${maxBytes} byte safety limit.`);
    }

    return {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      headers: headersToRecord(response.headers),
      buffer: Buffer.from(arrayBuffer),
    };
  }
}

class ChromeSessionTransport implements CanvasTransport {
  private browser?: Browser;
  private page?: Page;

  constructor(
    private readonly baseUrl: string,
    private readonly chromeDebugUrl: string,
    private readonly requestTimeoutMs: number,
  ) {}

  async request(url: URL): Promise<HttpResult> {
    const page = await this.ensureCanvasPage();
    const result = await page.evaluate(async ({ requestUrl, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
      const response = await fetch(requestUrl, {
        credentials: "include",
        headers: { Accept: "application/json" },
          signal: controller.signal,
      });

      return {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        headers: Object.fromEntries(response.headers.entries()),
        text: await response.text(),
      };
      } finally {
        clearTimeout(timer);
      }
    }, { requestUrl: url.href, timeoutMs: this.requestTimeoutMs });

    return result;
  }

  async requestBinary(url: URL, maxBytes: number): Promise<BinaryResult> {
    const page = await this.ensureCanvasPage();

    const result = await page.evaluate(
      async ({ requestUrl, maxAllowedBytes, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
        const response = await fetch(requestUrl, { credentials: "include", signal: controller.signal });
        const arrayBuffer = await response.arrayBuffer();

        if (arrayBuffer.byteLength > maxAllowedBytes) {
          throw new Error(`Downloaded file is larger than the ${maxAllowedBytes} byte safety limit.`);
        }

        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";

        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }

        return {
          status: response.status,
          statusText: response.statusText,
          url: response.url,
          headers: Object.fromEntries(response.headers.entries()),
          base64: btoa(binary),
        };
        } finally {
          clearTimeout(timer);
        }
      },
      { requestUrl: url.href, maxAllowedBytes: maxBytes, timeoutMs: this.requestTimeoutMs },
    );

    return {
      status: result.status,
      statusText: result.statusText,
      url: result.url,
      headers: result.headers,
      buffer: Buffer.from(result.base64, "base64"),
    };
  }

  async readRenderedPageText(url: URL, maxChars: number): Promise<string> {
    const page = await this.ensureCanvasPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

    if (!this.isCanvasOrigin(page.url())) {
      throw new CanvasError("Chrome was redirected away from Canvas. Log in to AIU Canvas in the debug Chrome window.");
    }

    const text = await page.evaluate(() => document.body?.innerText || "");
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n[Truncated to ${maxChars} characters. Increase max_chars to see more.]`
      : text;
  }

  private async ensureCanvasPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = browser.contexts()[0];

    if (!context) {
      throw new CanvasError("Connected to Chrome, but no browser context was available.");
    }

    if (this.page?.isClosed()) {
      this.page = undefined;
    }

    this.page =
      this.page ||
      context.pages().find((page) => this.isCanvasOrigin(page.url())) ||
      context.pages()[0] ||
      (await context.newPage());

    if (!this.isCanvasOrigin(this.page.url())) {
      await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error: unknown) => {
        throw new CanvasError(
          `Could not open ${this.baseUrl} in Chrome. Make sure the debug Chrome window is running and has internet access. ${String(
            error,
          )}`,
        );
      });
    }

    if (!this.isCanvasOrigin(this.page.url())) {
      throw new CanvasError(
        `Chrome is not currently logged in to ${this.baseUrl}. Run npm run chrome, log in to AIU Canvas, then try again.`,
      );
    }

    return this.page;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    try {
      this.browser = await chromium.connectOverCDP(this.chromeDebugUrl);
      this.browser.on("disconnected", () => {
        this.browser = undefined;
        this.page = undefined;
      });
      return this.browser;
    } catch (error) {
      throw new CanvasError(
        `Could not connect to Chrome at ${this.chromeDebugUrl}. Run npm run chrome first, then log in to AIU Canvas. ${String(
          error,
        )}`,
      );
    }
  }

  private isCanvasOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.baseUrl).origin;
    } catch {
      return false;
    }
  }
}

async function responseToTextResult(response: Response): Promise<HttpResult> {
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    headers: headersToRecord(response.headers),
    text: await response.text(),
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

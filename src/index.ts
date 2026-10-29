#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadEnv } from "dotenv";
import { z } from "zod/v4";

import { CanvasClient, type CanvasQuery, pathPart } from "./canvas.js";
import { errorResult, formatError, textResult } from "./format.js";

loadEnv({ quiet: true });

const client = CanvasClient.fromEnv();
const server = new McpServer({
  name: "aiu-canvas-mcp-server",
  version: "0.1.0",
});

const courseIdSchema = z
  .string()
  .min(1)
  .describe("Canvas course ID, for example 12345. SIS-style IDs may also work if Canvas accepts them.");
const moduleIdSchema = z.string().min(1).describe("Canvas module ID.");
const maxCharsSchema = z
  .number()
  .int()
  .min(1_000)
  .max(50_000)
  .optional()
  .default(20_000)
  .describe("Maximum characters returned by the tool.");
const perPageSchema = z.number().int().min(1).max(100).optional().default(100);

registerTool(
  "canvas_auth_status",
  {
    title: "Canvas Auth Status",
    description: "Check whether the MCP server can reach AIU Canvas using the configured token or Chrome session.",
    inputSchema: {
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const profile = await client.getJson<Record<string, unknown>>("/api/v1/users/self/profile");

    return {
      status: "ok",
      base_url: client.baseUrl,
      auth_mode: client.authMode,
      chrome_rendered_pages_available: client.canReadRenderedPages(),
      profile: compactUser(profile),
    };
  },
);

registerTool(
  "canvas_list_courses",
  {
    title: "List Canvas Courses",
    description: "List courses available to the logged-in Canvas account.",
    inputSchema: {
      enrollment_state: z
        .enum(["active", "completed", "invited_or_pending", "all"])
        .optional()
        .default("active")
        .describe("Which course enrollment state to list. Use all to omit this filter."),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const params: CanvasQuery = {
      "include[]": ["term", "favorites"],
      per_page: args.per_page,
    };

    if (args.enrollment_state !== "all") {
      params.enrollment_state = args.enrollment_state;
    }

    const courses = await client.getAll<Record<string, unknown>>("/api/v1/courses", params);
    return courses.map(compactCourse);
  },
);

registerTool(
  "canvas_search_courses",
  {
    title: "Search Canvas Courses",
    description: "Search your Canvas courses by name, code, ID, or term.",
    inputSchema: {
      query: z.string().min(1).describe("Text to search for."),
      enrollment_state: z.enum(["active", "completed", "invited_or_pending", "all"]).optional().default("active"),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const needle = args.query.toLowerCase();
    const params: CanvasQuery = {
      "include[]": ["term", "favorites"],
      per_page: args.per_page,
    };

    if (args.enrollment_state !== "all") {
      params.enrollment_state = args.enrollment_state;
    }

    const courses = await client.getAll<Record<string, unknown>>("/api/v1/courses", params);

    return courses.map(compactCourse).filter((course) => JSON.stringify(course).toLowerCase().includes(needle));
  },
);

registerTool(
  "canvas_get_course",
  {
    title: "Get Canvas Course",
    description: "Get details for a Canvas course, optionally including syllabus HTML converted to text.",
    inputSchema: {
      course_id: courseIdSchema,
      include_syllabus: z.boolean().optional().default(true),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const include = ["term", "teachers", "sections"];

    if (args.include_syllabus) {
      include.push("syllabus_body");
    }

    return client.getJson(`/api/v1/courses/${pathPart(args.course_id)}`, {
      "include[]": include,
    });
  },
);

registerTool(
  "canvas_list_course_tabs",
  {
    title: "List Course Tabs",
    description: "List visible Canvas navigation tabs for a course, including URLs for content areas.",
    inputSchema: {
      course_id: courseIdSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => client.getAll(`/api/v1/courses/${pathPart(args.course_id)}/tabs`, { per_page: 100 }),
);

registerTool(
  "canvas_list_modules",
  {
    title: "List Course Modules",
    description: "List modules in a Canvas course. Enable include_items to include module items in the same response.",
    inputSchema: {
      course_id: courseIdSchema,
      include_items: z.boolean().optional().default(true),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const params: CanvasQuery = { per_page: args.per_page };

    if (args.include_items) {
      params["include[]"] = ["items"];
    }

    return client.getAll(`/api/v1/courses/${pathPart(args.course_id)}/modules`, params);
  },
);

registerTool(
  "canvas_list_module_items",
  {
    title: "List Module Items",
    description: "List the items inside one Canvas module.",
    inputSchema: {
      course_id: courseIdSchema,
      module_id: moduleIdSchema,
      include_content_details: z.boolean().optional().default(true),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const params: CanvasQuery = { per_page: args.per_page };

    if (args.include_content_details) {
      params["include[]"] = ["content_details"];
    }

    return client.getAll(
      `/api/v1/courses/${pathPart(args.course_id)}/modules/${pathPart(args.module_id)}/items`,
      params,
    );
  },
);

registerTool(
  "canvas_get_module_item_content",
  {
    title: "Get Module Item Content",
    description:
      "Retrieve one module item and follow its Canvas API URL to fetch the page, assignment, discussion, quiz, or file metadata behind it.",
    inputSchema: {
      course_id: courseIdSchema,
      module_id: moduleIdSchema,
      item_id: z.string().min(1).describe("Canvas module item ID."),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => getModuleItemContent(args.course_id, args.module_id, args.item_id),
);

registerTool(
  "canvas_list_pages",
  {
    title: "List Course Pages",
    description: "List wiki pages in a Canvas course.",
    inputSchema: {
      course_id: courseIdSchema,
      search_term: z.string().optional().describe("Optional page title search."),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    client.getAll(`/api/v1/courses/${pathPart(args.course_id)}/pages`, {
      per_page: args.per_page,
      sort: "title",
      order: "asc",
      search_term: args.search_term,
    }),
);

registerTool(
  "canvas_get_page",
  {
    title: "Get Course Page",
    description: "Get a Canvas page body. Use the page URL slug, or page_id:123 if you know the numeric page ID.",
    inputSchema: {
      course_id: courseIdSchema,
      page_url_or_id: z.string().min(1).describe("Canvas page URL slug, or page_id:123."),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    client.getJson(`/api/v1/courses/${pathPart(args.course_id)}/pages/${pathPart(args.page_url_or_id)}`, {
      "include[]": ["body"],
    }),
);

registerTool(
  "canvas_list_assignments",
  {
    title: "List Assignments",
    description: "List assignments in a Canvas course.",
    inputSchema: {
      course_id: courseIdSchema,
      search_term: z.string().optional(),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    client.getAll(`/api/v1/courses/${pathPart(args.course_id)}/assignments`, {
      per_page: args.per_page,
      search_term: args.search_term,
      "include[]": ["all_dates"],
    }),
);

registerTool(
  "canvas_get_assignment",
  {
    title: "Get Assignment",
    description: "Get a Canvas assignment, including its description converted to text.",
    inputSchema: {
      course_id: courseIdSchema,
      assignment_id: z.string().min(1),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    client.getJson(`/api/v1/courses/${pathPart(args.course_id)}/assignments/${pathPart(args.assignment_id)}`, {
      "include[]": ["all_dates"],
    }),
);

registerTool(
  "canvas_list_discussions",
  {
    title: "List Discussions",
    description: "List Canvas discussion topics, with optional announcements-only mode.",
    inputSchema: {
      course_id: courseIdSchema,
      only_announcements: z.boolean().optional().default(false),
      search_term: z.string().optional(),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    client.getAll(`/api/v1/courses/${pathPart(args.course_id)}/discussion_topics`, {
      per_page: args.per_page,
      only_announcements: args.only_announcements,
      search_term: args.search_term,
    }),
);

registerTool(
  "canvas_get_discussion",
  {
    title: "Get Discussion",
    description: "Get a Canvas discussion topic or announcement.",
    inputSchema: {
      course_id: courseIdSchema,
      topic_id: z.string().min(1).describe("Canvas discussion topic ID."),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    client.getJson(`/api/v1/courses/${pathPart(args.course_id)}/discussion_topics/${pathPart(args.topic_id)}`),
);

registerTool(
  "canvas_list_quizzes",
  {
    title: "List Quizzes",
    description: "List classic Canvas quizzes in a course. New Quizzes may appear through module items instead.",
    inputSchema: {
      course_id: courseIdSchema,
      search_term: z.string().optional(),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) =>
    client.getAll(`/api/v1/courses/${pathPart(args.course_id)}/quizzes`, {
      per_page: args.per_page,
      search_term: args.search_term,
    }),
);

registerTool(
  "canvas_get_quiz",
  {
    title: "Get Quiz",
    description: "Get metadata and description for a classic Canvas quiz. This does not bypass locked quiz access.",
    inputSchema: {
      course_id: courseIdSchema,
      quiz_id: z.string().min(1),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => client.getJson(`/api/v1/courses/${pathPart(args.course_id)}/quizzes/${pathPart(args.quiz_id)}`),
);

registerTool(
  "canvas_list_files",
  {
    title: "List Course Files",
    description: "List files in a Canvas course or folder.",
    inputSchema: {
      course_id: courseIdSchema,
      folder_id: z.string().optional().describe("Optional Canvas folder ID. If omitted, course files are listed."),
      search_term: z.string().optional(),
      per_page: perPageSchema,
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const endpoint = args.folder_id
      ? `/api/v1/folders/${pathPart(args.folder_id)}/files`
      : `/api/v1/courses/${pathPart(args.course_id)}/files`;

    return client.getAll(endpoint, {
      per_page: args.per_page,
      search_term: args.search_term,
    });
  },
);

registerTool(
  "canvas_get_file",
  {
    title: "Get File Metadata",
    description: "Get Canvas file metadata, including the authenticated download URL when Canvas provides one.",
    inputSchema: {
      file_id: z.string().min(1).describe("Canvas file ID."),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => client.getJson(`/api/v1/files/${pathPart(args.file_id)}`),
);

registerTool(
  "canvas_download_file",
  {
    title: "Download Canvas File",
    description: "Download a Canvas file to the local machine and return the saved path.",
    inputSchema: {
      file_id: z.string().min(1).describe("Canvas file ID."),
      download_dir: z
        .string()
        .optional()
        .describe("Optional local directory. Defaults to CANVAS_DOWNLOAD_DIR or ./downloads."),
      max_bytes: z.number().int().min(1).max(250 * 1024 * 1024).optional().default(100 * 1024 * 1024),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => client.downloadFile(args.file_id, args.download_dir, args.max_bytes),
);

registerTool(
  "canvas_fetch_url_or_api_path",
  {
    title: "Fetch Canvas URL Or API Path",
    description:
      "Fetch a Canvas API path or translate a normal Canvas course URL into the relevant API content request when possible.",
    inputSchema: {
      url_or_path: z
        .string()
        .min(1)
        .describe("Full https://aiu.instructure.com URL, /api/v1/... path, or /courses/... Canvas path."),
      max_chars: maxCharsSchema,
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => fetchCanvasUrlOrApiPath(args.url_or_path, args.max_chars),
);

const transport = new StdioServerTransport();
await server.connect(transport);

function registerTool(
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: Record<string, z.ZodType>;
    annotations?: Record<string, unknown>;
  },
  handler: (args: any) => Promise<unknown>,
) {
  server.registerTool(name, config as any, async (args: any) => {
    try {
      return textResult(await handler(args || {}), args?.max_chars);
    } catch (error) {
      return errorResult(error);
    }
  });
}

async function getModuleItemContent(
  courseId: string,
  moduleId: string | number,
  itemId: string | number,
  knownItem?: Record<string, unknown>,
) {
  const moduleItem =
    knownItem ||
    (await client.getJson<Record<string, unknown>>(
      `/api/v1/courses/${pathPart(courseId)}/modules/${pathPart(moduleId)}/items/${pathPart(itemId)}`,
      {
        "include[]": ["content_details"],
      },
    ));

  const apiUrl = typeof moduleItem.url === "string" ? moduleItem.url : undefined;

  if (!apiUrl) {
    return {
      module_item: moduleItem,
      resolved_content: null,
      note: "This module item does not expose a Canvas API URL. It may be an external URL/tool or locked content.",
    };
  }

  try {
    return {
      module_item: moduleItem,
      resolved_content: await client.getJson(apiUrl),
    };
  } catch (error) {
    return {
      module_item: moduleItem,
      resolved_content_error: formatError(error),
    };
  }
}

async function fetchCanvasUrlOrApiPath(urlOrPath: string, maxChars: number) {
  const url = client.toCanvasUrl(urlOrPath);
  const pathName = url.pathname;
  const segments = pathName.split("/").filter(Boolean).map(decodeURIComponent);

  if (segments[0] === "api" && segments[1] === "v1") {
    return client.getJson(`${url.pathname}${url.search}`);
  }

  if (segments[0] !== "courses" || !segments[1]) {
    return fallbackRenderedPage(url, maxChars);
  }

  const courseId = segments[1];
  const area = segments[2];

  if (!area) {
    return client.getJson(`/api/v1/courses/${pathPart(courseId)}`, {
      "include[]": ["term", "teachers", "sections", "syllabus_body"],
    });
  }

  if (area === "pages") {
    const pageSlug = segments.slice(3).join("/");

    if (!pageSlug) {
      return client.getAll(`/api/v1/courses/${pathPart(courseId)}/pages`, { per_page: 100 });
    }

    return client.getJson(`/api/v1/courses/${pathPart(courseId)}/pages/${pathPart(pageSlug)}`, {
      "include[]": ["body"],
    });
  }

  if (area === "assignments") {
    const assignmentId = segments[3];

    if (!assignmentId) {
      return client.getAll(`/api/v1/courses/${pathPart(courseId)}/assignments`, { per_page: 100 });
    }

    return client.getJson(`/api/v1/courses/${pathPart(courseId)}/assignments/${pathPart(assignmentId)}`, {
      "include[]": ["all_dates"],
    });
  }

  if (area === "discussion_topics") {
    const topicId = segments[3];

    if (!topicId) {
      return client.getAll(`/api/v1/courses/${pathPart(courseId)}/discussion_topics`, { per_page: 100 });
    }

    return client.getJson(`/api/v1/courses/${pathPart(courseId)}/discussion_topics/${pathPart(topicId)}`);
  }

  if (area === "quizzes") {
    const quizId = segments[3];

    if (!quizId) {
      return client.getAll(`/api/v1/courses/${pathPart(courseId)}/quizzes`, { per_page: 100 });
    }

    return client.getJson(`/api/v1/courses/${pathPart(courseId)}/quizzes/${pathPart(quizId)}`);
  }

  if (area === "files") {
    const fileId = segments[3];

    if (!fileId) {
      return client.getAll(`/api/v1/courses/${pathPart(courseId)}/files`, { per_page: 100 });
    }

    return client.getJson(`/api/v1/files/${pathPart(fileId)}`);
  }

  if (area === "modules") {
    if (!segments[3]) {
      return client.getAll(`/api/v1/courses/${pathPart(courseId)}/modules`, {
        "include[]": ["items"],
        per_page: 100,
      });
    }

    if (segments[3] === "items" && segments[4]) {
      return findModuleItemContent(courseId, segments[4]);
    }

    if (segments[4] === "items" && segments[5]) {
      return getModuleItemContent(courseId, segments[3], segments[5]);
    }
  }

  return fallbackRenderedPage(url, maxChars);
}

async function findModuleItemContent(courseId: string, itemId: string) {
  const modules = await client.getAll<Record<string, unknown>>(`/api/v1/courses/${pathPart(courseId)}/modules`, {
    "include[]": ["items"],
    per_page: 100,
  });

  for (const module of modules) {
    const moduleItems = Array.isArray(module.items) ? module.items : [];
    const match = moduleItems.find((item) => isRecord(item) && String(item.id) === String(itemId));

    if (isRecord(match) && module.id !== undefined) {
      return getModuleItemContent(courseId, String(module.id), itemId, match);
    }
  }

  throw new Error(`Could not find module item ${itemId} in course ${courseId}.`);
}

async function fallbackRenderedPage(url: URL, maxChars: number) {
  if (client.canReadRenderedPages()) {
    return {
      rendered_page_text: await client.readRenderedPageText(url.href, maxChars),
      source_url: url.href,
      note: "Returned rendered browser text because this Canvas URL does not map cleanly to one of the API helpers.",
    };
  }

  throw new Error(
    "This Canvas URL does not map to a built-in API helper. Pass an /api/v1/... path, or use Chrome mode for rendered page text.",
  );
}

function compactCourse(course: Record<string, unknown>) {
  return {
    id: course.id,
    name: course.name,
    course_code: course.course_code,
    workflow_state: course.workflow_state,
    enrollment_term_id: course.enrollment_term_id,
    term: course.term,
    start_at: course.start_at,
    end_at: course.end_at,
    is_favorite: course.is_favorite,
  };
}

function compactUser(profile: Record<string, unknown>) {
  return {
    id: profile.id,
    name: profile.name,
    short_name: profile.short_name,
    sortable_name: profile.sortable_name,
    locale: profile.locale,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

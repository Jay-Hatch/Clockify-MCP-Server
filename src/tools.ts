import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { ClockifyApiError, ClockifyClient } from "./clockify.js";
import { config, resolveWorkspaceId } from "./config.js";

const isoDateDescription = "Date-time in Clockify format, for example 2026-05-01T17:00:00Z.";

const commonWorkspaceShape = {
  workspaceId: z
    .string()
    .optional()
    .describe("Clockify workspace ID. Defaults to CLOCKIFY_WORKSPACE_ID when set."),
};

const paginationShape = {
  page: z.number().int().min(1).optional().describe("Page number. Defaults to 1."),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Page size. Defaults depend on the Clockify endpoint."),
};

const customFieldSchema = z
  .object({
    customFieldId: z.string().optional(),
    id: z.string().optional(),
    value: z.unknown().optional(),
  })
  .passthrough();

const customAttributeSchema = z.record(z.string(), z.unknown());

const timeEntryTypeSchema = z.enum(["REGULAR", "BREAK"]);

const timeEntryCreateShape = {
  ...commonWorkspaceShape,
  projectId: z.string().describe("Clockify project ID to assign to the entry."),
  description: z.string().min(1).max(3000).describe("Time entry description."),
  start: z.string().describe(isoDateDescription),
  end: z.string().describe(isoDateDescription),
  billable: z.boolean().optional(),
  tagIds: z.array(z.string()).optional(),
  taskId: z.string().optional(),
  type: timeEntryTypeSchema.optional(),
  customFields: z.array(customFieldSchema).max(50).optional(),
  customAttributes: z.array(customAttributeSchema).max(10).optional(),
};

const AUDIT_ACTIONS = [
  "CREATE_TIME_PERSONAL_TIMER",
  "CREATE_TIME_PERSONAL_MANUAL",
  "CREATE_TIME_IMPORT",
  "CREATE_TIME_KIOSK",
  "CREATE_TIME_FOR_OTHER",
  "RESTORE_TIME",
  "RESTORE_TIME_FOR_OTHER",
  "UPDATE_TIME_PERSONAL",
  "UPDATE_TIME_FOR_OTHER",
  "DELETE_TIME_PERSONAL",
  "DELETE_TIME_FOR_OTHER",
  "CREATE_PROJECT",
  "CREATE_PROJECT_IMPORT",
  "CREATE_PROJECT_QUICKBOOKS",
  "UPDATE_PROJECT",
  "DELETE_PROJECT",
  "CREATE_TASK",
  "CREATE_TASK_IMPORT",
  "UPDATE_TASK",
  "DELETE_TASK",
  "CREATE_CLIENT",
  "CREATE_CLIENT_IMPORT",
  "CREATE_CLIENT_QUICKBOOKS",
  "UPDATE_CLIENT",
  "DELETE_CLIENT",
  "CREATE_TAG",
  "CREATE_TAG_IMPORT",
  "UPDATE_TAG",
  "DELETE_TAG",
  "CREATE_EXPENSE",
  "CREATE_EXPENSE_FOR_OTHER",
  "RESTORE_EXPENSE",
  "RESTORE_EXPENSE_FOR_OTHER",
  "UPDATE_EXPENSE",
  "UPDATE_EXPENSE_FOR_OTHER",
  "DELETE_EXPENSE",
  "DELETE_EXPENSE_FOR_OTHER",
] as const;

type CurrentUser = {
  id: string;
};

type WorkspaceUser = {
  id?: unknown;
  name?: unknown;
  email?: unknown;
  status?: unknown;
  [key: string]: unknown;
};

type AuditAuthorsInput = {
  authorIds?: unknown;
  ids?: unknown;
  contains?: unknown;
  [key: string]: unknown;
};

const auditAuthorsSchema = z
  .object({
    authorIds: z
      .array(z.string())
      .optional()
      .describe("Clockify user IDs that authored changes. Use SYSTEM for system events."),
    contains: z.enum(["CONTAINS", "DOES_NOT_CONTAIN"]).optional(),
  })
  .passthrough();

const asToolResult = (result: unknown): CallToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify(result, null, 2),
    },
  ],
  structuredContent:
    result && typeof result === "object" && !Array.isArray(result)
      ? { ...(result as Record<string, unknown>) }
      : { result },
});

const asToolError = (error: unknown): CallToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: formatError(error),
    },
  ],
});

const formatError = (error: unknown) => {
  if (error instanceof ClockifyApiError) {
    return JSON.stringify(
      {
        message: error.message,
        status: error.status,
        statusText: error.statusText,
        url: error.url,
        responseBody: error.responseBody,
      },
      null,
      2,
    );
  }

  return error instanceof Error ? error.message : String(error);
};

const handleClockifyTool = async (operation: () => Promise<unknown>) => {
  try {
    return asToolResult(await operation());
  } catch (error) {
    return asToolError(error);
  }
};

const resolveUserId = async (client: ClockifyClient, userId?: string) => {
  if (userId) {
    return userId;
  }

  if (config.defaultUserId) {
    return config.defaultUserId;
  }

  const currentUser = await client.api<CurrentUser>("/user");
  return currentUser.id;
};

const nowIso = () => new Date().toISOString();

const normalizeAuditAuthors = (
  authors?: AuditAuthorsInput,
  authorIds?: string[],
  includeSystemAuthor?: boolean,
) => {
  const normalizedAuthors = authors ? { ...authors } : {};
  const rawAuthorIds = authorIds ?? normalizedAuthors.authorIds ?? normalizedAuthors.ids ?? [];
  const normalizedAuthorIds = Array.isArray(rawAuthorIds)
    ? rawAuthorIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];

  if (includeSystemAuthor && !normalizedAuthorIds.includes("SYSTEM")) {
    normalizedAuthorIds.push("SYSTEM");
  }

  delete normalizedAuthors.ids;

  return {
    ...normalizedAuthors,
    contains: normalizedAuthors.contains ?? "CONTAINS",
    authorIds: normalizedAuthorIds,
  };
};

const validateAuditDateRange = (start: string, end: string) => {
  const startDate = new Date(start);
  const endDate = new Date(end);

  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    throw new Error("Audit log start and end must be valid date-time strings.");
  }

  if (endDate <= startDate) {
    throw new Error("Audit log end must be after start.");
  }

  const maxAuditRangeMs = 30 * 24 * 60 * 60 * 1000;

  if (endDate.getTime() - startDate.getTime() > maxAuditRangeMs) {
    throw new Error("Clockify audit log reports are limited to a maximum 30-day date range.");
  }
};

export const registerClockifyTools = (server: McpServer) => {
  const client = new ClockifyClient();

  server.registerTool(
    "find_project",
    {
      title: "Find Project",
      description: "Find Clockify projects in a workspace by name and filters.",
      inputSchema: {
        ...commonWorkspaceShape,
        name: z.string().optional(),
        strictNameSearch: z.boolean().optional(),
        archived: z.boolean().optional(),
        billable: z.boolean().optional(),
        clientIds: z.array(z.string()).optional(),
        containsClient: z.boolean().optional(),
        clientStatus: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).optional(),
        userIds: z.array(z.string()).optional(),
        containsUser: z.boolean().optional(),
        userStatus: z.enum(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).optional(),
        hydrated: z.boolean().optional(),
        access: z.enum(["PUBLIC", "PRIVATE"]).optional(),
        sortColumn: z
          .enum(["ID", "NAME", "CLIENT_NAME", "DURATION", "BUDGET", "PROGRESS"])
          .optional(),
        sortOrder: z.enum(["ASCENDING", "DESCENDING"]).optional(),
        ...paginationShape,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) =>
      handleClockifyTool(() =>
        client.api(`/workspaces/${resolveWorkspaceId(args.workspaceId)}/projects`, {
          query: {
            name: args.name,
            "strict-name-search": args.strictNameSearch,
            archived: args.archived,
            billable: args.billable,
            clients: args.clientIds,
            "contains-client": args.containsClient,
            "client-status": args.clientStatus,
            users: args.userIds,
            "contains-user": args.containsUser,
            "user-status": args.userStatus,
            hydrated: args.hydrated ?? true,
            access: args.access,
            "sort-column": args.sortColumn,
            "sort-order": args.sortOrder,
            page: args.page,
            "page-size": args.pageSize,
          },
        }),
      ),
  );

  server.registerTool(
    "get_workspace_users",
    {
      title: "Get Workspace Users",
      description:
        "Get Clockify users on a workspace, including user IDs. By default this fetches all pages and returns a compact userIds list plus the raw users.",
      inputSchema: {
        ...commonWorkspaceShape,
        name: z
          .string()
          .optional()
          .describe("Filter users whose name contains this string."),
        email: z
          .string()
          .optional()
          .describe("Filter users whose email address contains this string."),
        projectId: z
          .string()
          .optional()
          .describe("Filter to users who have access to this Clockify project ID."),
        status: z.enum(["PENDING", "ACTIVE", "DECLINED", "INACTIVE", "ALL"]).optional(),
        accountStatuses: z
          .array(z.string())
          .optional()
          .describe("Optional Clockify account status filters, for example ACTIVE or LIMITED."),
        memberships: z.enum(["ALL", "NONE", "WORKSPACE", "PROJECT", "USERGROUP"]).optional(),
        includeRoles: z
          .boolean()
          .optional()
          .describe("Include each user's detailed manager role information."),
        sortColumn: z
          .enum(["ID", "EMAIL", "NAME", "NAME_LOWERCASE", "ACCESS", "HOURLYRATE", "COSTRATE"])
          .optional(),
        sortOrder: z.enum(["ASCENDING", "DESCENDING"]).optional(),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Fetch only this page unless fetchAll is true."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Page size. Defaults to 100 for fetchAll and Clockify's default otherwise."),
        fetchAll: z
          .boolean()
          .optional()
          .describe("Fetch every page until Clockify returns a short or empty page. Defaults to true when page is omitted."),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Safety limit for fetchAll. Defaults to 100."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) =>
      handleClockifyTool(async () => {
        const workspaceId = resolveWorkspaceId(args.workspaceId);
        const shouldFetchAll = args.fetchAll ?? args.page === undefined;
        const pageSize = args.pageSize ?? (shouldFetchAll ? 100 : undefined);

        const fetchPage = (page?: number) =>
          client.api<WorkspaceUser[]>(`/workspaces/${workspaceId}/users`, {
            query: {
              email: args.email,
              "project-id": args.projectId,
              status: args.status,
              "account-statuses": args.accountStatuses,
              name: args.name,
              "sort-column": args.sortColumn,
              "sort-order": args.sortOrder,
              page,
              "page-size": pageSize,
              memberships: args.memberships,
              "include-roles": args.includeRoles ?? false,
            },
          });

        if (!shouldFetchAll) {
          const users = await fetchPage(args.page);

          return {
            users,
            userIds: users.map(({ id, name, email, status }) => ({
              id,
              name,
              email,
              status,
            })),
            count: users.length,
          };
        }

        const users: WorkspaceUser[] = [];
        const maxPages = args.maxPages ?? 100;
        const effectivePageSize = pageSize ?? 100;
        let pagesFetched = 0;

        for (let page = args.page ?? 1; page < (args.page ?? 1) + maxPages; page += 1) {
          const pageUsers = await fetchPage(page);
          pagesFetched += 1;
          users.push(...pageUsers);

          if (pageUsers.length < effectivePageSize) {
            break;
          }
        }

        return {
          users,
          userIds: users.map(({ id, name, email, status }) => ({
            id,
            name,
            email,
            status,
          })),
          count: users.length,
          pagesFetched,
          maxPages,
          pageSize: effectivePageSize,
          truncatedByMaxPages: pagesFetched === maxPages,
        };
      }),
  );

  server.registerTool(
    "find_running_timer",
    {
      title: "Find Running Timer",
      description:
        "Find in-progress Clockify time entries on a workspace. Optionally filter results to one user ID.",
      inputSchema: {
        ...commonWorkspaceShape,
        userId: z.string().optional(),
        ...paginationShape,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) =>
      handleClockifyTool(async () => {
        const entries = await client.api<unknown[]>(
          `/workspaces/${resolveWorkspaceId(args.workspaceId)}/time-entries/status/in-progress`,
          {
            query: {
              page: args.page,
              "page-size": args.pageSize,
            },
          },
        );

        if (!args.userId) {
          return entries;
        }

        return entries.filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            "userId" in entry &&
            entry.userId === args.userId,
        );
      }),
  );

  server.registerTool(
    "get_time_entries",
    {
      title: "Get Time Entries",
      description:
        "Get time entries for a user on a Clockify workspace. Responses include Clockify customFieldValues when available.",
      inputSchema: {
        ...commonWorkspaceShape,
        userId: z
          .string()
          .optional()
          .describe("Clockify user ID. Defaults to CLOCKIFY_USER_ID or the API key owner."),
        start: z.string().optional().describe(isoDateDescription),
        end: z.string().optional().describe(isoDateDescription),
        description: z.string().optional(),
        projectId: z.string().optional(),
        taskId: z.string().optional(),
        tagIds: z.array(z.string()).optional(),
        projectRequired: z.boolean().optional(),
        taskRequired: z.boolean().optional(),
        hydrated: z.boolean().optional(),
        inProgress: z.boolean().optional(),
        getWeekBefore: z.string().optional().describe(isoDateDescription),
        ...paginationShape,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) =>
      handleClockifyTool(async () => {
        const workspaceId = resolveWorkspaceId(args.workspaceId);
        const userId = await resolveUserId(client, args.userId);

        return client.api(`/workspaces/${workspaceId}/user/${userId}/time-entries`, {
          query: {
            description: args.description,
            start: args.start,
            end: args.end,
            project: args.projectId,
            task: args.taskId,
            tags: args.tagIds,
            "project-required": args.projectRequired,
            "task-required": args.taskRequired,
            hydrated: args.hydrated ?? true,
            page: args.page,
            "page-size": args.pageSize,
            "in-progress": args.inProgress,
            "get-week-before": args.getWeekBefore,
          },
        });
      }),
  );

  server.registerTool(
    "create_time_entry",
    {
      title: "Create Time Entry",
      description:
        "Create a completed Clockify time entry for the API key owner, including project and description.",
      inputSchema: timeEntryCreateShape,
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) =>
      handleClockifyTool(() =>
        client.api(`/workspaces/${resolveWorkspaceId(args.workspaceId)}/time-entries`, {
          method: "POST",
          body: {
            billable: args.billable ?? false,
            customAttributes: args.customAttributes,
            customFields: args.customFields,
            description: args.description,
            end: args.end,
            projectId: args.projectId,
            start: args.start,
            tagIds: args.tagIds,
            taskId: args.taskId,
            type: args.type ?? "REGULAR",
          },
        }),
      ),
  );

  server.registerTool(
    "add_time_entry_for_user",
    {
      title: "Add Time Entry For User",
      description:
        "Add a completed Clockify time entry for another user on a workspace, including project and description.",
      inputSchema: {
        ...timeEntryCreateShape,
        userId: z.string().describe("Clockify user ID to create the time entry for."),
        fromEntry: z.string().optional().describe("Optional time entry ID to copy defaults from."),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) =>
      handleClockifyTool(() => {
        const workspaceId = resolveWorkspaceId(args.workspaceId);

        return client.api(`/workspaces/${workspaceId}/user/${args.userId}/time-entries`, {
          method: "POST",
          query: {
            "from-entry": args.fromEntry,
          },
          body: {
            billable: args.billable ?? false,
            customAttributes: args.customAttributes,
            customFields: args.customFields,
            description: args.description,
            end: args.end,
            projectId: args.projectId,
            start: args.start,
            tagIds: args.tagIds,
            taskId: args.taskId,
            type: args.type ?? "REGULAR",
          },
        });
      }),
  );

  server.registerTool(
    "delete_time_entry",
    {
      title: "Delete Time Entry",
      description: "Delete a Clockify time entry from a workspace.",
      inputSchema: {
        ...commonWorkspaceShape,
        timeEntryId: z.string().describe("Clockify time entry ID to delete."),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args) =>
      handleClockifyTool(async () => {
        const workspaceId = resolveWorkspaceId(args.workspaceId);
        await client.api(`/workspaces/${workspaceId}/time-entries/${args.timeEntryId}`, {
          method: "DELETE",
        });

        return {
          deleted: true,
          workspaceId,
          timeEntryId: args.timeEntryId,
        };
      }),
  );

  server.registerTool(
    "start_timer",
    {
      title: "Start Timer",
      description:
        "Start a Clockify timer for the API key owner by creating a time entry without an end time.",
      inputSchema: {
        ...commonWorkspaceShape,
        description: z.string().min(1).max(3000),
        projectId: z.string().optional(),
        start: z
          .string()
          .optional()
          .describe(`Optional ${isoDateDescription} Defaults to the current time.`),
        billable: z.boolean().optional(),
        tagIds: z.array(z.string()).optional(),
        taskId: z.string().optional(),
        type: timeEntryTypeSchema.optional(),
        customFields: z.array(customFieldSchema).max(50).optional(),
        customAttributes: z.array(customAttributeSchema).max(10).optional(),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) =>
      handleClockifyTool(() =>
        client.api(`/workspaces/${resolveWorkspaceId(args.workspaceId)}/time-entries`, {
          method: "POST",
          body: {
            billable: args.billable ?? false,
            customAttributes: args.customAttributes,
            customFields: args.customFields,
            description: args.description,
            projectId: args.projectId,
            start: args.start ?? nowIso(),
            tagIds: args.tagIds,
            taskId: args.taskId,
            type: args.type ?? "REGULAR",
          },
        }),
      ),
  );

  server.registerTool(
    "stop_timer",
    {
      title: "Stop Timer",
      description:
        "Stop the currently running Clockify timer on a workspace for a user. Defaults to the API key owner.",
      inputSchema: {
        ...commonWorkspaceShape,
        userId: z
          .string()
          .optional()
          .describe("Clockify user ID. Defaults to CLOCKIFY_USER_ID or the API key owner."),
        end: z
          .string()
          .optional()
          .describe(`Optional ${isoDateDescription} Defaults to the current time.`),
      },
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args) =>
      handleClockifyTool(async () => {
        const workspaceId = resolveWorkspaceId(args.workspaceId);
        const userId = await resolveUserId(client, args.userId);

        return client.api(`/workspaces/${workspaceId}/user/${userId}/time-entries`, {
          method: "PATCH",
          body: {
            end: args.end ?? nowIso(),
          },
        });
      }),
  );

  server.registerTool(
    "read_audit_log_report",
    {
      title: "Read Audit Log Report",
      description:
        "Read Clockify audit log entries for a workspace. Audit logs require the Clockify Enterprise audit log feature.",
      inputSchema: {
        ...commonWorkspaceShape,
        start: z.string().describe(isoDateDescription),
        end: z.string().describe(isoDateDescription),
        actions: z
          .array(z.enum(AUDIT_ACTIONS))
          .min(1)
          .optional()
          .describe("Defaults to every documented Clockify audit action."),
        authorIds: z
          .array(z.string())
          .optional()
          .describe("Clockify author user IDs to include. Use SYSTEM for system events."),
        includeSystemAuthor: z
          .boolean()
          .optional()
          .describe("Add SYSTEM to the authorIds filter."),
        authors: auditAuthorsSchema
          .optional()
          .describe(
            "Raw Clockify authors filter object. Use authorIds, not ids. Defaults to all authors.",
          ),
        page: z.number().int().min(0).optional(),
        pageSize: z.number().int().min(1).max(50).optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) =>
      handleClockifyTool(() => {
        validateAuditDateRange(args.start, args.end);

        return client.auditLog(`/workspaces/${resolveWorkspaceId(args.workspaceId)}/audit-log`, {
          method: "POST",
          body: {
            actions: args.actions ?? AUDIT_ACTIONS,
            authors: normalizeAuditAuthors(
              args.authors,
              args.authorIds,
              args.includeSystemAuthor,
            ),
            end: args.end,
            page: args.page ?? 1,
            "page-size": args.pageSize ?? 20,
            start: args.start,
          },
        });
      }),
  );
};

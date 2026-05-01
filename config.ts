import "dotenv/config";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");

export const config = {
  port: Number(process.env.PORT ?? 3000),
  clockifyApiKey: process.env.CLOCKIFY_API_KEY,
  clockifyApiBaseUrl: trimTrailingSlash(
    process.env.CLOCKIFY_API_BASE_URL ?? "https://api.clockify.me/api/v1",
  ),
  clockifyReportsBaseUrl: trimTrailingSlash(
    process.env.CLOCKIFY_REPORTS_BASE_URL ?? "https://reports.api.clockify.me/v1",
  ),
  clockifyAuditLogBaseUrl: trimTrailingSlash(
    process.env.CLOCKIFY_AUDIT_LOG_BASE_URL ?? "https://auditlog-api.api.clockify.me/v1",
  ),
  defaultWorkspaceId:
    process.env.CLOCKIFY_WORKSPACE_ID ?? process.env.CLOCKIFY_DEFAULT_WORKSPACE_ID,
  defaultUserId: process.env.CLOCKIFY_USER_ID ?? process.env.CLOCKIFY_DEFAULT_USER_ID,
  serverToken: process.env.MCP_SERVER_TOKEN,
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};

export const requireClockifyApiKey = () => {
  if (!config.clockifyApiKey) {
    throw new Error("CLOCKIFY_API_KEY is not configured.");
  }

  return config.clockifyApiKey;
};

export const resolveWorkspaceId = (workspaceId?: string) => {
  const resolved = workspaceId ?? config.defaultWorkspaceId;

  if (!resolved) {
    throw new Error(
      "workspaceId is required. Pass it to the tool or set CLOCKIFY_WORKSPACE_ID.",
    );
  }

  return resolved;
};

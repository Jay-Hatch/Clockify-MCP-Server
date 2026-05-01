# Clockify Railway MCP Server

Remote MCP server for Clockify, designed for Railway. It exposes a Streamable HTTP MCP endpoint at `/mcp` and reads your Clockify API key from Railway environment variables.

## Tools

- `find_project`
- `get_workspace_users`
- `find_running_timer`
- `get_time_entries`
- `create_time_entry`
- `add_time_entry_for_user`
- `delete_time_entry`
- `start_timer`
- `stop_timer`
- `read_audit_log_report`

## Railway Setup

1. Create a new Railway service from this repository.
2. Add these environment variables in Railway:

```bash
CLOCKIFY_API_KEY=your_clockify_api_key
CLOCKIFY_WORKSPACE_ID=optional_default_workspace_id
CLOCKIFY_USER_ID=optional_default_user_id
MCP_SERVER_TOKEN=choose_a_long_random_token
```

3. Deploy. Railway will run `npm run build` during build and `npm run start` on deploy.
4. Your MCP endpoint will be:

```text
https://your-railway-app.up.railway.app/mcp
```

If `MCP_SERVER_TOKEN` is set, configure your MCP client to send:

```text
Authorization: Bearer <MCP_SERVER_TOKEN>
```

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Local health check:

```text
http://localhost:3000/health
```

Local MCP endpoint:

```text
http://localhost:3000/mcp
```

## Clockify Regions and Subdomains

By default, the server uses Clockify's global API hosts:

```bash
CLOCKIFY_API_BASE_URL=https://api.clockify.me/api/v1
CLOCKIFY_REPORTS_BASE_URL=https://reports.api.clockify.me/v1
CLOCKIFY_AUDIT_LOG_BASE_URL=https://auditlog-api.api.clockify.me/v1
```

For regional or subdomain workspaces, override these in Railway. Clockify documents examples such as:

```bash
CLOCKIFY_API_BASE_URL=https://euc1.clockify.me/api/v1
CLOCKIFY_REPORTS_BASE_URL=https://use2.clockify.me/report/v1
```

For a subdomain workspace, use your workspace-specific Clockify API key and the correct subdomain URL from Clockify's API docs.

## Notes

- `get_workspace_users` returns both raw Clockify users and a compact `userIds` list with `id`, `name`, `email`, and `status`.
- `create_time_entry` and `add_time_entry_for_user` require both `projectId` and `description`.
- `get_time_entries` returns Clockify's `customFieldValues` when Clockify includes them in the API response.
- `read_audit_log_report` requires Clockify's audit log feature, which is an Enterprise workspace feature.
- If you do not set `MCP_SERVER_TOKEN`, the Railway MCP endpoint is public.

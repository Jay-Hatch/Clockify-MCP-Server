import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";

import { config } from "./config.js";
import { registerClockifyTools } from "./tools.js";

const buildMcpServer = () => {
  const server = new McpServer(
    {
      name: "clockify-railway-mcp-server",
      version: "1.0.0",
    },
    {
      instructions:
        "Use these tools to work with Clockify projects, timers, time entries, and audit logs. Prefer find_project before creating entries when the user gives a project name instead of a project ID.",
    },
  );

  registerClockifyTools(server);

  return server;
};

const app = createMcpExpressApp({ host: "0.0.0.0" });

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id",
  );

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

const requireBearerToken = (req: Request, res: Response, next: NextFunction) => {
  if (!config.serverToken) {
    next();
    return;
  }

  const authorization = req.header("authorization");

  if (authorization !== `Bearer ${config.serverToken}`) {
    res.status(401).json({
      error: "Unauthorized",
      message: "Send Authorization: Bearer <MCP_SERVER_TOKEN>.",
    });
    return;
  }

  next();
};

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    name: "clockify-railway-mcp-server",
    clockifyApiConfigured: Boolean(config.clockifyApiKey),
    authEnabled: Boolean(config.serverToken),
  });
});

app.post("/mcp", requireBearerToken, async (req: Request, res: Response) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", requireBearerToken, (_req: Request, res: Response) => {
  res.status(405).setHeader("Allow", "POST").json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST for this stateless MCP server.",
    },
    id: null,
  });
});

app.delete("/mcp", requireBearerToken, (_req: Request, res: Response) => {
  res.status(405).setHeader("Allow", "POST").json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This stateless MCP server has no sessions to delete.",
    },
    id: null,
  });
});

if (!config.serverToken) {
  console.warn(
    "MCP_SERVER_TOKEN is not set. Your Railway MCP endpoint will be public unless Railway/network controls protect it.",
  );
}

const httpServer = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Clockify MCP server listening on port ${config.port}`);
  console.log("MCP endpoint: /mcp");
});

httpServer.on("error", (error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

const shutdown = () => {
  httpServer.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

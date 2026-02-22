import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const pomodoroHtml = readFileSync("public/pomodoro-widget.html", "utf8");

/* ---------------------------
   Schemas
---------------------------- */

const startTimerSchema = {
  minutes: z.number().int().nonnegative().optional(),
  seconds: z.number().int().nonnegative().optional(),
};

const editTimerSchema = startTimerSchema;

/* ---------------------------
   Timer State (in-memory)
---------------------------- */

let timer = {
  durationMs: 0,
  remainingMs: 0,
  startedAt: null,
  isRunning: false,
  timeoutRef: null,
};

/* ---------------------------
   Helpers
---------------------------- */

function computeRemaining() {
  if (!timer.isRunning || !timer.startedAt) {
    return timer.remainingMs;
  }

  const elapsed = Date.now() - timer.startedAt;
  return Math.max(timer.durationMs - elapsed, 0);
}

function replyWithTimer(message) {
  const remainingMs = computeRemaining();

  return {
    content: message ? [{ type: "text", text: message }] : [],
    structuredContent: {
      isRunning: timer.isRunning,
      durationMs: timer.durationMs,
      remainingMs,
      remainingSeconds: Math.ceil(remainingMs / 1000),
    },
  };
}

/* ---------------------------
   MCP Server
---------------------------- */

function createPomodoroServer() {
  const server = new McpServer({
    name: "pomodoro-app",
    version: "0.1.0",
  });

  registerAppResource(
    server,
    "pomodoro-widget",
    "ui://widget/pomodoro.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/pomodoro.html",
          mimeType: RESOURCE_MIME_TYPE,
          text: pomodoroHtml,
        },
      ],
    }),
  );

  /* ---------------------------
     Start Timer
  ---------------------------- */

  registerAppTool(
    server,
    "start_timer",
    {
      title: "Start timer",
      description: "Starts a Pomodoro timer with minutes or seconds.",
      inputSchema: startTimerSchema,
      _meta: {
        ui: { resourceUri: "ui://widget/pomodoro.html" },
      },
    },
    async (args) => {
      const minutes = args?.minutes ?? 0;
      const seconds = args?.seconds ?? 0;

      const durationMs = minutes * 60000 + seconds * 1000;

      if (durationMs <= 0) {
        return replyWithTimer("Provide a duration greater than 0.");
      }

      if (timer.timeoutRef) {
        clearTimeout(timer.timeoutRef);
      }

      timer.durationMs = durationMs;
      timer.remainingMs = durationMs;
      timer.startedAt = Date.now();
      timer.isRunning = true;

      timer.timeoutRef = setTimeout(() => {
        timer.isRunning = false;
        timer.remainingMs = 0;
        timer.startedAt = null;
        timer.timeoutRef = null;
        console.log("Pomodoro complete.");
      }, durationMs);

      return replyWithTimer("Timer started.");
    },
  );

  /* ---------------------------
     Stop Timer
  ---------------------------- */

  registerAppTool(
    server,
    "stop_timer",
    {
      title: "Stop timer",
      description: "Stops the current timer.",
      inputSchema: {},
      _meta: {
        ui: { resourceUri: "ui://widget/pomodoro.html" },
      },
    },
    async () => {
      if (!timer.isRunning) {
        return replyWithTimer("Timer is not running.");
      }

      const remaining = computeRemaining();

      clearTimeout(timer.timeoutRef);

      timer.remainingMs = remaining;
      timer.isRunning = false;
      timer.startedAt = null;
      timer.timeoutRef = null;

      return replyWithTimer("Timer stopped.");
    },
  );

  /* ---------------------------
     Edit Timer
  ---------------------------- */

  registerAppTool(
    server,
    "edit_timer",
    {
      title: "Edit timer",
      description: "Changes the timer duration.",
      inputSchema: editTimerSchema,
      _meta: {
        ui: { resourceUri: "ui://widget/pomodoro.html" },
      },
    },
    async (args) => {
      const minutes = args?.minutes ?? 0;
      const seconds = args?.seconds ?? 0;

      const newDurationMs = minutes * 60000 + seconds * 1000;

      if (newDurationMs <= 0) {
        return replyWithTimer("Provide a duration greater than 0.");
      }

      if (timer.timeoutRef) {
        clearTimeout(timer.timeoutRef);
      }

      timer.durationMs = newDurationMs;
      timer.remainingMs = newDurationMs;
      timer.startedAt = timer.isRunning ? Date.now() : null;

      if (timer.isRunning) {
        timer.timeoutRef = setTimeout(() => {
          timer.isRunning = false;
          timer.remainingMs = 0;
          timer.startedAt = null;
          timer.timeoutRef = null;
          console.log("Pomodoro complete.");
        }, newDurationMs);
      }

      return replyWithTimer("Timer updated.");
    },
  );

  /* ---------------------------
     Get Timer State
  ---------------------------- */

  registerAppTool(
    server,
    "get_timer",
    {
      title: "Get timer",
      description: "Returns the current timer state.",
      inputSchema: {},
      _meta: {
        ui: { resourceUri: "ui://widget/pomodoro.html" },
      },
    },
    async () => replyWithTimer(),
  );

  return server;
}

/* ---------------------------
   HTTP Server (unchanged structure)
---------------------------- */

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("Pomodoro MCP server");
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createPomodoroServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(
    `Pomodoro MCP server listening on http://localhost:${port}${MCP_PATH}`,
  );
});

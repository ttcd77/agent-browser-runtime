import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface BrowserWorkerClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export interface BrowserWorkerHealth {
  ok?: boolean;
  defaultProfile?: string;
  cdpPort?: number;
  cdpEndpoint?: string;
  browserAttachMode?: string;
  browserLaunchMode?: string;
  tools?: string[];
  [key: string]: unknown;
}

export interface BrowserWorkerToolCatalog {
  tools: Array<{
    name: string;
    description?: string;
    parameters?: unknown;
  }>;
}

export class BrowserWorkerClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: BrowserWorkerClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ||
      process.env.AGENT_BROWSER_RUNTIME_URL ||
      process.env.AGENT_BROWSER_SERVER ||
      "http://127.0.0.1:17335",
    );
    this.timeoutMs = options.timeoutMs ?? Number(process.env.AGENT_BROWSER_MCP_TIMEOUT_MS || 30000);
  }

  async health(): Promise<BrowserWorkerHealth> {
    return await this.getJson<BrowserWorkerHealth>("/health");
  }

  async tools(): Promise<Tool[]> {
    const catalog = await this.getJson<BrowserWorkerToolCatalog>("/tools");
    return (catalog.tools || [])
      .filter((tool) => typeof tool?.name === "string" && tool.name.trim() !== "")
      .map((tool) => ({
        name: tool.name,
        description: tool.description || `Agent Browser Runtime tool: ${tool.name}`,
        inputSchema: normalizeInputSchema(tool.parameters),
      }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return await this.postJson<unknown>(`/tool/${encodeURIComponent(name)}`, args);
  }

  async doctor(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {
      schema: "agent-browser-runtime.mcp-worker-doctor.v1",
      checkedAt: new Date().toISOString(),
      ok: false,
      baseUrl: this.baseUrl,
      endpoints: {
        health: `${this.baseUrl}/health`,
        tools: `${this.baseUrl}/tools`,
        tool: `${this.baseUrl}/tool/{toolName}`,
        panel: `${this.baseUrl}/panel`,
      },
      nextActions: [],
    };
    try {
      const health = await this.health();
      const tools = await this.tools();
      result.ok = health.ok === true;
      result.health = health;
      result.toolCount = tools.length;
      result.facadeTools = tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("browser_"));
      if (result.ok !== true) {
        (result.nextActions as string[]).push("Worker responded but did not report ok=true. Check server logs.");
      }
    } catch (error) {
      result.error = String((error as Error)?.message || error);
      (result.nextActions as string[]).push("Start the Browser Worker: CDP_LAUNCH_BROWSER=1 npm run agent:server");
      (result.nextActions as string[]).push("If using a custom port, set AGENT_BROWSER_RUNTIME_URL before starting the MCP server.");
    }
    return result;
  }

  private async getJson<T>(path: string): Promise<T> {
    return await this.requestJson<T>("GET", path);
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return await this.requestJson<T>("POST", path, body);
  }

  private async requestJson<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${truncate(text, 500)}`);
      return text.trim() === "" ? ({} as T) : (JSON.parse(text) as T);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const DOCTOR_TOOL: Tool = {
  name: "browser_worker_doctor",
  description: "Check whether the local Agent Browser Runtime worker is reachable and list next setup actions.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export function toolResultText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function normalizeInputSchema(value: unknown): Tool["inputSchema"] {
  if (isRecord(value) && value.type === "object") {
    return value as Tool["inputSchema"];
  }
  return { type: "object", properties: {} };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

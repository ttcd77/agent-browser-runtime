export type AgentToolContent = {
  type: "text";
  text: string;
};

export type AgentToolResult = {
  content: AgentToolContent[];
  details?: unknown;
};

export type AnyAgentTool = {
  name: string;
  label?: string;
  description?: string;
  details?: string;
  parameters?: Record<string, unknown>;
  schema?: unknown;
  execute: (...args: any[]) => Promise<AgentToolResult> | AgentToolResult;
};

export type PluginLogger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

export type OpenClawPluginService = {
  id: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
};

export type OpenClawPluginApi = {
  logger: PluginLogger;
  registerTool: (factory: (ctx: unknown) => AnyAgentTool) => void;
  registerService: (service: OpenClawPluginService) => void;
};

export type OpenClawPluginEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: Record<string, unknown>;
  register: (api: OpenClawPluginApi) => void;
};

type DefinePluginEntryOptions = {
  id: string;
  name: string;
  description: string;
  configSchema?: Record<string, unknown>;
  register: (api: OpenClawPluginApi) => void;
};

export function definePluginEntry(options: DefinePluginEntryOptions): OpenClawPluginEntry {
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    configSchema: options.configSchema || { type: "object", properties: {} },
    register: options.register,
  };
}

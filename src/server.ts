import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ServerConfig, ParsedSpec, AuthConfig, GeneratedTool } from "./types";
import {
  parseOpenApiSpec,
  isOpenAPIFile,
  updateSpecServerUrls,
  resolveServerUrl,
} from "./utils/openapi-parser";
import { HttpClient } from "./utils/http-client";
import { ensureEnvKeysForSpecs, loadAuthConfig } from "./utils/auth";
import { PromptRegistrar } from "./prompts";
import { ToolRegistrar } from "./tools";
import fs from "fs";
import path from "path";

function debugLog(message: string) {
  try {
    const debugPath = path.join(__dirname, "../debug.log");
    fs.appendFileSync(debugPath, `${new Date().toISOString()}: ${message}\n`);
  } catch (e) {}
}

export class OpenApiMcpServer {
  private fastMCP: FastMCP;
  private httpClient: HttpClient;
  private parsedSpecs: Map<string, ParsedSpec> = new Map();
  private toolRegistry: Map<
    string,
    { spec: ParsedSpec; tool: GeneratedTool; schema: z.ZodObject<any> }
  > = new Map();
  private authConfig: AuthConfig = {};
  private config: ServerConfig;
  private envPath: string;
  private lastEnvMtimeMs: number | null = null;
  private envWatcher?: fs.FSWatcher;
  private envWatchTimeout?: NodeJS.Timeout;
  private resourceCounter = 0;
  private promptRegistrar: PromptRegistrar;
  private toolRegistrar: ToolRegistrar;

  constructor(config: ServerConfig) {
    this.config = config;
    this.httpClient = new HttpClient();
    this.envPath = path.join(this.config.specsPath, ".env");

    this.fastMCP = new FastMCP({
      name: "SpecRun",
      version: "1.0.0",
      instructions:
        "I SpecRun OpenAPI specifications to MCP tools. I load .json, .yaml, and .yml files containing OpenAPI specs from a specified folder and automatically generate tools for each endpoint. Authentication is handled via environment variables with naming patterns like {API_NAME}_API_KEY.",
    });

    this.toolRegistrar = new ToolRegistrar({
      fastMCP: this.fastMCP,
      toolRegistry: this.toolRegistry,
      httpClient: this.httpClient,
      getAuthConfig: () => this.authConfig,
      refreshEnvConfigIfChanged: this.refreshEnvConfigIfChanged.bind(this),
      createResponseResourceContent:
        this.createResponseResourceContent.bind(this),
    });

    this.promptRegistrar = new PromptRegistrar({
      fastMCP: this.fastMCP,
      toolRegistry: this.toolRegistry,
    });

    this.registerResponseResourceSupport();
    this.setupServerEvents();
    this.toolRegistrar.registerBatchDispatcherTool();
    this.promptRegistrar.registerPrompts();
  }

  private setupServerEvents(): void {
    this.fastMCP.on("connect", (event: any) => {
      this.authConfig = loadAuthConfig(this.config.specsPath);
      this.lastEnvMtimeMs = this.getEnvMtimeMs();
    });

    this.fastMCP.on("disconnect", (event: any) => {});
  }

  async start(): Promise<void> {
    // Only log to console if not in stdio mode (which would interfere with MCP protocol)
    const isStdioMode = this.config.transportType !== "httpStream";

    debugLog(`Starting SpecRun with specsPath: ${this.config.specsPath}`);

    if (!isStdioMode) {
      console.log("Starting SpecRun...");
    }

    // Load authentication config
    await this.loadSpecs();
    this.startEnvWatcher();

    debugLog(
      `After loading specs: ${this.parsedSpecs.size} specs, ${this.getTotalToolsCount()} tools`,
    );

    // Start FastMCP server AFTER all tools are registered
    const transportConfig =
      this.config.transportType === "httpStream" && this.config.port
        ? {
            transportType: "httpStream" as const,
            httpStream: { port: this.config.port },
          }
        : { transportType: "stdio" as const };

    this.fastMCP.start(transportConfig);

    if (!isStdioMode) {
      console.log(
        `SpecRun started. Loaded ${this.parsedSpecs.size} API specifications with ${this.getTotalToolsCount()} tools from ${this.config.specsPath}.`,
      );
    }
  }

  public async loadSpecs(): Promise<void> {
    const existingFiles = await this.getExistingFiles();
    ensureEnvKeysForSpecs(this.config.specsPath, existingFiles);
    this.authConfig = loadAuthConfig(this.config.specsPath);
    updateSpecServerUrls(existingFiles, process.env);
    this.lastEnvMtimeMs = this.getEnvMtimeMs();
    await this.loadExistingSpecs(existingFiles);
  }

  async stop(): Promise<void> {
    if (this.envWatchTimeout) {
      clearTimeout(this.envWatchTimeout);
      this.envWatchTimeout = undefined;
    }

    if (this.envWatcher) {
      this.envWatcher.close();
      this.envWatcher = undefined;
    }
  }

  private async loadExistingSpecs(existingFiles: string[]): Promise<void> {
    debugLog(
      `Found ${existingFiles.length} existing files: ${existingFiles.join(", ")}`,
    );
    for (const filePath of existingFiles) {
      debugLog(`Processing file: ${filePath}`);
      await this.handleSpecAdded(filePath);
    }
  }

  private async getExistingFiles(): Promise<string[]> {
    try {
      debugLog(`Reading directory: ${this.config.specsPath}`);

      // Ensure directory exists
      try {
        await fs.promises.access(this.config.specsPath);
      } catch {
        await fs.promises.mkdir(this.config.specsPath, { recursive: true });
        return [];
      }

      const files = await fs.promises.readdir(this.config.specsPath);
      debugLog(`Found files: ${files.join(", ")}`);

      const filteredFiles = files.filter((file) => {
        const isValid = isOpenAPIFile(file);
        debugLog(`File ${file}: isOpenAPIFile = ${isValid}`);
        return isValid;
      });

      const fullPaths = filteredFiles.map((file) =>
        path.join(this.config.specsPath, file),
      );
      debugLog(`Returning files: ${fullPaths.join(", ")}`);
      return fullPaths;
    } catch (error) {
      debugLog(`Error reading directory ${this.config.specsPath}: ${error}`);
      return [];
    }
  }

  private async handleSpecAdded(filePath: string): Promise<void> {
    debugLog(`Attempting to parse: ${filePath}`);
    const parsedSpec = await parseOpenApiSpec(filePath);
    if (parsedSpec) {
      debugLog(
        `Successfully parsed ${filePath}: ${parsedSpec.tools.length} tools`,
      );
      this.parsedSpecs.set(filePath, parsedSpec);
      this.toolRegistrar.registerToolsFromSpec(parsedSpec);
    } else {
      debugLog(`Failed to parse: ${filePath}`);
    }
  }

  private getEnvMtimeMs(): number | null {
    try {
      return fs.statSync(this.envPath).mtimeMs;
    } catch {
      return null;
    }
  }

  private refreshEnvConfigIfChanged(force = false): void {
    const currentMtimeMs = this.getEnvMtimeMs();
    if (!force && currentMtimeMs === this.lastEnvMtimeMs) {
      return;
    }

    this.authConfig = loadAuthConfig(this.config.specsPath);
    updateSpecServerUrls(Array.from(this.parsedSpecs.keys()), process.env);
    this.updateToolBaseUrlsFromEnv();
    this.lastEnvMtimeMs = currentMtimeMs;
  }

  private updateToolBaseUrlsFromEnv(): void {
    for (const spec of this.parsedSpecs.values()) {
      const newBaseUrl = resolveServerUrl(spec.apiName, process.env);
      if (!newBaseUrl) {
        continue;
      }
      const resolvedBaseUrl = this.resolveToolBaseUrl(spec, newBaseUrl);

      for (const tool of spec.tools) {
        tool.baseUrl = resolvedBaseUrl;
      }

      for (const entry of this.toolRegistry.values()) {
        if (entry.spec.apiName === spec.apiName) {
          entry.tool.baseUrl = resolvedBaseUrl;
        }
      }
    }
  }

  private resolveToolBaseUrl(spec: ParsedSpec, newBaseUrl: string): string {
    const swaggerSpec = spec.spec as any;
    if (swaggerSpec && swaggerSpec.swagger === "2.0") {
      try {
        const parsed = new URL(newBaseUrl);
        const hasPath = parsed.pathname && parsed.pathname !== "/";
        if (!hasPath && typeof swaggerSpec.basePath === "string") {
          const basePath = swaggerSpec.basePath.trim();
          if (basePath) {
            parsed.pathname = basePath;
            return parsed.toString().replace(/\/$/, "");
          }
        }
      } catch {
        return newBaseUrl;
      }
    }

    if (swaggerSpec && swaggerSpec.openapi) {
      return this.appendOpenApiBasePath(newBaseUrl, swaggerSpec);
    }

    return newBaseUrl;
  }

  private appendOpenApiBasePath(baseUrl: string, spec: any): string {
    const basePath = this.getOpenApiBasePath(spec);
    if (!basePath) {
      return baseUrl;
    }

    try {
      const parsed = new URL(baseUrl);
      const hasPath = parsed.pathname && parsed.pathname !== "/";
      if (hasPath) {
        return baseUrl;
      }

      parsed.pathname = basePath;
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return baseUrl;
    }
  }

  private getOpenApiBasePath(spec: any): string | null {
    const raw = (typeof spec?.basePath === "string" && spec.basePath) || "";
    const trimmed = String(raw).trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  }

  private startEnvWatcher(): void {
    if (this.envWatcher) {
      return;
    }

    try {
      this.envWatcher = fs.watch(this.envPath, (eventType) => {
        if (eventType !== "change" && eventType !== "rename") {
          return;
        }

        if (this.envWatchTimeout) {
          clearTimeout(this.envWatchTimeout);
        }

        this.envWatchTimeout = setTimeout(() => {
          this.refreshEnvConfigIfChanged(true);
        }, 50);
      });
    } catch {
      // Watching is best-effort; fall back to refresh-on-request only.
    }
  }

  private registerResponseResourceSupport(): void {
    this.fastMCP.addResource({
      uri: "specrun://responses",
      name: "SpecRun Responses",
      description: "SpecRun response resources",
      mimeType: "application/json",
      load: async () => ({
        text: JSON.stringify({
          message: "SpecRun response resources are available by URI.",
        }),
      }),
    });
  }

  private async createResponseResourceContent(
    name: string,
    description: string,
    payload: unknown,
  ): Promise<{ type: "resource"; resource: any }> {
    const uri = `specrun://responses/${this.createResourceId()}`;
    this.fastMCP.addResource({
      uri,
      name,
      description,
      mimeType: "application/json",
      load: async () => ({
        text: JSON.stringify(payload, null, 2),
      }),
    });

    return {
      type: "resource",
      resource: await this.fastMCP.embedded(uri),
    };
  }

  private createResourceId(): string {
    this.resourceCounter += 1;
    return `${Date.now()}-${this.resourceCounter}-${Math.floor(
      Math.random() * 1_000_000,
    )}`;
  }

  private getTotalToolsCount(): number {
    return Array.from(this.parsedSpecs.values()).reduce(
      (total, spec) => total + spec.tools.length,
      0,
    );
  }

  public getLoadedSpecs(): ParsedSpec[] {
    return Array.from(this.parsedSpecs.values());
  }

  public getAuthConfig(): AuthConfig {
    return this.authConfig;
  }
}

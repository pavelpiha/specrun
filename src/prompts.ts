import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ParsedSpec, GeneratedTool } from "./types";

type ToolRegistryEntry = {
  spec: ParsedSpec;
  tool: GeneratedTool;
  schema: z.ZodObject<any>;
};

type ToolRegistry = Map<string, ToolRegistryEntry>;

export class PromptRegistrar {
  private fastMCP: FastMCP;
  private toolRegistry: ToolRegistry;

  constructor(options: { fastMCP: FastMCP; toolRegistry: ToolRegistry }) {
    this.fastMCP = options.fastMCP;
    this.toolRegistry = options.toolRegistry;
  }

  registerPrompts(): void {
    this.fastMCP.addPrompt({
      name: "list_apis",
      description:
        "List loaded APIs/tools and ask the user to choose an endpoint.",
      arguments: [
        {
          name: "filter",
          description: "Optional substring to filter tool or API names.",
          required: false,
        },
        {
          name: "max_results",
          description: "Maximum number of tools to display.",
          required: false,
        },
        {
          name: "cursor",
          description: "Pagination cursor from a previous list_apis response.",
          required: false,
        },
      ],
      load: async (args: Record<string, any>) => {
        const parsed = this.parseListApisArgs(args);
        if (!parsed.ok) {
          return {
            messages: [
              {
                role: "user",
                content: { type: "text", text: parsed.error },
              },
            ],
          };
        }

        const { filter, maxResults, offset } = parsed;
        const matches = this.getToolEntries(filter);
        const visible = matches.slice(offset, offset + maxResults);
        const hasMore = offset + maxResults < matches.length;
        const nextCursor = hasMore
          ? this.encodeCursor({
              offset: offset + maxResults,
              filter,
              maxResults,
            })
          : null;
        const text = this.buildToolListPromptText(
          visible,
          matches.length,
          filter,
          maxResults,
          offset,
          nextCursor,
        );

        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text },
            },
          ],
        };
      },
    });

    const completeToolNames = async (value: string, _auth: unknown) =>
      this.completeToolNames(value);
    const completePostToolNames = async (value: string, _auth: unknown) =>
      this.completePostToolNames(value);

    this.fastMCP.addPrompt({
      name: "generate_api_call",
      description:
        "Collect required inputs for a tool and provide a ready-to-run JSON payload.",
      arguments: [
        {
          name: "tool_name",
          description: "Exact SpecRun tool name.",
          required: true,
          complete: completeToolNames,
        },
      ],
      load: async (args: Record<string, any>) => {
        const toolNameResult = this.parseToolNameArg(args?.tool_name);
        if (!toolNameResult.ok) {
          return {
            messages: [
              {
                role: "user",
                content: { type: "text", text: toolNameResult.error },
              },
            ],
          };
        }

        const toolName = toolNameResult.toolName;
        const entry = this.toolRegistry.get(toolName);

        if (!entry) {
          return {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Unknown tool: ${this.sanitizePromptText(
                    toolName,
                  )}. Ask the user to choose a valid tool name.`,
                },
              },
            ],
          };
        }

        const payload = this.buildExamplePayload(entry.tool);
        const lines: string[] = [];
        lines.push(
          `Tool: ${this.sanitizePromptText(entry.tool.name)}`,
          `Method: ${this.sanitizePromptText(
            entry.tool.method,
          )} ${this.sanitizePromptText(entry.tool.path)}`,
          "",
          this.buildRequiredOptionalSummary(entry.tool),
          "",
          "Ready-to-run JSON input:",
          "```json",
          JSON.stringify(payload, null, 2),
          "```",
          "",
          "Ask the user to confirm or provide missing required values.",
        );

        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: lines.join("\n") },
            },
          ],
        };
      },
    });

    this.fastMCP.addPrompt({
      name: "explain_api_schema",
      description: "Explain tool parameters and request body schema.",
      arguments: [
        {
          name: "tool_name",
          description: "Exact SpecRun tool name.",
          required: true,
          complete: completeToolNames,
        },
      ],
      load: async (args: Record<string, any>) => {
        const toolNameResult = this.parseToolNameArg(args?.tool_name);
        if (!toolNameResult.ok) {
          return {
            messages: [
              {
                role: "user",
                content: { type: "text", text: toolNameResult.error },
              },
            ],
          };
        }

        const toolName = toolNameResult.toolName;
        const entry = this.toolRegistry.get(toolName);
        if (!entry) {
          return {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Unknown tool: ${this.sanitizePromptText(
                    toolName,
                  )}. Ask the user to choose a valid tool name.`,
                },
              },
            ],
          };
        }

        const text = this.buildSchemaExplanation(entry.tool);
        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text },
            },
          ],
        };
      },
    });

    this.fastMCP.addPrompt({
      name: "generate_random_data",
      description:
        "Generate random, ready-to-run JSON payload samples for a tool.",
      arguments: [
        {
          name: "tool_name",
          description: "Exact SpecRun POST tool name.",
          required: true,
          complete: completePostToolNames,
        },
        {
          name: "count",
          description:
            "Number of random payload samples to generate (default 1).",
          required: false,
        },
        {
          name: "include_optional",
          description:
            "Include optional fields in generated payloads (default false).",
          required: false,
        },
      ],
      load: async (args: Record<string, any>) => {
        const toolNameResult = this.parsePostToolNameArg(args?.tool_name);
        if (!toolNameResult.ok) {
          return {
            messages: [
              {
                role: "user",
                content: { type: "text", text: toolNameResult.error },
              },
            ],
          };
        }

        const countResult = this.parseRandomCountArg(args?.count);
        if (!countResult.ok) {
          return {
            messages: [
              {
                role: "user",
                content: { type: "text", text: countResult.error },
              },
            ],
          };
        }

        const includeOptionalResult = this.parseIncludeOptionalArg(
          args?.include_optional,
        );
        if (!includeOptionalResult.ok) {
          return {
            messages: [
              {
                role: "user",
                content: { type: "text", text: includeOptionalResult.error },
              },
            ],
          };
        }

        const toolName = toolNameResult.toolName;
        const entry = this.toolRegistry.get(toolName);
        if (!entry) {
          return {
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Unknown tool: ${this.sanitizePromptText(
                    toolName,
                  )}. Ask the user to choose a valid tool name.`,
                },
              },
            ],
          };
        }

        const lines: string[] = [];
        lines.push(
          `Tool: ${this.sanitizePromptText(entry.tool.name)}`,
          `Method: ${this.sanitizePromptText(
            entry.tool.method,
          )} ${this.sanitizePromptText(entry.tool.path)}`,
          "",
          this.buildRequiredOptionalSummary(entry.tool),
        );

        if (!includeOptionalResult.includeOptional) {
          lines.push(
            "",
            "Generation mode: required fields only.",
            "If you want optional fields too, rerun with include_optional: true.",
          );
        }

        if (countResult.count === 1) {
          const sample = this.buildRandomPayload(
            entry.tool,
            1,
            includeOptionalResult.includeOptional,
          );
          lines.push(
            "",
            "Random payload sample:",
            "```json",
            JSON.stringify(sample, null, 2),
            "```",
          );
        } else {
          const items: Record<string, any>[] = [];
          for (let i = 0; i < countResult.count; i++) {
            items.push(
              this.buildRandomPayload(
                entry.tool,
                i + 1,
                includeOptionalResult.includeOptional,
              ),
            );
          }

          const batchInput = {
            toolName: entry.tool.name,
            items,
            failFast: false,
          };

          lines.push(
            "",
            `Batch input for specrun_batch (${countResult.count} items):`,
            "```json",
            JSON.stringify(batchInput, null, 2),
            "```",
            "Run specrun_batch with this payload.",
          );

          if (countResult.count > 200) {
            lines.push(
              "For batches over 200 items, specrun_batch will require confirmLargeBatch and confirmLargeBatchToken.",
            );
          }
        }

        lines.push("", "Adjust values if needed before running the tool.");

        return {
          messages: [
            {
              role: "user",
              content: { type: "text", text: lines.join("\n") },
            },
          ],
        };
      },
    });
  }

  private parseMaxResults(
    value: unknown,
  ): { ok: true; value: number } | { ok: false; error: string } {
    if (value === undefined || value === null || value === "") {
      return { ok: true, value: 50 };
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: "max_results must be a number." };
    }

    return {
      ok: true,
      value: Math.min(Math.max(1, Math.floor(parsed)), 200),
    };
  }

  private parseFilter(
    value: unknown,
  ): { ok: true; value: string } | { ok: false; error: string } {
    if (value === undefined || value === null || value === "") {
      return { ok: true, value: "" };
    }

    if (typeof value !== "string") {
      return { ok: false, error: "filter must be a string." };
    }

    const trimmed = value.trim();
    if (trimmed.length > 200) {
      return { ok: false, error: "filter is too long." };
    }

    return { ok: true, value: trimmed };
  }

  private parseCursor(
    value: unknown,
  ): { ok: true; value: string | null } | { ok: false; error: string } {
    if (value === undefined || value === null || value === "") {
      return { ok: true, value: null };
    }

    if (typeof value !== "string") {
      return { ok: false, error: "cursor must be a string." };
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: false, error: "cursor must not be empty." };
    }

    return { ok: true, value: trimmed };
  }

  private parseListApisArgs(
    args: Record<string, any>,
  ):
    | { ok: true; filter: string; maxResults: number; offset: number }
    | { ok: false; error: string } {
    const filterResult = this.parseFilter(args?.filter);
    if (!filterResult.ok) {
      return filterResult;
    }

    const maxResultsResult = this.parseMaxResults(args?.max_results);
    if (!maxResultsResult.ok) {
      return maxResultsResult;
    }

    const cursorResult = this.parseCursor(args?.cursor);
    if (!cursorResult.ok) {
      return cursorResult;
    }

    if (!cursorResult.value) {
      return {
        ok: true,
        filter: filterResult.value,
        maxResults: maxResultsResult.value,
        offset: 0,
      };
    }

    const decoded = this.decodeCursor(cursorResult.value);
    if (!decoded) {
      return {
        ok: false,
        error: "Invalid cursor. Request the first page without a cursor.",
      };
    }

    if (filterResult.value && filterResult.value !== decoded.filter) {
      return {
        ok: false,
        error: "filter does not match the cursor filter.",
      };
    }

    if (args?.max_results !== undefined) {
      const expected = this.parseMaxResults(args?.max_results);
      if (!expected.ok || expected.value !== decoded.maxResults) {
        return {
          ok: false,
          error: "max_results does not match the cursor page size.",
        };
      }
    }

    return {
      ok: true,
      filter: decoded.filter,
      maxResults: decoded.maxResults,
      offset: decoded.offset,
    };
  }

  private parseToolNameArg(
    value: unknown,
  ): { ok: true; toolName: string } | { ok: false; error: string } {
    if (typeof value !== "string") {
      return {
        ok: false,
        error: "tool_name must be provided as a non-empty string.",
      };
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: false, error: "tool_name must not be empty." };
    }

    const normalized = this.normalizeToolName(trimmed);

    if (!this.toolRegistry.has(normalized)) {
      return {
        ok: false,
        error: "tool_name must match an available tool name.",
      };
    }

    return { ok: true, toolName: normalized };
  }

  private parsePostToolNameArg(
    value: unknown,
  ): { ok: true; toolName: string } | { ok: false; error: string } {
    const base = this.parseToolNameArg(value);
    if (!base.ok) {
      return base;
    }

    const entry = this.toolRegistry.get(base.toolName);
    if (!entry || String(entry.tool.method || "").toUpperCase() !== "POST") {
      return {
        ok: false,
        error: "tool_name must match an available POST tool name.",
      };
    }

    return base;
  }

  private parseRandomCountArg(
    value: unknown,
  ): { ok: true; count: number } | { ok: false; error: string } {
    if (value === undefined || value === null || value === "") {
      return { ok: true, count: 1 };
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        error: "count must be a positive integer.",
      };
    }

    const count = Math.floor(parsed);
    if (count < 1) {
      return {
        ok: false,
        error: "count must be a positive integer.",
      };
    }

    return { ok: true, count };
  }

  private parseIncludeOptionalArg(
    value: unknown,
  ): { ok: true; includeOptional: boolean } | { ok: false; error: string } {
    if (value === undefined || value === null || value === "") {
      return { ok: true, includeOptional: false };
    }

    if (typeof value === "boolean") {
      return { ok: true, includeOptional: value };
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "y"].includes(normalized)) {
        return { ok: true, includeOptional: true };
      }
      if (["false", "0", "no", "n"].includes(normalized)) {
        return { ok: true, includeOptional: false };
      }
    }

    return {
      ok: false,
      error: "include_optional must be true or false.",
    };
  }

  private normalizeToolName(value: string): string {
    const trimmed = value.trim();
    const prefixes = ["mcp_specrun_", "specrun_"];

    for (const prefix of prefixes) {
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length);
      }
    }

    return trimmed;
  }

  private encodeCursor(data: {
    offset: number;
    filter: string;
    maxResults: number;
  }): string {
    const json = JSON.stringify(data);
    return Buffer.from(json, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  private decodeCursor(
    token: string,
  ): { offset: number; filter: string; maxResults: number } | null {
    try {
      const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
      const padding = (4 - (normalized.length % 4)) % 4;
      const padded = normalized + "=".repeat(padding);
      const json = Buffer.from(padded, "base64").toString("utf8");
      const parsed = JSON.parse(json);
      const offset = Number(parsed?.offset);
      const maxResults = Number(parsed?.maxResults);
      const filter =
        typeof parsed?.filter === "string" ? parsed.filter.trim() : "";

      if (!Number.isFinite(offset) || offset < 0) {
        return null;
      }

      if (!Number.isFinite(maxResults) || maxResults < 1 || maxResults > 200) {
        return null;
      }

      if (filter.length > 200) {
        return null;
      }

      return { offset: Math.floor(offset), filter, maxResults };
    } catch {
      return null;
    }
  }

  private sanitizePromptText(value: string, maxLength = 400): string {
    const raw = String(value ?? "");
    const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, "");
    const fenced = stripped.replace(/```/g, "'''");
    return fenced.slice(0, maxLength);
  }

  private getToolEntries(filter?: string): Array<{
    spec: ParsedSpec;
    tool: GeneratedTool;
    schema: z.ZodObject<any>;
  }> {
    const normalizedFilter = String(filter || "").toLowerCase();
    const entries = Array.from(this.toolRegistry.values());

    const filtered = normalizedFilter
      ? entries.filter((entry) => {
          const haystack =
            `${entry.spec.apiName} ${entry.tool.name} ${entry.tool.description}`.toLowerCase();
          return haystack.includes(normalizedFilter);
        })
      : entries;

    return filtered.sort((a, b) => {
      const apiCompare = a.spec.apiName.localeCompare(b.spec.apiName);
      if (apiCompare !== 0) {
        return apiCompare;
      }
      return a.tool.name.localeCompare(b.tool.name);
    });
  }

  private buildToolListPromptText(
    entries: Array<{ spec: ParsedSpec; tool: GeneratedTool }>,
    totalCount: number,
    filter: string,
    maxResults: number,
    offset: number,
    nextCursor: string | null,
  ): string {
    const lines: string[] = [];
    const header = filter
      ? `Filtered tools for "${this.sanitizePromptText(filter)}"`
      : "Available tools";
    lines.push(header);

    if (totalCount === 0) {
      lines.push("No tools are loaded.");
      return lines.join("\n");
    }

    const startIndex = Math.min(offset + 1, totalCount);
    const endIndex = Math.min(offset + entries.length, totalCount);
    lines.push(
      `Showing ${startIndex}-${endIndex} of ${totalCount} tools (limit ${maxResults}).`,
    );
    lines.push("");

    let currentApi = "";
    for (const entry of entries) {
      if (entry.spec.apiName !== currentApi) {
        currentApi = entry.spec.apiName;
        lines.push(`API: ${this.sanitizePromptText(currentApi)}`);
      }
      lines.push(
        `- ${this.sanitizePromptText(entry.tool.name)} (${this.sanitizePromptText(
          entry.tool.method,
        )} ${this.sanitizePromptText(entry.tool.path)}) - ${this.sanitizePromptText(
          entry.tool.description,
        )}`,
      );
    }

    if (nextCursor) {
      lines.push(
        "",
        "More results available.",
        `Next cursor: ${nextCursor}`,
        "Call list_apis again with the cursor to fetch the next page.",
      );
    }
    return lines.join("\n");
  }

  private completeToolNames(value: string): {
    values: string[];
    total: number;
  } {
    const normalized = String(value || "").toLowerCase();
    const names = Array.from(this.toolRegistry.keys()).sort();
    const matches = normalized
      ? names.filter((name) => name.toLowerCase().includes(normalized))
      : names;

    return { values: matches.slice(0, 50), total: matches.length };
  }

  private completePostToolNames(value: string): {
    values: string[];
    total: number;
  } {
    const normalized = String(value || "").toLowerCase();
    const names = this.getPostToolEntries()
      .map((entry) => entry.tool.name)
      .sort();
    const matches = normalized
      ? names.filter((name) => name.toLowerCase().includes(normalized))
      : names;

    return { values: matches.slice(0, 50), total: matches.length };
  }

  private getPostToolEntries(filter?: string): Array<{
    spec: ParsedSpec;
    tool: GeneratedTool;
    schema: z.ZodObject<any>;
  }> {
    return this.getToolEntries(filter).filter(
      (entry) => String(entry.tool.method || "").toUpperCase() === "POST",
    );
  }

  private buildRequiredOptionalSummary(tool: GeneratedTool): string {
    const required = tool.parameters.filter((param) => param.required);
    const optional = tool.parameters.filter((param) => !param.required);

    const requiredNames = required
      .map((param) => this.sanitizePromptText(param.name))
      .join(", ");
    const optionalNames = optional
      .map((param) => this.sanitizePromptText(param.name))
      .join(", ");

    const lines: string[] = [];
    lines.push(
      `Required params: ${requiredNames || "none"}`,
      `Optional params: ${optionalNames || "none"}`,
    );

    const requestBodySchema = this.getRequestBodySchema(tool.requestBody);
    if (requestBodySchema) {
      const requestBodyRequired = Boolean(tool.requestBody?.required);
      lines.push(
        `Request body: ${requestBodyRequired ? "required" : "optional"}`,
      );
    }

    return lines.join("\n");
  }

  private buildExamplePayload(tool: GeneratedTool): Record<string, any> {
    const payload: Record<string, any> = {};

    for (const param of tool.parameters) {
      if (!param.required) {
        continue;
      }
      payload[param.name] = this.createExampleValue(param.schema, 0);
    }

    const requestBodySchema = this.getRequestBodySchema(tool.requestBody);
    if (requestBodySchema) {
      payload.body = this.createExampleValue(requestBodySchema, 0);
    }

    return payload;
  }

  private buildRandomPayload(
    tool: GeneratedTool,
    sequence: number,
    includeOptional: boolean,
  ): Record<string, any> {
    const payload: Record<string, any> = {};
    const namingContext: RandomNamingContext = {
      objectName: this.deriveObjectName(tool),
      timestampMs: Date.now(),
      sequence,
    };

    for (const param of tool.parameters) {
      if (!includeOptional && !param.required) {
        continue;
      }
      payload[param.name] = this.createRandomValue(param.schema, 0, {
        fieldName: param.name,
        namingContext,
        includeOptional,
      });
    }

    const requestBodySchema = this.getRequestBodySchema(tool.requestBody);
    if (requestBodySchema) {
      payload.body = this.createRandomValue(requestBodySchema, 0, {
        fieldName: "body",
        namingContext,
        includeOptional,
      });
    }

    return payload;
  }

  private buildSchemaExplanation(tool: GeneratedTool): string {
    const lines: string[] = [];
    lines.push(
      `Tool: ${this.sanitizePromptText(tool.name)}`,
      `Method: ${this.sanitizePromptText(
        tool.method,
      )} ${this.sanitizePromptText(tool.path)}`,
      "",
    );

    if (tool.parameters.length === 0) {
      lines.push("Parameters: none");
    } else {
      lines.push("Parameters:");
      for (const param of tool.parameters) {
        const typeLabel = this.describeSchemaType(param.schema);
        const example = this.createExampleValue(param.schema, 0);
        const exampleText =
          example === undefined ? "" : `, example: ${JSON.stringify(example)}`;
        lines.push(
          `- ${this.sanitizePromptText(param.name)} (${this.sanitizePromptText(
            String(param.in),
          )}, ${param.required ? "required" : "optional"}, type: ${this.sanitizePromptText(
            typeLabel,
          )}${exampleText})`,
        );
      }
    }

    const requestBodySchema = this.getRequestBodySchema(tool.requestBody);
    if (requestBodySchema) {
      const requestBodyRequired = Boolean(tool.requestBody?.required);
      lines.push("", "Request body:");
      lines.push(
        `- ${requestBodyRequired ? "required" : "optional"}, example: ${JSON.stringify(
          this.createExampleValue(requestBodySchema, 0),
        )}`,
      );
    }

    lines.push("", "Provide concise explanations and example values.");
    return lines.join("\n");
  }

  private describeSchemaType(schema: any): string {
    if (!schema || typeof schema !== "object") {
      return "any";
    }

    if (schema.type) {
      return String(schema.type);
    }

    if (schema.enum) {
      return "enum";
    }

    if (schema.oneOf || schema.anyOf || schema.allOf) {
      return "composed";
    }

    if (schema.properties) {
      return "object";
    }

    if (schema.items) {
      return "array";
    }

    return "any";
  }

  private createExampleValue(schema: any, depth: number): any {
    if (depth > 4) {
      return null;
    }

    if (!schema || typeof schema !== "object") {
      return null;
    }

    if (schema.example !== undefined) {
      return schema.example;
    }

    if (schema.default !== undefined) {
      return schema.default;
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum[0];
    }

    const type = schema.type;
    if (type === "string") {
      if (schema.format === "date-time") {
        return "2025-01-01T00:00:00Z";
      }
      if (schema.format === "date") {
        return "2025-01-01";
      }
      return "string";
    }

    if (type === "integer") {
      return 0;
    }

    if (type === "number") {
      return 0;
    }

    if (type === "boolean") {
      return true;
    }

    if (type === "array") {
      return [this.createExampleValue(schema.items || {}, depth + 1)];
    }

    if (type === "object" || schema.properties) {
      const properties = schema.properties || {};
      const required = new Set<string>(schema.required || []);
      const result: Record<string, any> = {};
      let added = 0;

      for (const [key, value] of Object.entries(properties)) {
        if (required.size > 0 && !required.has(key)) {
          continue;
        }
        result[key] = this.createExampleValue(value, depth + 1);
        added += 1;
        if (added >= 5) {
          break;
        }
      }

      if (added === 0) {
        const fallbackKey = Object.keys(properties)[0];
        if (fallbackKey) {
          result[fallbackKey] = this.createExampleValue(
            properties[fallbackKey],
            depth + 1,
          );
        }
      }

      return result;
    }

    if (schema.items) {
      return [this.createExampleValue(schema.items, depth + 1)];
    }

    return null;
  }

  private createRandomValue(
    schema: any,
    depth: number,
    options?: {
      fieldName?: string;
      namingContext?: RandomNamingContext;
      includeOptional?: boolean;
    },
  ): any {
    if (depth > 4) {
      return null;
    }

    if (!schema || typeof schema !== "object") {
      return null;
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      const index = Math.floor(Math.random() * schema.enum.length);
      return schema.enum[index];
    }

    const type = schema.type;
    if (type === "string") {
      if (
        options?.namingContext &&
        this.isNameLikeField(options.fieldName) &&
        !schema.format
      ) {
        return this.buildGeneratedName(schema, options.namingContext);
      }

      if (schema.format === "uuid") {
        return this.randomUuid();
      }
      if (schema.format === "email") {
        return `user${this.randomInt(1000, 9999)}@example.com`;
      }
      if (schema.format === "date-time") {
        return new Date(
          Date.now() - this.randomInt(0, 365 * 24 * 3600 * 1000),
        ).toISOString();
      }
      if (schema.format === "date") {
        return new Date(Date.now() - this.randomInt(0, 365 * 24 * 3600 * 1000))
          .toISOString()
          .slice(0, 10);
      }

      const minLength = Number.isFinite(Number(schema.minLength))
        ? Math.max(1, Number(schema.minLength))
        : 6;
      const maxLength = Number.isFinite(Number(schema.maxLength))
        ? Math.max(minLength, Math.min(24, Number(schema.maxLength)))
        : Math.max(minLength, 12);
      const targetLength = this.randomInt(minLength, maxLength);

      return this.randomAlphaNumeric(targetLength);
    }

    if (type === "integer") {
      const min = Number.isFinite(Number(schema.minimum))
        ? Math.ceil(Number(schema.minimum))
        : 0;
      const max = Number.isFinite(Number(schema.maximum))
        ? Math.floor(Number(schema.maximum))
        : min + 1000;
      return this.randomInt(min, Math.max(min, max));
    }

    if (type === "number") {
      const min = Number.isFinite(Number(schema.minimum))
        ? Number(schema.minimum)
        : 0;
      const max = Number.isFinite(Number(schema.maximum))
        ? Number(schema.maximum)
        : min + 1000;
      const random = min + Math.random() * Math.max(0, max - min);
      return Number(random.toFixed(2));
    }

    if (type === "boolean") {
      return Math.random() >= 0.5;
    }

    if (type === "array") {
      const minItems = Number.isFinite(Number(schema.minItems))
        ? Math.max(1, Number(schema.minItems))
        : 1;
      const maxItems = Number.isFinite(Number(schema.maxItems))
        ? Math.max(minItems, Math.min(5, Number(schema.maxItems)))
        : Math.max(minItems, 2);
      const count = this.randomInt(minItems, maxItems);
      const items = [];
      for (let i = 0; i < count; i++) {
        items.push(
          this.createRandomValue(schema.items || {}, depth + 1, {
            fieldName: options?.fieldName,
            namingContext: options?.namingContext,
            includeOptional: options?.includeOptional,
          }),
        );
      }
      return items;
    }

    if (type === "object" || schema.properties) {
      const properties = schema.properties || {};
      const allowedEntries = Object.entries(properties).filter(
        ([, value]) => !this.isReadOnlySchema(value),
      );
      const required = new Set<string>(
        (schema.required || []).filter(
          (key: string) => !this.isReadOnlySchema(properties[key]),
        ),
      );
      const result: Record<string, any> = {};

      for (const [key, value] of allowedEntries) {
        const include = required.has(key) || Boolean(options?.includeOptional);
        if (!include) {
          continue;
        }
        result[key] = this.createRandomValue(value, depth + 1, {
          fieldName: key,
          namingContext: options?.namingContext,
          includeOptional: options?.includeOptional,
        });
      }

      if (
        Object.keys(result).length === 0 &&
        Boolean(options?.includeOptional)
      ) {
        const fallbackKey = allowedEntries[0]?.[0];
        if (fallbackKey) {
          result[fallbackKey] = this.createRandomValue(
            properties[fallbackKey],
            depth + 1,
            {
              fieldName: fallbackKey,
              namingContext: options?.namingContext,
              includeOptional: options?.includeOptional,
            },
          );
        }
      }

      return result;
    }

    if (schema.items) {
      return [
        this.createRandomValue(schema.items, depth + 1, {
          fieldName: options?.fieldName,
          namingContext: options?.namingContext,
          includeOptional: options?.includeOptional,
        }),
      ];
    }

    return null;
  }

  private randomInt(min: number, max: number): number {
    const safeMin = Math.floor(min);
    const safeMax = Math.floor(max);
    if (safeMax <= safeMin) {
      return safeMin;
    }
    return Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin;
  }

  private randomAlphaNumeric(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      const idx = this.randomInt(0, chars.length - 1);
      result += chars[idx];
    }
    return result;
  }

  private randomUuid(): string {
    const part = (size: number) => {
      let s = "";
      for (let i = 0; i < size; i++) {
        s += this.randomInt(0, 15).toString(16);
      }
      return s;
    };

    return `${part(8)}-${part(4)}-4${part(3)}-${(8 + this.randomInt(0, 3)).toString(16)}${part(3)}-${part(12)}`;
  }

  private deriveObjectName(tool: GeneratedTool): string {
    const segments = String(tool.path || "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(
        (segment) =>
          segment && !segment.startsWith("{") && !segment.endsWith("}"),
      );

    const raw = segments.length > 0 ? segments[segments.length - 1] : tool.name;
    const normalized = String(raw)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .trim();

    if (!normalized) {
      return "item";
    }

    if (normalized.endsWith("s") && normalized.length > 1) {
      return normalized.slice(0, -1);
    }

    return normalized;
  }

  private isNameLikeField(fieldName?: string): boolean {
    const key = String(fieldName || "").toLowerCase();
    if (!key) {
      return false;
    }

    return ["name", "label", "title", "displayname"].some((token) =>
      key.includes(token),
    );
  }

  private buildGeneratedName(
    schema: any,
    namingContext: RandomNamingContext,
  ): string {
    const delimiter = this.isDashAllowedInStringSchema(schema) ? "-" : "";
    const objectName = String(namingContext.objectName || "item").replace(
      /[^a-zA-Z0-9]/g,
      "",
    );
    const datePart = String(namingContext.timestampMs);
    const sequencePart = String(namingContext.sequence);

    const withObject = objectName
      ? `ai${delimiter}${objectName}${delimiter}${datePart}${delimiter}${sequencePart}`
      : `ai${delimiter}${datePart}${delimiter}${sequencePart}`;
    const withoutObject = `ai${delimiter}${datePart}${delimiter}${sequencePart}`;

    const maxLength = Number.isFinite(Number(schema?.maxLength))
      ? Math.max(1, Math.floor(Number(schema.maxLength)))
      : null;
    const minLength = Number.isFinite(Number(schema?.minLength))
      ? Math.max(0, Math.floor(Number(schema.minLength)))
      : 0;

    let candidate = withObject;

    if (maxLength !== null && candidate.length > maxLength) {
      candidate = withoutObject;
    }

    if (maxLength !== null && candidate.length > maxLength) {
      candidate = candidate.slice(0, maxLength);
    }

    if (!this.matchesStringPattern(schema, candidate)) {
      const compact = candidate.replace(/[^a-zA-Z0-9]/g, "");
      if (compact && this.matchesStringPattern(schema, compact)) {
        candidate = compact;
      } else {
        const fallbackLength =
          maxLength !== null
            ? Math.max(minLength || 1, Math.min(maxLength, 12))
            : Math.max(minLength || 1, 12);
        candidate = this.randomAlphaNumeric(fallbackLength);
      }
    }

    if (candidate.length < minLength) {
      const pad = this.randomAlphaNumeric(minLength - candidate.length);
      candidate = `${candidate}${pad}`;
    }

    return candidate;
  }

  private isDashAllowedInStringSchema(schema: any): boolean {
    if (!schema || typeof schema !== "object" || !schema.pattern) {
      return true;
    }

    try {
      const regex = new RegExp(String(schema.pattern));
      return regex.test("a-a");
    } catch {
      return true;
    }
  }

  private matchesStringPattern(schema: any, value: string): boolean {
    if (!schema || typeof schema !== "object" || !schema.pattern) {
      return true;
    }

    try {
      const regex = new RegExp(String(schema.pattern));
      return regex.test(value);
    } catch {
      return true;
    }
  }

  private isReadOnlySchema(schema: any): boolean {
    return Boolean(schema && typeof schema === "object" && schema.readOnly);
  }

  private getRequestBodySchema(requestBody: any): any | null {
    if (!requestBody || typeof requestBody !== "object") {
      return null;
    }

    const content = requestBody.content;
    if (!content || typeof content !== "object") {
      return null;
    }

    if (content["application/json"]?.schema) {
      return content["application/json"].schema;
    }

    const first = Object.values(content).find(
      (entry: any) => entry && entry.schema,
    ) as { schema?: any } | undefined;

    return first?.schema || null;
  }
}

type RandomNamingContext = {
  objectName: string;
  timestampMs: number;
  sequence: number;
};

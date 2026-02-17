import { randomUUID } from "crypto";
import { FastMCP } from "fastmcp";
import { z } from "zod";
import {
  ParsedSpec,
  GeneratedTool,
  ToolExecutionContext,
  ApiCallResult,
  AuthConfig,
} from "./types";
import { HttpClient } from "./utils/http-client";

type ToolRegistryEntry = {
  spec: ParsedSpec;
  tool: GeneratedTool;
  schema: z.ZodObject<any>;
};

type ToolRegistry = Map<string, ToolRegistryEntry>;

type ToolRegistrarOptions = {
  fastMCP: FastMCP;
  toolRegistry: ToolRegistry;
  httpClient: HttpClient;
  getAuthConfig: () => AuthConfig;
  refreshEnvConfigIfChanged: () => void;
  createResponseResourceContent: (
    name: string,
    description: string,
    payload: unknown,
  ) => Promise<{ type: "resource"; resource: any }>;
};

export class ToolRegistrar {
  private static readonly largeBatchThreshold = 200;
  private static readonly largeBatchTokenTtlMs = 5 * 60 * 1000;
  private fastMCP: FastMCP;
  private toolRegistry: ToolRegistry;
  private httpClient: HttpClient;
  private getAuthConfig: () => AuthConfig;
  private refreshEnvConfigIfChanged: () => void;
  private createResponseResourceContent: ToolRegistrarOptions["createResponseResourceContent"];
  private largeBatchConfirmations: Map<
    string,
    { toolName: string; count: number; expiresAt: number }
  >;

  constructor(options: ToolRegistrarOptions) {
    this.fastMCP = options.fastMCP;
    this.toolRegistry = options.toolRegistry;
    this.httpClient = options.httpClient;
    this.getAuthConfig = options.getAuthConfig;
    this.refreshEnvConfigIfChanged = options.refreshEnvConfigIfChanged;
    this.createResponseResourceContent = options.createResponseResourceContent;
    this.largeBatchConfirmations = new Map();
  }

  registerToolsFromSpec(spec: ParsedSpec): void {
    for (const tool of spec.tools) {
      this.registerTool(spec, tool);
    }
  }

  registerBatchDispatcherTool(): void {
    const batchSchema = z.object({
      toolName: z.string().min(1),
      items: z.array(z.any()).min(1),
      failFast: z.boolean().optional(),
      confirmLargeBatch: z.boolean().optional(),
      confirmLargeBatchToken: z.string().min(1).optional(),
    });

    this.fastMCP.addTool({
      name: "specrun_batch",
      description: "Run any SpecRun tool in batch with multiple inputs",
      parameters: batchSchema,
      execute: async (args: Record<string, any>) => {
        this.refreshEnvConfigIfChanged();
        const rawToolName = String(args.toolName || "");
        const toolName = this.normalizeToolName(rawToolName);
        const entry = this.toolRegistry.get(toolName);

        if (!entry) {
          const resource = await this.createResponseResourceContent(
            "SpecRun Batch Error",
            "Batch execution error",
            {
              toolName: rawToolName,
              normalizedToolName: toolName,
              error: `Unknown tool: ${toolName}`,
            },
          );

          return {
            content: [resource],
          };
        }

        const items = Array.isArray(args.items) ? args.items : [];
        const failFast = Boolean(args.failFast);
        const confirmLargeBatch = Boolean(args.confirmLargeBatch);
        const confirmLargeBatchToken =
          typeof args.confirmLargeBatchToken === "string"
            ? args.confirmLargeBatchToken
            : "";

        if (
          items.length > ToolRegistrar.largeBatchThreshold &&
          !this.isLargeBatchConfirmed(
            confirmLargeBatch,
            confirmLargeBatchToken,
            toolName,
            items.length,
          )
        ) {
          const token = this.issueLargeBatchToken(toolName, items.length);
          const resource = await this.createResponseResourceContent(
            "SpecRun Batch Confirmation Required",
            "Batch execution confirmation required",
            {
              toolName,
              count: items.length,
              threshold: ToolRegistrar.largeBatchThreshold,
              confirmLargeBatchToken: token,
              confirmLargeBatchTokenTtlMs: ToolRegistrar.largeBatchTokenTtlMs,
              message:
                "Batch execution over 200 items requires user confirmation. Re-run with confirmLargeBatch: true and confirmLargeBatchToken to proceed.",
            },
          );

          return {
            content: [
              {
                type: "text",
                text: "Confirmation required: ask the user to approve this batch, then retry with confirmLargeBatch: true and the provided confirmLargeBatchToken.",
              },
              resource,
            ],
            isError: true,
          };
        }
        const results: Array<
          | { index: number; result: ApiCallResult }
          | { index: number; error: string }
        > = [];

        for (let index = 0; index < items.length; index += 1) {
          const itemArgs = items[index];
          const parsedArgs = entry.schema.safeParse(itemArgs);
          if (!parsedArgs.success) {
            results.push({
              index,
              error: parsedArgs.error.message,
            });
            if (failFast) {
              break;
            }
            continue;
          }

          const context: ToolExecutionContext = {
            apiName: entry.spec.apiName,
            tool: entry.tool,
            authConfig: this.getAuthConfig()[entry.spec.apiName],
          };

          try {
            const output = await this.httpClient.executeRequest(
              context,
              parsedArgs.data,
            );
            results.push({ index, result: output });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            results.push({ index, error: message });
            if (failFast) {
              break;
            }
          }
        }

        const resource = await this.createResponseResourceContent(
          `SpecRun Batch ${toolName}`,
          `Batch responses for ${toolName}`,
          {
            toolName,
            count: items.length,
            results,
          },
        );

        return {
          content: [resource],
        };
      },
    });
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

  private registerTool(spec: ParsedSpec, tool: GeneratedTool): void {
    const schema = this.buildZodSchema(tool);
    this.toolRegistry.set(tool.name, { spec, tool, schema });

    this.fastMCP.addTool({
      name: tool.name,
      description: tool.description,
      parameters: schema,
      execute: async (args: Record<string, any>) => {
        this.refreshEnvConfigIfChanged();
        const context: ToolExecutionContext = {
          apiName: spec.apiName,
          tool,
          authConfig: this.getAuthConfig()[spec.apiName],
        };

        const result = await this.httpClient.executeRequest(context, args);
        const resource = await this.createResponseResourceContent(
          `SpecRun Response ${tool.name}`,
          `Response for ${tool.name}`,
          result,
        );

        return {
          content: [resource],
        };
      },
    });
  }

  private issueLargeBatchToken(toolName: string, count: number): string {
    const token = randomUUID();
    this.largeBatchConfirmations.set(token, {
      toolName,
      count,
      expiresAt: Date.now() + ToolRegistrar.largeBatchTokenTtlMs,
    });
    return token;
  }

  private isLargeBatchConfirmed(
    confirmLargeBatch: boolean,
    confirmLargeBatchToken: string,
    toolName: string,
    count: number,
  ): boolean {
    if (!confirmLargeBatch || !confirmLargeBatchToken) {
      return false;
    }

    const record = this.largeBatchConfirmations.get(confirmLargeBatchToken);
    if (!record) {
      return false;
    }

    if (record.expiresAt <= Date.now()) {
      this.largeBatchConfirmations.delete(confirmLargeBatchToken);
      return false;
    }

    if (record.toolName !== toolName || record.count !== count) {
      return false;
    }

    this.largeBatchConfirmations.delete(confirmLargeBatchToken);
    return true;
  }

  private buildZodSchema(tool: GeneratedTool): z.ZodObject<any> {
    const schemaFields: Record<string, z.ZodType<any>> = {};

    for (const param of tool.parameters) {
      let fieldSchema = this.openAPISchemaToZod(param.schema);

      if (param.description) {
        fieldSchema = fieldSchema.describe(param.description);
      }

      if (!param.required) {
        fieldSchema = fieldSchema.optional();
      }

      schemaFields[param.name] = fieldSchema;
    }

    if (tool.requestBody) {
      schemaFields.body = z.any().optional().describe("Request body data");
    }

    const schema = z.object(schemaFields);

    return tool.requestBody ? schema.passthrough() : schema;
  }

  private openAPISchemaToZod(schema: any): z.ZodType<any> {
    if (!schema || typeof schema !== "object") {
      return z.any();
    }

    switch (schema.type) {
      case "string":
        return z.string();
      case "number":
        return z.number();
      case "integer":
        return z.number().int();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(this.openAPISchemaToZod(schema.items || {}));
      case "object": {
        const properties = schema.properties || {};
        const required = new Set<string>(schema.required || []);
        const shape: Record<string, z.ZodType<any>> = {};

        for (const [key, value] of Object.entries(properties)) {
          let propertySchema = this.openAPISchemaToZod(value);

          if (!required.has(key)) {
            propertySchema = propertySchema.optional();
          }

          shape[key] = propertySchema;
        }

        let objectSchema = z.object(shape);
        const additional = schema.additionalProperties;

        if (additional === false) {
          objectSchema = objectSchema.strict();
        } else if (additional === true || additional === undefined) {
          objectSchema = objectSchema.loose();
        } else if (typeof additional === "object") {
          objectSchema = objectSchema.catchall(
            this.openAPISchemaToZod(additional),
          );
        }

        return objectSchema;
      }
      default:
        return z.any();
    }
  }
}

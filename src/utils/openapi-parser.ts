import SwaggerParser from "@apidevtools/swagger-parser";
import path from "path";
import fs from "fs";
import YAML from "yaml";
import { ParsedSpec, GeneratedTool, ToolParameter } from "../types";
import { getApiNameFromFile } from "./auth";

const DEFAULT_SERVER_URL = "https://api-server.placeholder";

export async function parseOpenApiSpec(
  filePath: string,
): Promise<ParsedSpec | null> {
  try {
    const spec = (await SwaggerParser.validate(filePath)) as any; // OpenAPIV3.Document;
    const apiName = getApiNameFromFile(filePath);

    const tools = generateToolsFromSpec(spec, apiName);

    return {
      apiName,
      filePath,
      spec,
      tools,
    };
  } catch (error) {
    // Only log errors for files that look like they should be OpenAPI specs
    const filename = path.basename(filePath);
    if (
      filename.toLowerCase().includes("openapi") ||
      filename.toLowerCase().includes("swagger") ||
      filename.toLowerCase().includes("api")
    ) {
      console.error(`Failed to parse OpenAPI spec at ${filePath}:`, error);
    } else {
      // For other files, just log a brief message
      console.log(`Skipping ${filename} - not a valid OpenAPI specification`);
    }
    return null;
  }
}

function generateToolsFromSpec(spec: any, apiName: string): GeneratedTool[] {
  const tools: GeneratedTool[] = [];
  const baseUrl = getBaseUrl(spec);

  if (!spec.paths) return tools;

  for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const methods = [
      "get",
      "post",
      "put",
      "patch",
      "delete",
      "head",
      "options",
    ] as const;

    for (const method of methods) {
      const operation = (pathItem as any)[method];
      if (!operation) continue;

      const tool = createToolFromOperation(
        apiName,
        pathTemplate,
        method,
        operation,
        baseUrl,
        (pathItem as any).parameters,
        spec,
      );

      if (tool) {
        tools.push(tool);
      }
    }
  }

  return tools;
}

function createToolFromOperation(
  apiName: string,
  pathTemplate: string,
  method: string,
  operation: any,
  baseUrl: string,
  pathLevelParams?: any[],
  spec?: any,
): GeneratedTool | null {
  try {
    const toolName = generateToolName(apiName, operation, pathTemplate, method);
    const description =
      operation.summary ||
      operation.description ||
      `${method.toUpperCase()} ${pathTemplate}`;

    // Combine path-level and operation-level parameters
    const allParams = [
      ...(pathLevelParams || []),
      ...(operation.parameters || []),
    ];

    const parameters = extractParameters(allParams, spec);

    return {
      name: toolName,
      description,
      operationId: operation.operationId,
      method: method.toUpperCase(),
      path: pathTemplate,
      parameters,
      requestBody: operation.requestBody as any,
      responses: operation.responses,
      security: operation.security || [],
      baseUrl,
    };
  } catch (error) {
    console.error(
      `Failed to create tool for ${method} ${pathTemplate}:`,
      error,
    );
    return null;
  }
}

function generateToolName(
  apiName: string,
  operation: any,
  pathTemplate: string,
  method: string,
): string {
  if (operation.operationId) {
    return `${apiName}_${operation.operationId}`;
  }

  // Generate from path and method
  const pathParts = pathTemplate
    .split("/")
    .filter((part) => part && !part.startsWith("{"))
    .map((part) => part.replace(/[^a-zA-Z0-9]/g, ""));

  const pathName = pathParts.join("_") || "root";
  return `${apiName}_${method}_${pathName}`;
}

function extractParameters(paramRefs: any[], spec?: any): ToolParameter[] {
  const parameters: ToolParameter[] = [];

  for (const paramRef of paramRefs) {
    const param = resolveParameterRef(paramRef, spec);
    if (!param) {
      continue;
    }

    const schema = getParameterSchema(param);

    if (param.in && param.name && schema) {
      parameters.push({
        name: param.name,
        in: param.in as "path" | "query" | "header" | "cookie" | "body",
        required: param.required || param.in === "path",
        schema: schema as any,
        description: param.description,
      });
    }
  }

  return parameters;
}

function getBaseUrl(spec: any): string {
  if (isOpenApi3Spec(spec) && typeof spec["x-base-url"] === "string") {
    const baseUrl = spec["x-base-url"].trim();
    if (baseUrl) {
      return appendBasePathIfNeeded(baseUrl, spec);
    }
  }

  if (isOpenApi3Spec(spec) && spec.servers && spec.servers.length > 0) {
    const baseUrl = resolveOpenApi3ServerUrl(spec.servers[0]);
    return appendBasePathIfNeeded(baseUrl, spec);
  }

  if (isSwagger2Spec(spec)) {
    const schemes = Array.isArray(spec.schemes) ? spec.schemes : [];
    const scheme = schemes[0] || "https";
    const host = typeof spec.host === "string" ? spec.host : "";
    const basePath = typeof spec.basePath === "string" ? spec.basePath : "";
    if (host) {
      return `${scheme}://${host}${basePath}`;
    }
  }

  // Fallback for older specs or specs without servers
  return DEFAULT_SERVER_URL;
}

function resolveParameterRef(paramRef: any, spec?: any): any | null {
  if (!paramRef || typeof paramRef !== "object") {
    return null;
  }

  if (!("$ref" in paramRef)) {
    return paramRef;
  }

  const ref = String((paramRef as any).$ref || "");
  if (!ref || !spec) {
    return null;
  }

  return resolveJsonPointer(spec, ref);
}

function resolveJsonPointer(root: any, ref: string): any | null {
  if (!ref.startsWith("#/")) {
    return null;
  }

  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: any = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return null;
    }
    current = current[part];
  }

  return current;
}

function getParameterSchema(param: any): any | null {
  if (param.schema && typeof param.schema === "object") {
    return param.schema;
  }

  if (param.content && typeof param.content === "object") {
    const content = param.content as Record<string, any>;
    const preferred =
      content["application/json"] ||
      Object.values(content).find((entry) => entry && entry.schema);
    if (preferred && preferred.schema) {
      return preferred.schema;
    }
  }

  if (param.type) {
    const schema: Record<string, any> = { type: param.type };
    if (param.format) {
      schema.format = param.format;
    }
    if (param.items) {
      schema.items = param.items;
    }
    if (param.enum) {
      schema.enum = param.enum;
    }
    if (param.default !== undefined) {
      schema.default = param.default;
    }
    return schema;
  }

  return null;
}

function resolveOpenApi3ServerUrl(server: any): string {
  if (!server || typeof server !== "object") {
    return DEFAULT_SERVER_URL;
  }

  const rawUrl = typeof server.url === "string" ? server.url : "";
  if (!rawUrl) {
    return DEFAULT_SERVER_URL;
  }

  if (!server.variables || typeof server.variables !== "object") {
    return rawUrl;
  }

  return rawUrl.replace(/\{([^}]+)\}/g, (_match: string, varName: string) => {
    const variable = server.variables[varName];
    if (variable && typeof variable.default === "string") {
      return variable.default;
    }
    return _match;
  });
}

function appendBasePathIfNeeded(baseUrl: string, spec: any): string {
  const basePath = getOpenApiBasePath(spec);
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

function getOpenApiBasePath(spec: any): string | null {
  const raw = (typeof spec?.basePath === "string" && spec.basePath) || "";
  const trimmed = String(raw).trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

type SpecFormat = "json" | "yaml";

function readSpecFile(
  filePath: string,
): { spec: any; format: SpecFormat } | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".json") {
      return { spec: JSON.parse(content), format: "json" };
    }

    return { spec: YAML.parse(content), format: "yaml" };
  } catch {
    return null;
  }
}

function writeSpecFile(filePath: string, spec: any, format: SpecFormat): void {
  if (format === "json") {
    fs.writeFileSync(filePath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");
    return;
  }

  fs.writeFileSync(filePath, YAML.stringify(spec), "utf8");
}

export function updateSpecServerUrls(
  specFiles: string[],
  env: NodeJS.ProcessEnv,
): void {
  for (const filePath of specFiles) {
    const apiName = getApiNameFromFile(filePath);
    if (!apiName) {
      continue;
    }

    const newUrl = resolveServerUrl(apiName, env);
    if (!newUrl) {
      continue;
    }

    const parsed = readSpecFile(filePath);
    if (!parsed || !parsed.spec || typeof parsed.spec !== "object") {
      continue;
    }

    const spec = parsed.spec as any;
    const updated = applyServerUrlToSpec(spec, newUrl);

    if (updated) {
      writeSpecFile(filePath, spec, parsed.format);
    }
  }
}

export function resolveServerUrl(
  apiName: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const envKey = `${apiName.toUpperCase()}_SERVER_URL`;
  const envValue = env[envKey];

  if (typeof envValue === "string" && envValue.trim()) {
    return envValue.trim();
  }

  return null;
}

function isSwagger2Spec(spec: any): boolean {
  return Boolean(spec && typeof spec === "object" && spec.swagger === "2.0");
}

function isOpenApi3Spec(spec: any): boolean {
  return Boolean(spec && typeof spec === "object" && spec.openapi);
}

function applyServerUrlToSpec(spec: any, newUrl: string): boolean {
  let updated = false;

  if (isSwagger2Spec(spec)) {
    updated = applySwagger2ServerUrl(spec, newUrl) || updated;
  } else if (isOpenApi3Spec(spec)) {
    updated = applyOpenApi3ServerUrl(spec, newUrl) || updated;
  }

  return updated;
}

function applyOpenApi3ServerUrl(spec: any, newUrl: string): boolean {
  let updated = false;

  if (Array.isArray(spec.servers) && spec.servers.length > 0) {
    const first = spec.servers[0];
    if (!first || typeof first !== "object" || first.url !== newUrl) {
      spec.servers[0] = { ...(first || {}), url: newUrl };
      updated = true;
    }
  } else {
    spec.servers = [{ url: newUrl }];
    updated = true;
  }

  return updated;
}

function applySwagger2ServerUrl(spec: any, newUrl: string): boolean {
  let updated = false;
  const parsedUrl = safeParseUrl(newUrl);
  if (parsedUrl) {
    const scheme = parsedUrl.protocol.replace(":", "");
    const host = parsedUrl.host;
    const hasPath = parsedUrl.pathname && parsedUrl.pathname !== "/";
    const basePath = hasPath ? parsedUrl.pathname : spec.basePath;

    if (
      scheme &&
      (!Array.isArray(spec.schemes) || spec.schemes[0] !== scheme)
    ) {
      spec.schemes = [scheme];
      updated = true;
    }

    if (host && spec.host !== host) {
      spec.host = host;
      updated = true;
    }

    if (hasPath && spec.basePath !== basePath) {
      spec.basePath = basePath;
      updated = true;
    }
  }

  if (spec.servers) {
    delete spec.servers;
    updated = true;
  }

  return updated;
}

function safeParseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function isOpenAPIFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const filename = path.basename(filePath).toLowerCase();

  // Only accept certain extensions
  if (![".json", ".yaml", ".yml"].includes(ext)) {
    return false;
  }

  // Skip common non-OpenAPI files
  const skipFiles = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    ".eslintrc.json",
    "jest.config.json",
  ];

  if (skipFiles.includes(filename)) {
    return false;
  }

  return true;
}

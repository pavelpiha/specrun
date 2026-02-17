import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import fs from "fs";
import path from "path";
import { ApiCallResult, GeneratedTool, ToolExecutionContext } from "../types";
import { applyAuthentication } from "./auth";

export class HttpClient {
  async executeRequest(
    context: ToolExecutionContext,
    args: Record<string, any>,
  ): Promise<ApiCallResult> {
    let requestConfig: AxiosRequestConfig | null = null;
    try {
      requestConfig = this.buildRequestConfig(context, args);
      this.debugLogRequest(requestConfig);
      const response = await axios(requestConfig);

      this.debugLogResponse(response);

      return {
        requestUrl: this.buildRequestUrl(requestConfig),
        requestBody: requestConfig.data ?? null,
        response: {
          status: response.status,
          body: response.data ?? null,
        },
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.debugLogError(error);
        return {
          requestUrl: requestConfig ? this.buildRequestUrl(requestConfig) : "",
          requestBody: requestConfig?.data ?? null,
          response: {
            status: error.response?.status ?? "Unknown",
            body: error.response?.data ?? null,
          },
        };
      }

      return {
        requestUrl: requestConfig ? this.buildRequestUrl(requestConfig) : "",
        requestBody: requestConfig?.data ?? null,
        response: {
          status: "Error",
          body: {
            error: error instanceof Error ? error.message : String(error),
          },
        },
      };
    }
  }

  private buildRequestConfig(
    context: ToolExecutionContext,
    args: Record<string, any>,
  ): AxiosRequestConfig {
    const { tool, authConfig } = context;

    // Build URL with path parameters
    const url = this.buildUrl(tool, args);

    // Build headers
    let headers: Record<string, string> = {
      "User-Agent": "specrun/1.0.0",
      Accept: "application/json",
    };

    // Apply authentication
    headers = applyAuthentication(headers, authConfig);

    // Add header parameters
    this.addHeaderParameters(tool, args, headers);

    // Build query parameters
    const params = this.buildQueryParameters(tool, args);

    // Build request body
    const data = this.buildRequestBody(tool, args);
    if (data !== null && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const config: AxiosRequestConfig = {
      method: tool.method.toLowerCase() as any,
      url,
      headers,
      timeout: 30000, // 30 second timeout
    };

    if (Object.keys(params).length > 0) {
      config.params = params;
    }

    if (data !== null) {
      config.data = data;
    }

    return config;
  }

  private buildUrl(tool: GeneratedTool, args: Record<string, any>): string {
    let url = tool.baseUrl.replace(/\/$/, "") + tool.path;

    // Replace path parameters
    for (const param of tool.parameters) {
      if (param.in === "path" && args[param.name] !== undefined) {
        url = url.replace(
          `{${param.name}}`,
          encodeURIComponent(String(args[param.name])),
        );
      }
    }

    return url;
  }

  private addHeaderParameters(
    tool: GeneratedTool,
    args: Record<string, any>,
    headers: Record<string, string>,
  ): void {
    for (const param of tool.parameters) {
      if (param.in === "header" && args[param.name] !== undefined) {
        headers[param.name] = String(args[param.name]);
      }
    }
  }

  private buildQueryParameters(
    tool: GeneratedTool,
    args: Record<string, any>,
  ): Record<string, any> {
    const params: Record<string, any> = {};

    for (const param of tool.parameters) {
      if (param.in === "query" && args[param.name] !== undefined) {
        params[param.name] = args[param.name];
      }
    }

    return params;
  }

  private buildRequestBody(
    tool: GeneratedTool,
    args: Record<string, any>,
  ): any {
    if (!tool.requestBody) {
      const bodyParam = tool.parameters.find((param) => param.in === "body");
      if (!bodyParam) {
        return null;
      }

      if (args[bodyParam.name] !== undefined) {
        return args[bodyParam.name];
      }

      if (args.body !== undefined) {
        return args.body;
      }

      return null;
    }

    // Look for 'body' or 'requestBody' in args
    if (args.body !== undefined) {
      return args.body;
    }

    if (args.requestBody !== undefined) {
      return args.requestBody;
    }

    // If no explicit body parameter, collect all non-parameter args
    const bodyArgs: Record<string, any> = {};
    const paramNames = new Set(tool.parameters.map((p) => p.name));

    for (const [key, value] of Object.entries(args)) {
      if (!paramNames.has(key)) {
        bodyArgs[key] = value;
      }
    }

    return Object.keys(bodyArgs).length > 0 ? bodyArgs : null;
  }

  private debugLogRequest(config: AxiosRequestConfig): void {
    if (!this.isHttpDebugEnabled()) return;

    const safeHeaders = this.redactHeaders(
      (config.headers || {}) as Record<string, string>,
    );

    const payload = {
      method: String(config.method || "").toUpperCase(),
      url: config.url,
      headers: safeHeaders,
      params: config.params,
      data: config.data,
    };

    this.appendDebugLog(`HTTP Request: ${JSON.stringify(payload, null, 2)}`);
  }

  private debugLogResponse(response: AxiosResponse): void {
    if (!this.isHttpDebugEnabled()) return;

    const payload = {
      status: response.status,
      statusText: response.statusText,
      headers: this.redactHeaders(response.headers as Record<string, string>),
      data: response.data,
    };

    this.appendDebugLog(`HTTP Response: ${JSON.stringify(payload, null, 2)}`);
  }

  private debugLogError(error: any): void {
    if (!this.isHttpDebugEnabled()) return;

    const payload = {
      message: error.message,
      status: error.response?.status,
      statusText: error.response?.statusText,
      headers: this.redactHeaders(
        (error.response?.headers || {}) as Record<string, string>,
      ),
      data: error.response?.data,
    };

    this.appendDebugLog(`HTTP Error: ${JSON.stringify(payload, null, 2)}`);
  }

  private isHttpDebugEnabled(): boolean {
    const raw =
      process.env.SPECRUN_HTTP_DEBUG || process.env.SPECRUN_DEBUG_HTTP || "";
    const value = String(raw).toLowerCase();
    return value === "1" || value === "true" || value === "yes";
  }

  private redactHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const redacted = { ...headers };
    const redactKeys = ["authorization", "x-api-key"];

    for (const key of Object.keys(redacted)) {
      if (redactKeys.includes(key.toLowerCase())) {
        redacted[key] = "[redacted]";
      }
    }

    return redacted;
  }

  private appendDebugLog(message: string): void {
    try {
      const debugPath = path.join(__dirname, "../../debug.log");
      fs.appendFileSync(debugPath, `${new Date().toISOString()}: ${message}\n`);
    } catch (e) {}
  }

  private buildRequestUrl(config: AxiosRequestConfig): string {
    const baseUrl = config.url || "";
    const params = (config.params || {}) as Record<string, unknown>;
    if (!baseUrl || Object.keys(params).length === 0) {
      return baseUrl;
    }

    try {
      const parsed = new URL(baseUrl);
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
          continue;
        }

        if (Array.isArray(value)) {
          for (const entry of value) {
            parsed.searchParams.append(key, String(entry));
          }
          continue;
        }

        if (typeof value === "object") {
          parsed.searchParams.append(key, JSON.stringify(value));
          continue;
        }

        parsed.searchParams.append(key, String(value));
      }

      return parsed.toString();
    } catch {
      return baseUrl;
    }
  }
}

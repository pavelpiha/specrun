import { config } from "dotenv";
import path from "path";
import fs from "fs";
import { AuthConfig } from "../types";

const ENV_PLACEHOLDER_COMMENT = "# SpecRun placeholders";

function getEnvPlaceholderValue(key: string): string {
  if (key.endsWith("_SERVER_URL")) {
    return "";
  }

  if (key.endsWith("_BEARER_TOKEN")) {
    return "";
  }

  return "";
}

function parseEnvKeys(envContent: string): Set<string> {
  const keys = new Set<string>();

  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Z0-9_]+)\s*=/);
    if (match) {
      keys.add(match[1]);
    }
  }

  return keys;
}

export function ensureEnvKeysForSpecs(
  specsPath: string,
  specFiles: string[],
): void {
  const envPath = path.join(specsPath, ".env");
  const envContent = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : "";
  const existingKeys = parseEnvKeys(envContent);

  const missingKeys: string[] = [];

  for (const specFile of specFiles) {
    const apiName = getApiNameFromFile(specFile);
    if (!apiName) {
      continue;
    }

    const envPrefix = apiName.toUpperCase();
    const serverKey = `${envPrefix}_SERVER_URL`;
    const bearerKey = `${envPrefix}_BEARER_TOKEN`;

    if (!existingKeys.has(serverKey)) {
      missingKeys.push(serverKey);
    }

    if (!existingKeys.has(bearerKey)) {
      missingKeys.push(bearerKey);
    }
  }

  if (missingKeys.length === 0) {
    return;
  }

  const additions: string[] = [];
  if (!envContent.includes(ENV_PLACEHOLDER_COMMENT)) {
    additions.push(ENV_PLACEHOLDER_COMMENT);
  }

  for (const key of missingKeys) {
    const value = getEnvPlaceholderValue(key);
    additions.push(`${key}=${value}`);
  }

  const needsNewline = envContent.length > 0 && !envContent.endsWith("\n");
  const prefix = envContent.length > 0 ? (needsNewline ? "\n" : "") : "";
  const updatedContent = `${envContent}${prefix}${additions.join("\n")}\n`;

  fs.writeFileSync(envPath, updatedContent, "utf8");
}

export function loadAuthConfig(specsPath: string): AuthConfig {
  // Load .env file from specs directory
  const envPath = path.join(specsPath, ".env");
  if (fs.existsSync(envPath)) {
    // Ensure dotenv stays quiet to avoid breaking MCP stdio.
    process.env.DOTENV_CONFIG_QUIET = "true";
    config({ path: envPath, override: true, debug: false });
  }

  const authConfig: AuthConfig = {};

  // Parse environment variables with naming convention {API_NAME}_API_KEY, etc.
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;

    // Match patterns like CARS_API_KEY, GITHUB_TOKEN, etc.
    const apiKeyMatch = key.match(/^(.+)_API_KEY$/);
    const tokenMatch = key.match(/^(.+)_TOKEN$/);
    const bearerMatch = key.match(/^(.+)_BEARER_TOKEN$/);
    const basicUserMatch = key.match(/^(.+)_USERNAME$/);
    const basicPassMatch = key.match(/^(.+)_PASSWORD$/);

    let apiName: string | undefined;
    let authType: "bearer" | "apiKey" | "basic" | undefined;
    let configKey: string | undefined;

    if (apiKeyMatch) {
      apiName = apiKeyMatch[1].toLowerCase();
      authType = "apiKey";
      configKey = "token";
    } else if (bearerMatch) {
      apiName = bearerMatch[1].toLowerCase();
      authType = "bearer";
      configKey = "token";
    } else if (tokenMatch && !key.includes("BEARER")) {
      apiName = tokenMatch[1].toLowerCase();
      authType = "bearer";
      configKey = "token";
    } else if (basicUserMatch) {
      apiName = basicUserMatch[1].toLowerCase();
      authType = "basic";
      configKey = "username";
    } else if (basicPassMatch) {
      apiName = basicPassMatch[1].toLowerCase();
      authType = "basic";
      configKey = "password";
    }

    if (apiName && authType && configKey) {
      if (!authConfig[apiName]) {
        authConfig[apiName] = { type: authType };
      }

      // Override type if more specific auth found
      if (authType === "bearer" && authConfig[apiName].type !== "bearer") {
        authConfig[apiName].type = authType;
      }

      (authConfig[apiName] as any)[configKey] = value;

      // Set default header name for API keys
      if (authType === "apiKey" && !authConfig[apiName].headerName) {
        authConfig[apiName].headerName = "X-API-Key";
      }
    }
  }

  return authConfig;
}

export function applyAuthentication(
  headers: Record<string, string>,
  authConfig?: AuthConfig[string],
): Record<string, string> {
  if (!authConfig) return headers;

  const result = { ...headers };

  switch (authConfig.type) {
    case "bearer":
      if (authConfig.token) {
        result.Authorization = `Bearer ${authConfig.token}`;
      }
      break;

    case "apiKey":
      if (authConfig.token && authConfig.headerName) {
        result[authConfig.headerName] = authConfig.token;
      }
      break;

    case "basic":
      if (authConfig.username && authConfig.password) {
        const credentials = Buffer.from(
          `${authConfig.username}:${authConfig.password}`,
        ).toString("base64");
        result.Authorization = `Basic ${credentials}`;
      }
      break;
  }

  return result;
}

export function getApiNameFromFile(filePath: string): string {
  let fileName = path.basename(filePath, path.extname(filePath));

  // Trim common OpenAPI/Swagger suffixes from base name.
  fileName = fileName.replace(/([._-])(swagger|openapi)$/i, "");

  // Normalize by replacing non-alphanumeric characters with underscores.
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

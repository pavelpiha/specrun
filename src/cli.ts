#!/usr/bin/env node

import { Command } from "commander";
import path from "path";
import type { ServerConfig } from "./types";

const program = new Command();

function ensureSupportedNode(): void {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (!Number.isNaN(major) && major >= 22) {
    return;
  }

  console.error(
    `SpecRun requires Node.js >= 22. Detected ${process.version}. Run with Node 22, for example: npx -y node@22 ./dist/cli.js --specs /absolute/path/to/specs`,
  );
  process.exit(1);
}

async function createServer(config: ServerConfig) {
  ensureSupportedNode();
  const { OpenApiMcpServer } = await import("./server");
  return new OpenApiMcpServer(config);
}

function ensureValidTransportRuntime(config: ServerConfig): void {
  const transportType = config.transportType ?? "stdio";
  const isStdio = transportType === "stdio";
  const isInteractiveTerminal =
    Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

  if (!isStdio || !isInteractiveTerminal) {
    return;
  }

  console.error(
    [
      "SpecRun stdio transport expects an MCP client over stdin/stdout, not an interactive terminal.",
      "Use one of these options:",
      "- Start from an MCP client configuration (recommended)",
      "- Run HTTP mode for manual testing: npm run dev -- --transport httpStream --port 8080 --specs /absolute/path/to/specs",
      "- List tools without starting MCP transport: npm run dev -- list --specs /absolute/path/to/specs",
    ].join("\n"),
  );
  process.exit(1);
}

program
  .name("specrun")
  .description(
    "Converts OpenAPI specifications to MCP tools - automatically generates tools from OpenAPI specs",
  )
  .version("1.0.0")
  .option(
    "--specs <path>",
    "Path to directory containing OpenAPI spec files",
    process.cwd(),
  )
  .option(
    "--port <number>",
    "Port number for HTTP transport (enables HTTP mode)",
    (val: any) => parseInt(val, 10),
  )
  .option("--transport <type>", "Transport type: stdio or httpStream", "stdio")
  .action(async (options: any) => {
    try {
      // Debug: log raw options without breaking JSON protocol
      const globalOptions = program.opts();
      const specsPath = path.resolve(
        options.specs || globalOptions.specs || process.cwd(),
      );

      const config: ServerConfig = {
        specsPath,
        port: options.port,
        transportType: options.transport as "stdio" | "httpStream",
      };

      // Validate transport configuration
      if (config.transportType === "httpStream" && !config.port) {
        console.error(
          "Error: --port is required when using httpStream transport",
        );
        process.exit(1);
      }

      ensureValidTransportRuntime(config);

      const server = await createServer(config);

      // Handle graceful shutdown
      const shutdown = async () => {
        if (config.transportType !== "stdio") {
          console.log("Shutting down...");
        }
        await server.stop();
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Start the server
      await server.start();
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  });

// Add a command to list loaded specs (useful for debugging)
program
  .command("list")
  .description("List all loaded OpenAPI specifications and their tools")
  .option("--specs <path>", "Path to directory containing OpenAPI spec files")
  .action(async (options: any) => {
    try {
      // Debug: log raw options without breaking JSON protocol
      const globalOptions = program.opts();
      const specsPath = path.resolve(
        globalOptions.specs || options.specs || process.cwd(),
      );

      const config: ServerConfig = {
        specsPath,
      };

      const server = await createServer(config);

      await server.loadSpecs();

      const specs = server.getLoadedSpecs();
      const authConfig = server.getAuthConfig();

      console.log("\n=== SpecRun Status ===\n");
      console.log(`Specs Directory: ${config.specsPath}`);
      console.log(`Loaded Specifications: ${specs.length}`);

      if (specs.length === 0) {
        console.log("\nNo OpenAPI specifications found.");
        console.log("Add .json, .yaml, or .yml files to the specs directory.");
      } else {
        for (const spec of specs) {
          console.log(`\n📋 ${spec.apiName.toUpperCase()}`);
          console.log(`   File: ${path.basename(spec.filePath)}`);
          console.log(`   Base URL: ${spec.tools[0]?.baseUrl || "N/A"}`);
          console.log(`   Tools: ${spec.tools.length}`);

          if (authConfig[spec.apiName]) {
            const auth = authConfig[spec.apiName];
            console.log(
              `   Auth: ${auth.type} ${auth.type === "apiKey" ? `(${auth.headerName})` : ""}`,
            );
          } else {
            console.log(`   Auth: None configured`);
          }

          if (spec.tools.length > 0) {
            console.log("   Available tools:");
            for (const tool of spec.tools.slice(0, 5)) {
              // Show first 5 tools
              console.log(`     • ${tool.name} - ${tool.description}`);
            }
            if (spec.tools.length > 5) {
              console.log(`     ... and ${spec.tools.length - 5} more`);
            }
          }
        }
      }

      console.log("\n=== Global Tools ===\n");
      console.log("• specrun_batch - Run any SpecRun tool in batch");

      console.log("\n=== Authentication Configuration ===\n");
      const authKeys = Object.keys(authConfig);
      if (authKeys.length === 0) {
        console.log("No authentication configured.");
        console.log("Add a .env file with credentials like:");
      } else {
        for (const apiName of authKeys) {
          const auth = authConfig[apiName];
          console.log(`🔐 ${apiName.toUpperCase()}: ${auth.type}`);
        }
      }

      await server.stop();
    } catch (error) {
      console.error("Failed to list specs:", error);
      process.exit(1);
    }
  });

if (require.main === module) {
  program.parse();
}

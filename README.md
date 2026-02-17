<h1 align="center">
  SpecRun
</h1>
An MCP server that turns OpenAPI specifications into MCP tools. Scans a folder for OpenAPI spec files and automatically generate corresponding tools. These tools can then be used in any MCP client to interact with the APIs defined by the specs, with built-in support for authentication and server URL management via a simple `.env` file.

Built with [FastMCP](https://www.npmjs.com/package/fastmcp) for TypeScript.

## ✨ Features

- **Zero Configuration**: Filesystem is the interface - just drop OpenAPI specs in a folder
- **Supports OpenAPI 3.0 and 2.0**: Works with both OpenAPI 3.x and Swagger 2.0 specs
- **Namespace Isolation**: Multiple APIs coexist cleanly
- **Full OpenAPI Support**: Handles parameters, request bodies, authentication, and responses
- **Run Any Tool to Interact with APIs**: For example, `cars_addCar` to call `POST /cars` from `cars.json` spec to create a new car, or `github_get_user_repos` to call `GET /user/repos` from `github.yaml` spec to list repos.
- **Run Any Tool with Custom Inputs**: Pass structured JSON inputs for parameters and request bodies
- **Run Any Tool to see Spec Details**: Get the original OpenAPI spec details for any tool, including parameters, request body schema, and response schema
- **Run Any Tool to get API responses as resources**: Each tool call returns a JSON resource containing request URL, request body, and response
- **Run Any Tool in Batch**: One `specrun_batch` tool can execute any tool with multiple inputs and returns a consolidated JSON resource
- **Auto Authentication**: Simple `.env` file with `{API_NAME}_API_KEY` pattern
- **Auto .env Placeholders**: Adds `{API_NAME}_SERVER_URL` and `{API_NAME}_BEARER_TOKEN` entries when missing
- **Multiple Transports**: Support for stdio and HTTP streaming
- **Built-in Debugging**: List command to see loaded specs and tools
- **MCP Prompts**: Built-in prompts for listing tools, generating inputs, and explaining schemas
- **Agent**: configured agent for using SpecRun tools to explore and operate APIs in a guided way ([`.github/agents/specrun.agent.md`](.github/agents/specrun.agent.md))

## Quick Start

### Requirements

- Node.js 22 or newer

### 1️⃣ Install (optional)

```bash
npm install -g specrun
```

### 2️⃣ Create a specs folder where the server can read OpenAPI spec files. For example:

```bash
mkdir ~/specs
```

### 3️⃣ Add OpenAPI specs

Drop any `.json`, `.yaml`, or `.yml` OpenAPI specification files into your specs folder

### 4️⃣ Configure authentication (optional)

Create a `.env` file in your specs folder:

```bash
# ~/specs/.env
CARS_API_KEY=your_api_key_here
```

SpecRun will also ensure `{API_NAME}_SERVER_URL` and `{API_NAME}_BEARER_TOKEN` entries exist for each spec, adding empty placeholders when missing.
When `{API_NAME}_SERVER_URL` has a value, SpecRun updates the spec file on load:

- OpenAPI 3.0: updates the first `servers` entry.
- OpenAPI 2.0 (formerly Swagger 2.0): updates `host`, `schemes`, and `basePath` (no `servers` section in OpenAPI 2.0).

SpecRun also watches the `.env` file and refreshes server URLs and auth config automatically after changes.

### 5️⃣ Add to MCP client configuration

Add to your MCP configuration:

If installed on your machine:

```json
{
  "mcpServers": {
    "specrun": {
      "command": "specrun",
      "args": ["--specs", "/path/to/your/specs/folder"]
    }
  }
}
```

Otherwise:

```json
{
  "mcpServers": {
    "specrun": {
      "command": "npx",
      "args": ["-y", "specrun", "--specs", "/absolute/path/to/your/specs"]
    }
  }
}
```

or with specific Node version:

```json
{
  "mcpServers": {
    "specrun": {
      "command": "/Users/YOUR_USER_NAME/.local/bin/mcp-npx-node22",
      "args": ["specrun@latest", "--specs", "/absolute/path/to/your/specs"],
      "type": "stdio"
    }
  }
}
```

The `mcp-npx-node22` script file uses nvm to run specrun with Node.js 22.14.0, ensuring compatibility regardless of the default Node version on your system.:

```bash
#!/bin/bash
# Set the PATH to include NVM's Node.js v22.14.0 installation
export PATH="/Users/YOUR_USER_NAME/.nvm/versions/node/v22.14.0/bin:$PATH"

# Execute npx with all passed arguments
exec npx "$@"
```

## 💻 CLI Usage

### 🚀 Start the server

```bash
# Default: stdio transport, current directory
specrun

# Custom specs folder
specrun --specs ~/specs

# HTTP transport mode
specrun --transport httpStream --port 8080
```

### 📋 List loaded specs and tools

```bash
# List all loaded specifications and their tools
specrun list

# List specs from custom folder
specrun list --specs ~/specs

```

## 🔑 Authentication Patterns

The server automatically detects authentication from environment variables using these patterns:

| Pattern                                       | Auth Type       | Usage                           |
| --------------------------------------------- | --------------- | ------------------------------- |
| `{API_NAME}_API_KEY`                          | 🗝️ API Key      | `X-API-Key` header              |
| `{API_NAME}_TOKEN`                            | 🎫 Bearer Token | `Authorization: Bearer {token}` |
| `{API_NAME}_BEARER_TOKEN`                     | 🎫 Bearer Token | `Authorization: Bearer {token}` |
| `{API_NAME}_USERNAME` + `{API_NAME}_PASSWORD` | 👤 Basic Auth   | `Authorization: Basic {base64}` |

SpecRun also creates `.env` placeholders for:

| Pattern                   | Purpose                      |
| ------------------------- | ---------------------------- |
| `{API_NAME}_SERVER_URL`   | Base URL for the API         |
| `{API_NAME}_BEARER_TOKEN` | Token placeholder if missing |

If `{API_NAME}_SERVER_URL` is set, SpecRun writes that value into the spec before generating tools:

- OpenAPI 3.0: writes the first `servers` entry.
- OpenAPI 2.0 (formerly Swagger 2.0): writes `host`, `schemes`, and `basePath`.

Updates to `.env` are applied automatically without restarting the MCP server.

The `{API_NAME}` is derived from the filename of your OpenAPI spec:

- `cars.json` → `CARS_API_KEY`
- `github-api.yaml` → `GITHUB_TOKEN`
- `my_custom_api.yml` → `MY_CUSTOM_API_KEY`

## 🏷️ Tool Naming

Tools are automatically named using this pattern:

- **With operationId**: `{api_name}_{operationId}`
- **Without operationId**: `{api_name}_{method}_{path_segments}`

Specs:

- `cars_getCarById` (from operationId)
- `github_get_user_repos` (generated from `GET /user/repos`)

Use the shared batch tool to run any tool with an array of inputs:

```json
{
  "toolName": "cars_getCarById",
  "items": [{ "id": "123" }, { "id": "456" }],
  "failFast": false
}
```

Batch responses return a consolidated JSON resource with per-item outputs.

For batches over 200 items, SpecRun requires explicit confirmation. This is to prevent accidental large runs that could cause performance issues or unintended consequences. The server will return a message asking for confirmation, and you can retry with `confirmLargeBatch: true` and the provided `confirmLargeBatchToken` to proceed.

## 📦 Resource Outputs

Tool responses are returned as MCP resources with `application/json` content. Each resource includes:

1. Request URL
2. Request body
3. Response status and body

Example resource payload:

```json
{
  "requestUrl": "https://api.example.com/v1/users/123",
  "requestBody": null,
  "response": {
    "status": 200,
    "body": {
      "id": "123",
      "name": "Jane Doe"
    }
  }
}
```

Batch runs return a single consolidated resource containing all item results.

## 📁 File Structure

```
your-project/
── specs/           # Your OpenAPI specs folder
   ├── .env            # Authentication credentials
   └── custom-api.yml  # Your OpenAPI spec files
```

## 🧭 MCP Prompts

SpecRun exposes MCP prompts for common workflows:

- `list_apis`: List loaded APIs/tools and ask the user to choose an endpoint
- `generate_api_call`: Generate a ready-to-run JSON input payload for a tool
- `explain_api_schema`: Explain parameters and request body schema with examples

## 📄 Example OpenAPI Spec

Here's a minimal example that creates two tools:

```yaml
# ~/specs/example.yaml
openapi: 3.0.0
info:
  title: Example API
  version: 1.0.0
servers:
  - url: https://api-server.placeholder
paths:
  /users/{id}:
    get:
      operationId: getUser
      summary: Get user by ID
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: User found
  /users:
    post:
      operationId: createUser
      summary: Create a new user
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                email:
                  type: string
      responses:
        "201":
          description: User created
```

This creates tools named:

- `example_getUser`
- `example_createUser`

## 🔧 Troubleshooting

### ❌ No tools appearing?

1. Check that your OpenAPI specs are valid:

   ```bash
   specrun list --specs /path/to/specs
   ```

2. Ensure files have correct extensions (`.json`, `.yaml`, `.yml`)

3. Check the server logs for parsing errors

> **⚠️ Note:** SpecRun works best when you use absolute paths (with no spaces) for the `--specs` argument and other file paths. Relative paths or paths containing spaces may cause issues on some platforms or with some MCP clients.

### 🔐 Authentication not working?

1. Verify your `.env` file is in the specs directory
2. Check the naming pattern matches your spec filename
3. Use the list command to verify auth configuration:
   ```bash
   specrun list
   ```

### 🔄 Tools not updating after spec changes?

1. Restart the MCP server to reload the specs
2. Check file permissions
3. Restart the MCP client if needed

## 🛠️ Development

```bash
# Clone and install
git clone git@github.com:Pavel-Piha/specrun.git
cd specrun
npm install

# Build
npm run build

# Test locally
npm run dev -- --specs ./specs
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

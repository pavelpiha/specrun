# SpecRun Prompts Guide

This document summarizes all SpecRun MCP prompts with small examples.

## list_apis

Lists loaded APIs/tools and helps pick the next endpoint.

**Arguments**

- `filter` (optional): substring filter for API/tool names
- `max_results` (optional): page size
- `cursor` (optional): pagination cursor from previous response

**Example args**

```json
{
  "filter": "cars",
  "max_results": 20
}
```

## generate_api_call

Builds a ready-to-run JSON payload using required tool parameters and request body schema.

**Arguments**

- `tool_name` (required): exact POST tool name

**Example args**

```json
{
  "tool_name": "cars_get_car_by_id"
}
```

## explain_api_schema

Explains parameters and request body shape for a selected tool.

**Arguments**

- `tool_name` (required): exact tool name

**Example args**

```json
{
  "tool_name": "github_get_user_repos"
}
```

## generate_random_data

Generates random ready-to-run JSON payload samples for a selected tool.

This prompt supports POST tools only.

**Arguments**

- `tool_name` (required): exact tool name
- `count` (optional): number of samples (any positive integer, default 1)
- `include_optional` (optional): include optional fields (default `false`)

**Example args**

```json
{
  "tool_name": "cars_add_car",
  "count": 2,
  "include_optional": false
}
```

When `count > 1`, the prompt returns a ready-to-run payload for `specrun_batch` using:

- `toolName`
- `items`
- `failFast`

By default, generated payloads include only required fields.

To include optional fields, rerun with:

```json
{
  "tool_name": "cars_add_car",
  "include_optional": true
}
```

**Name-like field behavior**

For string fields like `name`, `label`, or similar, generated values follow:

- `ai-{object-name}-{date-in-ms}-{N}`
- If `-` is not allowed by schema pattern, delimiter is removed
- If value exceeds `maxLength`, `{object-name}` is omitted first

Example outputs:

- `ai-car-1767259200123-1`
- `ai17672592001231`
- `ai-1767259200123-2`

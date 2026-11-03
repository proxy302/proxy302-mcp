# Installing proxy302-mcp (guide for AI agents)

Ask the user for a Proxy302 API key first. They create it in the Proxy302 console (https://proxy302.com); it has a key id and a secret. Never invent one, and never write it into files that get committed.

## Option A: hosted server (nothing to install)

Use the Streamable HTTP endpoint `https://proxy302.com/v1/mcp` with the header `Authorization: Bearer <key id>:<secret>`.

```json
{
  "mcpServers": {
    "proxy302": {
      "url": "https://proxy302.com/v1/mcp",
      "headers": { "Authorization": "Bearer <key id>:<secret>" }
    }
  }
}
```

## Option B: local server (stdio, needs Node.js 20+)

```json
{
  "mcpServers": {
    "proxy302": {
      "command": "npx",
      "args": ["-y", "github:proxy302/proxy302-mcp"],
      "env": { "PROXY302_API_KEY": "<key id>:<secret>" }
    }
  }
}
```

The first `npx` run downloads and builds the server, which takes a few seconds.

## Check that it works

Call `get_account_usage`. It should return the account's wallet balance and remaining traffic. An authentication error means the key id or secret is wrong.

All tools are read-only and never spend money.

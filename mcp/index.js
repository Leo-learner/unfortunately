#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp } from './server.js';
// stdout is exclusively reserved for the MCP protocol, never credentials/logs.
await createMcp().connect(new StdioServerTransport());

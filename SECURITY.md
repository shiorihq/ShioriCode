# Security Policy

ShioriCode brokers coding-agent sessions, launches local tools, and handles provider credentials. Please treat security issues carefully.

## Reporting Vulnerabilities

Do not open a public GitHub issue for a vulnerability.

Report security issues privately to the maintainers. Include:

- A concise description of the issue.
- Steps to reproduce.
- Affected versions or commit SHAs.
- Logs, screenshots, or proof-of-concept details if useful.
- Whether credentials, local files, shell access, remote access, or provider sessions are affected.

## Sensitive Areas

Please be especially careful around:

- WebSocket authentication and remote server mode.
- Provider tokens and OAuth flows.
- Shell command execution and terminal sessions.
- MCP server configuration and tool exposure.
- Desktop deep links, preload bridges, and IPC.
- Auto-update feeds and release signing.
- Telemetry, structured logs, and crash or diagnostic data.

## Supported Versions

ShioriCode is pre-1.0. Security fixes target the current main branch unless a maintainer explicitly announces support for a release line.

## Disclosure

Give maintainers a reasonable amount of time to investigate and release a fix before publishing details. We will credit reporters when requested and appropriate.

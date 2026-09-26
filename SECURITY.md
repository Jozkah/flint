# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.9.x   | Yes       |
| < 0.9   | No        |

Security fixes land on `main` and ship in the next 0.9.x release.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report vulnerabilities privately through GitHub's private vulnerability reporting:

1. Open https://github.com/Jozkah/flint/security/advisories/new
   (or go to the **Security** tab and click **Report a vulnerability**).
2. Describe the issue, the affected version and platform, and steps to reproduce.
   A minimal proof of concept helps.

You will get a reply in the advisory thread. Once a fix is available, the advisory
is published with credit to the reporter unless you ask to stay anonymous.

## Scope

Flint runs models and agent tools locally on your machine. Reports are especially
welcome for:

- ways an agent or tool call can escape the configured permissions or sandbox,
- ways a model, MCP server, extension or downloaded file can run code or read files
  without the user's approval,
- leaks of API keys or other secrets stored by the app.

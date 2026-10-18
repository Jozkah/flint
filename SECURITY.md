# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 0.9   | No        |

Security fixes land on `main` and ship in the next 1.0.x release.

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

## PowerShell scripts always ask

The agent's shell scan can prove some POSIX commands safe, but it does not try to prove PowerShell scripts safe: a script that is not a plain, single read-only command asks for approval even in the mode that lets tasks work inside their own folder.

This is deliberate. A classifier that let "contained" PowerShell scripts skip the prompt was built and reviewed adversarially twice (see the reverted commits 66035d7fb and 01066c612 in the history). Each round found several confirmed bypasses, including statement separators that PowerShell treats differently from the scanner (a lone carriage return), parameter binding that turns a bare word into a method call (`ForEach-Object Delete`), working-directory desync after a failing `Set-Location`, and variable names that fold Unicode letters inside strings. PowerShell's grammar is too large to prove safe with a small interpreter, and the cost of a miss is a silent delete or secret read, so the prompt stays. The OS sandbox is still the enforcement layer for whatever the user approves.

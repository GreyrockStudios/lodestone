# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅ Community tier |

Lodestone is in early development. Only the latest 0.1.x release receives security fixes.

## Reporting a Vulnerability

If you discover a security vulnerability in Lodestone, please report it responsibly.

**Contact:** security@greyrockstudios.com

**Do not** open a public GitHub issue for security vulnerabilities.

### What to Include in Your Report

- A clear description of the vulnerability and its potential impact
- Steps to reproduce (proof of concept, minimal example)
- Affected version and configuration details
- Any relevant logs or screenshots (redact secrets)
- Your suggested fix, if you have one

### Response Timeline

| Stage | Target |
| ----- | ------ |
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 7 days |
| Patch for critical issues | Within 30 days |

You will receive updates at each stage. If a fix is delayed beyond the target, we will explain why and provide a revised timeline.

## Scope

This policy covers **Lodestone core** — the runtime, tool execution engine, context management, MCP integration, and configuration system.

It does **not** cover:

- Third-party dependencies (report to upstream maintainers)
- Issues in LLM providers (OpenAI, Anthropic, Ollama, etc.)
- Self-hosted infrastructure misconfiguration
- Tool plugins contributed by the community

If you are unsure whether something is in scope, send the report anyway — we will route it appropriately.

## Safe Harbor

We support responsible disclosure. If you act in good faith and follow this policy:

- We will not pursue legal action against you
- We will not request law enforcement action against you
- We will work with you to understand and resolve the issue

In return, we ask that you:

- Give us reasonable time to fix the issue before public disclosure
- Do not access or modify data that does not belong to you
- Do not degrade service availability (no DoS, DDoS, or brute force)
- Report promptly upon discovery

We will credit reporters in release notes unless you prefer to remain anonymous.
# Business Operations Agent

A Lodestone agent that handles day-to-day business operations: scheduling, reminders, email triage, reporting.

## Quick Start

```bash
# 1. Copy this example's workspace
cp -r examples/business-ops/workspace ./workspace

# 2. Configure your LLM
# Edit lodestone.config.yaml — set model + baseUrl

# 3. Start the agent
lodestone start
```

## Identity

This agent's identity files are in `workspace/`:

- **IDENTITY.md** — "Ops" — a business operations agent
- **SOUL.md** — Practical, efficient, proactive
- **USER.md** — Configure with your name and business details
- **AGENTS.md** — Standard workspace rules

## What It Does

- **Morning brief**: Summarizes calendar, priorities, pending items
- **Email triage**: Categorizes incoming emails (urgent, follow-up, archive)
- **Reminder management**: Tracks deadlines and follow-ups
- **Weekly reporting**: Generates activity reports from logged data
- **Proactive suggestions**: Identifies scheduling conflicts, missed deadlines

## Configuration

```yaml
# lodestone.config.yaml
workspace:
  root: ./workspace

llm:
  default:
    type: ollama
    model: glm-5.2:cloud
    baseUrl: http://127.0.0.1:11434/api

channels:
  - type: telegram
    token: ${TELEGRAM_BOT_TOKEN}
  - type: webchat
    port: 3000

proactive:
  checkIntervalMs: 900000  # 15 min — check for opportunities

dashboard:
  enabled: true
  port: 18789
```

## Tools Used

| Tool | Purpose |
|------|---------|
| business-hours | Check if it's business hours before sending |
| calendar | Schedule management, free slot finding |
| decision-log | Record operational decisions |
| watchdog | Track deadlines and expected outcomes |
| resume-state | Save task state across sessions |

## Customization

Edit `workspace/SOUL.md` to change the agent's personality. Edit `workspace/AGENTS.md` to change workspace rules and behavior expectations.
# Customer Support Agent

A Lodestone agent that handles customer support: ticket triage, response drafting, FAQ lookup, escalation.

## Quick Start

```bash
cp -r examples/customer-support/workspace ./workspace
lodestone start
```

## What It Does

- **Ticket triage**: Categorizes incoming tickets by urgency and topic
- **FAQ lookup**: Searches wiki/knowledge base for relevant answers
- **Response drafting**: Suggests responses based on past resolved tickets
- **Escalation**: Identifies when a ticket needs human intervention
- **Sentiment tracking**: Monitors customer satisfaction trends
- **Knowledge base maintenance**: Updates wiki with new resolved issues

## Tools Used

| Tool | Purpose |
|------|---------|
| smart-retrieve | Find relevant past resolutions |
| wiki-resolve | Link to knowledge base articles |
| decision-log | Record escalation decisions |
| watchdog | Track response time SLAs |
| business-hours | Check if support is currently available |
| resume-state | Maintain ticket context across sessions |

## Configuration

```yaml
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
  - type: email
    imapUrl: ${IMAP_URL}
    smtpUrl: ${SMTP_URL}

safety:
  qualityGate:
    enabled: true
    thresholds:
      code: 0.7
      external_message: 0.8  # Higher bar for customer-facing responses

proactive:
  checkIntervalMs: 300000  # 5 min — check for SLA breaches
```
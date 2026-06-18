# Researcher Agent

A Lodestone agent that does research: web search, source evaluation, synthesis, report writing.

## Quick Start

```bash
cp -r examples/researcher/workspace ./workspace
lodestone start
```

## What It Does

- **Web research**: Searches the web, fetches sources, evaluates credibility
- **Literature review**: Synthesizes multiple sources into coherent summaries
- **Citation tracking**: Records sources in wiki with full provenance
- **Knowledge synthesis**: Builds wiki pages from research findings
- **Fact-checking**: Cross-references claims against multiple sources

## Tools Used

| Tool | Purpose |
|------|---------|
| web-search | Find relevant sources |
| web-fetch | Retrieve full article content |
| wiki-resolve | Link related wiki pages |
| smart-retrieve | Recall prior research |
| decision-log | Record research conclusions |
| file-ops | Save research reports |
| code-exec | Run data analysis on findings |

## Configuration

```yaml
workspace:
  root: ./workspace

llm:
  default:
    type: ollama
    model: glm-5.2:cloud
    baseUrl: http://127.0.0.1:11434/api

memory:
  wiki:
    path: ./workspace/memory/wiki

channels:
  - type: webchat
    port: 3000
```
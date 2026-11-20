# Atlassian Marketplace submission kit

Everything needed to list **Kairos** on the Atlassian Marketplace once the Forge app is registered (`forge register`) and deployed.

| Item | Content |
|---|---|
| Name | Kairos: Support Copilot |
| Tagline | Sourced answers, SLA forecasts and incident radar for Jira Service Management and Confluence, with no paid LLM. |
| Categories | Service management, AI |
| Highlights | Rovo agent and MCP tools (7 actions); answers cite existing sentences and abstain when unsure; 48 LLM-free analyses; French, English, Spanish |
| Data handling | Ticket text is masked for personal data before any call to the AI service; the AI service is open-source and self-hosted; no third-party AI API |
| Security | Signed requests (FIT), scoped API keys, hash-chained audit log, SSRF-protected webhooks, per-organization isolation verified by tests |
| Egress | One declared remote: the Kairos API (see `forge-app/manifest.yml`) |
| Support | GitHub issues of the repository |
| Demo | https://kairos-web-pi-lilac.vercel.app (button "Try the demo") |

Steps: `forge register` → `forge deploy -e production` → `forge install` → submit through the Marketplace partner portal (requires an Atlassian partner account).

Teamwork Graph: the connector module and API are in Forge's Early Access Program; they need an EAP invitation before they can be declared in a manifest.

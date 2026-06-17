# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately via
[GitHub Security Advisory](https://github.com/ttcd77/agent-browser-runtime/security/advisories/new).

Do **not** file public issues for security vulnerabilities.

## What to Report

We are particularly interested in:

- Privilege escalation in the local HTTP worker server
- Sandbox escapes from the Chrome extension bridge to the host
- Authentication bypass for the bridge token
- Path traversal in evidence file or artifact handling
- Injection in CDP commands or worker-side tool handlers
- ReDoS or resource exhaustion in worker request processing
- Server-Side Request Forgery via worker-controlled fetch or DNS paths

## What's In Scope

- Code in this repository (latest `main` branch).
- The Chrome extension shipped with this repository.

## What's Not In Scope

- Use against targets the operator is not authorized to test — this is an
  authorization problem, not a runtime vulnerability.
- Vulnerabilities in third-party dependencies — please report those to the
  upstream projects.
- Social engineering, phishing, or credential harvesting against ABR operators.

## Response

We aim to acknowledge your report within **7 days** and will work with you on
disclosure timing. This is a best-effort open-source project; response times
may vary based on severity and reporter coordination.

## Preferred Languages

English or Chinese.

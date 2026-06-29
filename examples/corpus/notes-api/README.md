# Notes API

A small REST service for creating, organising, and searching personal notes. It is intentionally
simple — it exists as a sample corpus so Doc has a real project to build a manual from and to
exercise the documentation quality gate in CI.

## Overview

The Notes API stores notes in a relational database and exposes a JSON HTTP interface. Each note has
a title, a body, an owner, and a set of free-form tags. Notes can be listed, filtered by tag,
full-text searched, and archived. Authentication is token based: every request carries a bearer
token that identifies the owner, and notes are always scoped to their owner so one user can never
read another user's notes.

The service is deliberately stateless. All persistent state lives in the database, which means the
API can be scaled horizontally by running more instances behind a load balancer. Background jobs —
search re-indexing and archival cleanup — run on a separate worker process so that request latency is
never affected by housekeeping.

## Getting started

1. Install dependencies and start the database.
2. Run the migrations to create the `notes`, `tags`, and `owners` tables.
3. Start the server; it listens on port 8080 by default.
4. Create an owner token and start posting notes.

## Documentation

- **[API Reference](docs/API.md)** — endpoints, request and response payloads, and error codes.
- **[Deployment Guide](docs/DEPLOY.md)** — how to configure, containerise, and run the service.
- **[Architecture](docs/ARCHITECTURE.md)** — how the pieces fit together and why.

## License

Released under the MIT License.

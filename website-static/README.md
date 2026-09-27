# MergeShip public website

Standalone static deployment for the public landing and privacy pages. This service is intentionally separate from the Shopify app service.

Railway service settings:

- Builder: Dockerfile
- Dockerfile path: `website-static/Dockerfile`
- Config file path: `/website-static/railway.toml`
- Health check: `/`

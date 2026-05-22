# Miyagi Sanchez Scraper

Standalone collect-only scraper for Miyagi Sanchez supply acquisition.

## Environment

Required env vars:

- `ADMIN_SECRET`
- `SERPAPI_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The app writes scraper output to the existing Supabase tables:

- `marketplace_scrape_runs`
- `marketplace_scrape_run_items`

Open `/?secret=<ADMIN_SECRET>` or `/admin?secret=<ADMIN_SECRET>`.

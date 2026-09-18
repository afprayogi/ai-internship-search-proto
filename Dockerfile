# Packages the browser dashboard + offline scraper (tools/) as a standalone
# image - the Claude-driven workflow (/setup, /scrape, /apply, ...) still
# needs Claude Code running interactively and isn't part of this image.
#
# Build:  docker build -t job-search-dashboard .
# Run:    docker compose up -d      (see docker-compose.yml for the volumes
#                                     that keep your data outside the image)
FROM oven/bun:1

WORKDIR /app

# Only what tools/dashboard_server.mjs and tools/offline_scraper.mjs need at
# runtime - keeps the image lean and never bakes in personal CV/cover-letter/
# document content, which stays on the host, not in the image.
COPY tools/ ./tools/
COPY .agents/skills/linkedin-search/ ./.agents/skills/linkedin-search/

# job_scraper/ and job_search_tracker.csv are created fresh on first run if
# missing - real data lives in the volumes from docker-compose.yml instead,
# never baked into the image.
RUN mkdir -p job_scraper

EXPOSE 4870
ENV DASHBOARD_PORT=4870

CMD ["bun", "run", "tools/dashboard_server.mjs"]

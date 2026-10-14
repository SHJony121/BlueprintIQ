# BlueprintIQ: one container running the Next.js frontend (public port) and the FastAPI
# backend (127.0.0.1 inside the container only). See docs/deployment.md.
#
#   docker build --build-arg SOURCE_URL=https://example.org/owner/repo -t blueprintiq .
#
# SOURCE_URL is the public source of exactly this version (AGPL-3.0-or-later section 13); the
# build refuses to continue without a valid https address.

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PYTHON_IMAGE=python:3.12-slim-bookworm

# ---- frontend build -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS frontend
ARG SOURCE_URL
# Optional public origin of the site (for the social-preview image address); unset leaves it out.
ARG SITE_URL=
WORKDIR /src
COPY deploy/verify-source-url.mjs deploy/verify-source-url.mjs
RUN test -n "$SOURCE_URL" && node deploy/verify-source-url.mjs "$SOURCE_URL"
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend frontend
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_SOURCE_URL=${SOURCE_URL} NEXT_PUBLIC_SITE_URL=${SITE_URL}
RUN cd frontend && npm run build && npm prune --omit=dev

# ---- backend dependencies (hash-pinned from uv.lock) ------------------------------------
FROM ${PYTHON_IMAGE} AS backend
RUN python -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir uv==0.13.0
WORKDIR /src/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN /opt/venv/bin/uv export --frozen --no-dev --no-emit-project --format requirements-txt \
      --output-file /tmp/requirements.txt \
 && /opt/venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
 && /opt/venv/bin/pip uninstall -y uv
COPY backend/src src
RUN /opt/venv/bin/python -m compileall -q src

# ---- runtime -----------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
COPY --from=frontend /usr/local/bin/node /usr/local/bin/node
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin blueprintiq
WORKDIR /app
COPY --from=backend /opt/venv /opt/venv
COPY --from=backend /src/backend/src backend/src
COPY --from=frontend /src/frontend/.next frontend/.next
COPY --from=frontend /src/frontend/node_modules frontend/node_modules
COPY --from=frontend /src/frontend/package.json /src/frontend/next.config.ts frontend/
COPY --from=frontend /src/frontend/public frontend/public
COPY deploy deploy
COPY LICENSE NOTICE.md ./

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONPATH=/app/backend/src \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/tmp \
    PORT=8080

# Only /tmp needs to be writable (the worker's scratch space); the image can run with
# --read-only. Everything else is owned by root and not writable by the service user.
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "deploy/healthcheck.mjs"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "deploy/entrypoint.mjs"]

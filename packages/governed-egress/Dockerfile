# Governed AI Egress — the full pipeline as a container: the drop-in proxy,
# PDF / DOCX / XLSX / PPTX / CSV ingestion, detection, tokenization or
# synthetic replacement, verification, release, response scan and
# re-identification. Built and run by the CUSTOMER, inside their boundary.
# See docs/runbooks/governed-egress-proxy-container.md.
#
# Pin the base image by digest before building for production:
#   FROM node:22-slim@sha256:<digest you have reviewed>
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies only, installed exactly from the integrity-pinned lock.
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY package.json LICENSE ./pkg/
COPY src ./pkg/src
COPY bin ./pkg/bin

# The policy is mounted read-only at /config/policy.json; evidence (hashes,
# categories and counts only) is written under /data if --evidence-file is
# given. The token and the provider key come from the environment.
RUN mkdir -p /data && chown 10001 /data
USER 10001
ENTRYPOINT ["node", "/app/pkg/bin/strix-egress-proxy.mjs", "--policy", "/config/policy.json"]
# Loopback by default: run it as a sidecar sharing the caller's network
# namespace. A non-loopback bind needs --host, --tls-cert and --tls-key.
CMD ["--provider", "anthropic", "--evidence-file", "/data/evidence.jsonl"]

FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.212
ARG CODEX_VERSION=0.146.0
ARG OPENCODE_VERSION=1.18.9
ARG PI_VERSION=0.82.1

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "opencode-ai@${OPENCODE_VERSION}" \
    "@earendil-works/pi-coding-agent@${PI_VERSION}"

WORKDIR /workspace

COPY verify-versions.sh /usr/local/bin/cca-verify-agent-versions
RUN chmod 0755 /usr/local/bin/cca-verify-agent-versions

CMD ["cca-verify-agent-versions"]

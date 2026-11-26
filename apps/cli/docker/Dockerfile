# The Agent Rishi runner image (docs/remote-runners.md §5.2): the whole runner, run as a non-root
# user in a container of its own per agent session. The server's Docker backend builds it on
# first use as agent-rishi-runner:<version>, from this file and the package's own bundle; it is
# never published. Nothing secret is ever part of it: no token, key or login is copied in or
# set in its environment. The GitHub token reaches a container only inside a runner command
# over the link, for one git process at a time.
#
# The build context (made by the server): agent-rishi/package.json (runtime dependencies only) and
# agent-rishi/dist (the runner and CLI bundle, without the web UI).

FROM node:24-bookworm-slim AS deps
# node-pty has no prebuilt Linux binary: it compiles here, and the tools stay in this stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/agent-rishi
COPY agent-rishi/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system user.name "Agent Rishi" \
  && git config --system user.email "agent-rishi@localhost" \
  && git config --system init.defaultBranch main
COPY --from=deps /opt/agent-rishi/node_modules /opt/agent-rishi/node_modules
COPY agent-rishi/ /opt/agent-rishi/
RUN printf '#!/bin/sh\nexec node /opt/agent-rishi/dist/cli.js "$@"\n' > /usr/local/bin/agent-rishi \
  && printf '#!/bin/sh\nexec node /opt/agent-rishi/dist/runner.js "$@"\n' > /usr/local/bin/agent-rishi-runner \
  && chmod 755 /usr/local/bin/agent-rishi /usr/local/bin/agent-rishi-runner \
  && mkdir -p /data \
  && chown node:node /data
USER node
WORKDIR /data
CMD ["agent-rishi-runner", "--home", "/data", "--backend", "docker", "--no-builtin"]

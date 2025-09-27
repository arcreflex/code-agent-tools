# Minimal per-repo Dockerfile that extends from the base image
ARG BASE_IMAGE_TAG=latest
FROM agent-sandbox-base:${BASE_IMAGE_TAG}

# Optional: Add repo-specific OS packages (keep minimal and clean caches)
# USER root
# RUN apt-get update && apt-get install -y --no-install-recommends \
#     <repo-specific-packages> \
#   && apt-get clean && rm -rf /var/lib/apt/lists/*
# USER node

# Optional: Add extra global tools unique to this repo
# RUN npm install -g <tool>@<version>

# Inherit ENTRYPOINT/USER/WORKDIR from base
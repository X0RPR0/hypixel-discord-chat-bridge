# define base image
FROM node:22-bullseye-slim

# download dumb-init
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init git openssh-client ca-certificates

# define environment
ENV NODE_ENV production

# set work directory
WORKDIR /usr/src/app

# install dependencies
COPY --chown=node:node package.json package-lock.json /usr/src/app/
RUN npm ci --omit=dev --no-audit --no-fund

# copy app sources (kept after dependency layer for fast rebuilds)
COPY --chown=node:node . /usr/src/app

# run your app
USER node
RUN mkdir -p /home/node/.ssh \
  && chmod 700 /home/node/.ssh \
  && touch /home/node/.ssh/known_hosts \
  && (ssh-keyscan -H github.com >> /home/node/.ssh/known_hosts 2>/dev/null || true) \
  && chmod 644 /home/node/.ssh/known_hosts \
  && git config --global pull.rebase false
CMD ["dumb-init", "node", "index.js"]

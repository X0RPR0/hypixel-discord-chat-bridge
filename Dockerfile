# define base image
FROM node:22-bullseye-slim

# download dumb-init
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init git openssh-client ca-certificates

# define environment
ENV NODE_ENV production

# set work directory
WORKDIR /usr/src/app

# copy all sources to container
COPY --chown=node:node . /usr/src/app

# install dependencies
RUN npm install --omit=dev
RUN chown -R node:node /usr/src/app

# run your app
USER node
RUN mkdir -p /home/node/.ssh \
  && ssh-keyscan -H github.com >> /home/node/.ssh/known_hosts \
  && chmod 700 /home/node/.ssh \
  && chmod 644 /home/node/.ssh/known_hosts \
  && git config --global pull.rebase false
CMD [ " dumb-init\, \node\, \index.js\ ]

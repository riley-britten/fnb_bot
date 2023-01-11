FROM keybaseio/client:nightly-node
RUN mkdir -p /app/fnb_bot_storage && chown -R keybase:keybase /app
WORKDIR /app
COPY package*.json ./
RUN npm install # or use yarn
COPY . .
CMD node /app/index.js
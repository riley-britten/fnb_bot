FROM keybaseio/client:nightly-node
COPY package*.json ./
RUN npm install
COPY . .
CMD node index.js
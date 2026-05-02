FROM node:18-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

RUN mkdir -p /app/uploads /app/logs

EXPOSE 3003

CMD ["node", "src/index.js"]

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p logs

EXPOSE 3001

CMD ["sh", "-c", "npm run migrate && node src/index.js"]

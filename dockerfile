FROM node:18-slim
RUN apt-get update && apt-get install -y build-essential python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]

FROM node:20-alpine
WORKDIR /app
# Install build tools required for better-sqlite3 compilation
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install --production
COPY . .
RUN mkdir -p /app/data
CMD ["npm", "start"]
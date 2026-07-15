FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000 3001
CMD ["npm", "start", "--", "--hostname", "0.0.0.0"]

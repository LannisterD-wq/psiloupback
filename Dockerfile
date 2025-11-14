FROM node:18-alpine
WORKDIR /app
COPY back/package.json /app/back/package.json
WORKDIR /app/back
RUN apk add --no-cache python3 make g++ \
  && (npm ci || npm install) \
  && npm cache clean --force
COPY back /app/back
ENV NODE_ENV=production
CMD ["npm","start"]
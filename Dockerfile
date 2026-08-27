FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
RUN mkdir -p /app/files /app/data /app/uploads
ENV NODE_ENV=production PORT=30286 FILES_DIR=/app/files DATA_DIR=/app/data UPLOAD_DIR=/app/uploads
EXPOSE 30286
VOLUME ["/app/files", "/app/data"]
CMD ["node", "server.js"]

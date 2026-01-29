# Use Node.js LTS
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source
COPY . .

# Create public directories
RUN mkdir -p public/avatars public/chat-files public/course-slides public/post-images public/post-videos

# Expose port
EXPOSE 8080

# Set environment
ENV PORT=8080
ENV NODE_ENV=production

# Start the app
CMD ["node", "server.js"]

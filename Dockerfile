# Use the official Playwright image (includes Node.js + Browsers)
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install

# Copy the rest of the code
COPY . .

# Tell Playwright we already have browsers (skips huge download)
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]

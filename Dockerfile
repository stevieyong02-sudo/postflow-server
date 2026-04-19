FROM node:20-slim

# Install Chrome for Remotion rendering
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto \
    fonts-noto-cjk \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome path for Remotion
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV REMOTION_CHROME_EXECUTABLE=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source files
COPY . .

# Create videos output directory
RUN mkdir -p public/videos

EXPOSE 3333

CMD ["node", "server.js"]

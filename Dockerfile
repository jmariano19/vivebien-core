# ============================================================================
# ViveBien Core - Production Dockerfile
# ============================================================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# ============================================================================
# Stage 2: Production
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./

# Copy prompts if they exist
COPY --chown=nodejs:nodejs prompts ./prompts

# Copy public folder for dashboard
COPY --chown=nodejs:nodejs public ./public

# Set environment
ENV NODE_ENV=production
ENV PORT=3000

# Health check disabled - Easypanel handles service monitoring
HEALTHCHECK NONE

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Default command (API server)
CMD ["node", "dist/index.js"]

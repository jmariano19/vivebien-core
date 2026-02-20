"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processJob = processJob;
const logger_1 = require("../infra/logging/logger");
const inbound_1 = require("./handlers/inbound");
async function processJob(job) {
    const startTime = Date.now();
    const { correlationId, type } = job.data;
    const jobLogger = logger_1.logger.child({
        jobId: job.id,
        correlationId,
        type,
        attemptsMade: job.attemptsMade,
    });
    jobLogger.info('Processing job');
    try {
        let result;
        switch (type) {
            case 'inbound_message':
                result = await (0, inbound_1.handleInboundMessage)(job.data, jobLogger);
                break;
            // Future handlers
            // case 'process_media':
            //   result = await handleMediaProcessing(job.data, jobLogger);
            //   break;
            // case 'send_response':
            //   result = await handleSendResponse(job.data, jobLogger);
            //   break;
            default:
                throw new Error(`Unknown job type: ${type}`);
        }
        const duration = Date.now() - startTime;
        if (result.status === 'failed') {
            jobLogger.warn({ duration, result: result.status, error: result.error }, 'Job completed with error (fallback response sent to user)');
        }
        else {
            jobLogger.info({ duration, result: result.status }, 'Job processed successfully');
        }
        return result;
    }
    catch (error) {
        const duration = Date.now() - startTime;
        const err = error;
        jobLogger.error({
            duration,
            error: err.message,
            stack: err.stack,
        }, 'Job processing failed');
        // Determine if we should retry
        if (isRetryableError(err)) {
            throw error; // BullMQ will retry based on settings
        }
        // Non-retryable error - mark as failed permanently
        return {
            status: 'failed',
            error: err.message,
            correlationId,
        };
    }
}
function isRetryableError(error) {
    const message = error.message.toLowerCase();
    // Retry on transient errors
    if (message.includes('timeout') ||
        message.includes('econnreset') ||
        message.includes('econnrefused') ||
        message.includes('rate limit') ||
        message.includes('429') ||
        message.includes('503') ||
        message.includes('502')) {
        return true;
    }
    // Don't retry on validation or business logic errors
    if (message.includes('invalid') ||
        message.includes('not found') ||
        message.includes('unauthorized') ||
        message.includes('insufficient credits')) {
        return false;
    }
    // Default to retry for unknown errors
    return true;
}
//# sourceMappingURL=processor.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processCheckinJob = processCheckinJob;
const logger_1 = require("../infra/logging/logger");
const checkin_1 = require("./handlers/checkin");
/**
 * Process check-in jobs from the queue
 */
async function processCheckinJob(job) {
    const jobLogger = logger_1.logger.child({
        jobId: job.id,
        userId: job.data.userId,
        conversationId: job.data.conversationId,
    });
    jobLogger.info('Processing check-in job');
    try {
        const result = await (0, checkin_1.handleCheckinJob)(job.data, jobLogger);
        return result;
    }
    catch (err) {
        jobLogger.error({ err }, 'Check-in job processing failed');
        throw err;
    }
}
//# sourceMappingURL=checkin-processor.js.map
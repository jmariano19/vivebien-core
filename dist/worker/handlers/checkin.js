"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCheckinJob = handleCheckinJob;
exports.processCheckinResponse = processCheckinResponse;
const service_1 = require("../../domain/checkin/service");
const service_2 = require("../../domain/conversation/service");
const client_1 = require("../../infra/db/client");
const client_2 = require("../../infra/queue/client");
/**
 * Handle the 24-hour check-in job when it fires
 */
async function handleCheckinJob(data, logger) {
    const { userId, conversationId } = data;
    logger.info({ userId, conversationId }, 'Processing 24h check-in job');
    const checkinQueue = (0, client_2.getCheckinQueue)();
    const checkinService = new service_1.CheckinService(client_1.db, checkinQueue);
    try {
        const sent = await checkinService.executeCheckin(userId, conversationId);
        logger.info({ userId, sent }, 'Check-in job completed');
        return { sent };
    }
    catch (err) {
        logger.error({ userId, err }, 'Check-in job failed');
        throw err;
    }
}
/**
 * Process a check-in response from the user
 * Called from the main inbound handler when checkin_status = 'sent'
 */
async function processCheckinResponse(userId, userMessage, conversationId, logger) {
    const checkinQueue = (0, client_2.getCheckinQueue)();
    const checkinService = new service_1.CheckinService(client_1.db, checkinQueue);
    const conversationService = new service_2.ConversationService(client_1.db);
    const response = await checkinService.handleCheckinResponse(userId, userMessage);
    if (!response) {
        return { isCheckinResponse: false };
    }
    // Update the health summary with the follow-up entry
    try {
        const currentSummary = await conversationService.getHealthSummary(userId);
        if (currentSummary) {
            const updatedSummary = currentSummary + '\n\n---\n' + response.noteEntry;
            // Update the summary in the database
            await client_1.db.query(`UPDATE memories
         SET content = $1, created_at = NOW()
         WHERE user_id = $2 AND category = 'health_summary'`, [updatedSummary, userId]);
            logger.info({ userId }, 'Health summary updated with check-in follow-up');
        }
    }
    catch (err) {
        logger.error({ userId, err }, 'Failed to update health summary with check-in');
    }
    return {
        isCheckinResponse: true,
        acknowledgment: response.acknowledgment,
        noteEntry: response.noteEntry,
    };
}
//# sourceMappingURL=checkin.js.map
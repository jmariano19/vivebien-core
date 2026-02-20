"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testRoutes = void 0;
const client_1 = require("../../infra/db/client");
const auth_1 = require("../middleware/auth");
const service_1 = require("../../domain/user/service");
const service_2 = require("../../domain/conversation/service");
const service_3 = require("../../domain/ai/service");
const language_1 = require("../../shared/language");
const TEST_CONVERSATION_ID = 99999;
const testRoutes = async (app) => {
    app.addHook('preHandler', auth_1.authMiddleware);
    // POST /api/test/message — Run one message through the AI pipeline
    app.post('/message', async (request) => {
        const { phone, message } = request.body;
        const userService = new service_1.UserService(client_1.db);
        const conversationService = new service_2.ConversationService(client_1.db);
        const aiService = new service_3.AIService();
        // Load or create user
        const user = await userService.loadOrCreate(phone);
        // Detect and update language (mirrors inbound.ts Step 5)
        const detectedLang = (0, language_1.detectLanguage)(message);
        if (detectedLang && detectedLang !== user.language) {
            await userService.updateLanguage(user.id, detectedLang);
            user.language = detectedLang;
        }
        // Load context
        const context = await conversationService.loadContext(user.id, TEST_CONVERSATION_ID);
        // Build messages and call AI
        const messages = await conversationService.buildMessages(context, message);
        const aiResponse = await aiService.generateResponse(messages, context, user.id, 'test-' + Date.now());
        const cleanedResponse = aiService.postProcess(aiResponse.content);
        // Extract and save user name BEFORE saving messages (mirrors inbound.ts Step 9)
        // Must happen first so lastAssistantMessage is the name-ask, not the current response
        if (!user.name) {
            const recentMessages = await conversationService.getRecentMessages(user.id, 5);
            const extractedName = (0, language_1.extractUserName)(message, recentMessages);
            const finalName = extractedName || (0, language_1.extractNameFromAIResponse)(cleanedResponse);
            if (finalName) {
                await userService.updateName(user.id, finalName);
                user.name = finalName;
            }
        }
        // Save messages
        await conversationService.saveMessages(user.id, TEST_CONVERSATION_ID, [
            { role: 'user', content: message },
            { role: 'assistant', content: cleanedResponse },
        ]);
        // Update conversation state
        await conversationService.updateState(user.id, context);
        // Read current state
        const updatedUser = await userService.loadOrCreate(phone);
        return {
            success: true,
            aiResponse: cleanedResponse,
            user: { id: updatedUser.id, name: updatedUser.name, language: updatedUser.language },
            messageCount: context.messageCount + 1,
        };
    });
    // DELETE /api/test/user — Clean test user data
    app.delete('/user', async (request) => {
        const { phone } = request.body;
        const userResult = await client_1.db.query('SELECT id FROM users WHERE phone = $1', [phone]);
        const userId = userResult.rows[0]?.id;
        if (!userId)
            return { success: true, status: 'no_user' };
        const client = await client_1.db.connect();
        try {
            await client.query('BEGIN');
            for (const table of ['concern_snapshots', 'messages', 'health_concerns', 'memories', 'conversation_state', 'experiment_assignments', 'credit_transactions', 'billing_accounts']) {
                await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
            }
            await client.query('DELETE FROM users WHERE id = $1', [userId]);
            await client.query('COMMIT');
            return { success: true, status: 'deleted', userId };
        }
        catch (e) {
            await client.query('ROLLBACK');
            throw e;
        }
        finally {
            client.release();
        }
    });
};
exports.testRoutes = testRoutes;
//# sourceMappingURL=test.js.map
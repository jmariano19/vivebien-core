import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { db } from '../../infra/db/client';
import { authMiddleware } from '../middleware/auth';
import { UserService } from '../../domain/user/service';
import { ConversationService } from '../../domain/conversation/service';
import { AIService } from '../../domain/ai/service';
import { ConcernService } from '../../domain/concern/service';

const TEST_CONVERSATION_ID = 99999;

export const testRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', authMiddleware);

  // POST /api/test/message — Run one message through the AI pipeline
  app.post('/message', async (request) => {
    const { phone, message } = request.body as { phone: string; message: string };

    const userService = new UserService(db);
    const conversationService = new ConversationService(db);
    const aiService = new AIService();
    const concernService = new ConcernService(db);

    // Load or create user
    const user = await userService.loadOrCreate(phone);

    // Load context
    const context = await conversationService.loadContext(user.id, TEST_CONVERSATION_ID);

    // Build messages and call AI
    const messages = await conversationService.buildMessages(context, message);
    const aiResponse = await aiService.generateResponse(messages, context, user.id, 'test-' + Date.now());
    const cleanedResponse = aiService.postProcess(aiResponse.content);

    // Save messages
    await conversationService.saveMessages(user.id, TEST_CONVERSATION_ID, [
      { role: 'user', content: message },
      { role: 'assistant', content: cleanedResponse },
    ]);

    // Update conversation state
    await conversationService.updateState(user.id, context);

    // Update health summary after enough messages
    if (context.messageCount >= 2) {
      await conversationService.updateHealthSummary(user.id, message, cleanedResponse, aiService);
    }

    // Read current state
    const updatedUser = await userService.loadOrCreate(phone);
    const concerns = await concernService.getActiveConcerns(user.id);

    return {
      success: true,
      aiResponse: cleanedResponse,
      user: { id: updatedUser.id, name: updatedUser.name, language: updatedUser.language },
      messageCount: context.messageCount + 1,
      concerns: concerns.map(c => ({
        title: c.title,
        status: c.status,
        summaryContent: c.summaryContent,
      })),
    };
  });

  // DELETE /api/test/user — Clean test user data (cascades via FK)
  app.delete('/user', async (request) => {
    const { phone } = request.body as { phone: string };

    const result = await db.query('DELETE FROM users WHERE phone = $1 RETURNING id', [phone]);

    if (result.rowCount === 0) {
      return { success: true, status: 'no_user' };
    }

    return { success: true, status: 'deleted', userId: result.rows[0].id };
  });
};

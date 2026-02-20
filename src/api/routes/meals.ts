import { FastifyInstance } from 'fastify';
import { MealService } from '../../domain/meal/service';
import { db } from '../../infra/db/client';

const mealService = new MealService(db);

export async function mealRoutes(app: FastifyInstance) {
  // GET /api/meals/:userId - Get meals for a user
  // Optional query params: date (YYYY-MM-DD), start, end
  app.get('/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { date, start, end } = request.query as {
      date?: string;
      start?: string;
      end?: string;
    };

    try {
      let meals;

      if (date) {
        // Single day query
        meals = await mealService.getMealEventsForDay(userId, new Date(date));
      } else if (start && end) {
        // Date range query
        meals = await mealService.getMealEvents(userId, new Date(start), new Date(end));
      } else {
        // Default: last 7 days
        meals = await mealService.getRecentMeals(userId, 7);
      }

      return reply.send({
        success: true,
        userId,
        count: meals.length,
        meals,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // GET /api/meals/:userId/today - Get today's meals
  app.get('/:userId/today', async (request, reply) => {
    const { userId } = request.params as { userId: string };

    try {
      const meals = await mealService.getMealEventsForDay(userId, new Date());
      const count = meals.length;

      return reply.send({
        success: true,
        userId,
        date: new Date().toISOString().split('T')[0],
        count,
        meals,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });

  // GET /api/meals/:userId/stats - Meal statistics
  app.get('/:userId/stats', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { days } = request.query as { days?: string };

    const lookbackDays = parseInt(days || '7', 10);

    try {
      const meals = await mealService.getRecentMeals(userId, lookbackDays);

      // Calculate stats
      const totalMeals = meals.length;
      const mealsPerDay = totalMeals / lookbackDays;
      const mealTypes: Record<string, number> = {};
      const daysWithMeals = new Set(
        meals.map(m => m.createdAt.toISOString().split('T')[0])
      ).size;

      for (const meal of meals) {
        const type = meal.mealType || 'unknown';
        mealTypes[type] = (mealTypes[type] || 0) + 1;
      }

      return reply.send({
        success: true,
        userId,
        period: `${lookbackDays} days`,
        stats: {
          totalMeals,
          mealsPerDay: Math.round(mealsPerDay * 10) / 10,
          daysWithMeals,
          daysWithoutMeals: lookbackDays - daysWithMeals,
          mealTypes,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return reply.status(500).send({ success: false, error: err.message });
    }
  });
}

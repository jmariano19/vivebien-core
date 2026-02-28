import { db } from '../../../infra/db/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoogleFitData {
  sleepHours: number | null;
  steps: number | null;
  restingHeartRate: number | null;
  activeMinutes: number | null;
  caloriesBurned: number | null;
  rawSummary: string;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'https://carelog.vivebien.io/api/integrations/googlefit/callback';

const SCOPES = [
  'https://www.googleapis.com/auth/fitness.sleep.read',
  'https://www.googleapis.com/auth/fitness.heart_rate.read',
  'https://www.googleapis.com/auth/fitness.activity.read',
].join(' ');

// ─── Google Fit Service ───────────────────────────────────────────────────────

export class GoogleFitService {

  // ── OAuth ──────────────────────────────────────────────────────────────────

  getAuthUrl(userId: string): string {
    const params = new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      redirect_uri:  GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope:         SCOPES,
      access_type:   'offline',
      prompt:        'consent',
      state:         userId,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async handleCallback(code: string, userId: string): Promise<void> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google token exchange failed: ${err}`);
    }

    const tokens = await res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    await this.storeTokens(userId, {
      accessToken:  tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt:    new Date(Date.now() + tokens.expires_in * 1000),
    });
  }

  async isConnected(userId: string): Promise<boolean> {
    const result = await db.query(
      'SELECT id FROM google_fit_tokens WHERE user_id = $1',
      [userId]
    );
    return result.rows.length > 0;
  }

  async disconnect(userId: string): Promise<void> {
    await db.query('DELETE FROM google_fit_tokens WHERE user_id = $1', [userId]);
  }

  // ── Data Fetching ──────────────────────────────────────────────────────────

  async fetchTodayData(userId: string): Promise<GoogleFitData | null> {
    const tokens = await this.getValidTokens(userId);
    if (!tokens) return null;

    const now   = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    const endMs   = now.getTime();

    const [sleepResult, stepsResult, hrResult, activityResult] = await Promise.allSettled([
      this.fetchSleepHours(tokens.accessToken, startMs, endMs),
      this.fetchSteps(tokens.accessToken, startMs, endMs),
      this.fetchRestingHR(tokens.accessToken, startMs, endMs),
      this.fetchActivity(tokens.accessToken, startMs, endMs),
    ]);

    const sleepHours       = sleepResult.status    === 'fulfilled' ? sleepResult.value    : null;
    const steps            = stepsResult.status    === 'fulfilled' ? stepsResult.value    : null;
    const restingHeartRate = hrResult.status       === 'fulfilled' ? hrResult.value       : null;
    const activity         = activityResult.status === 'fulfilled' ? activityResult.value : null;

    const parts: string[] = ['[Google Fit]'];
    if (sleepHours)              parts.push(`Sleep: ${sleepHours}h`);
    if (steps)                   parts.push(`Steps: ${steps.toLocaleString()}`);
    if (restingHeartRate)        parts.push(`Resting HR: ${restingHeartRate} bpm`);
    if (activity?.activeMinutes) parts.push(`Active: ${activity.activeMinutes} min`);
    if (activity?.calories)      parts.push(`Calories: ${activity.calories} kcal`);

    return {
      sleepHours,
      steps,
      restingHeartRate,
      activeMinutes:  activity?.activeMinutes ?? null,
      caloriesBurned: activity?.calories      ?? null,
      rawSummary:     parts.length > 1 ? parts.join(' | ') : '',
    };
  }

  // ── Private: Data Fetchers ─────────────────────────────────────────────────

  private async fetchSleepHours(accessToken: string, startMs: number, endMs: number): Promise<number | null> {
    const res = await googleFitPost(accessToken, '/dataset:aggregate', {
      aggregateBy: [{ dataTypeName: 'com.google.sleep.segment' }],
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    });

    let totalMs = 0;
    for (const bucket of res.bucket ?? []) {
      for (const dataset of bucket.dataset ?? []) {
        for (const point of dataset.point ?? []) {
          const type = point.value?.[0]?.intVal;
          if (type >= 1 && type <= 5) {
            totalMs += Number(point.endTimeNanos) / 1e6 - Number(point.startTimeNanos) / 1e6;
          }
        }
      }
    }

    const hours = Math.round((totalMs / 3_600_000) * 10) / 10;
    return hours > 0 ? hours : null;
  }

  private async fetchSteps(accessToken: string, startMs: number, endMs: number): Promise<number | null> {
    const res = await googleFitPost(accessToken, '/dataset:aggregate', {
      aggregateBy: [{ dataTypeName: 'com.google.step_count.delta' }],
      bucketByTime: { durationMillis: endMs - startMs },
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    });
    return res.bucket?.[0]?.dataset?.[0]?.point?.[0]?.value?.[0]?.intVal ?? null;
  }

  private async fetchRestingHR(accessToken: string, startMs: number, endMs: number): Promise<number | null> {
    const res = await googleFitPost(accessToken, '/dataset:aggregate', {
      aggregateBy: [{ dataTypeName: 'com.google.heart_rate.bpm' }],
      bucketByTime: { durationMillis: endMs - startMs },
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    });
    const val = res.bucket?.[0]?.dataset?.[0]?.point?.[0]?.value?.[0]?.fpVal;
    return val ? Math.round(val) : null;
  }

  private async fetchActivity(accessToken: string, startMs: number, endMs: number): Promise<{ activeMinutes: number | null; calories: number | null }> {
    const res = await googleFitPost(accessToken, '/dataset:aggregate', {
      aggregateBy: [
        { dataTypeName: 'com.google.active_minutes' },
        { dataTypeName: 'com.google.calories.expended' },
      ],
      bucketByTime: { durationMillis: endMs - startMs },
      startTimeMillis: startMs,
      endTimeMillis: endMs,
    });

    let activeMinutes: number | null = null;
    let calories: number | null      = null;

    for (const ds of res.bucket?.[0]?.dataset ?? []) {
      const val = ds.point?.[0]?.value?.[0];
      if (ds.dataSourceId?.includes('active_minutes') && val?.intVal != null) {
        activeMinutes = val.intVal as number;
      }
      if (ds.dataSourceId?.includes('calories') && val?.fpVal != null) {
        calories = Math.round(val.fpVal as number);
      }
    }

    return { activeMinutes, calories };
  }

  // ── Token Management ───────────────────────────────────────────────────────

  private async getValidTokens(userId: string): Promise<StoredTokens | null> {
    const result = await db.query<{
      access_token: string;
      refresh_token: string;
      expires_at: Date;
    }>(
      'SELECT access_token, refresh_token, expires_at FROM google_fit_tokens WHERE user_id = $1',
      [userId]
    );

    if (!result.rows.length) return null;

    const row    = result.rows[0]!;
    const tokens: StoredTokens = {
      accessToken:  row.access_token,
      refreshToken: row.refresh_token,
      expiresAt:    row.expires_at,
    };

    // Refresh if expiring within 5 minutes
    if (new Date() >= new Date(tokens.expiresAt.getTime() - 5 * 60_000)) {
      return this.refreshTokens(userId, tokens.refreshToken);
    }

    return tokens;
  }

  private async refreshTokens(userId: string, refreshToken: string): Promise<StoredTokens | null> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type:    'refresh_token',
      }),
    });

    if (!res.ok) {
      await this.disconnect(userId);
      return null;
    }

    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const tokens: StoredTokens = {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt:    new Date(Date.now() + data.expires_in * 1000),
    };

    await this.storeTokens(userId, tokens);
    return tokens;
  }

  private async storeTokens(userId: string, tokens: StoredTokens): Promise<void> {
    await db.query(
      `INSERT INTO google_fit_tokens (user_id, access_token, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = NOW()`,
      [userId, tokens.accessToken, tokens.refreshToken, tokens.expiresAt]
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function googleFitPost(accessToken: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://www.googleapis.com/fitness/v1/users/me${path}`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Google Fit API ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

export const googleFitService = new GoogleFitService();

export interface GoogleFitData {
    sleepHours: number | null;
    steps: number | null;
    restingHeartRate: number | null;
    activeMinutes: number | null;
    caloriesBurned: number | null;
    rawSummary: string;
}
export declare class GoogleFitService {
    getAuthUrl(userId: string): string;
    handleCallback(code: string, userId: string): Promise<void>;
    isConnected(userId: string): Promise<boolean>;
    disconnect(userId: string): Promise<void>;
    fetchTodayData(userId: string): Promise<GoogleFitData | null>;
    private fetchSleepHours;
    private fetchSteps;
    private fetchRestingHR;
    private fetchActivity;
    private getValidTokens;
    private refreshTokens;
    private storeTokens;
}
export declare const googleFitService: GoogleFitService;
//# sourceMappingURL=service.d.ts.map
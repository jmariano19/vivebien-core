import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { InboundJobData } from '../../shared/types';
export declare const redis: Redis;
export declare const inboundQueue: Queue<InboundJobData, any, string, InboundJobData, any, string>;
export declare function getCheckinQueue(): Queue;
export declare const queueEvents: QueueEvents;
export declare function addInboundJob(data: InboundJobData): Promise<string>;
export declare function getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: boolean;
}>;
export declare function checkRedisHealth(): Promise<{
    healthy: boolean;
    latencyMs: number;
}>;
export declare function closeRedis(): Promise<void>;
//# sourceMappingURL=client.d.ts.map
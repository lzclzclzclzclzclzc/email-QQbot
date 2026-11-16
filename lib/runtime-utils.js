import { createHash, timingSafeEqual } from 'node:crypto';
export function constantTimeEqual(a, b) {
    const digest = (s) => createHash('sha256').update(s).digest();
    return timingSafeEqual(digest(a), digest(b));
}
export function nowShanghaiDay(now) {
    return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

import { z } from 'zod';
import type { Measurement } from '../telemetry/measurement.js';
import type { ReadOperation } from '../compiler/ir.js';

export const benchmarkRequestSchema = z
  .object({
    prompt: z.string().trim().min(5).max(2000),
    customerId: z.enum(['C-101', 'C-202', 'C-303']),
    scope: z.enum(['agent_decides', 'complete', 'orders', 'eligibility', 'refunds', 'policy']),
    execution: z.enum(['preview', 'live']),
    repeats: z.number().int().min(1).max(3),
  })
  .strict();
export type BenchmarkRequest = z.infer<typeof benchmarkRequestSchema>;
export type BenchmarkArm = {
  arm: 'normal' | 'foundry';
  mode: string;
  reason: string;
  measurement: Measurement;
  estimatedCostUsd: number | null;
  response: {
    customerId: string;
    eligible: boolean | null;
    orders: { id: string; daysLate: number }[] | null;
    refunds: { id: string; amount: number }[] | null;
    selectedOrderId: string | null;
    reply: string;
    action: string;
  } | null;
  checks: Record<string, boolean>;
  verification: 'contract' | 'facts_only';
  reads: { operation: ReadOperation; status: 'success' | 'failed'; durationMs: number }[];
  selectorMs: number;
  fallback: boolean;
  failure: string | null;
};
export type BenchmarkPair = {
  order: ('normal' | 'foundry')[];
  normal: BenchmarkArm;
  foundry: BenchmarkArm;
  equivalence: 'match' | 'mismatch' | 'unavailable';
};
export type BenchmarkRun = {
  id: string;
  createdAt: string;
  request: BenchmarkRequest;
  provider: string;
  model: string;
  setup: { durationMs: number; modelCalls: number; costUsd: number; checks: number };
  pricing: {
    model: string;
    applicable: boolean;
    checkedAt: string;
    source: string;
    inputPerMillionUsd: number;
    cachedInputPerMillionUsd: number;
    outputPerMillionUsd: number;
  };
  pairs: BenchmarkPair[];
};
export type RetainedSummary = {
  requests: number;
  mean: Pick<
    Measurement,
    | 'inputTokens'
    | 'outputTokens'
    | 'cachedInputTokens'
    | 'totalTokens'
    | 'modelCalls'
    | 'toolCalls'
    | 'durationMs'
  >;
  latency: { p50: number; p95: number };
  apiEquivalentCostUsd: number | null;
  correctnessRate: number;
  successRate: number;
  fallbackRate: number;
};
export type BenchmarkEvidence = {
  capturedAt: string;
  requests: number;
  cases: number;
  repeats: number;
  arms: Record<string, RetainedSummary>;
};
export type BenchmarkConfig = {
  liveEnabled: boolean;
  provider: string;
  model: string;
  scenarios: { scope: BenchmarkRequest['scope']; label: string; prompt: string }[];
};

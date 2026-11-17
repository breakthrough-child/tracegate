import { createSupportAgent, type Variant } from './agent.js';

/** CLI entry: `tracegate run --agent examples/support-agent/dist/entry.js`. Configure with env vars. */
const variant = (process.env.SUPPORT_VARIANT ?? 'good') as Variant;
const noise = Number(process.env.SUPPORT_NOISE ?? 0.03);
const degrade = Number(process.env.SUPPORT_DEGRADE ?? 0.25);

export const meta = { agent: 'support-agent', model: 'mock-large', prompt_version: variant, simulated: true };
const seedBase = Number(process.env.SUPPORT_SEED ?? 0);
export default createSupportAgent({ variant, noise, degrade, seedBase });

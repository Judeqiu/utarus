/**
 * Demo plan catalog — intentionally small free caps so the paywall is easy to hit.
 *
 * Replace pro.stripe_price_id with your Stripe Price id (Dashboard → Products).
 * Leave STRIPE_PRICE_ID env override for local experimentation without editing code.
 */

import type { PlansCatalogInput } from 'utarus';

const proPriceId = (process.env.STRIPE_PRICE_ID || '').trim() || 'price_REPLACE_ME';

export const DEMO_PLANS: PlansCatalogInput = {
  version: 1,
  past_due_policy: 'retain_until_period_end',
  trial_period_days: 7,
  default_paid_plan_id: 'pro',
  plans: {
    free: {
      display_name: 'Free',
      stripe_price_id: null,
      caps: {
        // ~a few short turns — designed so you can hit the paywall quickly
        llm_total_tokens: 5_000,
        tools: {
          firecrawl: 2,
          post_html_report: 1,
          hello: 5,
        },
      },
      features: [],
    },
    pro: {
      display_name: 'Pro',
      stripe_price_id: proPriceId,
      caps: {
        llm_total_tokens: 500_000,
        tools: {
          firecrawl: 100,
          post_html_report: 50,
          hello: 10_000,
        },
      },
      features: ['pro_tools', 'html_reports'],
    },
  },
};

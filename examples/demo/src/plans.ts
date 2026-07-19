/**
 * Demo plan catalog — two-phase trial:
 * - 7-day intro (no card, lower caps) from account create
 * - After intro: free = no use until Upgrade
 * - Checkout Pro: 30-day Stripe trial (card) at full Pro caps, then charge
 */

import type { PlansCatalogInput } from 'utarus';

const proPriceId = (process.env.STRIPE_PRICE_ID || '').trim() || 'price_REPLACE_ME';

export const DEMO_PLANS: PlansCatalogInput = {
  version: 1,
  past_due_policy: 'retain_until_period_end',
  trial_period_days: 30,
  intro_trial_days: 7,
  intro_caps: {
    llm_total_tokens: 50_000,
    tools: {
      firecrawl: 10,
      post_html_report: 5,
      hello: 50,
    },
  },
  default_paid_plan_id: 'pro',
  plans: {
    free: {
      display_name: 'Free',
      stripe_price_id: null,
      caps: {
        llm_total_tokens: 0,
        tools: {
          firecrawl: 0,
          post_html_report: 0,
          hello: 0,
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

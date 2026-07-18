/**
 * Billing subsystem — plan catalog, per-user billing YAML, entitlements.
 * Stripe Checkout/webhooks land in a later PR; this module is usable with
 * flag off (no-op) or flag on for entitlement reads + admin/comp file writes.
 */

export type {
  BillingState,
  BillingStatus,
  CapKind,
  DomainBillingConfig,
  Entitlement,
  EntitlementSource,
  PastDuePolicy,
  PaywallBlock,
  PaywallChannel,
  PlanCaps,
  PlanDefinition,
  PlansCatalog,
  PlansCatalogInput,
} from './types.js';
export { TRIAL_PERIOD_DAYS } from './types.js';

export {
  assertPlansCatalog,
  freePlanId,
  getBillingExtension,
  getPlan,
  loadPlansCatalog,
  plansFilePath,
  resetPlansCacheForTests,
  setBillingExtension,
} from './plans.js';

export {
  assertBillingStateCoherent,
  billingDir,
  billingFilePath,
  billingStatusIs,
  loadBillingState,
  saveBillingState,
  withBillingLock,
} from './billing-file.js';

export {
  entitlementFromBillingState,
  getEffectiveCap,
  getEntitlement,
  hasFeature,
} from './entitlements.js';

export {
  assertBillingConfig,
  assertCapsYamlCompatibleWithBilling,
  isBillingEnabled,
} from './validate.js';

export {
  billingStateErrorMessage,
  buildUpgradeUrl,
  formatPaywallMessage,
  publicBillingBaseUrl,
} from './messages.js';

export { checkLlmCap, checkTurnAllowed } from './gate.js';

export {
  getStripe,
  getStripePublishableKey,
  getStripeSecretKey,
  getStripeWebhookSecret,
  setStripeClientForTests,
} from './stripe-client.js';

export {
  BillingHttpError,
  createCheckoutSessionUrl,
  createPortalSessionUrl,
  isCheckoutBlocked,
} from './checkout.js';

export {
  applyStripeEvent,
  applySubscriptionToBilling,
  billingWebhookHandler,
  findSlugByCustomerId,
  resolveSlugFromStripe,
} from './webhooks.js';

export {
  eventAlreadyProcessed,
  markEventProcessed,
  readEventReceipt,
  billingEventsDir,
} from './events.js';

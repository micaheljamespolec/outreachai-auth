// ─── config.js ────────────────────────────────────────────────────────────────
export const CONFIG = {
  supabaseUrl: 'https://jjqpfltgrpzbaedbatli.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqcXBmbHRncnB6YmFlZGJhdGxpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY5NjI3MzAsImV4cCI6MjA5MjUzODczMH0.W2459vCxtWF_4ATyO3dT41_r_iDWUn8mKYHMCZsjwrA',

  fullenrichUrl: 'https://app.fullenrich.com/api/v1',

  appName:    'SourcedOut',
  version:    '1.1.0',
  pricingUrl: 'https://jjqpfltgrpzbaedbatli.supabase.co/functions/v1/create-checkout',

  stripe: {
    sourcer: {
      monthly: 'price_1T3k99HBH8to4gGBHlNU3ewA',
      yearly:  'price_1T3kAOHBH8to4gGBQvWk4fiF',
    },
    pro: {
      monthly: 'price_1T3kIDHBH8to4gGBnW3QoNBz',
      yearly:  'price_1T3kIvHBH8to4gGBV7WWfsD4',
    },
  },

  tiers: {
    free:    { lookups: 10,  ai_runs: 20,  emails: 10,   label: 'Free'    },
    sourcer: { lookups: 50,  ai_runs: 200, emails: 100,  label: 'Sourcer' },
    pro:     { lookups: 200, ai_runs: 999, emails: 9999, label: 'Pro'     },
  },

  bonusActivities: {
    verifyEmail:        3,
    generateFirstDraft: 5,
    rateExtension:      10,
  },

  features: {
    phoneNumberLookup: false,
    bulkExport:        false,
    crmIntegration:    false,
    teamAccounts:      false,
    emailSequences:    false,
  },
}

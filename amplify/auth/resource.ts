import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito user pool: email + password, invitation-only like Odoo (self
 * sign-up is switched off in backend.ts). Stays in Cognito's free tier
 * (10,000 monthly active users) at this scale.
 */
export const auth = defineAuth({
  loginWith: {
    email: {
      verificationEmailSubject: 'Rodeo ERP — verify your email',
      verificationEmailStyle: 'CODE',
    },
  },
  accountRecovery: 'EMAIL_ONLY',
});

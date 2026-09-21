import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito user pool: email + password, invitation-only like Odoo (self
 * sign-up is switched off in backend.ts). Stays in Cognito's free tier
 * (10,000 monthly active users) at this scale.
 *
 * Two Cognito emails carry the Almirsal name: the invitation (sent by
 * "Settings › Users" through AdminCreateUser, with the temporary password)
 * and the verification code (used by "Reset Password" on the login page).
 */
export const auth = defineAuth({
  loginWith: {
    email: {
      verificationEmailSubject: 'Almirsal — your password reset code',
      verificationEmailStyle: 'CODE',
      verificationEmailBody: (createCode: () => string) =>
        `Hello,\n\nUse this code to reset your Almirsal password: ${createCode()}\n\nIf you did not ask for a reset, you can ignore this email.\n\n— Almirsal`,
      userInvitation: {
        emailSubject: 'Almirsal — your account is ready',
        emailBody: (createUsername: () => string, createCode: () => string) =>
          `Hello,\n\nAn Almirsal account has been created for you.\n\nLogin: ${createUsername()}\nTemporary password: ${createCode()}\n\nSign in with it; you will be asked to choose your own password on the first login.\n\n— Almirsal`,
      },
    },
  },
  accountRecovery: 'EMAIL_ONLY',
});

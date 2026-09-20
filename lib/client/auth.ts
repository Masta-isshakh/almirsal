'use client';

/**
 * Log out from everywhere: the server clears its cookies, the browser
 * clears the Cognito token cookies the Amplify client wrote (they are not
 * HttpOnly, so the server-side clear alone is not enough on some browsers),
 * then the login page is loaded fresh.
 */
export async function logout(): Promise<void> {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* still clear locally */ }
  try {
    for (const part of document.cookie.split(';')) {
      const name = part.trim().split('=')[0];
      if (!name) continue;
      if (name.startsWith('CognitoIdentityServiceProvider.') || name.startsWith('amplify-') || name === 'rodeo_session') {
        for (const path of ['/', '/odoo', '/web']) document.cookie = `${name}=; path=${path}; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
      }
    }
    sessionStorage.clear();
  } catch { /* ignore */ }
  window.location.replace('/web/login?logout=1');
}

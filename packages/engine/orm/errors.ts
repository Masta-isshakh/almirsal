import type { I18n } from '../i18n/types.js';

/**
 * Odoo's error taxonomy. The client maps each `kind` to the dialog title the
 * spec requires ("Validation Error" / "Access Error" / "User Error") and shows
 * `message` — bilingual — as the body.
 */
export type OrmErrorKind =
  | 'user_error'
  | 'validation_error'
  | 'access_error'
  | 'access_denied'
  | 'missing_error'
  | 'redirect_warning';

export const ERROR_TITLES: Record<OrmErrorKind, I18n> = {
  user_error: { en: 'User Error', ar: 'خطأ المستخدم' },
  validation_error: { en: 'Validation Error', ar: 'خطأ في التحقق' },
  access_error: { en: 'Access Error', ar: 'خطأ في الوصول' },
  access_denied: { en: 'Access Denied', ar: 'تم رفض الوصول' },
  missing_error: { en: 'Missing Record', ar: 'سجل مفقود' },
  redirect_warning: { en: 'Warning', ar: 'تحذير' },
};

export class OrmError extends Error {
  readonly kind: OrmErrorKind;
  readonly i18n: I18n;
  /** Extra payload (e.g. the redirect action for a RedirectWarning). */
  readonly data?: unknown;

  constructor(kind: OrmErrorKind, message: I18n | string, data?: unknown) {
    const text = typeof message === 'string' ? { en: message, ar: message } : message;
    super(text.en);
    this.name = 'OrmError';
    this.kind = kind;
    this.i18n = text;
    this.data = data;
  }

  get title(): I18n {
    return ERROR_TITLES[this.kind];
  }

  /** Wire form for the RPC layer (not `toJSON`: test runners would hide the message). */
  serialize() {
    return { kind: this.kind, title: this.title, message: this.i18n, data: this.data };
  }
}

export class UserError extends OrmError {
  constructor(message: I18n | string, data?: unknown) { super('user_error', message, data); }
}

export class ValidationError extends OrmError {
  constructor(message: I18n | string, data?: unknown) { super('validation_error', message, data); }
}

export class AccessError extends OrmError {
  constructor(message: I18n | string, data?: unknown) { super('access_error', message, data); }
}

export class MissingError extends OrmError {
  constructor(message: I18n | string, data?: unknown) { super('missing_error', message, data); }
}

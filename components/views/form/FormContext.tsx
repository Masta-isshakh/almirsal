'use client';

import { createContext, useContext } from 'react';

/**
 * What a field widget needs to know about the record around it. A field is
 * given its value and nothing else, but a few of Odoo's widgets act on the
 * record itself — the payment widget applies an outstanding credit to the
 * invoice it is drawn on — and then have to read the record back.
 */
export interface FormRecord {
  model: string;
  recordId: number | null;
  reload: () => void;
}

const FormRecordContext = createContext<FormRecord | null>(null);

export const FormRecordProvider = FormRecordContext.Provider;

/** The record the form shows, or null outside a form (a list cell). */
export function useFormRecord(): FormRecord | null {
  return useContext(FormRecordContext);
}

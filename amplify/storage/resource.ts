import { defineStorage } from '@aws-amplify/backend';

/**
 * One bucket for everything binary (A-1 Files): attachments, avatars,
 * generated PDFs, document files, signed PDFs, spreadsheets. Keys follow
 * `attachments/{model}/{id}/{uuid}`. S3 standard storage is cents per GB;
 * lifecycle rules can move old report PDFs to Infrequent Access later.
 */
export const storage = defineStorage({
  name: 'rodeo-files',
  access: (allow) => ({
    'attachments/*': [allow.authenticated.to(['read', 'write', 'delete'])],
    'avatars/*': [allow.authenticated.to(['read', 'write', 'delete'])],
    'reports/*': [allow.authenticated.to(['read', 'write', 'delete'])],
    'documents/*': [allow.authenticated.to(['read', 'write', 'delete'])],
    'sign/*': [allow.authenticated.to(['read', 'write', 'delete'])],
    'spreadsheets/*': [allow.authenticated.to(['read', 'write', 'delete'])],
    'public/*': [allow.guest.to(['read']), allow.authenticated.to(['read', 'write', 'delete'])],
  }),
});

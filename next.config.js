/** @type {import('next').NextConfig} */
const nextConfig = {
  // The ORM and PGlite run in Node route handlers; keep them out of the bundler.
  serverExternalPackages: ['@electric-sql/pglite', 'pg', '@aws-sdk/client-rds-data'],
  // Route handlers read the export at runtime; ship it with the server output.
  outputFileTracingIncludes: { '/**': ['./registry/**', './messages/**', './amplify_outputs.json'] },
  webpack: (config) => {
    // packages/engine uses ESM-style `./x.js` specifiers for `.ts` sources.
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
};

module.exports = nextConfig;

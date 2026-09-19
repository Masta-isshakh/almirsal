import { defineBackend } from '@aws-amplify/backend';
import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { auth } from './auth/resource.js';
import { storage } from './storage/resource.js';
import { AuroraDatabase } from './database/aurora.js';

/**
 * Backend wiring, sized for the lowest possible AWS bill (see docs/COST.md):
 *
 *  - Cognito (free tier)             → auth
 *  - S3 (cents)                      → storage
 *  - Aurora Serverless v2, 0–2 ACU,  → database, reached through the Data API
 *    auto-pause, Data API              so nothing runs inside a VPC
 *  - Amplify Hosting SSR compute     → runs Next.js route handlers that host
 *                                      the ORM; there is no AppSync and no
 *                                      separate RPC Lambda to pay for
 *
 * The Hosting compute role must be allowed to call the Data API and read the
 * DB secret; the policy is emitted as an output so it can be attached to the
 * app's service role (Amplify console → App settings → IAM roles).
 */
const backend = defineBackend({ auth, storage });

// Invitation-only, like Odoo: users are created from Settings › Users.
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = { allowAdminCreateUserOnly: true };
cfnUserPool.userPoolAddOns = { advancedSecurityMode: 'OFF' };

const dbStack = backend.createStack('database');
const branch = process.env.AWS_BRANCH ?? 'sandbox';
const database = new AuroraDatabase(dbStack, 'Aurora', { production: branch === 'main' });

/** Managed policy granting Data API + secret access; attach to the SSR compute role. */
// Names are left to CloudFormation: a nested stack's name is ~80 characters,
// which would push a hand-built IAM role name past the 64-character limit.
const dataApiPolicy = new iam.ManagedPolicy(dbStack, 'DataApiAccess', {
  description: 'Rodeo ERP: Aurora Data API and DB secret access for the Amplify Hosting compute role',
  statements: [
    new iam.PolicyStatement({
      actions: [
        'rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement',
        'rds-data:BeginTransaction', 'rds-data:CommitTransaction', 'rds-data:RollbackTransaction',
      ],
      resources: [database.cluster.clusterArn],
    }),
    new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [database.cluster.secret!.secretArn],
    }),
  ],
});

/**
 * The role Amplify Hosting's SSR compute assumes. Select it once in the
 * console (App settings → IAM roles → Compute role; its name starts with
 * "amplify-…-ComputeRole"); everything else is automatic because the app
 * reads the cluster details from amplify_outputs.
 */
const computeRole = new iam.Role(dbStack, 'ComputeRole', {
  description: 'Rodeo ERP: assumed by Amplify Hosting SSR compute (select it under App settings > IAM roles)',
  assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
  managedPolicies: [dataApiPolicy],
});

backend.addOutput({
  custom: {
    database: {
      clusterArn: database.cluster.clusterArn,
      secretArn: database.cluster.secret!.secretArn,
      databaseName: database.databaseName,
      region: Stack.of(dbStack).region,
      dataApiPolicyArn: dataApiPolicy.managedPolicyArn,
      computeRoleArn: computeRole.roleArn,
    },
  },
});

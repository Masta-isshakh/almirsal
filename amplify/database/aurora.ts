import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

/**
 * Aurora PostgreSQL Serverless v2 configured for the lowest possible bill:
 *
 *  - min capacity 0 ACU: the cluster auto-pauses after the idle timeout and
 *    costs only storage (~$0.10/GB-month) while nobody uses it. The first
 *    request after a pause takes ~15 s to resume.
 *  - max capacity 2 ACU: enough for this workload; raise later if needed.
 *  - the Data API is enabled so application code talks HTTPS+IAM to the
 *    cluster. That is what lets the app run outside a VPC — no NAT Gateway
 *    (~$32/month), no RDS Proxy (~$11/month), no VPC-attached cold starts.
 *  - isolated subnets only (a VPC with no NAT and no internet gateway is
 *    free); nothing needs to reach the cluster over TCP.
 *  - one-day backups, no deletion protection for non-production stacks.
 */
export interface AuroraProps {
  /** `true` for the production branch: 7-day backups, deletion protection. */
  production?: boolean;
}

export class AuroraDatabase extends Construct {
  readonly cluster: rds.DatabaseCluster;
  readonly databaseName = 'rodeo';

  constructor(scope: Construct, id: string, props: AuroraProps = {}) {
    super(scope, id);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      // Minor versions get retired region by region (16.6 no longer exists in
      // ap-south-1 / eu-west-1); 16.13 is offered in every region we use and
      // supports scale-to-zero (>= 16.3). Instances auto-upgrade minors.
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_13 }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      writer: rds.ClusterInstance.serverlessV2('writer', { publiclyAccessible: false }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      // Pause after 10 idle minutes (the default is 5; a little slack avoids
      // resume latency between a user's page loads).
      serverlessV2AutoPauseDuration: Duration.minutes(10),
      enableDataApi: true,
      defaultDatabaseName: this.databaseName,
      credentials: rds.Credentials.fromGeneratedSecret('rodeo'),
      backup: { retention: Duration.days(props.production ? 7 : 1) },
      deletionProtection: props.production ?? false,
      removalPolicy: props.production ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      storageEncrypted: true,
      cloudwatchLogsRetention: undefined,
    });
  }
}

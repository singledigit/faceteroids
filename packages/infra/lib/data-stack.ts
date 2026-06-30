// Persistent data: the single DynamoDB table and the S3 bucket that holds MicroVM
// image build artifacts (the zipped Dockerfile + bundled server).

import { Stack, type StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { TABLE_NAME } from './config.js';

export class DataStack extends Stack {
  readonly table: Table;
  readonly artifactBucket: Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Single-table design. PK/SK strings; TTL on `expiresAt` auto-reaps rooms.
    this.table = new Table(this, 'GameTable', {
      tableName: TABLE_NAME,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.DESTROY, // sample project; users are CLI-recreated
    });

    // Artifact bucket for image builds. Lifecycle-expire old zips to control cost.
    this.artifactBucket = new Bucket(this, 'ArtifactBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ prefix: 'microvm-images/', expiration: Duration.days(14) }],
    });

    new CfnOutput(this, 'ArtifactBucketName', { value: this.artifactBucket.bucketName });
    new CfnOutput(this, 'TableNameOutput', { value: this.table.tableName });
  }
}

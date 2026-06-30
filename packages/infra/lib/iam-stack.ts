// IAM roles for the MicroVM lifecycle. Both roles trust lambda.amazonaws.com
// with an aws:SourceAccount condition (always present, taken from the stack
// account) to prevent the confused-deputy problem. We deliberately do NOT add an
// aws:SourceArn condition: these roles are assumed across multiple MicroVM
// operations and an overly specific SourceArn makes AssumeRole fail at run time.
//
//  - buildRole:     assumed by Lambda during CreateMicrovmImage (reads the S3 zip).
//  - executionRole: assumed inside each running MicroVM (logs only — the game
//                   server holds all state in memory and needs no AWS access).
//
// The control-plane Lambda role (permissions to RunMicrovm / mint tokens /
// terminate / PassRole the execution role / DynamoDB / SSM) lives in api-stack,
// where the functions are defined.

import { Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  Effect,
  type IRole,
} from 'aws-cdk-lib/aws-iam';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

interface IamStackProps extends StackProps {
  artifactBucket: Bucket;
}

export class IamStack extends Stack {
  readonly buildRole: IRole;
  readonly executionRole: IRole;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    // Confused-deputy mitigation: scope the trust to this account. We use
    // aws:SourceAccount (always present — never collapsing to an unconditional
    // trust) rather than aws:SourceArn, because the build/execution roles are
    // assumed across several MicroVM operations (image build AND per-VM run) and
    // a single SourceArn pattern doesn't reliably match all of them; an overly
    // specific ArnLike causes AssumeRole to fail and the VM to terminate at run.
    const lambdaPrincipal = new ServicePrincipal('lambda.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': this.account },
      },
    });

    // --- Build role: read the artifact zip + write build logs. ---
    this.buildRole = new Role(this, 'BuildRole', {
      roleName: 'AsteroidsMicroVmBuildRole',
      assumedBy: lambdaPrincipal,
      description: 'Assumed by Lambda during CreateMicrovmImage',
    });
    props.artifactBucket.grantRead(this.buildRole, 'microvm-images/*');
    this.buildRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['arn:aws:logs:*:*:log-group:/aws/lambda-microvms/*'],
      }),
    );

    // --- Execution role: ship application stdout to CloudWatch. Nothing else. ---
    this.executionRole = new Role(this, 'ExecutionRole', {
      roleName: 'AsteroidsMicroVmExecutionRole',
      assumedBy: lambdaPrincipal,
      description: 'Assumed at runtime by the Asteroids MicroVM (least privilege)',
    });
    this.executionRole.addToPrincipalPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: ['arn:aws:logs:*:*:log-group:/aws/lambda-microvms/*'],
      }),
    );

    new CfnOutput(this, 'BuildRoleArn', { value: this.buildRole.roleArn });
    new CfnOutput(this, 'ExecutionRoleArn', { value: this.executionRole.roleArn });
  }
}

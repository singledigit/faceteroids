// Control plane: an HTTP API (v2) fronting a single Node Lambda router, plus the
// least-privilege role the Lambda needs to run rooms, mint tokens, terminate VMs,
// and touch DynamoDB — and the S3+CloudFront hosting for the static web client.
//
// Auth is not hand-rolled: a Cognito user pool backs host accounts, and host
// routes are protected by an API Gateway Cognito JWT authorizer (verification
// happens at the edge). Guests are anonymous and authorized by an opaque,
// DynamoDB-backed session token inside the Lambda — no signing secret anywhere.

import { Stack, type StackProps, CfnOutput, Duration, RemovalPolicy, Arn, ArnFormat } from 'aws-cdk-lib';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  HttpApi,
  HttpMethod,
  CorsHttpMethod,
  CfnStage,
  type IHttpRouteAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { PolicyStatement, Effect, type IRole } from 'aws-cdk-lib/aws-iam';
import {
  UserPool,
  UserPoolClient,
  AccountRecovery,
  ClientAttributes,
} from 'aws-cdk-lib/aws-cognito';
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import {
  Distribution,
  ViewerProtocolPolicy,
  type ErrorResponse,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BucketDeployment, Source, CacheControl } from 'aws-cdk-lib/aws-s3-deployment';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Construct } from 'constructs';
import { MICROVM_IMAGE_NAME } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTROL_PLANE_ENTRY = join(
  HERE,
  '..',
  '..',
  'control-plane',
  'src',
  'index.ts',
);
// Built static client (run `npx vite build packages/web` before `cdk deploy`).
const WEB_DIST = join(HERE, '..', '..', 'web', 'dist');

interface ApiStackProps extends StackProps {
  table: Table;
  executionRole: IRole;
}

export class ApiStack extends Stack {
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    // --- Static web client hosting (S3 private + CloudFront via OAC) ---
    // Created first so the API's CORS can be scoped to the exact CloudFront origin.
    const siteBucket = new Bucket(this, 'WebBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, // sample project; assets are redeployed
      autoDeleteObjects: true,
    });

    // SPA-style: 403/404 from S3 serve index.html (client routes via query string).
    const spaErrors: ErrorResponse[] = [
      { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
      { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
    ];
    const distribution = new Distribution(this, 'WebDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      errorResponses: spaErrors,
    });
    const webBaseUrl = `https://${distribution.distributionDomainName}`;

    // --- Host identity: Cognito user pool (self-registration DISABLED) ---
    // Hosts are the only credentialed users; guests are anonymous and never
    // enter the pool. Accounts are created out-of-band via `game-admin
    // create-user` (AdminCreateUser) — there is no public sign-up.
    const userPool = new UserPool(this, 'HostUserPool', {
      userPoolName: 'AsteroidsHosts',
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      accountRecovery: AccountRecovery.NONE,
      passwordPolicy: { minLength: 8, requireLowercase: true, requireDigits: true },
      removalPolicy: RemovalPolicy.DESTROY, // sample project; users are CLI-recreated
    });
    const userPoolClient = new UserPoolClient(this, 'HostUserPoolClient', {
      userPool,
      generateSecret: false, // public client; admin auth flow only
      authFlows: { adminUserPassword: true },
      idTokenValidity: Duration.hours(12),
      accessTokenValidity: Duration.hours(12),
      readAttributes: new ClientAttributes().withStandardAttributes({}),
    });

    // Cognito JWT authorizer — verifies host ID tokens at the API Gateway edge,
    // so host routes never reach the Lambda with an unverified token.
    const hostAuthorizer: IHttpRouteAuthorizer = new HttpUserPoolAuthorizer(
      'HostAuthorizer',
      userPool,
      { userPoolClients: [userPoolClient] },
    );

    // Explicit log group with bounded retention (the implicit one never expires).
    const logGroup = new LogGroup(this, 'ControlPlaneLogs', {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = new NodejsFunction(this, 'ControlPlaneFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: CONTROL_PLANE_ENTRY,
      handler: 'handler',
      timeout: Duration.seconds(30),
      memorySize: 256,
      logGroup,
      bundling: {
        // CommonJS output: bcryptjs/jsonwebtoken use dynamic require() of Node
        // builtins, which esbuild can't express in ESM output. CJS sidesteps it.
        target: 'node20',
        minify: true,
        // The Lambda runtime ships AWS SDK v3, but NOT the new lambda-microvms
        // client — so bundle everything rather than letting CDK mark @aws-sdk/*
        // external by default.
        externalModules: [],
      },
      environment: {
        TABLE_NAME: props.table.tableName,
        // ARNs built from stack account/region via Arn.format — no hardcoding.
        // MicroVM resource ARNs use the COLON form (microvm-image:<name>); only
        // the IAM trust-policy SourceArn uses the slash form.
        MICROVM_IMAGE_ARN: this.microvmArn('microvm-image', MICROVM_IMAGE_NAME),
        EXECUTION_ROLE_ARN: props.executionRole.roleArn,
        WEB_BASE_URL: webBaseUrl,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });

    // --- Permissions (least privilege) ---
    props.table.grantReadWriteData(fn);
    // Log hosts in against Cognito (admin auth flow). Token verification on later
    // requests is done by the API Gateway authorizer, not the Lambda.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['cognito-idp:AdminInitiateAuth'],
        resources: [userPool.userPoolArn],
      }),
    );

    // MicroVM control: run/token/terminate/get, scoped to region+account.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'lambda:RunMicrovm',
          'lambda:CreateMicrovmAuthToken',
          'lambda:SuspendMicrovm',
          'lambda:ResumeMicrovm',
          'lambda:TerminateMicrovm',
          'lambda:GetMicrovm',
        ],
        resources: [
          this.microvmArn('microvm-image', MICROVM_IMAGE_NAME),
          this.microvmArn('microvm', '*'),
        ],
      }),
    );
    // PassRole the execution role into RunMicrovm.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [props.executionRole.roleArn],
      }),
    );
    // RunMicrovm attaches the default AWS-managed network connectors (HTTP_INGRESS
    // + INTERNET_EGRESS), each requiring lambda:PassNetworkConnector.
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['lambda:PassNetworkConnector'],
        resources: [
          Arn.format(
            {
              service: 'lambda',
              account: 'aws',
              resource: 'network-connector',
              resourceName: 'aws-network-connector:*',
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            },
            this,
          ),
        ],
      }),
    );

    // --- HTTP API ---
    const integration = new HttpLambdaIntegration('ControlPlaneIntegration', fn);
    const api = new HttpApi(this, 'HttpApi', {
      // CORS scoped to the CloudFront origin (plus localhost for dev).
      corsPreflight: {
        allowOrigins: [webBaseUrl, 'http://localhost:5173'],
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type', 'authorization'],
        maxAge: Duration.hours(1),
      },
    });

    // Public routes — no edge authorizer (login itself, plus the anonymous-guest
    // join / status / token-refresh, which are authorized in-Lambda).
    const publicRoutes: Array<[string, HttpMethod]> = [
      ['/auth/login', HttpMethod.POST],
      ['/rooms/{roomId}', HttpMethod.GET],
      ['/rooms/{roomId}/join', HttpMethod.POST],
      ['/tokens/{roomId}/refresh', HttpMethod.POST],
    ];
    for (const [path, method] of publicRoutes) {
      api.addRoutes({ path, methods: [method], integration });
    }

    // Host-only routes — gated by the Cognito JWT authorizer at the edge.
    const hostRoutes: Array<[string, HttpMethod]> = [
      ['/rooms', HttpMethod.POST],
      ['/rooms/{roomId}/close', HttpMethod.POST],
      ['/rooms/{roomId}/suspend', HttpMethod.POST],
      ['/rooms/{roomId}/resume', HttpMethod.POST],
      ['/rooms/{roomId}/token', HttpMethod.POST],
    ];
    for (const [path, method] of hostRoutes) {
      api.addRoutes({ path, methods: [method], integration, authorizer: hostAuthorizer });
    }

    // Throttle the default stage to blunt brute-force / abuse on /auth/login.
    const cfnStage = api.defaultStage?.node.defaultChild as CfnStage | undefined;
    cfnStage?.addPropertyOverride('DefaultRouteSettings', {
      ThrottlingBurstLimit: 20,
      ThrottlingRateLimit: 10,
    });

    this.apiUrl = api.apiEndpoint;
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });

    // Deploy the built client + a runtime config.json carrying the API URL, so
    // the static bundle resolves the API at load time (no rebuild on URL change).
    //
    // Two deployments with different cache policies:
    //  - hashed assets (assets/*) are immutable -> cache for a year.
    //  - index.html + config.json must never be pinned by the browser, or users
    //    keep loading a stale app shell after a redeploy -> no-cache.
    new BucketDeployment(this, 'DeployWebAssets', {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/assets/*'],
      prune: false,
      sources: [Source.asset(WEB_DIST, { exclude: ['index.html'] })],
      cacheControl: [CacheControl.maxAge(Duration.days(365)), CacheControl.immutable()],
    });
    new BucketDeployment(this, 'DeployWebRoot', {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/index.html', '/config.json', '/'],
      prune: false,
      sources: [
        Source.asset(WEB_DIST, { exclude: ['assets/*'] }),
        Source.jsonData('config.json', { apiUrl: api.apiEndpoint }),
      ],
      cacheControl: [CacheControl.noCache(), CacheControl.mustRevalidate()],
    });

    new CfnOutput(this, 'WebUrl', { value: webBaseUrl });
  }

  /**
   * Build a MicroVM resource ARN in this stack's account/region. MicroVM resource
   * ARNs use the COLON form (`...:microvm-image:<name>`, `...:microvm:<id>`) — the
   * SLASH form is only valid for the IAM trust-policy SourceArn condition.
   */
  private microvmArn(resource: 'microvm-image' | 'microvm', name: string): string {
    return Arn.format(
      { service: 'lambda', resource, resourceName: name, arnFormat: ArnFormat.COLON_RESOURCE_NAME },
      this,
    );
  }
}

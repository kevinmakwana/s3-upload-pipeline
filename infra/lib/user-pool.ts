import { Aws, CfnOutput, Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export interface UserPoolAuthProps {
  /** Becomes part of the sign-in domain, which must be unique across AWS. */
  name: string;
  /** Web origins that may complete a sign-in (the app's own address, plus localhost for development). */
  origins: string[];
  /** Let anyone create an account. Off by default: add users yourself, or turn this on knowingly. */
  selfSignUp: boolean;
  removalPolicy: RemovalPolicy;
}

/** Names Cognito refuses in a domain prefix. */
const RESERVED = ['aws', 'amazon', 'cognito'];

/**
 * Sign-in for the web app: a Cognito user pool with the hosted login page and one public client
 * (authorization code + PKCE, no secret). The API verifies the pool's ID tokens through its JWKS.
 */
export class UserPoolAuth extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  /** https://<prefix>.auth.<region>.amazoncognito.com */
  readonly loginUrl: string;
  /** What the API must be given as JWT_ISSUER / JWT_AUDIENCE / JWT_JWKS_URL. */
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;

  constructor(scope: Construct, id: string, props: UserPoolAuthProps) {
    super(scope, id);
    const prefix = props.name.toLowerCase();
    if (RESERVED.some((word) => prefix.includes(word))) {
      throw new Error(`Cognito does not allow "${RESERVED.join('", "')}" in its sign-in domain, so the stack id "${props.name}" cannot be used with cognito`);
    }

    this.userPool = new cognito.UserPool(this, 'Pool', {
      selfSignUpEnabled: props.selfSignUp,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      removalPolicy: props.removalPolicy,
      deletionProtection: props.removalPolicy === RemovalPolicy.RETAIN,
    });

    const callbacks = props.origins.map((o) => `${o.replace(/\/$/, '')}/`);
    this.client = this.userPool.addClient('WebClient', {
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: callbacks,
        logoutUrls: callbacks,
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    const domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `${prefix}-${Aws.ACCOUNT_ID}` },
    });
    this.loginUrl = domain.baseUrl();

    // userPoolProviderUrl is cognito-idp.<region>.amazonaws.com/<pool id>, which is the tokens' `iss`.
    this.issuer = Fn.join('', ['https://', this.userPool.userPoolProviderUrl]);
    this.audience = this.client.userPoolClientId; // an ID token's `aud` is the client id
    this.jwksUrl = `${this.issuer}/.well-known/jwks.json`;

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.client.userPoolClientId });
    new CfnOutput(this, 'LoginUrl', { value: this.loginUrl });
  }
}

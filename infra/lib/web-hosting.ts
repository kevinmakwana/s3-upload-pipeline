import { CfnOutput, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

export interface WebHostingProps {
  /** The built web app (apps/web/dist). Must contain index.html. */
  distPath: string;
  /** Host name the API answers on (https only). The page may call this origin and nothing else of ours. */
  apiDomain: string;
  removalPolicy: RemovalPolicy;
}

/** What the web app reads from /config.json at start-up, so one build serves any deployment. */
export interface WebRuntimeConfig {
  apiUrl: string;
  auth: { mode: 'demo' } | { mode: 'oidc'; authorizeUrl: string; tokenUrl: string; logoutUrl: string; clientId: string; scope: string };
}

/**
 * The static web app: a private bucket served only through CloudFront (origin access control),
 * HTTPS only, with security headers and single-page-app fallbacks.
 */
export class WebHosting extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  /** https://<distribution domain>, which the upload bucket's CORS and the API must allow. */
  readonly origin: string;

  constructor(
    scope: Construct,
    id: string,
    private readonly props: WebHostingProps,
  ) {
    super(scope, id);
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(props.apiDomain) || props.apiDomain.includes('://')) {
      throw new Error(`apiDomain must be a bare host name such as api.example.com, got "${props.apiDomain}"`);
    }

    this.bucket = new s3.Bucket(this, 'Bucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: props.removalPolicy === RemovalPolicy.DESTROY,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(730), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: contentSecurityPolicy(props.apiDomain), override: true },
      },
    });

    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);
    // The shell and the config must show a new deployment at once; hashed assets can be cached for good.
    const fresh = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      responseHeadersPolicy: headers,
      compress: true,
    };
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Upload pipeline web app',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      additionalBehaviors: { '/index.html': fresh, '/config.json': fresh },
      // A deep link such as /?code=... is still the app; a missing asset is not worth a fallback.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) },
      ],
    });
    this.origin = `https://${this.distribution.distributionDomainName}`;

    new CfnOutput(this, 'WebUrl', { value: this.origin });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'WebBucketName', { value: this.bucket.bucketName });
  }

  /** Uploads the built app plus its config, then invalidates the CDN. Call once the config's values exist. */
  publish(config: WebRuntimeConfig): void {
    new s3deploy.BucketDeployment(this, 'Deployment', {
      destinationBucket: this.bucket,
      sources: [s3deploy.Source.asset(this.props.distPath), s3deploy.Source.jsonData('config.json', config)],
      prune: true,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });
  }
}

/**
 * Scripts and styles only from the app itself. The page may call the API, S3 (parts, thumbnails,
 * downloads) and Cognito's hosted login, and nothing else. React sets inline style attributes, hence
 * 'unsafe-inline' for styles only.
 */
export function contentSecurityPolicy(apiDomain: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https://*.amazonaws.com",
    `connect-src 'self' https://${apiDomain} https://*.amazonaws.com https://*.amazoncognito.com`,
    "base-uri 'none'",
    "form-action 'self' https://*.amazoncognito.com",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The /config.json the page reads. With a hosted login (Cognito) it signs in there; without, it uses the demo identity. */
export function webRuntimeConfig(apiDomain: string, login?: { url: string; clientId: string }): WebRuntimeConfig {
  return {
    apiUrl: `https://${apiDomain}`,
    auth: login
      ? {
          mode: 'oidc',
          authorizeUrl: `${login.url}/oauth2/authorize`,
          tokenUrl: `${login.url}/oauth2/token`,
          logoutUrl: `${login.url}/logout`,
          clientId: login.clientId,
          scope: 'openid email',
        }
      : { mode: 'demo' },
  };
}

import { HttpApi, HttpMethod } from "@aws-cdk/aws-apigatewayv2-alpha";
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from "@aws-cdk/aws-apigatewayv2-authorizers-alpha";
import { HttpLambdaIntegration } from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Architecture, Code, Function, InlineCode, Runtime } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { randomUUID } from "crypto";
import * as path from "path";

export class ApiGwHttpOnlyCookieAuthStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /**
     * API Gateway
     */
    const httpApi = new HttpApi(this, "HttpOnlyCookieHttpApi");

    const httpApiDomainName = `https://${httpApi.apiId}.execute-api.${Stack.of(this).region}.amazonaws.com`;

    new CfnOutput(this, "App URL", {
      value: httpApiDomainName,
      description: "The base URL of the endpoint",
    });

    /**
     * Cognito
     */
    const userPool = new UserPool(this, "HttpOnlyCookieUserPool", {
      userPoolName: "HttpOnlyCookie",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const callbackUrl = httpApiDomainName + "/oauth2/callback";
    const userPoolClient = userPool.addClient("MyAppClient", {
      oAuth: {
        callbackUrls: [callbackUrl],
      },
    });

    const domain = userPool.addDomain("UserPoolDomain", {
      cognitoDomain: {
        domainPrefix: "http-only-cookie" + "-" + randomUUID(),
      },
    });
    const signInUrl = domain.signInUrl(userPoolClient, {
      redirectUri: callbackUrl, // must be a URL configured under 'callbackUrls' with the client
    });
    new CfnOutput(this, "Sign-in URL", {
      value: signInUrl,
      description: "Use this URL to sign-in to your app",
    });

    /**
     * Lambda getProtectedResource
     */
    const getProtectedResourceFunction = new Function(this, "getProtectedResource", {
      functionName: "getProtectedResource",
      handler: "index.handler",
      runtime: Runtime.NODEJS_16_X,
      architecture: Architecture.ARM_64,
      code: new InlineCode(`
exports.handler = () => {
  return {
    statusCode: 200,
    body: JSON.stringify("Hello from Lambda!"),
  }; 
};`),
    });

    /**
     * Lambda oAuth2Callback
     */
    const oAuth2CallbackFunction = new Function(this, "oAuth2Callback", {
      functionName: "oAuth2Callback",
      runtime: Runtime.NODEJS_16_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromAsset(path.join(__dirname, "../src/oAuth2Callback")),
      environment: {
        TOKEN_ENDPOINT: `${domain.baseUrl()}/oauth2/token`,
        CLIENT_ID: userPoolClient.userPoolClientId,
        REDIRECT_URI: callbackUrl,
      },
    });

    /**
     * Lambda oAuth2Authorizer
     */
    const oAuth2AuthorizerFunction = new Function(this, "oAuth2Authorizer", {
      functionName: "oAuth2Authorizer",
      runtime: Runtime.NODEJS_16_X,
      architecture: Architecture.ARM_64,
      handler: "index.handler",
      code: Code.fromAsset(path.join(__dirname, "../src/oAuth2Authorizer")),
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });

    /**
     * API Gateway routes
     */
    httpApi.addRoutes({
      path: "/",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("getProtectedResource", getProtectedResourceFunction),
      authorizer: new HttpLambdaAuthorizer("oAuth2Authorizer", oAuth2AuthorizerFunction, {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        identitySource: [],
        resultsCacheTtl: Duration.seconds(0),
      }),
    });
    httpApi.addRoutes({
      path: "/oauth2/callback",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("oAuth2ServerIntegration", oAuth2CallbackFunction),
    });
  }
}

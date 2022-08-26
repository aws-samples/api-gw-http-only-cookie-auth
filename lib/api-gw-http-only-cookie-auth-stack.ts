import { HttpApi } from "@aws-cdk/aws-apigatewayv2-alpha";
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from "@aws-cdk/aws-apigatewayv2-authorizers-alpha";
import { HttpLambdaIntegration } from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, Duration, RemovalPolicy } from "aws-cdk-lib";
import { UserPool } from "aws-cdk-lib/aws-cognito";
import { Architecture, Code, Function, InlineCode, Runtime } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as path from "path";

export class ApiGwHttpOnlyCookieAuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * API Gateway
     */
    const httpApi = new HttpApi(this, id + "-FHIR-Http-Api");

    const httpApiDomainName = `${httpApi.apiId}.execute-api.${props?.env?.region}.amazonaws.com`;

    new CfnOutput(this, "App URL", {
      value: httpApiDomainName,
      description: "The base URL of the endpoint",
    });

    /**
     * Cognito
     */
    const userPoolId = id + "-user-pool";
    const userPool = new UserPool(this, userPoolId, {
      userPoolName: userPoolId,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const callbackUrl = httpApiDomainName + "/oauth2/callback";
    const userPoolClient = userPool.addClient(id + "-AppClient", {
      generateSecret: true,
      oAuth: {
        callbackUrls: [
          callbackUrl,
          "https://oauth.pstmn.io/v1/callback", // In case you want to test with Postman: https://www.postman.com/
        ],
      },
    });

    const domain = userPool.addDomain(id + "-Domain", {
      cognitoDomain: {
        domainPrefix: id.toLowerCase() + "-fhir-app",
      },
    });
    const signInUrl = domain.signInUrl(userPoolClient, {
      redirectUri: httpApiDomainName, // must be a URL configured under 'callbackUrls' with the client
      signInPath: "/oauth2/authorize",
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
      code: Code.fromAsset(path.join(__dirname, "./src/oAuth2Callback")),
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
      code: Code.fromAsset(path.join(__dirname, "./src/oAuth2Authorizer")),
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
      integration: new HttpLambdaIntegration("getProtectedResourceFunction", getProtectedResourceFunction),
      authorizer: new HttpLambdaAuthorizer("oAuth2AuthorizerFunction", oAuth2AuthorizerFunction, {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        resultsCacheTtl: Duration.seconds(0),
      }),
    });
    httpApi.addRoutes({
      path: "/api/v1/oauth2/callback",
      integration: new HttpLambdaIntegration("oAuth2ServerIntegration", oAuth2CallbackFunction),
      // authorizer: noAuth, TODO: Check this
    });
  }
}

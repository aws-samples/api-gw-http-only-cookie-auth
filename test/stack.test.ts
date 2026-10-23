import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ApiGwHttpOnlyCookieAuthStack } from "../lib/api-gw-http-only-cookie-auth-stack";

// Note: no snapshot test, because the Cognito domain prefix contains randomUUID().
describe("ApiGwHttpOnlyCookieAuthStack", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new ApiGwHttpOnlyCookieAuthStack(app, "TestStack");
    template = Template.fromStack(stack);
  });

  /** Returns the logical ID of the single resource of `type` matching `props`. */
  function logicalId(type: string, props: Record<string, unknown>): string {
    const ids = Object.keys(template.findResources(type, { Properties: props }));
    expect(ids).toHaveLength(1);
    return ids[0];
  }

  /** Matches CDK's join for `https://<apiId>.execute-api.<region>.amazonaws.com<suffix>`. */
  function apiUrl(suffix: string) {
    return {
      "Fn::Join": [
        "",
        [
          "https://",
          { Ref: Match.stringLikeRegexp("^HttpOnlyCookieHttpApi") },
          ".execute-api.",
          { Ref: "AWS::Region" },
          `.amazonaws.com${suffix}`,
        ],
      ],
    };
  }

  describe("API Gateway HTTP API", () => {
    test("creates exactly one HTTP API", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
      template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
    });

    test("has exactly two routes", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Route", 2);
    });

    test("GET / is protected by the Lambda authorizer", () => {
      const authorizerId = logicalId("AWS::ApiGatewayV2::Authorizer", { Name: "oAuth2Authorizer" });
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "GET /",
        AuthorizationType: "CUSTOM",
        AuthorizerId: { Ref: authorizerId },
      });
    });

    test("GET /oauth2/callback is public (the OAuth2 redirect must reach it unauthenticated)", () => {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: "GET /oauth2/callback",
        AuthorizationType: "NONE",
        AuthorizerId: Match.absent(),
      });
    });

    test("authorizer is a REQUEST authorizer with payload v2.0 and simple responses", () => {
      template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
      template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
        AuthorizerType: "REQUEST",
        AuthorizerPayloadFormatVersion: "2.0", // provides the top-level `cookies` array
        EnableSimpleResponses: true, // handler returns { isAuthorized }
      });
    });

    test("authorizer has no identity sources and caching disabled (invoked on every request)", () => {
      // API Gateway requires caching to be off when no identity source is configured
      template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
        IdentitySource: [],
        AuthorizerResultTtlInSeconds: 0,
      });
    });

    test("authorizer invokes the oAuth2Authorizer function", () => {
      const fnId = logicalId("AWS::Lambda::Function", { FunctionName: "oAuth2Authorizer" });
      template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
        AuthorizerUri: {
          "Fn::Join": ["", Match.arrayWith([{ "Fn::GetAtt": [fnId, "Arn"] }])],
        },
      });
    });

    test.each([
      ["GET /", "getProtectedResource"],
      ["GET /oauth2/callback", "oAuth2Callback"],
    ])("route %s integrates with the %s function", (routeKey, functionName) => {
      const fnId = logicalId("AWS::Lambda::Function", { FunctionName: functionName });
      const integrationId = logicalId("AWS::ApiGatewayV2::Integration", {
        IntegrationType: "AWS_PROXY",
        IntegrationUri: { "Fn::GetAtt": [fnId, "Arn"] },
      });
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        Target: { "Fn::Join": ["", ["integrations/", { Ref: integrationId }]] },
      });
    });
  });

  describe("Lambda functions", () => {
    test("creates exactly three functions", () => {
      template.resourceCountIs("AWS::Lambda::Function", 3);
    });

    test.each(["getProtectedResource", "oAuth2Callback", "oAuth2Authorizer"])(
      "%s uses Node.js 24 on arm64 with reserved concurrency 1",
      (functionName) => {
        template.hasResourceProperties("AWS::Lambda::Function", {
          FunctionName: functionName,
          Runtime: "nodejs24.x",
          Architectures: ["arm64"],
          Handler: "index.handler",
          ReservedConcurrentExecutions: 1,
        });
      },
    );

    test.each(["getProtectedResource", "oAuth2Callback", "oAuth2Authorizer"])(
      "API Gateway is allowed to invoke %s",
      (functionName) => {
        const fnId = logicalId("AWS::Lambda::Function", { FunctionName: functionName });
        template.hasResourceProperties("AWS::Lambda::Permission", {
          Action: "lambda:InvokeFunction",
          Principal: "apigateway.amazonaws.com",
          FunctionName: { "Fn::GetAtt": [fnId, "Arn"] },
        });
      },
    );

    test("oAuth2Callback gets the token endpoint, client ID and redirect URI", () => {
      const clientId = logicalId("AWS::Cognito::UserPoolClient", {});
      const domainId = logicalId("AWS::Cognito::UserPoolDomain", {});
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "oAuth2Callback",
        Environment: {
          Variables: {
            CLIENT_ID: { Ref: clientId },
            REDIRECT_URI: apiUrl("/oauth2/callback"),
            TOKEN_ENDPOINT: {
              "Fn::Join": [
                "",
                Match.arrayWith([{ Ref: domainId }, Match.stringLikeRegexp("/oauth2/token$")]),
              ],
            },
          },
        },
      });
    });

    test("oAuth2Authorizer gets the user pool ID and client ID", () => {
      const poolId = logicalId("AWS::Cognito::UserPool", {});
      const clientId = logicalId("AWS::Cognito::UserPoolClient", {});
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "oAuth2Authorizer",
        Environment: {
          Variables: {
            USER_POOL_ID: { Ref: poolId },
            CLIENT_ID: { Ref: clientId },
          },
        },
      });
    });

    test("getProtectedResource has no environment (mock backend)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "getProtectedResource",
        Environment: Match.absent(),
      });
    });
  });

  describe("Cognito", () => {
    test("creates one user pool that is destroyed with the stack", () => {
      template.resourceCountIs("AWS::Cognito::UserPool", 1);
      template.hasResource("AWS::Cognito::UserPool", {
        Properties: { UserPoolName: "HttpOnlyCookie" },
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
      });
    });

    test("self sign-up is disabled (only admins can create users)", () => {
      template.hasResourceProperties("AWS::Cognito::UserPool", {
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      });
    });

    test("app client allows only the authorization code grant (no implicit flow)", () => {
      template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        AllowedOAuthFlows: ["code"],
        AllowedOAuthFlowsUserPoolClient: true,
      });
    });

    test("app client is a public client without a secret", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        GenerateSecret: Match.absent(),
      });
    });

    test("app client callback URL is the API's /oauth2/callback", () => {
      template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
        CallbackURLs: [apiUrl("/oauth2/callback")],
      });
    });

    test("hosted UI domain uses an http-only-cookie- prefix with a UUID suffix", () => {
      template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
      template.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
        Domain: Match.stringLikeRegexp(
          "^http-only-cookie-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        ),
      });
    });
  });

  describe("Outputs", () => {
    test("exports the app URL", () => {
      const outputs = template.findOutputs("*", { Description: "The base URL of the endpoint" });
      expect(Object.values(outputs)).toEqual([expect.objectContaining({ Value: apiUrlValue("") })]);
    });

    test("exports a sign-in URL that redirects to the callback", () => {
      const outputs = Object.values(
        template.findOutputs("*", { Description: "Use this URL to sign-in to your app" }),
      );
      expect(outputs).toHaveLength(1);
      const serialized = JSON.stringify(outputs[0].Value);
      expect(serialized).toContain("/login?client_id=");
      expect(serialized).toContain("&response_type=code&redirect_uri=");
      expect(serialized).toContain("/oauth2/callback");
    });
  });
});

/** Plain-object form of the API URL join, for use with Jest matchers instead of CDK Match. */
function apiUrlValue(suffix: string) {
  return {
    "Fn::Join": [
      "",
      [
        "https://",
        { Ref: expect.stringMatching(/^HttpOnlyCookieHttpApi/) },
        ".execute-api.",
        { Ref: "AWS::Region" },
        `.amazonaws.com${suffix}`,
      ],
    ],
  };
}

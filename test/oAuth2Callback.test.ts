import * as path from "path";

const LAMBDA_DIR = path.join(__dirname, "../src/oAuth2Callback");

const ENV = {
  TOKEN_ENDPOINT: "https://example-domain.auth.us-east-1.amazoncognito.com/oauth2/token",
  CLIENT_ID: "test-client-id",
  REDIRECT_URI: "https://abc123.execute-api.us-east-1.amazonaws.com/oauth2/callback",
};

describe("oAuth2Callback handler", () => {
  let handler: (event: unknown) => Promise<any>;
  let postMock: jest.Mock;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, ...ENV };
    jest.isolateModules(() => {
      // Resolve axios from the Lambda's own node_modules, the same instance index.js uses
      const axios = require(require.resolve("axios", { paths: [LAMBDA_DIR] })).default;
      postMock = jest.fn();
      axios.post = postMock;
      handler = require(LAMBDA_DIR).handler;
    });
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  const eventWithCode = (code = "auth-code-123") => ({ queryStringParameters: { code } });

  describe("input validation", () => {
    test.each([
      ["no queryStringParameters", {}],
      ["empty queryStringParameters", { queryStringParameters: {} }],
      ["other query params only", { queryStringParameters: { state: "xyz" } }],
    ])("returns 400 when %s", async (_desc, event) => {
      const res = await handler(event);
      expect(res).toEqual({ statusCode: 400, body: "code query param required" });
      expect(postMock).not.toHaveBeenCalled();
    });
  });

  describe("token exchange request", () => {
    beforeEach(() => postMock.mockResolvedValue({ data: { access_token: "tok" } }));

    test("POSTs to the configured Cognito token endpoint", async () => {
      await handler(eventWithCode());
      expect(postMock).toHaveBeenCalledTimes(1);
      expect(postMock.mock.calls[0][0]).toBe(ENV.TOKEN_ENDPOINT);
    });

    test("uses application/x-www-form-urlencoded", async () => {
      await handler(eventWithCode());
      expect(postMock.mock.calls[0][2]).toEqual({
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    });

    test("sends grant_type, client_id, redirect_uri and code as form fields", async () => {
      await handler(eventWithCode("auth-code-123"));
      const body = new URLSearchParams(postMock.mock.calls[0][1]);
      expect(Object.fromEntries(body)).toEqual({
        grant_type: "authorization_code",
        client_id: ENV.CLIENT_ID,
        redirect_uri: ENV.REDIRECT_URI,
        code: "auth-code-123",
      });
    });

    test("does not send a client secret (public client)", async () => {
      await handler(eventWithCode());
      expect(new URLSearchParams(postMock.mock.calls[0][1]).has("client_secret")).toBe(false);
    });

    test("form-encodes a code containing special characters", async () => {
      await handler(eventWithCode("a&b=c d"));
      expect(new URLSearchParams(postMock.mock.calls[0][1]).get("code")).toBe("a&b=c d");
    });
  });

  describe("successful response", () => {
    const TOKEN = "eyJhbGciOiJSUzI1NiJ9.payload.signature";
    let res: any;

    beforeEach(async () => {
      postMock.mockResolvedValue({ data: { access_token: TOKEN, id_token: "id", refresh_token: "r" } });
      res = await handler(eventWithCode());
    });

    test("redirects to the app root with 302", () => {
      expect(res.statusCode).toBe(302);
      expect(res.headers.Location).toBe("/");
    });

    test("sets only the access token as the cookie value", () => {
      const cookie: string = res.headers["Set-Cookie"];
      expect(cookie.split(";")[0]).toBe(`accessToken=${TOKEN}`);
      expect(cookie).not.toContain("id_token");
      expect(cookie).not.toContain("refresh");
    });

    // OWASP: verify cookies are only set with the approved security attributes
    test("cookie has exactly the approved attributes", () => {
      const attributes = (res.headers["Set-Cookie"] as string)
        .split(";")
        .slice(1)
        .map((a) => a.trim());
      expect(attributes.sort()).toEqual(["HttpOnly", "Path=/", "SameSite=Lax", "Secure"].sort());
    });

    test("does not return a body containing the token", () => {
      expect(JSON.stringify(res.body ?? "")).not.toContain(TOKEN);
    });
  });

  describe("token endpoint failures", () => {
    test("currently rejects when the token request fails (API Gateway returns 500)", async () => {
      postMock.mockRejectedValue(new Error("Request failed with status code 400"));
      await expect(handler(eventWithCode())).rejects.toThrow("Request failed with status code 400");
    });

    test.each([
      ["no access_token field", { data: { id_token: "id" } }],
      ["empty access_token", { data: { access_token: "" } }],
      ["null access_token", { data: { access_token: null } }],
      ["no data", {}],
    ])("returns 502 without setting a cookie when the response has %s", async (_desc, response) => {
      postMock.mockResolvedValue(response);
      const res = await handler(eventWithCode());
      expect(res).toEqual({ statusCode: 502, body: "token endpoint did not return an access token" });
      expect(res.headers).toBeUndefined();
    });
  });
});

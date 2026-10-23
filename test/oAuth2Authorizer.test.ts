import { generateKeyPairSync, KeyObject, sign } from "crypto";
import * as path from "path";

/**
 * These tests run the real aws-jwt-verify verification against JWTs signed with a
 * locally generated RSA key. The JWKS is preloaded via `cacheJwks()`, so no network
 * calls to Cognito are made.
 */

const LAMBDA_DIR = path.join(__dirname, "../src/oAuth2Authorizer");
const REGION = "us-east-1";
const USER_POOL_ID = `${REGION}_TestPool1`;
const CLIENT_ID = "test-client-id";
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const GLOBAL_ISSUER = `https://issuer-cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const KID = "test-key-1";

function newKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  return { privateKey, jwk };
}

const signingKey = newKey(KID);
const otherKey = newKey("unknown-key");

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function signJwt(
  payload: Record<string, unknown>,
  { privateKey = signingKey.privateKey, kid = KID }: { privateKey?: KeyObject; kid?: string } = {},
) {
  const input = `${b64url({ alg: "RS256", typ: "JWT", kid })}.${b64url(payload)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

function accessTokenClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user-sub-1",
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: "access",
    scope: "openid email",
    auth_time: now,
    iat: now,
    exp: now + 3600,
    jti: "jti-1",
    username: "user@example.com",
    ...overrides,
  };
}

type Handler = (event: unknown) => Promise<{ isAuthorized: boolean }>;

/** Loads the Lambda module fresh, capturing the module-scoped verifier to preload its JWKS. */
function loadHandler(env: Record<string, string | undefined>) {
  let handler!: Handler;
  let createSpy!: jest.SpyInstance;
  jest.isolateModules(() => {
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    // Resolve from the Lambda's own node_modules, the same module instance index.js uses
    const { CognitoJwtVerifier } = require(require.resolve("aws-jwt-verify", { paths: [LAMBDA_DIR] }));
    const create = CognitoJwtVerifier.create.bind(CognitoJwtVerifier);
    createSpy = jest.spyOn(CognitoJwtVerifier, "create").mockImplementation((...args: unknown[]) => {
      const verifier = create(...args);
      verifier.cacheJwks({ keys: [signingKey.jwk] });
      return verifier;
    });
    handler = require(LAMBDA_DIR).handler;
  });
  return { handler, createSpy };
}

describe("oAuth2Authorizer handler", () => {
  const originalEnv = process.env;
  let handler: Handler;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    handler = loadHandler({ USER_POOL_ID, CLIENT_ID }).handler;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  const event = (cookies?: string[]) => ({
    version: "2.0",
    type: "REQUEST",
    routeKey: "GET /",
    ...(cookies !== undefined && { cookies }),
  });

  describe("module initialisation", () => {
    test("creates the verifier once, from USER_POOL_ID and CLIENT_ID, for access tokens", () => {
      const { createSpy } = loadHandler({ USER_POOL_ID, CLIENT_ID });
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith({ userPoolId: USER_POOL_ID, tokenUse: "access", clientId: CLIENT_ID });
    });

    test.each([
      ["missing", undefined],
      ["malformed", "not-a-user-pool-id"],
    ])("fails at cold start when USER_POOL_ID is %s", (_desc, userPoolId) => {
      expect(() => loadHandler({ USER_POOL_ID: userPoolId, CLIENT_ID })).toThrow();
    });
  });

  describe("allows", () => {
    test("a valid access token in the accessToken cookie", async () => {
      await expect(handler(event([`accessToken=${signJwt(accessTokenClaims())}`]))).resolves.toEqual({
        isAuthorized: true,
      });
    });

    test("a valid token when accessToken is not the first cookie", async () => {
      const cookies = ["theme=dark", "session=xyz", `accessToken=${signJwt(accessTokenClaims())}`];
      await expect(handler(event(cookies))).resolves.toEqual({ isAuthorized: true });
    });

    test("a valid token issued with the global Cognito issuer format", async () => {
      const token = signJwt(accessTokenClaims({ iss: GLOBAL_ISSUER }));
      await expect(handler(event([`accessToken=${token}`]))).resolves.toEqual({ isAuthorized: true });
    });
  });

  describe("denies when the token is missing", () => {
    test("no cookies on the request", async () => {
      await expect(handler(event())).resolves.toEqual({ isAuthorized: false });
      expect(logSpy).toHaveBeenCalledWith("No cookies found");
    });

    test("empty cookies array", async () => {
      await expect(handler(event([]))).resolves.toEqual({ isAuthorized: false });
      expect(logSpy).toHaveBeenCalledWith("Access token not found in cookies");
    });

    test("cookies present but no accessToken cookie", async () => {
      await expect(handler(event(["theme=dark", "session=xyz"]))).resolves.toEqual({ isAuthorized: false });
      expect(logSpy).toHaveBeenCalledWith("Access token not found in cookies");
    });

    test("empty accessToken cookie value", async () => {
      await expect(handler(event(["accessToken="]))).resolves.toEqual({ isAuthorized: false });
    });
  });

  describe("denies invalid tokens", () => {
    const now = () => Math.floor(Date.now() / 1000);

    test.each<[string, () => string]>([
      ["expired", () => signJwt(accessTokenClaims({ iat: now() - 7200, exp: now() - 3600 }))],
      ["wrong client_id", () => signJwt(accessTokenClaims({ client_id: "other-client" }))],
      ["ID token instead of access token", () => signJwt(accessTokenClaims({ token_use: "id" }))],
      ["wrong issuer", () => signJwt(accessTokenClaims({ iss: "https://evil.example.com/pool" }))],
      [
        "issuer from another user pool",
        () => signJwt(accessTokenClaims({ iss: `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_Other` })),
      ],
      ["signed by an unknown key", () => signJwt(accessTokenClaims(), { privateKey: otherKey.privateKey, kid: "unknown-key" })],
      ["signed by another key under a known kid", () => signJwt(accessTokenClaims(), { privateKey: otherKey.privateKey })],
      [
        "tampered payload",
        () => {
          const [h, , s] = signJwt(accessTokenClaims()).split(".");
          return `${h}.${b64url(accessTokenClaims({ sub: "admin" }))}.${s}`;
        },
      ],
      [
        "unsigned (alg none)",
        () => `${b64url({ alg: "none", typ: "JWT", kid: KID })}.${b64url(accessTokenClaims())}.`,
      ],
      ["not a JWT", () => "not-a-jwt"],
    ])("%s", async (_desc, makeToken) => {
      await expect(handler(event([`accessToken=${makeToken()}`]))).resolves.toEqual({ isAuthorized: false });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("cookie parsing (current behaviour)", () => {
    test("currently matches any cookie whose name ends with accessToken", async () => {
      // split("accessToken=") is a substring match; still safe because the JWT must verify
      const token = signJwt(accessTokenClaims());
      await expect(handler(event([`xaccessToken=${token}`]))).resolves.toEqual({ isAuthorized: true });
    });

    test("currently uses the first matching cookie", async () => {
      const cookies = ["accessToken=garbage", `accessToken=${signJwt(accessTokenClaims())}`];
      await expect(handler(event(cookies))).resolves.toEqual({ isAuthorized: false });
    });
  });
});

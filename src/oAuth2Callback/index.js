const qs = require("qs");
const axios = require("axios").default;

exports.handler = async function (event) {
  const code = event.queryStringParameters?.code;

  if (code == null) {
    return {
      statusCode: 400,
      body: "code query param required",
    };
  }

  const data = {
    grant_type: "authorization_code",
    client_id: process.env.CLIENT_ID,
    // The redirect has already happened, but you still need to pass the URI for validation, so a valid oAuth2 access token can be generated
    redirect_uri: encodeURI(process.env.REDIRECT_URI),
    code: code,
  };

  // Every Cognito instance has its own token endpoints. For more information check the documentation: https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html
  const res = await axios.post(process.env.TOKEN_ENDPOINT, qs.stringify(data), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const accessToken = res.data?.access_token;
  if (accessToken == null || accessToken === "") {
    // Never persist an empty or "undefined" cookie value; treat it as an upstream failure
    console.error("Token endpoint response did not include an access_token");
    return {
      statusCode: 502,
      body: "token endpoint did not return an access token",
    };
  }

  return {
    statusCode: 302,
    // These headers are returned as part of the response to the browser.
    headers: {
      // The Location header tells the browser it should redirect to the root of the URL
      Location: "/",
      // The Set-Cookie header tells the browser to persist the access token in the cookie store
      "Set-Cookie": `accessToken=${accessToken}; Secure; HttpOnly; SameSite=Lax; Path=/`,
    },
  };
};

const { CognitoJwtVerifier } = require("aws-jwt-verify");

function getAccessTokenFromCookies(cookiesArray) {
  // cookieStr contains the full cookie definition string: "accessToken=abc"
  for (const cookieStr of cookiesArray) {
    const cookieArr = cookieStr.split("accessToken=");
    // After splitting you should get an array with 2 entries: ["", "abc"] - Or only 1 entry in case it was a different cookie string: ["test=test"]
    if (cookieArr[1] != null) {
      return cookieArr[1]; // Returning only the value of the access token without cookie name
    }
  }

  return null;
}

// Create the verifier outside the Lambda handler (= during cold start),
// so the cache can be reused for subsequent invocations. Then, only during the
// first invocation, will the verifier actually need to fetch the JWKS.
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  tokenUse: "access",
  clientId: process.env.CLIENT_ID,
});

exports.handler = async (event) => {
  if (event.cookies == null) {
    console.log("No cookies found");

    return {
      isAuthorized: false,
    };
  }

  // Cookies array looks something like this: ["accessToken=abc", "otherCookie=Random Value"]
  const accessToken = getAccessTokenFromCookies(event.cookies);

  if (accessToken == null) {
    console.log("Access token not found in cookies");
    return {
      isAuthorized: false,
    };
  }

  try {
    await verifier.verify(accessToken);
    return {
      isAuthorized: true,
    };
  } catch (e) {
    console.error(e);
    return {
      isAuthorized: false,
    };
  }
};

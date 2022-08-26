# How to implement HttpOnly cookie authentication in Amazon API Gateway

This repository contains accompanying source code for the AWS Blog post, [How to implement HttpOnly cookie authentication in Amazon API Gateway](https://aws.amazon.com/). Read the blog for more information on architecture & concept. This repository only contains automated tools to easily deploy the solution.

## Pre-requisites

•	You should have level 200-300 know-how on the [OAuth2 protocol](https://oauth.net/2/).
•	You should have the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-chap-getting-started.html) installed & setup.
•	Download & install [NodeJS](https://nodejs.org/en/download/)

## Deployment

You are going to use [AWS Cloud Development Kit](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) to deploy the solution with infrastructure as code. Follow the following steps to deploy the solution.

Open a terminal & clone this repository:
```
$ git clone https://github.com/aws-samples/api-gw-http-only-cookie-auth.git
```

Go into the cloned folder:
```
$ cd ./api-gw-http-only-cookie-auth.git
```

Run the deployment script and follow the on-screen quesetions:
```
$ npm run deploy
```

...Wait until the script finishes & all resources are deployed...

Create test user:
1. Navigate to the [Amazon Cognito](https://console.aws.amazon.com/cognito/home) console and choose **HttpOnlyCookie**.
1. Under **Users** choose **Create user**.
1. For **User name** enter any user name you like.
1. For **Email address** enter any email you like.
> Note: For this tutorial you don’t need to send out actual emails. That’s why the email does not need to actually exist.
5.	Choose **Mark email address as verified**.
6.	For **password** enter a password you can remember (or even better: use a password generator).
7.	Remember the **email** and **password** for later use.
8.	Choose **Create user**.

<img width="511" alt="Create user" src="https://user-images.githubusercontent.com/7549295/186916667-a22e180c-192d-416d-8079-5ab7d0ba0289.png">

That's it 🎉

Now that you have all components in place, you can test your OAuth2 Flow:
1.	Navigate to the Amazon Cognito console and choose MyUserPool.
2.	Under the navigation tabs choose App integration.
3.	Under App client list choose MyAppClient.
4.	Choose View Hosted UI.
5.	In the newly opened browser tab, open your developer tools, so you can inspect the network requests.
6.	Login with your Email & password
7.	Now you’ll see your Hello from Lambda message.

How do you know that the cookie was accurately set?
Check your browser network tab in the browser developer settings. You’ll see the /oauth2/callback request which looks like this:
 
Figure 13 Callback network request

As you can see the response headers include a Set-Cookie header as you specified in your Lambda function. This ensures that your OAuth2 access token is set as a HttpOnly cookie in the browser & access is prohibited from any client-side code.

Also, you can inspect the cookie in the browser cookie storage: 
Figure 14 Cookie storage

| Note: In case you want to retry the authentication: Navigate in your browser to the base URL of Amazon Cognito & clear all site data in the browser developer tools. Do the same for your API Gateway website. Now you can restart the test with a clean state.
![image](https://user-images.githubusercontent.com/7549295/186916891-b6c5af4d-e9ad-492f-9082-78ea7e2ca6a9.png)


## Security

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

This library is licensed under the MIT-0 License. See the LICENSE file.
